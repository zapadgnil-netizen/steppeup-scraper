/**
 * SteppeUp — Stale-job cleanup (standalone, focused).
 *
 * Marks dead listings status='inactive' so the board only shows live jobs.
 * Runs on its own schedule via .github/workflows/cleanup-jobs.yml — kept separate
 * from scrape-jobs.js so cleanup runs reliably even if scraping is paused.
 *
 *   Pass 1  Time expiry   — anything older than FRESH_DAYS (except partner jobs).
 *   Pass 2  hh.kz verify  — active hh-sourced jobs that are archived/closed/gone
 *                           on the source, so early archivals die within a day.
 *   Pass 3  Self-heal     — recently deactivated hh jobs that are actually still
 *                           live on hh.kz get re-activated. Recovers from any bug
 *                           or outage that wrongly killed listings.
 *
 * VERIFICATION RULE (hard-learned): api.hh.ru 403-blocks ALL datacenter/CI IPs.
 * A 403 means "you may not ask", NOT "the job is gone". An earlier version
 * treated 403 as dead and silently wiped the whole board down to ~12 jobs.
 * We therefore verify against the public hh.kz vacancy PAGE (which serves CI
 * traffic fine) and only trust definitive signals:
 *   404/410            → dead
 *   200 + archive text → dead
 *   anything else      → unknown, LEAVE ACTIVE (retry next run)
 *
 * Run:
 *   node cleanup-jobs.js            # live (needs SUPABASE_URL + SUPABASE_SERVICE_KEY)
 *   node cleanup-jobs.js --dry-run  # report only, no writes
 */

const fetch = require('node-fetch');
const { createClient } = require('@supabase/supabase-js');
const WebSocket = require('ws');

// ── Config ──────────────────────────────────────────────────────────────────
const FRESH_DAYS = 14;                 // jobs older than this are deactivated
const EXEMPT_SOURCES = ['partner'];    // never auto-expire (paid / manually curated)
const HH_CHECK_LIMIT = 150;            // max hh verifications per run (Pass 2)
const HEAL_CHECK_LIMIT = 150;          // max resurrection checks per run (Pass 3)
const MIN_ACTIVE_HEALTHY = 25;         // health gate: fewer than this fails the run
const HH_SOURCES = ['hh_kz', 'youth_portal']; // sources whose source_id is hh_<id>
const HH_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const DRY_RUN = process.argv.includes('--dry-run');
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!DRY_RUN && (!SUPABASE_URL || !SUPABASE_KEY)) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY env vars');
  process.exit(1);
}

const db = DRY_RUN ? null : createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
  realtime: { transport: WebSocket },
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── hh.kz liveness check (shared by Pass 2 + Pass 3) ─────────────────────────
// Returns 'dead' | 'alive' | 'unknown'. Only definitive signals count.
async function hhVacancyStatus(hhId) {
  try {
    const res = await fetch('https://hh.kz/vacancy/' + hhId, {
      headers: { 'User-Agent': HH_UA, 'Accept': 'text/html', 'Accept-Language': 'ru-RU,ru;q=0.9' },
      redirect: 'follow',
    });
    if (res.status === 404 || res.status === 410) return 'dead';
    if (res.ok) {
      const html = await res.text();
      // hh renders archived vacancies with an explicit archive banner
      if (/вакансия\s+в\s+архиве|vacancy-archived|данная\s+вакансия\s+архивирована/i.test(html)) return 'dead';
      return 'alive';
    }
    return 'unknown'; // 403/429/5xx — cannot verify from this IP; do NOT kill
  } catch (e) {
    return 'unknown'; // network blip — leave as-is, retry next run
  }
}

// ── Pass 1: time-based expiry ────────────────────────────────────────────────
async function expireOldJobs() {
  const cutoff = new Date(Date.now() - FRESH_DAYS * 24 * 60 * 60 * 1000).toISOString();
  if (DRY_RUN) {
    const ids = await db_dry('jobs', 'select=id&status=eq.active&posted_at=lt.' + cutoff);
    console.log(`[expiry] DRY: ${ids.length} active jobs older than ${FRESH_DAYS}d would be deactivated`);
    return 0;
  }
  let query = db.from('jobs').update({ status: 'inactive' })
    .eq('status', 'active')
    .lt('posted_at', cutoff)
    .select('id');
  for (const s of EXEMPT_SOURCES) query = query.neq('source', s);
  const { data, error } = await query;
  if (error) { console.log(`[expiry] error: ${error.message}`); return 0; }
  console.log(`[expiry] deactivated ${data.length} jobs older than ${FRESH_DAYS}d`);
  return data.length;
}

// ── Pass 2: hh.kz source verification ────────────────────────────────────────
async function verifyHhJobs() {
  const cutoff = new Date(Date.now() - FRESH_DAYS * 24 * 60 * 60 * 1000).toISOString();
  // Only check jobs still within the freshness window (older ones already expired).
  const { data: jobs, error } = await db.from('jobs')
    .select('id, source_id')
    .eq('status', 'active')
    .in('source', HH_SOURCES)
    .gte('posted_at', cutoff)
    .limit(HH_CHECK_LIMIT);
  if (error || !jobs) { console.log(`[hh-verify] fetch error: ${error && error.message}`); return 0; }

  let removed = 0, unknown = 0;
  for (const job of jobs) {
    const hhId = (job.source_id || '').replace(/^hh_|^youth_hh_/, '');
    if (!/^\d+$/.test(hhId)) continue;
    const status = await hhVacancyStatus(hhId);
    if (status === 'dead') {
      await db.from('jobs').update({ status: 'inactive' }).eq('id', job.id);
      removed++;
    } else if (status === 'unknown') {
      unknown++;
    }
    await sleep(400); // be gentle with hh.kz
  }
  console.log(`[hh-verify] checked ${jobs.length}, deactivated ${removed} dead/archived, ${unknown} unverifiable (left active)`);
  return removed;
}

// ── Pass 3: self-heal — resurrect wrongly deactivated jobs ───────────────────
// Any inactive hh-sourced job still within the freshness window gets re-checked
// against hh.kz. If the vacancy is demonstrably alive, it's re-activated.
// This automatically recovers from bugs/outages that mass-killed listings
// (like the api.hh.ru 403 incident) with zero manual intervention.
async function healWronglyKilledJobs() {
  if (DRY_RUN) { console.log('[heal] DRY: skipped'); return 0; }
  const cutoff = new Date(Date.now() - FRESH_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const { data: jobs, error } = await db.from('jobs')
    .select('id, source_id')
    .eq('status', 'inactive')
    .in('source', HH_SOURCES)
    .gte('posted_at', cutoff)
    .limit(HEAL_CHECK_LIMIT);
  if (error || !jobs) { console.log(`[heal] fetch error: ${error && error.message}`); return 0; }
  if (jobs.length === 0) { console.log('[heal] nothing to check'); return 0; }

  let revived = 0;
  for (const job of jobs) {
    const hhId = (job.source_id || '').replace(/^hh_|^youth_hh_/, '');
    if (!/^\d+$/.test(hhId)) continue;
    const status = await hhVacancyStatus(hhId);
    if (status === 'alive') {
      await db.from('jobs').update({ status: 'active' }).eq('id', job.id);
      revived++;
    }
    await sleep(400);
  }
  console.log(`[heal] checked ${jobs.length} recently-deactivated, revived ${revived} still-live jobs`);
  return revived;
}

// Tiny REST helper used only in dry-run (anon-readable) so --dry-run needs no key.
async function db_dry(table, qs) {
  const SB = 'https://wiijdddhzddqgntfdbsx.supabase.co';
  const KEY = process.env.SUPABASE_ANON_KEY ||
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IndpaWpkZGRoemRkcWdudGZkYnN4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzE1NDI0NjIsImV4cCI6MjA4NzExODQ2Mn0.rQyTBlIA1WVU-KfFyF8sXK8GVZUL9m9yFIHTydXPHe0';
  const res = await fetch(`${SB}/rest/v1/${table}?${qs}`, { headers: { apikey: KEY, Authorization: 'Bearer ' + KEY } });
  return res.ok ? res.json() : [];
}

async function main() {
  console.log('═══════════════════════════════════════════');
  console.log('  SteppeUp Stale-Job Cleanup');
  console.log(`  ${new Date().toISOString()} | Mode: ${DRY_RUN ? 'DRY RUN' : 'LIVE'} | fresh<=${FRESH_DAYS}d`);
  console.log('═══════════════════════════════════════════\n');

  const expired = await expireOldJobs();
  const verified = DRY_RUN ? 0 : await verifyHhJobs();
  const revived = DRY_RUN ? 0 : await healWronglyKilledJobs();

  // ── Health gate ─────────────────────────────────────────────────────────
  // The active count in Supabase is exactly what the website shows. If it has
  // decayed below the floor, fail the run loudly so GitHub emails immediately —
  // silent decay is how the board rotted to 12 jobs once. Never again.
  if (!DRY_RUN) {
    const { count, error } = await db.from('jobs')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'active');
    if (error) {
      console.error('[health] could not read active count: ' + error.message);
      process.exit(1);
    }
    console.log(`[health] active jobs on the board: ${count}`);
    if ((count || 0) < MIN_ACTIVE_HEALTHY) {
      console.error(`[health-gate] FAIL: only ${count} active jobs (< ${MIN_ACTIVE_HEALTHY}). ` +
        'A source is broken or cleanup is over-deleting. See per-pass logs above.');
      process.exit(1);
    }
  }

  if (!DRY_RUN) {
    try {
      await db.from('scraping_logs').insert({
        source: 'cleanup', jobs_found: revived, jobs_removed: expired + verified,
        status: 'success', details: { time_expired: expired, hh_archived: verified, revived, fresh_days: FRESH_DAYS },
      });
    } catch (e) { /* logs optional */ }
  }
  console.log(`\nDone. Deactivated ${expired + verified}, revived ${revived}.`);
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1); });
