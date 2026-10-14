/**
 * Load from ONE machine with several Playwright processes: distinct perf.users logins are split over
 * --shards processes (own Node + own Chromium each, so the load spreads over CPU cores), all
 * released at the same moment by a built-in coordinator; results are merged at the end.
 *
 *   npm run perf:bombard -- <alias> [--shards=4] [--run-id=R2.06.1_load_50vu_qa1]
 *
 * Output: reports/perf/<runId>/ (merged) + reports/perf/<runId>_shard<i>of<n>/ + logs/shard<i>.log
 */
import { spawn } from 'child_process';
import fs from 'fs';
import http from 'http';
import path from 'path';
import { listEnvironmentAliases } from '../src/config/environments';

const ROOT = path.join(__dirname, '..');
// eslint-disable-next-line no-console
const log = (line: string) => console.log(`[bombard ${new Date().toLocaleTimeString()}] ${line}`);

function option(name: string): string | undefined {
  return process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
}

async function main(): Promise<void> {
  const alias = process.argv.slice(2).find((a) => !a.startsWith('--'));
  const known = listEnvironmentAliases();
  if (!alias || !known.includes(alias)) {
    // eslint-disable-next-line no-console
    console.error(`Usage: npm run perf:bombard -- <alias> [--shards=4] [--run-id=…]\nAliases: ${known.join(', ')}`);
    process.exit(2);
  }
  const shards = Number(option('shards') || 4);
  if (!Number.isInteger(shards) || shards < 1) throw new Error('--shards must be a positive integer');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const runId = option('run-id') || `load_${alias}_${shards}x_${stamp}`;
  const logDir = path.join(ROOT, 'reports/perf', `${runId}_logs`);
  fs.mkdirSync(logDir, { recursive: true });

  // Built-in coordinator: GO when every shard has checked in.
  const waiting: http.ServerResponse[] = [];
  const server = http.createServer((req, res) => {
    if (!req.url?.startsWith('/ready')) {
      res.writeHead(404);
      res.end();
      return;
    }
    waiting.push(res);
    log(`shard ready (${waiting.length}/${shards})`);
    if (waiting.length === shards) {
      log(`GO - all ${shards} shards start their logins now`);
      waiting.forEach((r) => {
        r.writeHead(200, { 'content-type': 'application/json' });
        r.end('{"go":true}');
      });
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;

  log(`${shards} Playwright processes against "${alias}", run id ${runId}`);
  const exits = await Promise.all(
    Array.from({ length: shards }, (_, i) => {
      const shard = `${i + 1}/${shards}`;
      const out = fs.createWriteStream(path.join(logDir, `shard${i + 1}.log`));
      const child = spawn('npm', ['run', 'test:perf:load', '--', `--output=test-results/${runId}_shard${i + 1}`], {
        cwd: ROOT,
        shell: process.platform === 'win32',
        env: {
          ...process.env,
          NR_ENV: alias,
          PERF_SHARD: shard,
          PERF_COORDINATOR: `http://127.0.0.1:${port}`,
          PERF_RUN_ID: runId,
          // separate HTML reports per process (they would overwrite each other)
          PLAYWRIGHT_HTML_OUTPUT_DIR: `playwright-report/${runId}_shard${i + 1}`,
          PLAYWRIGHT_HTML_REPORT: `playwright-report/${runId}_shard${i + 1}`,
          PLAYWRIGHT_HTML_OPEN: 'never',
        },
      });
      child.stdout.pipe(out);
      child.stderr.pipe(out);
      // Console: only failures, aborted journeys and the end of each shard.
      child.stdout.on('data', (chunk: Buffer) =>
        chunk
          .toString()
          .split(/\r?\n/)
          .filter((l) => /FAILED|JOURNEY_ABORTED| passed \(| failed$|Perf results|perf-warning/.test(l))
          .forEach((l) => log(`shard ${shard}: ${l.trim()}`)),
      );
      return new Promise<number>((resolve) => child.on('close', (code) => resolve(code ?? 1)));
    }),
  );
  server.close();

  // PerfReporter only appends _shard<i>of<n> when there is more than one shard, so a single-shard
  // run writes straight to reports/perf/<runId>.
  const shardDir = (i: number) => (shards > 1 ? `reports/perf/${runId}_shard${i + 1}of${shards}` : `reports/perf/${runId}`);
  const dirs = Array.from({ length: shards }, (_, i) => shardDir(i)).filter((d) =>
    fs.existsSync(path.join(ROOT, d, 'measurements.json')),
  );
  if (dirs.length > 1) {
    log(`merging ${dirs.length} shard results into reports/perf/${runId}`);
    const merge = spawn('npm', ['run', '-s', 'perf:merge', '--', ...dirs, `--out=reports/perf/${runId}`], {
      cwd: ROOT,
      shell: process.platform === 'win32',
      // perf:merge prints the merged markdown itself. report() below is the single place that
      // puts it in the log, so drop that copy rather than printing the table twice.
      stdio: ['inherit', 'ignore', 'inherit'],
    });
    await new Promise((resolve) => merge.on('close', resolve));
  } else if (dirs.length === 1) {
    log(`only one shard produced results: ${dirs[0]}`);
  } else {
    log('no shard produced results - see the shard logs');
  }
  log(`shard logs: reports/perf/${runId}_logs/`);
  report(runId, shards, dirs.length, exits);
  process.exit(Math.max(...exits));
}

/**
 * Without this the merged table only exists inside the uploaded artifact, so judging a run means
 * downloading a zip. Print it to the job log, and on GitHub Actions to the job summary as well.
 */
function report(runId: string, shards: number, contributing: number, exits: number[]): void {
  const failed = exits.map((code, i) => ({ code, i })).filter((s) => s.code !== 0);
  const head = [
    `run id: ${runId}`,
    `shards with results: ${contributing}/${shards}`,
    failed.length ? `shards that failed: ${failed.map((s) => `${s.i + 1} (exit ${s.code})`).join(', ')}` : `all ${shards} shard(s) exited 0`,
  ];
  // Both a merged run and a single-shard run end up here; only the path differs.
  const file = path.join(ROOT, 'reports/perf', runId, 'summary.md');
  if (!fs.existsSync(file)) {
    head.forEach(log);
    log(`no summary at ${path.relative(ROOT, file)} - nothing to report`);
    return;
  }
  const markdown = fs.readFileSync(file, 'utf8').trim();
  const rule = '='.repeat(78);
  // eslint-disable-next-line no-console
  console.log(['', rule, 'PERF REPORT', ...head.map((h) => `  ${h}`), '', markdown, rule, ''].join('\n'));

  const stepSummary = process.env.GITHUB_STEP_SUMMARY;
  if (stepSummary) {
    const bullets = head.map((h) => `- ${h}`).join('\n');
    fs.appendFileSync(stepSummary, `## Perf report — ${runId}\n\n${bullets}\n\n${markdown}\n`);
    log('merged report written to the job summary');
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
