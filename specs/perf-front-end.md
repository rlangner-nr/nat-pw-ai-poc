# Plan — NetReveal front-end performance

Source: SSSMP1VUIO-3176 "Front End Performance Test – R2.06.1" (parent SSSMP1VUIO-3164) and
SSSMP1VUIO-2969 (All Alerts slowness). Seed: `tests/seed.spec.ts`. Project: `perf`.

## Measurement model

- **Screen time** = user initiates an action (click) → the resulting screen is ready for use:
  1. the old document or rows are gone (stale marker set just before the click),
  2. the screen's key element is visible,
  3. no NR busy indicator is visible (DataTables `Processing...`, `div.processing`, `#load`).
- Hover-menu navigation, typing and think time are **not** timed.
- Each measurement also records the slowest document/XHR time-to-first-byte in the window
  (`serverMs`, `slowestRequest`). That points a slow screen to the request, and from there to the DB query.
- In the baseline, leading `perf.warmupIterations` are recorded but excluded from statistics.
  The concurrent catalogue has no warm-up or repeated iterations. Reported: p50/p90/p95/max per screen.
- Concurrent catalogue = one isolated headless browser context per distinct `perf.users` login in **one** browser process,
  each logged in to its own NR session. It needs no extra browsers and no Selenium Grid sessions.
  One machine carries roughly free RAM ÷ `perf.load.memoryPerUserMb` users; for more (e.g. 100), run
  the load spec on several machines at the same time and combine the results with `npm run perf:merge`.
- Every action is a Gherkin-style step in NAT wording (`When I open menu item: "…"`). It is logged as one
  console line per virtual user (`perf.printSteps`) and shown as a step tree in the HTML report, with a nested
  `Then the screen is ready for use — <ms>` result.
- Screens a role cannot see (menu item absent) are recorded as **n/a**, not errors, in the load run
  (`perf.skipUnavailableScreens`). The baseline user (`perf.baselineUser`) must see every screen.

## Which screens (`perf.screens`)

- `auto` (SNB default): after login each virtual user reads its own menu from `nav#mainMenu`
  (the full tree is in the DOM right after login) and opens **every** screen in it, by clicking through
  the menu (links carry a per-session `secure=` token, so URLs are never replayed). Each role therefore
  opens its own set; `menus.json` lists per login what was opened and what was left out, and why.
- Never opened, whatever the config: labels/links with Reload, ReCalculate or Get Next (global actions such as
  Services Manager → Reload Configuration, or alert assignment), links without `href`, links to a new window.
  `perf.menu.exclude` (default `Import|Export|Merge`) and `perf.menu.include` narrow the set further.
- A list of `A->B->C` paths opens exactly those screens instead.
- Screens that are a separate app without the NR menu (Scenario Manager `smc.do`) are timed too; the next
  step first goes Back (untimed) to a page with the menu.

## Screen catalogue (ids used in reports, thresholds, baselines)

| Id | Action → ready |
|---|---|
| `LOGIN` | Submit login → Home header |
| `MENU <A > B>` | Click menu leaf (`perf.screens`) → new screen `h1` / `#content` / `#screenId` |
| `MENU Group Work > All Alerts` | Click menu leaf → Search button |
| `ALL_ALERTS_VIEW <view>` | Choose result view (`perf.allAlerts.view`) → view label switched |
| `ALL_ALERTS_SEARCH` | Click Search → result table redrawn |
| `ALERT_DETAILS_OPEN` | Click an unlocked alert id (starting row distributed by virtual user) → Key Actions |
| `ALERT_DETAILS_BACK` | Click Back → All Alerts |
| `DB <file>` | JDBC execute → first `perf.db.maxRows` rows |

## §1 Screen response-time baseline (`tests/perf/screen-timings.spec.ts`, `@perf-screens`)

**Scenario: key screens are timed from user action to ready for a single user**
1. `perf.baselineUser` logs in (timed `LOGIN`).
2. For `warmup + iterations` loops: open every `perf.screens` menu screen, then run the All Alerts flow
   (open → optional view switch → Search → open alert → Back).
3. Log out.

Expect: every screen becomes ready within `perf.readyTimeoutMs` (no errors). A p90 above `perf.thresholds`
is an annotation, or a failure when `perf.enforceThresholds=true`.

## §2 Concurrent NAT workload (`tests/perf/concurrent-workload.spec.ts`, `@perf-load`)

**Scenario: virtual users run the NetReveal journey concurrently**
1. With `perf.db.captureTopSql=true`, snapshot `v$sql`.
2. Start exactly one virtual user per distinct `perf.users` login, split disjointly across shards.
   Keep `perf.rampUpMs`, random `perf.arrivalWindowMs` and `perf.thinkTimeMs`/`perf.thinkTimeMaxMs` pauses.
   Each user discovers its own menu and visits every eligible screen once. Independently shuffle the
   screens and the position of one All Alerts flow (open → optional view switch → Search → open alert → Back),
   rather than making every user search after the same menu sequence.
   Global actions and configured menu exclusions remain excluded; All Alerts is visited only by its flow.
   Before Search, always set Created Between (Date From) to `01/01/2020`, overriding the application's
   default or a configured Date From. Other criteria still come from `perf.allAlerts.criteria`;
   when it is empty, only this start date is filled (no Alert ID wildcard).
   `perf.virtualUsers`, `perf.iterations`, `perf.warmupIterations`, `perf.screens` and
   `perf.screensPerIteration` do not limit or repeat this catalogue run.
   More than `perf.load.maxUsersElsewhere` users run only where
   `application.environment` is in `perf.load.allowedEnvironments` (PERF); elsewhere the test is skipped.
3. Record the run window (`window.json`) for the custom DB report (StatsPack is unavailable on AWS PERF).
4. Snapshot `v$sql` again and report the top `perf.db.topSqlLimit` statements by elapsed time (`top-sql.csv`).

Expect: error rate ≤ `perf.maxErrorRatePct`; thresholds as in §1. Additionally, every login assigned
to this shard must have a successful LOGIN, ALL_ALERTS_SEARCH and ALERT_DETAILS_OPEN. Empty results,
no unlocked alert or an alert lock race do not satisfy the requirement. There is only one alert-open
attempt: no Back/search retry cycle for locked alerts. Back after a successful open releases the lock.
Roles without All Alerts access fail this requirement and need suitable permissions/test data.
The `perf` project disables automatic test retries, including in CI.

Offline regression checks (no browser or customer environment):
`npx tsx --test tests/unit/perf-catalogue.test.ts`.

## §3 Screen SQL execution time (`tests/perf/db-query-timings.spec.ts`, `@perf-db`)

**Scenario: query `<file>` returns its first page within perf.db.maxQueryMs**
For every file in `perf.db.timedQueries`: run `perf.db.queryIterations` times (first = warm-up), fetching
`perf.db.maxRows` rows. Expect the fastest run ≤ `perf.db.maxQueryMs`.
SNB: `projects/snb/sql/wlm-alerts-list-top120.sql` (SSSMP1VUIO-2969, target < 1 s).

## Comparison between releases

`reports/perf/<runId>/summary.json` per run. `perf.baselineFile` or `npm run perf:compare` compares p90 per
screen and flags a change above `perf.regressionThresholdPct` as REGRESSION or IMPROVED.

## Out of scope / follow-ups

- Workflow (write) journeys, e.g. New → Release from NAT SSSMP1VUIO-2820. They consume `New` alerts and need a
  dedicated data pool.
- Role-specific journeys (supervisor vs investigator screens).
- Pushing `summary.json` to the Performance dashboard (format to be agreed).
- Higher load (hundreds of users) — protocol-level tool (Future Considerations in the ticket).
