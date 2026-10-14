import type { Locator, Page } from '@playwright/test';
import { NetRevealAuthCapability } from '../capabilities/netRevealAuthCapability';
import { resolveBaseUrl } from '../ui/browserManager';
import { AlertDetailsPage } from '../ui/pages/AlertDetailsPage';
import { AllAlertsPage } from '../ui/pages/AllAlertsPage';
import { HomePage } from '../ui/pages/HomePage';
import { MainMenuPage, MenuItemNotFoundError, type MenuScreen } from '../ui/pages/MainMenuPage';
import { NetRevealScreen, type NetworkActivity, type ReadyResult } from '../ui/pages/NetRevealScreen';
import { selectScreens, type MenuSelection } from './menuSelection';
import type { PerfConfig } from './perfConfig';
import type { MeasureOptions, ScreenTimer } from './screenTimer';
import type { Measurement } from './types';

/** Reports a named step (specs pass `test.step`, so steps show in the console and HTML report). */
export type StepRunner = <T>(title: string, body: () => Promise<T>) => Promise<T>;

export const runWithoutSteps: StepRunner = (_title, body) => body();

export type JourneyContext = {
  page: Page;
  cfg: PerfConfig;
  virtualUser: number;
  user: string;
  timer: ScreenTimer;
  step: StepRunner;
  /** Receives the menu read after login (perf.screens=auto) — written to menus.json. */
  reportMenu?: (user: string, selection: MenuSelection) => void;
  /** Catalogue workload: visit every selected screen once, in random order. */
  singlePass?: boolean;
};

export type Journey = (ctx: JourneyContext) => Promise<void>;

/** Stable screen ids used in reports, thresholds and baselines. */
export const SCREEN = {
  login: 'LOGIN',
  menu: (menuPath: string) => `MENU ${menuPath.split('->').map((p) => p.trim()).join(' > ')}`,
  allAlertsView: (view: string) => `ALL_ALERTS_VIEW ${view}`,
  allAlertsSearch: 'ALL_ALERTS_SEARCH',
  alertDetailsOpen: 'ALERT_DETAILS_OPEN',
  alertDetailsBack: 'ALERT_DETAILS_BACK',
  journeyError: 'JOURNEY_ERROR',
  journeyAborted: 'JOURNEY_ABORTED',
} as const;

/** A step failed (already recorded); the rest of that part of the journey is skipped. */
export class StepFailed extends Error {}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Untimed navigation back to a page with the menu. */
const RECOVERY_NAV_TIMEOUT_MS = 15000;

function shortResult(m: Measurement): string {
  if (m.status === 'skipped' && m.skipReason === 'nr-error') {
    return `skipped - screen not ready for testing (${m.error}); not opened again`;
  }
  if (m.status === 'skipped') return 'n/a for this role';
  if (m.status === 'error') return `FAILED: ${m.error}`;
  const server = m.serverMs == null ? '' : ` (server ${m.serverMs} ms)`;
  return `${m.durationMs} ms${server}${m.warmup ? ' [warm-up]' : ''}`;
}

function resultTitle(m: Measurement): string {
  if (m.status === 'skipped' && m.skipReason === 'nr-error') {
    return `Then NetReveal shows an error instead of the screen - skipped (${m.error})`;
  }
  if (m.status === 'skipped') return `Then the screen is not available for "${m.user}" - skipped (${m.error})`;
  if (m.status === 'error') return `Then the screen is ready for use - FAILED: ${m.error}`;
  const server = m.serverMs == null ? '' : `, server ${m.serverMs} ms`;
  const rows = m.rows == null ? '' : `, ${m.rows} rows`;
  return `Then the screen is ready for use - ${m.durationMs} ms${server}${rows}`;
}

/**
 * Representative NetReveal user journey, read-only apart from the alert lock that
 * opening an alert takes (released by leaving through Back):
 *
 *   login → [menu screens…] → All Alerts → (switch view) → Search → open alert → Back
 *
 * Every action is a Gherkin-style step (NAT wording) timed from the user's click to
 * "screen ready for use"; its result is a nested `Then …` step with the measured time.
 */
export const netRevealJourney: Journey = async ({ page, cfg, virtualUser, user, timer, step, reportMenu, singlePass = false }) => {
  const auth = new NetRevealAuthCapability(page);
  const home = new HomePage(page);
  const screen = new NetRevealScreen(page);
  const menu = new MainMenuPage(page);
  const alerts = new AllAlertsPage(page);
  const details = new AlertDetailsPage(page);
  const timeoutMs = cfg.readyTimeoutMs;
  const who = `[VU ${String(virtualUser).padStart(String(cfg.virtualUsers).length, '0')} ${user}]`;

  let lastMeasurement: Measurement | undefined;
  const check = (m: Measurement): Measurement => {
    lastMeasurement = m;
    if (m.status !== 'ok') throw new StepFailed(`${m.screen}: ${m.error}`);
    return m;
  };

  // Office-like pauses: random between thinkTimeMs and thinkTimeMaxMs when a maximum is set.
  const think = () =>
    sleep(cfg.thinkTimeMaxMs > cfg.thinkTimeMs ? cfg.thinkTimeMs + Math.random() * (cfg.thinkTimeMaxMs - cfg.thinkTimeMs) : cfg.thinkTimeMs);

  /** One console line per Gherkin step (perf.printSteps); the HTML report has the full step tree. */
  // eslint-disable-next-line no-console
  const say = (line: string) => cfg.printSteps && console.log(`${who} ${line}`);

  const recordFailure = (options: MeasureOptions, err: unknown) =>
    timer.measure(
      options,
      async () => {
        throw err;
      },
      async () => ({ readyAt: Date.now(), rows: null }),
    );

  /**
   * One timed Gherkin step. `prepare` (untimed) gets the page ready for the click — e.g. hover
   * through the menu; `action` is the click itself; `ready` ends the measurement.
   */
  const timed = async (
    gherkin: string,
    options: MeasureOptions,
    action: () => Promise<void>,
    ready: (network: NetworkActivity) => Promise<ReadyResult>,
    prepare?: () => Promise<void>,
  ): Promise<Measurement> => {
    let measurement: Measurement | undefined;
    await step(gherkin, async () => {
      try {
        if (prepare) await prepare();
      } catch (err) {
        measurement =
          err instanceof MenuItemNotFoundError && cfg.skipUnavailableScreens
            ? timer.skip(options, err.message)
            : await recordFailure(options, err);
      }
      if (!measurement) measurement = await timer.measure(options, action, ready);
      const result = measurement;
      say(`${gherkin}  =>  ${shortResult(result)}`);
      await step(resultTitle(result), async () => {
        if (result.status === 'error') throw new Error(result.error);
      }).catch(() => undefined);
    });
    return check(measurement as Measurement);
  };

  /**
   * Get back to a page with the main menu (after a failed step, or after a screen that is a separate app
   * without the NR menu, e.g. Scenario Manager smc.do), without timing anything:
   * stay where we are if the menu is there, else Back, else log in again.
   */
  const recover = async () => {
    try {
      // A workflow wizard swallows menu clicks until Cancel is pressed.
      if (await screen.leaveWizard(timeoutMs)) say('    left the workflow wizard via Cancel');
      if (await menu.isAvailable()) {
        await menu.collapse();
        return;
      }
      // Bounded: a page that blocks leaving (e.g. smc.do) must not hang the run.
      await page.goBack({ waitUntil: 'domcontentloaded', timeout: RECOVERY_NAV_TIMEOUT_MS }).catch(() => undefined);
      if (await menu.isAvailable()) return;
      await page.goto(resolveBaseUrl(), { waitUntil: 'domcontentloaded', timeout: RECOVERY_NAV_TIMEOUT_MS });
      if (await page.locator(auth.loginPage.usernameSelector).isVisible()) {
        await auth.loginAs(user);
        await page.locator(home.homeHeaderSelector).waitFor({ state: 'visible', timeout: timeoutMs });
      }
    } catch {
      // Next step will fail and be recorded; nothing more to do here.
    }
  };

  const openAllAlerts = (menuPath: string, iteration: number, warmup: boolean) => {
    let click: () => Promise<void> = async () => undefined;
    const item = allAlertsItem;
    return timed(
      `When I open menu item: "${menuPath}"`,
      { screen: SCREEN.menu(menuPath), iteration, warmup },
      () => click(),
      (network) =>
        screen.waitUntilReady({
          network,
          target: alerts.screenMarker,
          newDocument: true,
          expectScreen: 'All Alerts',
          timeoutMs,
        }),
      async () => {
        await recover();
        click = await menu.prepareLeafClick(await (item ? menu.revealScreen(item) : menu.revealLeaf(menuPath)));
        await screen.markStale();
      },
    );
  };

  const openMenuScreen = (
    menuPath: string,
    iteration: number,
    warmup: boolean,
    target: Locator = screen.screenTitle,
    reveal: () => Promise<Locator> = () => menu.revealLeaf(menuPath),
  ) => {
    // Hover through the menu and pick native vs DOM click untimed; only the click itself is timed.
    let click: () => Promise<void> = async () => undefined;
    return timed(
      `When I open menu item: "${menuPath}"`,
      { screen: SCREEN.menu(menuPath), iteration, warmup },
      () => click(),
      // Opening the screen you are on is legitimate (Home right after login, a role's start screen),
      // so no "stayed on" check here; wizards that hold the session are left via Cancel in recover().
      (network) => screen.waitUntilReady({ network, target, newDocument: true, timeoutMs }),
      async () => {
        await recover();
        click = await menu.prepareLeafClick(await reveal());
        await screen.markStale();
      },
    );
  };

  /** All Alerts as found in this user's menu (by li id); null = reveal by its label path. */
  let allAlertsItem: MenuScreen | null = null;

  const allAlertsFlow = async (iteration: number, warmup: boolean) => {
    const { menuPath, view, search, openAlertDetails, criteria } = cfg.allAlerts;
    // Ready = an element only All Alerts has (the Search button may be collapsed with the previous
    // results); landing on any other screen fails at once, naming it.
    await openAllAlerts(menuPath, iteration, warmup);
    await think();

    if (view && !(await alerts.isViewActive(view))) {
      await timed(
        `And I change the result view to "${view}" on All Alerts Page`,
        { screen: SCREEN.allAlertsView(view), iteration, warmup },
        () => alerts.chooseView(view),
        (network) => screen.waitUntilReady({ network, target: screen.screenTitle, predicate: () => alerts.isViewActive(view), timeoutMs }),
        async () => {
          await alerts.openViewSwitcher();
          await screen.markStale(alerts.resultsTable);
        },
      );
      await think();
    }

    if (!search) return;
    // NAT: And I am providing and submitting a search criteria in WLM view on All Alerts: | field | value |
    // Filling the form is untimed; the measurement is Search click → result list redrawn.
    const searchTitle = criteria.length
      ? 'And I am providing and submitting a search criteria in WLM view on All Alerts'
      : 'And I click Search on All Alerts Page';
    const result = await timed(
      searchTitle,
      { screen: SCREEN.allAlertsSearch, iteration, warmup },
      () => alerts.clickSearch(),
      (network) => screen.waitUntilReady({ network, target: alerts.resultsTable, redrawnTable: alerts.resultsTable, timeoutMs }),
      async () => {
        await alerts.ensureSearchVisible();
        if (criteria.length) {
          criteria.forEach(([field, value]) => say(`    | ${field} | ${value} |`));
          await alerts.fillWlmSearchCriteria(criteria);
        }
        await screen.markStale(alerts.resultsTable);
      },
    );
    await think();

    if (!openAlertDetails) return;
    // NAT: And I select the first not locked Wlm Alert on the All Alerts Page — rows with a lock icon
    // are skipped; only the repeated baseline retries a lock race (NR error CFG-80017).
    const maxLockAttempts = singlePass ? 1 : 10;
    let opened = false;
    // Each virtual user starts at its own unlocked row so users do not fight over the same alert.
    for (let tryNo = 0; tryNo < maxLockAttempts && !opened; tryNo += 1) {
      const alertCount = await alerts.alertCount();
      if (!result.rows || alertCount === 0) {
        if (singlePass) throw new Error('Search returned no unlocked alert to open');
        say(`And I select the first not locked Wlm Alert on the All Alerts Page  =>  no (more) unlocked alerts for these criteria`);
        return;
      }
      const row = (virtualUser - 1 + tryNo) % alertCount;
      try {
        await timed(
          'And I select the first not locked Wlm Alert on the All Alerts Page',
          { screen: SCREEN.alertDetailsOpen, iteration, warmup },
          () => alerts.openAlert(row),
          (network) => screen.waitUntilReady({ network, target: details.keyActions, newDocument: true, timeoutMs }),
          () => screen.markStale(),
        );
        opened = true;
      } catch (err) {
        if (singlePass) throw err;
        if (!(err instanceof StepFailed) || !/CFG-80017/.test(err.message)) throw err;
        // Locked by another user: back to the list (untimed) and take the next unlocked row.
        say(`    alert locked by another user - trying the next unlocked alert (${tryNo + 1}/${maxLockAttempts})`);
        await page.goBack({ waitUntil: 'domcontentloaded', timeout: RECOVERY_NAV_TIMEOUT_MS }).catch(() => undefined);
        await screen
          .waitUntilReady({ target: alerts.resultsTable, timeoutMs })
          .catch(() => undefined);
        if (!(await alerts.resultsTable.isVisible())) return;
      }
    }
    if (!opened) return;
    await think();

    await timed(
      'And I click Back on Alert Details Page',
      { screen: SCREEN.alertDetailsBack, iteration, warmup },
      () => details.clickBack(),
      (network) => screen.waitUntilReady({ network, target: screen.screenTitle, newDocument: true, timeoutMs }),
      () => screen.markStale(),
    );
  };

  /** Run one independent part of the journey; on failure record it, recover and carry on. */
  const attempt = async (part: () => Promise<unknown>, iteration: number, warmup: boolean) => {
    try {
      await part();
    } catch (err) {
      if (!(err instanceof StepFailed)) {
        // Untimed helper failed outside a timed step — record it so it counts as an error.
        await recordFailure({ screen: SCREEN.journeyError, iteration, warmup }, err);
      }
      await recover();
    }
  };

  say(`Scenario: virtual user ${virtualUser} of ${cfg.virtualUsers} as "${user}"`);
  await step('Given I open NetReveal Environment', async () => {
    say('Given I open NetReveal Environment');
    await page.goto(resolveBaseUrl(), { waitUntil: 'domcontentloaded' });
    await auth.openEnvironment();
  });

  // Each virtual user is its own NR session; LOGIN is a timed screen.
  await timed(
    `When I log into NetReveal as "${user}"`,
    { screen: SCREEN.login, iteration: 0, warmup: false },
    () => auth.loginAs(user),
    (network) => screen.waitUntilReady({ network, target: page.locator(home.homeHeaderSelector), newDocument: true, timeoutMs }),
    () => screen.markStale(),
  );

  // perf.screens=auto: the screens this user's own menu offers, read once after login.
  let discovered: MenuScreen[] = [];
  if (cfg.screensAuto) {
    const selection = await step(`And I read the main menu available to "${user}"`, async () => {
      const all = await menu.discoverScreens();
      const wanted = cfg.allAlerts.menuPath.split('->').map((p) => p.trim().toLowerCase()).join('->');
      allAlertsItem = all.find((s) => s.labels.map((l) => l.toLowerCase()).join('->') === wanted) ?? null;
      return selectScreens(all, {
        include: cfg.menu.include,
        exclude: cfg.menu.exclude,
        handledElsewhere: cfg.allAlerts.search || cfg.allAlerts.openAlertDetails ? [cfg.allAlerts.menuPath] : [],
      });
    });
    discovered = selection.open;
    reportMenu?.(user, selection);
    say(
      `And I read the main menu available to "${user}"  =>  ${selection.open.length} screens to open, ` +
        `${selection.excluded.length} left out`,
    );
    selection.excluded.forEach((e) => say(`    left out: "${e.path}" (${e.reason})`));
  }
  /** Screens NR answered with an error page (e.g. CFG-10011): not opened again by this user. */
  const notReady = new Set<string>();
  const menuScreens: { path: string; reveal?: () => Promise<Locator> }[] = cfg.screensAuto
    ? discovered.map((s) => ({ path: s.path, reveal: () => menu.revealScreen(s) }))
    : cfg.screens.map((path) => ({ path }));

  try {
    if (singlePass) {
      const actions: (() => Promise<unknown>)[] = menuScreens.map((item) => () =>
        openMenuScreen(item.path, 0, false, screen.screenTitle, item.reveal),
      );
      actions.push(() => allAlertsFlow(0, false));
      for (let i = actions.length - 1; i > 0; i -= 1) {
        const j = Math.floor(Math.random() * (i + 1));
        [actions[i], actions[j]] = [actions[j], actions[i]];
      }
      await step('Single pass: every menu screen and one All Alerts flow, in random order', async () => {
        for (const action of actions) {
          await think();
          await attempt(action, 0, false);
        }
      });
      return;
    }
    const total = cfg.warmupIterations + cfg.iterations;
    for (let iteration = 0; iteration < total; iteration += 1) {
      const warmup = iteration < cfg.warmupIterations;
      const label = `Iteration ${iteration + 1}/${total}${warmup ? ' (warm-up, not in statistics)' : ''}`;
      say(`# ${label}`);
      await step(label, async () => {
        // A real user opens a few screens in an order of their own, not every screen in menu order.
        const candidates = menuScreens.filter((item) => !notReady.has(item.path));
        const shuffled = cfg.screensPerIteration > 0 ? candidates.sort(() => Math.random() - 0.5) : candidates;
        const todo = cfg.screensPerIteration > 0 ? shuffled.slice(0, cfg.screensPerIteration) : shuffled;
        for (const item of todo) {
          await think();
          await attempt(
            async () => {
              try {
                await openMenuScreen(item.path, iteration, warmup, screen.screenTitle, item.reveal);
              } catch (err) {
                if (lastMeasurement?.skipReason === 'nr-error') notReady.add(item.path);
                throw err;
              }
            },
            iteration,
            warmup,
          );
        }
        if (cfg.allAlerts.search || cfg.allAlerts.openAlertDetails) {
          await think();
          await attempt(() => allAlertsFlow(iteration, warmup), iteration, warmup);
        }
      });
    }
  } finally {
    say('Then I am logging out');
    await step('Then I am logging out', () => auth.logout()).catch(() => undefined);
  }
};
