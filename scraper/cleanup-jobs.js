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
const HH_CHECK_LIMIT = 250;            // max hh API verifications per run
const HH_SOURCES = ['hh_kz', 'youth_portal']; // sources whose source_id is hh_<id>

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

// ── Pass 1: time-based expiry ────────────────────────────────────────────────
async function expireOldJobs() {
  const cutoff = new Date(Date.now() - FRESH_DAYS * 24 * 60 * 60 * 1000).toISOString();
  if (DRY_RUN) {
    let q = db_dry('jobs', 'select=id&status=eq.active&posted_at=lt.' + cutoff);
    const ids = await q;
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

  let removed = 0;
  for (const job of jobs) {
    const hhId = (job.source_id || '').replace(/^hh_|^youth_hh_/, '');
    if (!/^\d+$/.test(hhId)) continue;
    let dead = false;
    try {
      const res = await fetch('https://api.hh.ru/vacancies/' + hhId, {
        headers: { 'User-Agent': 'SteppeUp-cleanup/1.0' },
      });
      if (res.status === 404 || res.status === 403) dead = true;
      else if (res.ok) {
        const d = await res.json();
        if (d.archived || (d.type && d.type.id === 'closed')) dead = true;
      }
    } catch (e) { /* network blip — leave active, retry next run */ }
    if (dead) {
      await db.from('jobs').update({ status: 'inactive' }).eq('id', job.id);
      removed++;
    }
    await sleep(150); // be gentle with the hh API
  }
  console.log(`[hh-verify] checked ${jobs.length}, deactivated ${removed} archived/closed`);
  return removed;
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

  if (!DRY_RUN) {
    try {
      await db.from('scraping_logs').insert({
        source: 'cleanup', jobs_found: 0, jobs_removed: expired + verified,
        status: 'success', details: { time_expired: expired, hh_archived: verified, fresh_days: FRESH_DAYS },
      });
    } catch (e) { /* logs optional */ }
  }
  console.log(`\nDone. Deactivated ${expired + verified} stale jobs.`);
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1); });
