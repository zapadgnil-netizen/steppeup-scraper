#!/usr/bin/env node
/**
 * digest.js — the daily Telegram post for the founder's channel @steppeup.
 *
 * Lists the student-suitable, Telegram-sourced jobs FIRST SEEN in the last 24
 * hours (jobs.created_at, which an upsert never rewrites), each with title,
 * employer, city, pay when known, and a link to its job page
 * https://steppeup.ai/job/<id>.
 *
 *   node digest.js --dry-run                 # print the message (reads rows from the DB)
 *   node digest.js --dry-run --rows=rows.json  # …or from a JSON file of rows
 *   node digest.js --dry-run --now=2026-11-17T08:00:00Z
 *   node digest.js --post                    # really post: needs DIGEST_BOT_TOKEN
 *
 * Nothing here is wired into any workflow: the founder has not confirmed a bot.
 * Posting needs DIGEST_BOT_TOKEN (and optionally DIGEST_CHAT_ID, default
 * "@steppeup"); the bot must be an admin of the channel. Without --post the
 * script only prints. The token is never printed.
 *
 * Two consecutive days never overlap: each run covers the half-open window
 * [now - 24h, now), so a job first seen at the boundary belongs to exactly one.
 */

const filter = require('./lib/filter');

const SOURCE = 'telegram_career';
const SITE = 'https://steppeup.ai';
const DEFAULTS = { hours: 24, limit: 10 };

const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const fmt = (n) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');

function payText(r) {
  const lo = r.salary_min, hi = r.salary_max;
  const cur = !r.currency || r.currency === 'KZT' ? '₸' : r.currency;
  if (lo && hi && hi !== lo) return `${fmt(lo)}–${fmt(hi)} ${cur}`;
  if (lo || hi) return `от ${fmt(lo || hi)} ${cur}`;
  return null;
}

const jobUrl = (id, base = SITE) => `${base}/job/${id}`;

/** Rows first seen inside [since, until), Telegram-sourced, active, student-suitable, de-duplicated. */
function selectRows(rows, { since, until }) {
  const seen = new Set();
  const out = [];
  for (const r of rows || []) {
    if (!r || r.id == null || r.source !== SOURCE || (r.status && r.status !== 'active')) continue;
    const t = Date.parse(r.created_at);
    if (!isFinite(t) || t < since.getTime() || t >= until.getTime()) continue;
    if (filter.studentRejectReason(r.title, r.description || r.raw_text || '', r.tags || [])) continue;
    const key = `${String(r.title).toLowerCase().trim()}|${String(r.company).toLowerCase().trim()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  // newest first
  return out.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
}

/**
 * buildDigest(rows, { now, hours, limit, base }) → { text, items, since, until, total }
 * `items` are the rows listed; each has a job-page URL in `url`.
 */
function buildDigest(rows, { now = new Date(), hours = DEFAULTS.hours, limit = DEFAULTS.limit, base = SITE } = {}) {
  const until = new Date(now);
  const since = new Date(until.getTime() - hours * 3600e3);
  const all = selectRows(rows, { since, until });
  const items = all.slice(0, limit).map((r) => ({ ...r, url: jobUrl(r.id, base) }));

  const date = until.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', timeZone: 'Asia/Almaty' });
  if (!items.length) return { text: '', items, since, until, total: 0, empty: true };

  const lines = [`<b>Новые вакансии для студентов — ${esc(date)}</b>`, ''];
  items.forEach((r, i) => {
    const meta = [r.company, r.location && r.location !== 'Kazakhstan' ? r.location : null, payText(r)].filter(Boolean).map(esc).join(' · ');
    lines.push(`${i + 1}. <a href="${esc(r.url)}">${esc(r.title)}</a>`);
    if (meta) lines.push(`   ${meta}`);
  });
  if (all.length > items.length) lines.push('', `Ещё ${all.length - items.length} на <a href="${esc(base)}/">${esc(base.replace(/^https?:\/\//, ''))}</a>`);
  return { text: lines.join('\n'), items, since, until, total: all.length, empty: false };
}

/** Default row loader: active Telegram rows created in the window, from Supabase. */
async function loadFromDb({ since, until, env = process.env }) {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_KEY) {
    throw new Error('no rows source: pass --rows=<file.json> or set SUPABASE_URL and SUPABASE_SERVICE_KEY');
  }
  const { createDb } = require('./lib/db');
  const db = createDb({ url: env.SUPABASE_URL, key: env.SUPABASE_SERVICE_KEY, log: () => {} });
  const res = await db.client.from('jobs')
    .select('id, title, company, location, salary_min, salary_max, currency, tags, source, status, created_at, description')
    .eq('source', SOURCE).eq('status', 'active')
    .gte('created_at', since.toISOString()).lt('created_at', until.toISOString())
    .order('created_at', { ascending: false }).limit(200);
  if (res.error) throw new Error('digest query failed: ' + (res.error.message || res.error.code || 'unknown'));
  return res.data || [];
}

/** Real posting. Requires the bot token; never logs it. */
async function sendTelegram(text, { env = process.env, fetchImpl } = {}) {
  const token = env.DIGEST_BOT_TOKEN;
  if (!token) throw new Error('refusing to post: DIGEST_BOT_TOKEN is not set (the digest bot has not been confirmed)');
  const chat = env.DIGEST_CHAT_ID || '@steppeup';
  const doFetch = fetchImpl || require('node-fetch');
  const res = await doFetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chat, text, parse_mode: 'HTML', disable_web_page_preview: true }),
  });
  if (!res.ok) throw new Error(`Telegram sendMessage failed: HTTP ${res.status}`);
  return true;
}

/**
 * run({ argv, env, now, loader, sender, out }) — the CLI body, injectable.
 * loader({ since, until }) → rows; sender(text) → posts.
 */
async function run({ argv = [], env = process.env, now = null, loader = null, sender = null, out = console.log } = {}) {
  const arg = (name) => (argv.find((a) => a.startsWith(`--${name}=`)) || '').split('=').slice(1).join('=');
  const post = argv.includes('--post') && !argv.includes('--dry-run');
  const hours = Number(arg('hours')) || DEFAULTS.hours;
  const limit = Number(arg('limit')) || DEFAULTS.limit;
  const at = arg('now') ? new Date(arg('now')) : (now || new Date());
  if (isNaN(at.getTime())) throw new Error('bad --now');

  if (post && !env.DIGEST_BOT_TOKEN) throw new Error('refusing to post: DIGEST_BOT_TOKEN is not set (the digest bot has not been confirmed); use --dry-run');

  const since = new Date(at.getTime() - hours * 3600e3);
  let load = loader;
  if (!load && arg('rows')) {
    const rows = JSON.parse(require('fs').readFileSync(arg('rows'), 'utf8'));
    load = async () => rows;
  }
  if (!load) load = (w) => loadFromDb({ ...w, env });

  const rows = await load({ since, until: at });
  const digest = buildDigest(rows, { now: at, hours, limit });

  if (digest.empty) { out(`[digest] no new student-suitable Telegram jobs in the last ${hours}h (${since.toISOString()} → ${at.toISOString()})`); return digest; }
  out(`[digest] ${post ? 'POSTING' : 'DRY RUN'} — ${digest.items.length} of ${digest.total} jobs, window ${since.toISOString()} → ${at.toISOString()}`);
  out(digest.text);
  if (post) { await (sender || ((t) => sendTelegram(t, { env })))(digest.text); out('[digest] posted'); }
  return digest;
}

module.exports = { buildDigest, selectRows, run, sendTelegram, jobUrl, payText, loadFromDb };

if (require.main === module) {
  run({ argv: process.argv.slice(2) }).catch((e) => { console.error('[digest] ' + e.message); process.exit(1); });
}
