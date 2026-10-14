import type { Browser } from '@playwright/test';
import { resolveOrigin } from '../ui/browserManager';
import { runWithoutSteps, SCREEN, StepFailed, type Journey, type StepRunner } from './netRevealJourney';
import type { PerfConfig } from './perfConfig';
import type { PerfRecorder } from './perfRecorder';
import { ScreenTimer } from './screenTimer';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Hands out each login to one virtual user at a time, picking a random free one. */
class LoginPool {
  private readonly free: string[];
  private readonly waiting: ((login: string) => void)[] = [];

  constructor(logins: string[]) {
    this.free = [...new Set(logins)];
  }

  acquire(): Promise<string> {
    if (this.free.length) {
      return Promise.resolve(this.free.splice(Math.floor(Math.random() * this.free.length), 1)[0]);
    }
    return new Promise((resolve) => this.waiting.push(resolve));
  }

  release(login: string): void {
    const next = this.waiting.shift();
    if (next) next(login);
    else this.free.push(login);
  }
}
export type RunOptions = {
  virtualUsers?: number;
  /** Specs pass `test.step` so every virtual user's Gherkin steps are reported. */
  step?: StepRunner;
  singlePass?: boolean;
};

/**
 * Run `journey` for N virtual users concurrently inside ONE browser process: each virtual
 * user is an isolated BrowserContext (own cookies → own NetReveal session). This simulates
 * concurrent users without opening extra browsers or Selenium Grid sessions.
 * Users are assigned round-robin from perf.users, so every listed user takes part.
 */
export async function runVirtualUsers(
  browser: Browser,
  cfg: PerfConfig,
  recorder: PerfRecorder,
  journey: Journey,
  options: RunOptions = {},
): Promise<void> {
  const virtualUsers = options.virtualUsers ?? cfg.virtualUsers;
  const step = options.step ?? runWithoutSteps;
  if (options.singlePass && (virtualUsers !== cfg.users.length || new Set(cfg.users).size !== cfg.users.length)) {
    throw new Error('Config error: a single-pass workload requires one virtual user per distinct perf.users login');
  }
  // Multi-machine: global virtual-user numbers; this machine takes every shard.total-th one.
  const { index: shardIndex, total: shardTotal } = cfg.shard;
  const mine = Array.from({ length: virtualUsers }, (_, i) => i).filter((i) => i % shardTotal === shardIndex - 1);
  // Logins are split between shards (disjoint), and inside a shard a login serves one session at a time,
  // so the same account is never logged in twice at once. Extra virtual users wait for a free login.
  const shardLogins = cfg.users.filter((_, i) => i % shardTotal === shardIndex - 1);
  if (!mine.length) {
    throw new Error(
      `Config error: ${virtualUsers} virtual user(s) split over ${shardTotal} shards leaves shard ${shardIndex} ` +
        'with none. Raise perf.virtualUsers, or use fewer shards (a single-user baseline cannot be sharded).',
    );
  }
  if (!shardLogins.length) {
    // Falling back to the full list would log the same account in from two shards at once, and
    // NetReveal ends the earlier session — the other shard's virtual users would die mid-journey.
    throw new Error(
      `Config error: perf.users has ${cfg.users.length} login(s) but PERF_SHARD total is ${shardTotal}, ` +
        `so shard ${shardIndex} got none. Add logins to perf.users (at least one per shard) or use fewer shards.`,
    );
  }
  const logins = new LoginPool(shardLogins);
  // eslint-disable-next-line no-console
  console.log(
    `[shard ${shardIndex}/${shardTotal}] ${mine.length} of ${virtualUsers} virtual users, ` +
      `${shardLogins.length} of ${cfg.users.length} logins: ${shardLogins.join(', ')}`,
  );

  // On-demand: check in with the coordinator and wait for its GO (all shards released together).
  if (cfg.coordinator) {
    const url = `${cfg.coordinator}/ready?shard=${shardIndex}of${shardTotal}`;
    // eslint-disable-next-line no-console
    console.log(`[shard ${shardIndex}/${shardTotal}] ${mine.length} of ${virtualUsers} virtual users; waiting for GO from ${cfg.coordinator}`);
    for (;;) {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(cfg.testTimeoutMs) });
        if (res.ok) break;
      } catch {
        // coordinator not up yet / connection dropped - retry
      }
      await sleep(2000);
    }
    // eslint-disable-next-line no-console
    console.log(`[shard ${shardIndex}/${shardTotal}] GO`);
  }

  // Fixed time instead of a coordinator: all machines start their logins at that moment.
  if (cfg.startAt) {
    const wait = cfg.startAt - Date.now();
    // eslint-disable-next-line no-console
    console.log(
      `[shard ${shardIndex}/${shardTotal}] ${mine.length} of ${virtualUsers} virtual users; ` +
        (wait > 0 ? `waiting ${Math.round(wait / 1000)} s for PERF_START_AT` : 'PERF_START_AT already passed - starting now'),
    );
    if (wait > 0) await sleep(wait);
  }

  const runOne = async (index: number, position: number) => {
    const virtualUser = index + 1;
    await sleep(Math.floor(Math.random() * (cfg.arrivalWindowMs + 1)) + position * cfg.rampUpMs);
    // Fixed assignment prevents a fast-finishing session from handing its login to a later user.
    const user = options.singlePass ? shardLogins[position] : await logins.acquire();

    const context = await browser
      .newContext({
        baseURL: resolveOrigin(),
        ignoreHTTPSErrors: true,
        viewport: cfg.viewport,
        // browser.newContext() inherits the project's `use.storageState`, so without this every virtual
        // user would start already logged in as the setup user: the journey would land on the home page
        // instead of the login form, and LOGIN could never be timed. An empty state forces a real login.
        storageState: { cookies: [], origins: [] },
      })
      .catch((err) => {
        if (!options.singlePass) logins.release(user);
        throw err;
      });
    // Contexts made here do not inherit the project's `use` timeouts (Playwright Test: none for
    // navigation) — bound every action/navigation so one stuck page cannot hang the whole run.
    context.setDefaultTimeout(cfg.actionTimeoutMs);
    context.setDefaultNavigationTimeout(cfg.actionTimeoutMs);
    try {
      const page = await context.newPage();
      // Leaving a screen must never be blocked: accept "Leave site?" (beforeunload) and confirmations
      // (e.g. "cancel this workflow?" after Cancel in a wizard). The test clicks only navigation,
      // Search, alert links, Back and wizard Cancel, so no confirm can trigger a data change.
      page.on('dialog', (dialog) => {
        const accept = dialog.type() === 'beforeunload' || dialog.type() === 'confirm';
        (accept ? dialog.accept() : dialog.dismiss()).catch(() => undefined);
      });
      const timer = new ScreenTimer(
        page,
        { release: cfg.release, virtualUser, user },
        recorder.add,
        recorder.addErrorScreenshot,
        {
          quietMs: cfg.ready.networkQuietMs,
          maxRequestWaitMs: cfg.ready.maxRequestWaitMs,
          ignore: cfg.ready.ignoreRequests,
        },
      );
      await step(`Scenario: virtual user ${virtualUser} of ${virtualUsers} as "${user}"`, () =>
        journey({
          page,
          cfg: { ...cfg, virtualUsers },
          virtualUser,
          user,
          timer,
          step,
          reportMenu: recorder.addMenu,
          singlePass: options.singlePass,
        }),
      );
    } catch (err) {
      // StepFailed was already recorded by the step itself (e.g. LOGIN).
      if (!(err instanceof StepFailed)) {
        recorder.add({
          release: cfg.release,
          screen: SCREEN.journeyAborted,
          virtualUser,
          user,
          iteration: 0,
          warmup: false,
          startedAt: new Date().toISOString(),
          durationMs: 0,
          serverMs: null,
          requests: 0,
          slowestRequest: '',
          rows: null,
          status: 'error',
          error: err instanceof Error ? err.message.split('\n')[0] : String(err),
        });
      }
    } finally {
      await context.close();
      if (!options.singlePass) logins.release(user);
    }
  };

  await Promise.all(mine.map((index, position) => runOne(index, position)));
}
