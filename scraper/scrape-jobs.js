/**
 * SteppeUp Job Scraper — v2 orchestrator.
 *
 * Runs every source module (scraper/sources/*.js), upserts the results, and
 * ends with an explicit verdict: ok | degraded | failed. See SPEC.md for the
 * source contract and the history that shaped these rules.
 *
 * THE RULE THIS FILE EXISTS TO ENFORCE: a source that produces nothing must
 * fail loudly. Every past outage was silent — api.hh.ru 403s treated as "job
 * dead", `vacancy-archived` grepped out of JS bundles, upserts rejected by a
 * missing unique index, and hh.kz entity-encoding its embedded JSON so
 * JSON.parse threw and hh returned zero jobs for weeks. In every case the
 * workflow stayed green. Now each source declares `minExpected`, and falling
 * short is reported, alerted, and written to scraping_logs.
 *
 * Run:
 *   node scrape-jobs.js              # live  (SUPABASE_URL + SUPABASE_SERVICE_KEY)
 *   node scrape-jobs.js --dry-run    # no DB writes, prints everything
 *   node scrape-jobs.js --only=hh_kz # one source (repeatable, comma-separated)
 */

const { createHttp } = require('./lib/http');
const filter = require('./lib/filter');
const normalize = require('./lib/normalize');
const { createDb } = require('./lib/db');
const { createHealth, notify, writeStepSummary } = require('./lib/health');

const SOURCES = [
  require('./sources/hh'),
  require('./sources/enbek'),
  require('./sources/telegram'),
];

const DRY_RUN = process.argv.includes('--dry-run');
const ONLY = (process.argv.find((a) => a.startsWith('--only=')) || '').replace('--only=', '')
  .split(',').map((s) => s.trim()).filter(Boolean);

// Board-wide floor. Below this the website looks broken, so the run fails and
// GitHub emails. Deliberately lower than the sum of source minimums: one source
// having a bad day should degrade, not fail.
const MIN_ACTIVE_HEALTHY = 25;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!DRY_RUN && (!SUPABASE_URL || !SUPABASE_KEY)) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY env vars');
  process.exit(1);
}

const log = (...a) => console.log(...a);

async function runSource(src, ctx, health) {
  const started = Date.now();
  let canary = null;
  try {
    if (typeof src.canary === 'function') {
      canary = await src.canary(ctx);
      log(`[${src.name}] canary: ${canary.ok ? 'ok' : 'FAILED — ' + canary.reason}`);
    }
  } catch (e) {
    canary = { ok: false, reason: 'canary threw: ' + e.message };
    log(`[${src.name}] canary threw: ${e.message}`);
  }

  try {
    // The canary is diagnostic, not a gate: a changed page shape might still
    // yield jobs, and we would rather have them plus a warning.
    const { jobs = [], stats = {}, notes = [] } = await src.scrape(ctx);
    const kept = jobs.filter((j) => {
      // The orchestrator is the filter authority even if a source pre-filtered.
      const structuredEntry = (j.tags || []).some((t) => /без опыта|noexperience|стажировка|internship/i.test(t));
      return filter.isStudentFriendly(j.title, j.description, j.tags, { structuredEntry });
    });
    const dropped = jobs.length - kept.length;
    health.source(src.name, {
      found: kept.length, minExpected: src.minExpected, canary,
      extra: { raw: jobs.length, droppedByFilter: dropped, ms: Date.now() - started, ...stats },
    });
    notes.forEach((n) => log(`[${src.name}] note: ${n}`));
    log(`[${src.name}] ${jobs.length} scraped → ${kept.length} student-suitable (${dropped} dropped) in ${((Date.now() - started) / 1000).toFixed(1)}s`);
    return kept;
  } catch (e) {
    health.source(src.name, { found: 0, minExpected: src.minExpected, canary, error: e.message });
    log(`[${src.name}] CRASHED: ${e.message}`);
    if (process.env.DEBUG) console.error(e);
    return [];
  }
}

async function main() {
  const t0 = Date.now();
  log('═══════════════════════════════════════════');
  log('  SteppeUp Job Scraper v2');
  log(`  ${new Date().toISOString()}  |  ${DRY_RUN ? 'DRY RUN' : 'LIVE'}`);
  log('═══════════════════════════════════════════\n');

  const http = createHttp({ log, budget: 3000 });
  const health = createHealth({ log });
  const db = DRY_RUN ? null : createDb({ url: SUPABASE_URL, key: SUPABASE_KEY, log });

  const ctx = { http, log, filter, normalize, limits: { maxJobs: 400, maxPages: 6, maxAgeDays: 21 }, dryRun: DRY_RUN };

  const active = SOURCES.filter((s) => !ONLY.length || ONLY.includes(s.name));
  if (!active.length) { console.error(`No sources matched --only=${ONLY.join(',')}`); process.exit(1); }

  // Sources run sequentially: they share one HTTP budget and politeness matters
  // more than wall-clock here (the whole run is well inside the 20m timeout).
  const perSource = {};
  for (const src of active) {
    perSource[src.name] = await runSource(src, ctx, health);
  }

  const allJobs = Object.values(perSource).flat();

  // Cross-source dedupe: the same vacancy often appears on hh.kz AND in a
  // career channel that links to it. Prefer the structured source (earlier in
  // SOURCES order), which has better company/salary/liveness data.
  const seen = new Set();
  const deduped = [];
  let crossDupes = 0;
  for (const j of allJobs) {
    const applyKey = j.apply_url ? 'a:' + j.apply_url.replace(/[?#].*$/, '') : null;
    const nameKey = 't:' + j.title.toLowerCase().replace(/\s+/g, ' ') + '|' + j.company.toLowerCase();
    if ((applyKey && seen.has(applyKey)) || seen.has(nameKey)) { crossDupes++; continue; }
    if (applyKey) seen.add(applyKey);
    seen.add(nameKey);
    deduped.push(j);
  }

  log('\n── Summary ──────────────────────────────');
  for (const [name, jobs] of Object.entries(perSource)) log(`  ${name.padEnd(16)} ${String(jobs.length).padStart(4)} jobs`);
  log(`  ${'cross-dupes'.padEnd(16)} ${String(crossDupes).padStart(4)} removed`);
  log(`  ${'TOTAL'.padEnd(16)} ${String(deduped.length).padStart(4)} jobs`);

  if (DRY_RUN) {
    log('\n[DRY RUN] Sample of what would be upserted:');
    deduped.slice(0, 25).forEach((j) =>
      log(`  [${j.source}] ${j.title.slice(0, 46).padEnd(48)} | ${j.company.slice(0, 22).padEnd(24)} | ${j.location}`));
    if (deduped.length > 25) log(`  … and ${deduped.length - 25} more`);
    const v = health.verdict();
    log('\n' + v.summary);
    if (v.problems.length) log('\nProblems:\n - ' + v.problems.join('\n - '));
    log(`\nHTTP requests: ${http.used}  |  ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    return;
  }

  // ── Write ────────────────────────────────────────────────────────────────
  let upsert = { ok: 0, errors: 0, errorSamples: [], verified: null };
  if (deduped.length) {
    upsert = await db.upsertJobs(deduped);
    log(`\n[db] upserted ${upsert.ok}, errors ${upsert.errors}` +
        (upsert.verified ? `, verification ${upsert.verified.present}/${upsert.verified.sampled} sampled rows present` : ''));
    upsert.errorSamples.forEach((s) => log(`[db] ${s}`));
    // Writes silently failing while the workflow stayed green is a past
    // incident — treat "nothing landed" as fatal, not as a warning.
    if (upsert.verified && upsert.verified.present === 0) {
      health.problem('write verification failed: none of the sampled rows reached the DB');
    }
  }

  // ── Health ───────────────────────────────────────────────────────────────
  let activeTotal = 0, bySource = {};
  try {
    activeTotal = await db.activeCount();
    bySource = await db.activeCountsBySource();
  } catch (e) {
    health.problem('could not read active counts: ' + e.message);
  }
  log(`\n[health] active on board: ${activeTotal}  ${JSON.stringify(bySource)}`);

  const fatal = activeTotal < MIN_ACTIVE_HEALTHY ||
                (upsert.verified && upsert.verified.present === 0 && deduped.length > 0);
  if (activeTotal < MIN_ACTIVE_HEALTHY) {
    health.problem(`board has only ${activeTotal} active jobs (floor ${MIN_ACTIVE_HEALTHY})`);
  }
  const verdict = health.verdict({ fatal });

  // Per-source log rows, then the summary row. Each is best-effort.
  for (const [name, s] of Object.entries(verdict.sources)) {
    await db.logRun({ source: name, jobs_found: s.found, status: s.verdict, details: s });
  }
  await db.logRun({
    source: 'all', jobs_found: deduped.length, status: verdict.status,
    details: { bySource, activeTotal, crossDupes, upserted: upsert.ok, errors: upsert.errors, http: http.stats, seconds: (Date.now() - t0) / 1000 },
  });

  writeStepSummary(
    `## Scrape ${verdict.status.toUpperCase()}\n\n${verdict.summary}\n\n` +
    `Board: **${activeTotal}** active · upserted ${upsert.ok} · ${((Date.now() - t0) / 1000).toFixed(0)}s\n` +
    (verdict.problems.length ? `\n### Problems\n- ${verdict.problems.join('\n- ')}\n` : ''));

  log('\n═══════════════════════════════════════════');
  log(`  VERDICT: ${verdict.status.toUpperCase()}`);
  log(verdict.summary);
  if (verdict.problems.length) log('  Problems:\n   - ' + verdict.problems.join('\n   - '));
  log('═══════════════════════════════════════════');

  if (verdict.status !== 'ok') {
    await notify(
      `Scrape ${verdict.status}\n${verdict.summary}\n\nBoard: ${activeTotal} active\n` +
      verdict.problems.map((p) => '• ' + p).join('\n'),
      { level: verdict.status === 'failed' ? 'error' : 'warn', log });
  }
  if (verdict.status === 'failed') process.exit(1);
}

main().catch(async (e) => {
  console.error('Fatal error:', e);
  await notify(`Scraper crashed: ${e.message}`, { level: 'error' });
  process.exit(1);
});
