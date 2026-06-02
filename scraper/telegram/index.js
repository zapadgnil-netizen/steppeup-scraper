/**
 * SteppeUp — Telegram career-channel scraper (orchestrator).
 *
 * Pipeline:  fetcher → parser → student-suitability gate → dedupe → upsert → log
 *
 * Run:
 *   node telegram/index.js            # live (needs SUPABASE_URL + SUPABASE_SERVICE_KEY)
 *   node telegram/index.js --dry-run  # no DB writes; prints what it would insert
 *
 * Modular by concern: channels.js (config), fetcher.js (network), parser.js
 * (text→job, swappable), inserter.js (dedup+upsert). This file only orchestrates.
 * It does NOT import scrape-jobs.js and leaves the existing scraper untouched.
 */

const { createClient } = require('@supabase/supabase-js');
const WebSocket = require('ws');
const { CHANNELS } = require('./channels');
const { fetchChannel, sleep } = require('./fetcher');
const { parsePost } = require('./parser');
const { dedupe, upsertJobs } = require('./inserter');

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

// Student-suitability gate — mirrors studentRejectReason() in scrape-jobs.js so
// experience-required / senior / digest / discriminatory posts never get stored.
// Kept local on purpose (requiring scrape-jobs.js would run its main()).
function studentRejectReason(title, description) {
  const titleText = (title || '').toLowerCase();
  const t = `${titleText} ${(description || '').toLowerCase()}`;
  if (/студент\w*[^.]{0,25}(не\s*беспоко|не\s*обраща|не\s*подход|не\s*рассматр)|без\s*студент|не\s*для\s*студент/.test(t)) return 'excludes-students';
  // NB: \b doesn't work before Cyrillic in JS regex, so Cyrillic terms are plain substrings.
  if (/\b(senior|middle|lead|head)\b|сень[оё]р|синьор|мидл|тимлид|руководител|начальник|директор|главн(ый|ого|ая)|заведующ|управляющ|ведущий\s+специалист|эксперт/.test(titleText)) return 'senior-title';
  const requiresExp = /опыт\s*работы|с\s*опытом|опыт\s*от|обязателен\s*опыт|требуется\s*опыт|опыт\s*не\s*менее|стаж\s*(работы|от)|experience\s*(required|of)|years?\s*of\s*experience/.test(t);
  const welcomesNoExp = /без\s*опыта|опыт\s*не\s*требуется|опыта\s*не\s*требуется|можно\s*без\s*опыта|no\s*experience|обучение\s*с\s*нуля|обучаем|студент|стажир/.test(t);
  if (requiresExp && !welcomesNoExp) return 'requires-experience';
  if (/(женщин\w*|мужчин\w*|девушк\w*|парн\w*|парень|жен\.|муж\.)\s*(от|до)?\s*\d{2}/.test(t)) return 'age-gender-restricted';
  return null;
}

async function scrapeChannel(ch) {
  try {
    const posts = await fetchChannel(ch.username);
    const jobs = [];
    let rejected = 0;
    for (const post of posts) {
      const job = parsePost(post);
      if (!job) continue;                                   // not a vacancy
      if (studentRejectReason(job.title, job.raw_text)) { rejected++; continue; }
      jobs.push(job);
    }
    console.log(`[${ch.username}] ${posts.length} posts → ${jobs.length} jobs (${rejected} filtered as non-student)`);
    return jobs;
  } catch (e) {
    console.log(`[${ch.username}] ERROR: ${e.message}`);
    return [];
  }
}

async function main() {
  console.log('═══════════════════════════════════════════');
  console.log('  SteppeUp Telegram Career Scraper');
  console.log(`  ${new Date().toISOString()}  | Mode: ${DRY_RUN ? 'DRY RUN' : 'LIVE'}`);
  console.log(`  Channels: ${CHANNELS.length}`);
  console.log('═══════════════════════════════════════════\n');

  let all = [];
  for (const ch of CHANNELS) {
    const jobs = await scrapeChannel(ch);
    all = all.concat(jobs);
    await sleep(1500 + Math.random() * 1500); // polite, jittered delay between channels
  }

  console.log(`\n── Parsed ${all.length} candidate jobs across ${CHANNELS.length} channels ──`);

  if (DRY_RUN) {
    all.slice(0, 12).forEach((j) =>
      console.log(`  • [@${j.source_channel}] ${j.title} @ ${j.company} | ${j.location} | ${j.type} | apply:${j.source_type} | skills:${j.skills.join(',') || '—'}`));
    if (all.length > 12) console.log(`  … and ${all.length - 12} more`);
    console.log('\n[DRY RUN] No DB writes.');
    return;
  }

  const fresh = await dedupe(db, all);
  console.log(`Dedup: ${all.length} → ${fresh.length} new jobs`);
  const { inserted, errors } = await upsertJobs(db, fresh);
  console.log(`Upserted ${inserted} jobs (${errors} errors)`);

  try {
    await db.from('scraping_logs').insert({
      source: 'telegram_career',
      jobs_found: inserted,
      jobs_removed: 0,
      status: 'success',
      details: { channels: CHANNELS.length, parsed: all.length, deduped: fresh.length },
    });
  } catch (e) { /* logs table optional */ }

  console.log('\n── Done ─────────────────────────────────');
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1); });
