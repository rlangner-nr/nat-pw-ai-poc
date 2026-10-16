import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import type { Browser, Page, Locator } from '@playwright/test';
import { NetRevealAuthCapability } from '../../src/capabilities/netRevealAuthCapability';
import { AllAlertsPage } from '../../src/ui/pages/AllAlertsPage';
import { AlertDetailsPage } from '../../src/ui/pages/AlertDetailsPage';
import { MainMenuPage, MenuItemNotFoundError, type MenuScreen } from '../../src/ui/pages/MainMenuPage';
import { NetRevealScreen, NetRevealScreenError } from '../../src/ui/pages/NetRevealScreen';
import { netRevealJourney, runWithoutSteps, SCREEN } from '../../src/perf/netRevealJourney';
import { loadPerfConfig } from '../../src/perf/perfConfig';
import { PerfRecorder } from '../../src/perf/perfRecorder';
import { ScreenTimer } from '../../src/perf/screenTimer';
import { runVirtualUsers } from '../../src/perf/virtualUsers';
import { missingCatalogueScreens } from '../../src/perf/catalogueValidation';

const paths = ['My Work->Home', 'My Work->Inbox', 'Group Work->Worklist'];

function mockJourney(t: TestContext, options: { locked?: boolean; empty?: boolean; random?: number; noAllAlerts?: boolean } = {}) {
  const events: string[] = [];
  const locator: Locator = new Proxy({} as Locator, {
    get: (_target, property) => property === 'then' ? undefined : () => locator,
  });
  const page = {
    locator: () => locator,
    goto: async () => { events.push('environment'); },
    on: () => page,
    off: () => page,
    url: () => 'https://example.invalid/netreveal/',
    goBack: async () => { events.push('retry-back'); },
  } as unknown as Page;
  const screens: MenuScreen[] = [...paths, 'Group Work->All Alerts', 'Services->Reload Configuration'].map((path, i) => ({
    path,
    labels: path.split('->'),
    liId: `screen-${i}`,
    ancestorIds: [],
    href: `/screen-${i}`,
    target: '',
  }));
  t.mock.method(Math, 'random', () => options.random ?? 0);
  t.mock.method(NetRevealAuthCapability.prototype, 'openEnvironment', async () => undefined);
  t.mock.method(NetRevealAuthCapability.prototype, 'loginAs', async () => { events.push('login'); });
  t.mock.method(NetRevealAuthCapability.prototype, 'logout', async () => { events.push('logout'); });
  t.mock.method(MainMenuPage.prototype, 'discoverScreens', async () =>
    screens.filter((s) => !options.noAllAlerts || s.path !== 'Group Work->All Alerts'));
  t.mock.method(MainMenuPage.prototype, 'revealLeaf', async (path: string) => {
    throw new MenuItemNotFoundError(`Menu item not found (path "${path}")`);
  });
  t.mock.method(MainMenuPage.prototype, 'isAvailable', async () => true);
  t.mock.method(MainMenuPage.prototype, 'collapse', async () => undefined);
  t.mock.method(MainMenuPage.prototype, 'revealScreen', async (screen: MenuScreen) => {
    events.push(`reveal:${screen.path}`);
    return locator;
  });
  t.mock.method(MainMenuPage.prototype, 'prepareLeafClick', async () => async () => undefined);
  t.mock.method(NetRevealScreen.prototype, 'markStale', async () => undefined);
  t.mock.method(NetRevealScreen.prototype, 'leaveWizard', async () => false);
  t.mock.method(NetRevealScreen.prototype, 'waitUntilReady', async () => ({
    readyAt: Date.now(),
    rows: options.empty ? 0 : 20,
  }));
  t.mock.method(AllAlertsPage.prototype, 'ensureSearchVisible', async () => undefined);
  t.mock.method(AllAlertsPage.prototype, 'fillWlmSearchCriteria', async () => { events.push('criteria'); });
  t.mock.method(AllAlertsPage.prototype, 'clickSearch', async () => { events.push('search'); });
  t.mock.method(AllAlertsPage.prototype, 'alertCount', async () => options.empty ? 0 : 20);
  t.mock.method(AllAlertsPage.prototype, 'openAlert', async () => {
    events.push('open-alert');
    if (options.locked) throw new NetRevealScreenError('CFG-80017 - Alert locked');
  });
  t.mock.method(AlertDetailsPage.prototype, 'clickBack', async () => { events.push('back'); });

  const cfg = {
    ...loadPerfConfig(),
    virtualUsers: 1,
    screensAuto: true,
    skipUnavailableScreens: true,
    iterations: 10,
    warmupIterations: 3,
    screensPerIteration: 1,
    thinkTimeMs: 0,
    thinkTimeMaxMs: 0,
    printSteps: false,
    menu: { include: null, exclude: null },
    allAlerts: {
      menuPath: 'Group Work->All Alerts',
      view: '',
      criteria: [] as [string, string][],
      search: true,
      openAlertDetails: true,
    },
    ready: { networkQuietMs: 0, maxRequestWaitMs: 0, ignoreRequests: null },
  };
  const recorder = new PerfRecorder();
  const timer = new ScreenTimer(
    page,
    { user: 'catalogue-user', virtualUser: 1, release: 'unit' },
    recorder.add,
    undefined,
    { quietMs: 0, maxRequestWaitMs: 0, ignore: null },
  );
  return {
    events,
    recorder,
    run: (singlePass = true) => netRevealJourney({
      page, cfg, user: 'catalogue-user', virtualUser: 1, timer, step: runWithoutSteps, singlePass,
    }),
    cfg,
  };
}

test('catalogue visits all eligible menu screens and the alert flow once, without warmup or sampling', async (t) => {
  const { run, recorder, events } = mockJourney(t);
  await run();
  const measurements = recorder.all();
  for (const screen of [
    SCREEN.login, ...paths.map(SCREEN.menu), SCREEN.menu('Group Work->All Alerts'),
    SCREEN.allAlertsSearch, SCREEN.alertDetailsOpen, SCREEN.alertDetailsBack,
  ]) {
    assert.equal(measurements.filter((m) => m.screen === screen && m.status === 'ok').length, 1, screen);
  }
  assert.equal(measurements.length, 8);
  assert.deepEqual(missingCatalogueScreens(measurements, ['catalogue-user'], 'Group Work->All Alerts'), []);
  assert.ok(measurements.every((m) => !m.warmup && m.iteration === 0));
  assert.equal(events.filter((e) => e === 'logout').length, 1);
  assert.ok(!events.some((e) => e.includes('Reload Configuration')));
  const reveals = events.filter((e) => e.startsWith('reveal:'));
  assert.equal(reveals.indexOf('reveal:Group Work->All Alerts'), 2);
  assert.notDeepEqual(reveals.slice(0, 2), paths.slice(0, 2).map((path) => `reveal:${path}`));
});

test('another random draw puts All Alerts at a different position', async (t) => {
  const { run, events } = mockJourney(t, { random: 0.999 });
  await run();
  assert.deepEqual(events.filter((e) => e.startsWith('reveal:')), [
    ...paths, 'Group Work->All Alerts',
  ].map((path) => `reveal:${path}`));
});

test('catalogue sets Created Between from 01/01/2020 before Search, overriding a configured start date', async (t) => {
  const { run, cfg, events } = mockJourney(t);
  const filled: [string, string][][] = [];
  t.mock.method(AllAlertsPage.prototype, 'fillWlmSearchCriteria', async (criteria: [string, string][]) => {
    filled.push(criteria);
    events.push('criteria');
  });
  await run();
  assert.deepEqual(filled, [[['Date From', '01/01/2020']]]);
  assert.ok(events.indexOf('criteria') < events.indexOf('search'));

  cfg.allAlerts.criteria = [['Date From', '14/09/2026'], ['Status', 'New']];
  await run();
  assert.deepEqual(filled[1], [['Status', 'New'], ['Date From', '01/01/2020']]);
  assert.deepEqual(cfg.allAlerts.criteria, [['Date From', '14/09/2026'], ['Status', 'New']]);
});

test('a lock race never retries Search, alert open or Back in the catalogue', async (t) => {
  const { run, recorder, events } = mockJourney(t, { locked: true });
  await run();
  assert.equal(events.filter((e) => e === 'search').length, 1);
  assert.equal(events.filter((e) => e === 'open-alert').length, 1);
  assert.ok(!events.includes('retry-back'));
  assert.ok(!events.includes('back'));
  assert.ok(!recorder.all().some((m) => m.screen === SCREEN.alertDetailsOpen && m.status === 'ok'));
  assert.equal(recorder.all().filter((m) => m.screen.startsWith('MENU ')).length, 4);
  assert.equal(events.at(-1), 'logout');
});

test('empty results record an explicit failure, not a successful alert visit', async (t) => {
  const { run, recorder, events } = mockJourney(t, { empty: true });
  await run();
  assert.ok(recorder.errors().some((m) => m.screen === SCREEN.journeyError && /no unlocked alert/.test(m.error)));
  assert.ok(!events.includes('open-alert'));
  assert.deepEqual(missingCatalogueScreens(recorder.all(), ['catalogue-user'], 'Group Work->All Alerts'), [
    'catalogue-user: ALERT_DETAILS_OPEN',
  ]);
  assert.equal(events.at(-1), 'logout');
});

test('a role without All Alerts still visits its menu and satisfies role-aware validation', async (t) => {
  const { run, recorder, events } = mockJourney(t, { noAllAlerts: true });
  await run();
  assert.ok(recorder.skipped().some((m) =>
    m.screen === SCREEN.menu('Group Work->All Alerts') && m.skipReason === 'role'));
  for (const screen of [SCREEN.login, ...paths.map(SCREEN.menu)]) {
    assert.ok(recorder.all().some((m) => m.screen === screen && m.status === 'ok'), screen);
  }
  assert.ok(!events.includes('search'));
  assert.ok(!events.includes('open-alert'));
  assert.deepEqual(missingCatalogueScreens(recorder.all(), ['catalogue-user'], 'Group Work->All Alerts'), []);
  assert.equal(events.at(-1), 'logout');
});

test('only an explicit role skip exempts All Alerts actions, never login or another user', async (t) => {
  const { run, recorder } = mockJourney(t, { noAllAlerts: true });
  await run();
  const measurements = recorder.all();
  const menuPath = 'Group Work->All Alerts';
  const skip = measurements.find((m) => m.screen === SCREEN.menu(menuPath))!;
  const requiredAlerts = ['catalogue-user: ALL_ALERTS_SEARCH', 'catalogue-user: ALERT_DETAILS_OPEN'];
  for (const replacement of [
    [],
    [{ ...skip, skipReason: 'nr-error' as const }],
    [{ ...skip, status: 'error' as const }],
    [{ ...skip, status: 'ok' as const }],
    [skip, { ...skip, status: 'error' as const }],
    [{ ...skip, screen: SCREEN.menu('My Work->Inbox') }],
  ]) {
    assert.deepEqual(missingCatalogueScreens([
      ...measurements.filter((m) => m !== skip), ...replacement,
    ], ['catalogue-user'], menuPath), requiredAlerts);
  }
  assert.deepEqual(missingCatalogueScreens(
    measurements.filter((m) => m.screen !== SCREEN.login), ['catalogue-user'], menuPath,
  ), ['catalogue-user: LOGIN']);
  assert.deepEqual(missingCatalogueScreens(measurements, ['other-user'], menuPath), [
    'other-user: LOGIN', 'other-user: ALL_ALERTS_SEARCH', 'other-user: ALERT_DETAILS_OPEN',
  ]);
});

test('missing All Alerts access remains a failure when role skipping is disabled', async (t) => {
  const { run, recorder, cfg } = mockJourney(t, { noAllAlerts: true });
  cfg.skipUnavailableScreens = false;
  await run();
  assert.ok(recorder.errors().some((m) => m.screen === SCREEN.menu(cfg.allAlerts.menuPath)));
  assert.deepEqual(missingCatalogueScreens(recorder.all(), ['catalogue-user'], cfg.allAlerts.menuPath), [
    'catalogue-user: ALL_ALERTS_SEARCH', 'catalogue-user: ALERT_DETAILS_OPEN',
  ]);
});

test('the baseline still respects its iterations and warmup settings', async (t) => {
  const { run, recorder, cfg } = mockJourney(t);
  cfg.iterations = 2;
  cfg.warmupIterations = 1;
  cfg.screensPerIteration = 0;
  await run(false);
  for (const screen of [...paths.map(SCREEN.menu), SCREEN.allAlertsSearch, SCREEN.alertDetailsOpen]) {
    const measurements = recorder.all().filter((m) => m.screen === screen);
    assert.equal(measurements.length, 3, screen);
    assert.equal(measurements.filter((m) => m.warmup).length, 1, screen);
  }
});

for (const [count, shards] of [[5, 3], [100, 10]]) {
test(`${count} logins on ${shards} shards run once each and propagate single-pass mode`, async (t) => {
  t.mock.method(console, 'log', () => undefined);
  const users = Array.from({ length: count }, (_, i) => `role-${String(i + 1).padStart(3, '0')}`);
  const visits: string[] = [];
  let closed = 0;
  const page = { on: () => page } as unknown as Page;
  const browser = {
    newContext: async () => ({
      setDefaultTimeout: () => undefined,
      setDefaultNavigationTimeout: () => undefined,
      newPage: async () => page,
      close: async () => { closed += 1; },
    }),
  } as unknown as Browser;
  for (let index = 1; index <= shards; index += 1) {
    const expected = users.filter((_, i) => i % shards === index - 1);
    const shardVisits: string[] = [];
    await runVirtualUsers(browser, {
      ...loadPerfConfig(),
      users,
      virtualUsers: users.length,
      shard: { index, total: shards },
      arrivalWindowMs: 0,
      rampUpMs: 0,
      coordinator: '',
      startAt: null,
    }, new PerfRecorder(), async (ctx) => {
      assert.equal(ctx.singlePass, true);
      shardVisits.push(ctx.user);
      visits.push(ctx.user);
    }, { singlePass: true });
    assert.deepEqual(shardVisits.sort(), expected.sort());
  }
  assert.deepEqual(visits.sort(), users);
  assert.equal(closed, users.length);
});
}
