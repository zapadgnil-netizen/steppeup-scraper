/**
 * Regression: Telegram workflow 34774795506 failed after a successful scrape
 * because the board count read returned an empty error, the orchestrator
 * coerced that to board=0 vs floor 25, and scraping_logs insert used a missing
 * `source` column (PGRST204).
 *
 *   node --test tests/health-db.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createDb,
  formatPgError,
  formatCountFailure,
  asNonNegativeInt,
  scrapingLogPayload,
  parseExactCount,
  countActive,
} = require('../lib/db');
const { evaluateBoardCount, createHealth } = require('../lib/health');

function makeCountClient({ headResult, getResult }) {
  const calls = [];
  const client = {
    from() {
      const state = { head: false, range: null };
      const q = {
        select(_c, opts = {}) { state.head = !!opts.head; return q; },
        eq() { return q; },
        range(a, b) { state.range = [a, b]; return q; },
        then(resolve, reject) {
          calls.push({ head: state.head, range: state.range && state.range.slice() });
          const res = state.head ? headResult : getResult;
          return Promise.resolve(res).then(resolve, reject);
        },
      };
      return q;
    },
  };
  return { client, calls };
}

test('scrapingLogPayload has no source column; source lives in details', () => {
  const row = scrapingLogPayload({
    source: 'telegram_career',
    jobs_found: 10,
    jobs_removed: 0,
    status: 'ok',
    details: { parsed: 15 },
  });
  assert.equal(Object.prototype.hasOwnProperty.call(row, 'source'), false);
  assert.deepEqual(Object.keys(row).sort(), ['details', 'jobs_found', 'jobs_removed', 'status']);
  assert.equal(row.details.source, 'telegram_career');
  assert.equal(row.details.parsed, 15);
  assert.equal(row.jobs_found, 10);
  assert.equal(row.status, 'ok');
});

test('logRun inserts the compatibility payload, not a source column', async () => {
  let inserted = null;
  const client = {
    from(table) {
      const q = {
        insert(row) { inserted = { table, row }; return q; },
        then(resolve) { return Promise.resolve({ error: null }).then(resolve); },
      };
      return q;
    },
  };
  const db = createDb({ client, log() {} });
  const ok = await db.logRun({ source: 'telegram_career', jobs_found: 10, status: 'ok', details: { verified: '10/10' } });
  assert.equal(ok, true);
  assert.equal(inserted.table, 'scraping_logs');
  assert.equal(Object.prototype.hasOwnProperty.call(inserted.row, 'source'), false);
  assert.equal(inserted.row.details.source, 'telegram_career');
  assert.equal(inserted.row.jobs_found, 10);
});

test('asNonNegativeInt: null is missing, not zero (Number(null)===0)', () => {
  assert.equal(asNonNegativeInt(null), null);
  assert.equal(asNonNegativeInt(undefined), null);
  assert.equal(asNonNegativeInt(0), 0);
  assert.equal(asNonNegativeInt(5464), 5464);
  assert.equal(asNonNegativeInt(-1), null);
  assert.equal(asNonNegativeInt(1.5), null);
  assert.equal(asNonNegativeInt('5464'), null);
});

test('formatPgError does not stringify empty message as blank', () => {
  assert.equal(formatPgError({ message: '' }, 'empty error'), 'empty error');
  assert.equal(formatPgError({}, 'empty error'), 'empty error');
  assert.equal(formatPgError({ code: 'PGRST204', message: "Could not find the 'source' column of 'scraping_logs' in the schema cache" }).includes('PGRST204'), true);
});

test('formatCountFailure keeps outer HTTP status when the error message is empty', () => {
  const text = formatCountFailure({
    count: null,
    error: { message: '' },
    status: 502,
    statusText: 'Bad Gateway',
  });
  assert.match(text, /empty error/);
  assert.match(text, /http 502 Bad Gateway/);
});

test('parseExactCount includes HTTP status and does not return 0 for null', () => {
  assert.throws(
    () => parseExactCount({ count: null, error: { message: '' }, status: 502, statusText: 'Bad Gateway' }, { label: 'activeCount' }),
    (err) => /activeCount:/.test(err.message) && /empty error/.test(err.message) && /http 502 Bad Gateway/.test(err.message)
  );
  assert.throws(
    () => parseExactCount({ count: null, error: null, status: 200, statusText: 'OK' }, { label: 'activeCount' }),
    (err) => /missing exact count/.test(err.message) && /http 200 OK/.test(err.message)
  );
  assert.equal(parseExactCount({ count: 5464, error: null, status: 200 }), 5464);
  assert.equal(parseExactCount({ count: 0, error: null, status: 200 }), 0);
});

test('countActive: HEAD null count (no error) falls back to GET and returns the real total', async () => {
  const { client, calls } = makeCountClient({
    headResult: { count: null, error: null, status: 200, statusText: 'OK' },
    getResult: { count: 5464, error: null, status: 206, statusText: 'Partial Content' },
  });
  const logs = [];
  const n = await countActive(client, { log: (m) => logs.push(m) });
  assert.equal(n, 5464);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].head, true);
  assert.equal(calls[1].head, false);
  assert.deepEqual(calls[1].range, [0, 0]);
  assert.match(logs.join('\n'), /HEAD active count failed/);
  assert.match(logs.join('\n'), /missing exact count/);
  assert.match(logs.join('\n'), /http 200 OK/);
});

test('countActive: HEAD empty error with HTTP status falls back to GET', async () => {
  const { client, calls } = makeCountClient({
    headResult: { count: null, error: { message: '' }, status: 502, statusText: 'Bad Gateway' },
    getResult: { count: 5464, error: null, status: 206, statusText: 'Partial Content' },
  });
  const logs = [];
  const n = await countActive(client, { log: (m) => logs.push(m) });
  assert.equal(n, 5464);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].range, [0, 0]);
  assert.match(logs.join('\n'), /http 502 Bad Gateway/);
});

test('countActive preserves both HEAD and GET failures and does not coerce to 0', async () => {
  const { client } = makeCountClient({
    headResult: { count: null, error: { message: '' }, status: 502, statusText: 'Bad Gateway' },
    getResult: { count: null, error: { message: '' }, status: 500, statusText: 'Internal Server Error' },
  });
  await assert.rejects(
    () => countActive(client, { log() {} }),
    (err) => {
      assert.match(err.message, /^activeCount: GET failed \(/);
      assert.match(err.message, /http 500 Internal Server Error/);
      assert.match(err.message, /HEAD also failed \(/);
      assert.match(err.message, /http 502 Bad Gateway/);
      assert.equal(/board has only 0/.test(err.message), false);
      return true;
    }
  );
});

test('evaluateBoardCount: unknown is fatal and is not displayed as 0', () => {
  const unknown = evaluateBoardCount(null, { minHealthy: 25 });
  assert.equal(unknown.fatal, true);
  assert.equal(unknown.known, false);
  assert.equal(unknown.display, 'unknown');
  assert.match(unknown.problem, /unknown/);
  assert.equal(unknown.problem.includes('only 0'), false);
  assert.equal(unknown.problem.includes('floor 25'), false);

  const zero = evaluateBoardCount(0, { minHealthy: 25 });
  assert.equal(zero.fatal, true);
  assert.equal(zero.known, true);
  assert.equal(zero.display, '0');
  assert.match(zero.problem, /only 0 active jobs \(floor 25\)/);

  const healthy = evaluateBoardCount(5464, { minHealthy: 25 });
  assert.equal(healthy.fatal, false);
  assert.equal(healthy.display, '5464');
  assert.equal(healthy.problem, null);
});

test('health verdict: unknown count fails closed without a fake board-0 problem', () => {
  const h = createHealth({ log() {} });
  h.source('telegram_career', { found: 10, minExpected: 3 });
  h.problem('could not read active counts: activeCount: empty error');
  const board = evaluateBoardCount(null, { minHealthy: 25 });
  h.problem(board.problem);
  const v = h.verdict({ fatal: board.fatal });
  assert.equal(v.status, 'failed');
  assert.ok(v.problems.some((p) => /could not read active counts/.test(p)));
  assert.ok(v.problems.some((p) => /unknown/.test(p)));
  assert.equal(v.problems.some((p) => /board has only 0/.test(p)), false);
});

test('activeCountsBySource keeps all returned sources and throws on error (no silent holes)', async () => {
  let mode = 'ok';
  const client = {
    from() {
      const q = {
        select() { return q; },
        eq() { return q; },
        limit() { return q; },
        then(resolve) {
          if (mode === 'ok') {
            return Promise.resolve({
              data: [
                { source: 'hh_kz' },
                { source: 'legacy_foo' },
                { source: 'hh_kz' },
                { source: 'telegram_career' },
              ],
              error: null,
            }).then(resolve);
          }
          return Promise.resolve({
            data: null,
            error: { message: '' },
            status: 500,
            statusText: 'Internal Server Error',
          }).then(resolve);
        },
      };
      return q;
    },
  };
  const db = createDb({ client, log() {} });
  const out = await db.activeCountsBySource();
  assert.deepEqual(out, { hh_kz: 2, legacy_foo: 1, telegram_career: 1 });
  assert.equal(Object.prototype.hasOwnProperty.call(out, 'enbek_kz'), false);
  mode = 'err';
  await assert.rejects(
    () => db.activeCountsBySource(),
    (err) => /activeCountsBySource:/.test(err.message) && /http 500 Internal Server Error/.test(err.message)
  );
});
