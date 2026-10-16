import { test, expect } from '../fixtures';
import { diffSqlStats } from '../../src/capabilities/oracleDb';
import { netRevealJourney } from '../../src/perf/netRevealJourney';
import { missingCatalogueScreens } from '../../src/perf/catalogueValidation';
import { runVirtualUsers } from '../../src/perf/virtualUsers';
import { assertPerfRun, gherkinSteps, prepareLoadRun } from './perfAssertions';

/**
 * @plan specs/perf-front-end.md §2
 * @seed tests/seed.spec.ts
 *
 * One virtual user per distinct login in perf.users, each visiting its menu once in random order.
 * Each context logs in on its own (separate NR session) — the documented exception to storageState reuse. Runs above
 * perf.load.maxUsersElsewhere users only on perf.load.allowedEnvironments (PERF).
 */
test.describe('Concurrent NAT workload', () => {
  test(
    'virtual users run the NetReveal journey concurrently',
    { tag: ['@perf', '@perf-load', '@SSSMP1VUIO-3176'] },
    async ({ browser, perfConfig, perfRecorder, oracleDb }) => {
      test.setTimeout(perfConfig.testTimeoutMs);
      const users = [...new Set(perfConfig.users)];
      const workload = {
        ...perfConfig,
        users,
        virtualUsers: users.length,
        screensAuto: true,
        allAlerts: { ...perfConfig.allAlerts, search: true, openAlertDetails: true },
      };
      prepareLoadRun(workload);
      const captureTopSql = workload.db.captureTopSql;
      test.skip(
        captureTopSql && !oracleDb.isConfigured(),
        'perf.db.captureTopSql=true needs DbConnectionString / DbUsername / DbPassword',
      );

      const before = captureTopSql ? await oracleDb.snapshotSqlStats() : [];
      const startedAt = new Date().toISOString();

      await runVirtualUsers(browser, workload, perfRecorder, netRevealJourney, {
        step: gherkinSteps,
        singlePass: true,
      });

      // Exact run window, so the custom DB report can be generated for the same period.
      perfRecorder.setWindow({
        release: perfConfig.release,
        startedAt,
        endedAt: new Date().toISOString(),
        virtualUsers: workload.virtualUsers,
        users,
      });
      if (captureTopSql) {
        const after = await oracleDb.snapshotSqlStats();
        perfRecorder.setTopSql(diffSqlStats(before, after, perfConfig.db.topSqlLimit));
      }

      assertPerfRun(perfRecorder, workload);
      const shardUsers = users.filter((_, i) => i % workload.shard.total === workload.shard.index - 1);
      const missing = missingCatalogueScreens(perfRecorder.all(), shardUsers, workload.allAlerts.menuPath);
      expect(missing, 'every listed user must log in; users with All Alerts access must search and open an alert').toEqual([]);
    },
  );
});
