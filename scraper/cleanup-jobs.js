/**
 * SteppeUp — cleanup v2. Keeps the board honest without ever mass-deleting it.
 *
 *   Pass 1  TTL expiry     — per-source age limit (source.ttlDays); partners exempt.
 *   Pass 2  Liveness       — source.verify() per row, behind a circuit breaker.
 *   Pass 3  Self-heal      — recently-killed rows that verify 'alive' come back.
 *   Pass 4  Garbage sweep  — active rows that today's rules call junk get retired.
 *
 * THE RULE: never delete on ambiguity. 404/410 and a structured archived flag
 * are the only "dead" signals. A 403 means "you may not ask" — an earlier
 * version read it as "the job is gone" and wiped the board to ~12 listings.
 * A later one grepped `vacancy-archived` out of hh's JS bundle and killed 150
 * jobs in one run. Hence Pass 2's circuit breaker: if >40% of a meaningful
 * sample tests dead, that's a broken check, not reality — abort and alert.
 *
 * Pass 4 exists because rules improve: the board is currently full of rows that
 * today's filter would never have accepted (grants, event announcements, titles
 * that are sentence fragments). Without a sweep, old junk lives forever.
 *
 * Run:
 *   node cleanup-jobs.js
 *   node cleanup-jobs.js --dry-run
 */

const { createHttp } = require('./lib/http');
const filter = require('./lib/filter');
const normalize = require('./lib/normalize');
const { createDb } = require('./lib/db');
const { createHealth, notify, writeStepSummary } = require('./lib/health');

const SOURCES = [require('./sources/hh'), require('./sources/enbek'), require('./sources/telegram')];
const BY_NAME = Object.fromEntries(SOURCES.map((s) => [s.name, s]));

const EXEMPT_SOURCES = ['partner'];   // paid / manually curated — never auto-expire
const DEFAULT_TTL_DAYS = 21;
const VERIFY_LIMIT = 120;             // rows checked for liveness per run
const HEAL_LIMIT = 120;
// The sweep must see the WHOLE board. It used to read 400 unordered rows, so
// on a 642-row board a third of it was never examined and junk survived every
// night. Paged, ordered, and it says so when coverage is capped.
const SWEEP_LIMIT = 5000;             // max rows examined by the garbage sweep
const SWEEP_PAGE = 1000;
const SWEEP_MAX_KILL_RATIO = 0.5;     // sweep safety: never retire >50% of what it reads
const MIN_ACTIVE_HEALTHY = 25;
const BREAKER_MIN_SAMPLE = 20;
const BREAKER_DEAD_RATIO = 0.4;

const DRY_RUN = process.argv.includes('--dry-run');
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!DRY_RUN && (!SUPABASE_URL || !SUPABASE_KEY)) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY env vars');
  process.exit(1);
}

const log = (...a) => console.log(...a);

async function main() {
  log('═══════════════════════════════════════════');
  log('  SteppeUp Cleanup v2');
  log(`  ${new Date().toISOString()}  |  ${DRY_RUN ? 'DRY RUN' : 'LIVE'}`);
  log('═══════════════════════════════════════════\n');

  const http = createHttp({ log, budget: 600 });
  const health = createHealth({ log });
  const db = createDb({ url: SUPABASE_URL, key: SUPABASE_KEY, log });
  if (!db) { console.error('No DB client (dry-run needs SUPABASE_* too for cleanup)'); process.exit(1); }
  const ctx = { http, log, filter, normalize, limits: {}, dryRun: DRY_RUN };
  const client = db.client;

  const counts = { expired: 0, dead: 0, revived: 0, swept: 0, unknown: 0 };

  // ── Pass 1: per-source TTL expiry ─────────────────────────────────────────
  for (const src of SOURCES) {
    const ttl = src.ttlDays || DEFAULT_TTL_DAYS;
    const cutoff = new Date(Date.now() - ttl * 864e5).toISOString();
    const { data, error } = DRY_RUN
      ? await client.from('jobs').select('id').eq('status', 'active').eq('source', src.name).lt('posted_at', cutoff)
      : await client.from('jobs').update({ status: 'inactive' }).eq('status', 'active').eq('source', src.name).lt('posted_at', cutoff).select('id');
    if (error) { health.problem(`expiry ${src.name}: ${error.message}`); continue; }
    counts.expired += (data || []).length;
    log(`[expiry] ${src.name}: ${(data || []).length} older than ${ttl}d ${DRY_RUN ? 'would be' : ''} deactivated`);
  }
  // Sources no longer in SOURCES (retired scrapers) still need retiring.
  {
    const cutoff = new Date(Date.now() - DEFAULT_TTL_DAYS * 864e5).toISOString();
    let q = client.from('jobs');
    q = DRY_RUN ? q.select('id') : q.update({ status: 'inactive' });
    q = q.eq('status', 'active').lt('posted_at', cutoff);
    for (const s of [...Object.keys(BY_NAME), ...EXEMPT_SOURCES]) q = q.neq('source', s);
    const { data, error } = DRY_RUN ? await q : await q.select('id');
    if (!error && (data || []).length) {
      counts.expired += data.length;
      log(`[expiry] legacy sources: ${data.length} deactivated`);
    }
  }

  // ── Pass 2: liveness verification ─────────────────────────────────────────
  for (const src of SOURCES) {
    if (typeof src.verify !== 'function') continue;
    const ttl = src.ttlDays || DEFAULT_TTL_DAYS;
    const cutoff = new Date(Date.now() - ttl * 864e5).toISOString();
    const { data: rows, error } = await client.from('jobs')
      .select('id, source_id, source_url')
      .eq('status', 'active').eq('source', src.name).gte('posted_at', cutoff)
      .limit(VERIFY_LIMIT);
    if (error) { health.problem(`verify fetch ${src.name}: ${error.message}`); continue; }
    if (!rows || !rows.length) continue;

    const deadIds = [];
    let checked = 0, unknown = 0;
    for (const row of rows) {
      let verdict;
      try { verdict = await src.verify(ctx, row); } catch (_e) { verdict = 'unknown'; }
      if (verdict === 'dead') deadIds.push(row.id);
      else if (verdict === 'unknown') unknown++;
      if (verdict !== 'unknown') checked++;
      await http.sleep(350);
    }
    counts.unknown += unknown;

    // Circuit breaker — see the header note. Two separate incidents came from
    // a liveness check that broke and reported everything dead.
    const ratio = checked ? deadIds.length / checked : 0;
    if (checked >= BREAKER_MIN_SAMPLE && ratio > BREAKER_DEAD_RATIO) {
      const msg = `${src.name}: CIRCUIT BREAKER — ${deadIds.length}/${checked} (${Math.round(ratio * 100)}%) tested dead. Almost certainly a broken liveness check, not real archivals. Nothing deactivated.`;
      log(`[verify] ${msg}`);
      health.problem(msg);
      await notify(msg, { level: 'error', log });
      continue;
    }

    if (!DRY_RUN) for (const id of deadIds) await client.from('jobs').update({ status: 'inactive' }).eq('id', id);
    counts.dead += deadIds.length;
    log(`[verify] ${src.name}: checked ${rows.length}, ${deadIds.length} dead, ${unknown} unverifiable (left active)`);
  }

  // ── Pass 3: self-heal ─────────────────────────────────────────────────────
  // Recovers automatically from any bug or outage that wrongly killed listings.
  for (const src of SOURCES) {
    if (typeof src.verify !== 'function') continue;
    const ttl = src.ttlDays || DEFAULT_TTL_DAYS;
    const cutoff = new Date(Date.now() - ttl * 864e5).toISOString();
    const { data: rows, error } = await client.from('jobs')
      .select('id, source_id, source_url, title')
      .eq('status', 'inactive').eq('source', src.name).gte('posted_at', cutoff)
      .limit(HEAL_LIMIT);
    if (error || !rows || !rows.length) continue;

    let revived = 0;
    for (const row of rows) {
      // Never resurrect something today's rules would reject — that would undo
      // the garbage sweep every night.
      if (normalize.validateJob(row) || filter.studentRejectReason(row.title, '')) continue;
      let verdict;
      try { verdict = await src.verify(ctx, row); } catch (_e) { verdict = 'unknown'; }
      if (verdict === 'alive') {
        if (!DRY_RUN) await client.from('jobs').update({ status: 'active' }).eq('id', row.id);
        revived++;
      }
      await http.sleep(350);
    }
    counts.revived += revived;
    if (revived) log(`[heal] ${src.name}: revived ${revived} still-live jobs`);
  }

  // ── Pass 4: garbage sweep ─────────────────────────────────────────────────
  // Retire active rows that today's normalizer/filter would never have accepted.
  {
    let rows = [], error = null;
    for (let from = 0; from < SWEEP_LIMIT; from += SWEEP_PAGE) {
      const res = await client.from('jobs')
        .select('id, title, company, source, source_url, description')
        .eq('status', 'active')
        .order('id', { ascending: true })
        .range(from, from + SWEEP_PAGE - 1);
      if (res.error) { error = res.error; break; }
      rows = rows.concat(res.data || []);
      if (!res.data || res.data.length < SWEEP_PAGE) break;
    }
    if (error) health.problem('sweep fetch: ' + error.message);
    else {
      if (rows.length >= SWEEP_LIMIT) health.problem(`sweep coverage capped at ${SWEEP_LIMIT} rows — raise SWEEP_LIMIT`);
      const bad = [];
      const reasons = {};
      for (const row of rows || []) {
        if (EXEMPT_SOURCES.includes(row.source)) continue;
        const reason = normalize.validateJob(row) || filter.studentRejectReason(row.title, row.description || '');
        if (reason) { bad.push(row.id); reasons[reason] = (reasons[reason] || 0) + 1; }
      }
      const ratio = rows.length ? bad.length / rows.length : 0;
      if (bad.length && ratio > SWEEP_MAX_KILL_RATIO) {
        // The sweep reading most of the board as junk means the RULES broke,
        // not the board. Same lesson as the liveness breaker.
        const msg = `garbage sweep would retire ${bad.length}/${rows.length} (${Math.round(ratio * 100)}%) — refusing, filter rules likely broken. Reasons: ${JSON.stringify(reasons)}`;
        log('[sweep] ' + msg);
        health.problem(msg);
        await notify(msg, { level: 'error', log });
      } else if (bad.length) {
        if (!DRY_RUN) {
          for (let i = 0; i < bad.length; i += 50) {
            await client.from('jobs').update({ status: 'inactive' }).in('id', bad.slice(i, i + 50));
          }
        }
        counts.swept = bad.length;
        log(`[sweep] retired ${bad.length}/${rows.length} rows failing current rules: ${JSON.stringify(reasons)}`);
      } else {
        log(`[sweep] all ${rows.length} checked rows pass current rules`);
      }
    }
  }

  // ── Health ────────────────────────────────────────────────────────────────
  let activeTotal = 0, bySource = {};
  try { activeTotal = await db.activeCount(); bySource = await db.activeCountsBySource(); }
  catch (e) { health.problem('active count: ' + e.message); }
  log(`\n[health] active on board: ${activeTotal}  ${JSON.stringify(bySource)}`);

  const fatal = !DRY_RUN && activeTotal < MIN_ACTIVE_HEALTHY;
  if (fatal) health.problem(`board has only ${activeTotal} active jobs (floor ${MIN_ACTIVE_HEALTHY}) after cleanup`);
  const verdict = health.verdict({ fatal });

  if (!DRY_RUN) {
    await db.logRun({
      source: 'cleanup', jobs_found: counts.revived,
      jobs_removed: counts.expired + counts.dead + counts.swept,
      status: verdict.status, details: { ...counts, activeTotal, bySource },
    });
  }

  writeStepSummary(`## Cleanup ${verdict.status.toUpperCase()}\n\n` +
    `expired ${counts.expired} · dead ${counts.dead} · swept ${counts.swept} · revived ${counts.revived}\n\n` +
    `Board: **${activeTotal}** active\n` +
    (verdict.problems.length ? `\n### Problems\n- ${verdict.problems.join('\n- ')}\n` : ''));

  log(`\nDone. expired ${counts.expired}, dead ${counts.dead}, swept ${counts.swept}, revived ${counts.revived}.`);
  log(`VERDICT: ${verdict.status.toUpperCase()}`);

  if (verdict.status !== 'ok') {
    await notify(`Cleanup ${verdict.status}\nBoard: ${activeTotal} active\n` +
      verdict.problems.map((p) => '• ' + p).join('\n'),
      { level: verdict.status === 'failed' ? 'error' : 'warn', log });
  }
  if (verdict.status === 'failed') process.exit(1);
}

main().catch(async (e) => {
  console.error('Fatal:', e);
  await notify(`Cleanup crashed: ${e.message}`, { level: 'error' });
  process.exit(1);
});
