/**
 * lib/health.js — observability. A run is `ok`, `degraded`, or `failed`.
 *
 *   const h = createHealth({ log });
 *   h.source('hh_kz', { found: 120, minExpected: 30, ... });   // per-source verdict
 *   h.problem('cleanup circuit breaker tripped');              // free-form
 *   h.verdict()  → { status, problems[], summary }
 *   await notify(text, { level })  → Telegram bot if configured, always stdout
 *
 * Alert config (GitHub secrets → env):
 *   ALERT_TELEGRAM_BOT_TOKEN, ALERT_TELEGRAM_CHAT_ID
 */

const fetch = require('node-fetch');

function createHealth({ log = console.log } = {}) {
  const sources = {};
  const problems = [];

  function source(name, { found = 0, minExpected = 0, canary = null, error = null, extra = {} } = {}) {
    const s = { found, minExpected, canary, error, ...extra };
    if (error) { s.verdict = 'error'; problems.push(`${name}: crashed — ${error}`); }
    else if (minExpected > 0 && found < minExpected) { s.verdict = 'low'; problems.push(`${name}: only ${found} jobs (expected ≥ ${minExpected})${canary && !canary.ok ? ' — canary: ' + canary.reason : ''}`); }
    else s.verdict = 'ok';
    if (canary && !canary.ok && s.verdict === 'ok') problems.push(`${name}: canary failed (${canary.reason}) but scrape yielded ${found} — check soon`);
    sources[name] = s;
    return s;
  }

  function problem(text) { problems.push(text); }

  function verdict({ fatal = false } = {}) {
    const status = fatal ? 'failed' : problems.length ? 'degraded' : 'ok';
    const lines = Object.entries(sources).map(([n, s]) => `${s.verdict === 'ok' ? '✅' : s.verdict === 'low' ? '⚠️' : '❌'} ${n}: ${s.found}${s.minExpected ? '/' + s.minExpected : ''}`);
    return { status, problems: problems.slice(), sources, summary: lines.join('\n') };
  }

  return { source, problem, verdict, sources, problems };
}

async function notify(text, { level = 'info', log = console.log } = {}) {
  const prefix = level === 'error' ? '🚨' : level === 'warn' ? '⚠️' : 'ℹ️';
  const msg = `${prefix} SteppeUp scraper\n${text}`;
  log('\n' + msg + '\n');
  const token = process.env.ALERT_TELEGRAM_BOT_TOKEN, chat = process.env.ALERT_TELEGRAM_CHAT_ID;
  if (!token || !chat) return false;
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text: msg.slice(0, 3900), disable_web_page_preview: true }),
      timeout: 10000,
    });
    if (!res.ok) log(`[alert] telegram ${res.status}`);
    return res.ok;
  } catch (e) { log(`[alert] telegram failed: ${e.message}`); return false; }
}

/** GitHub Actions step summary (shows on the run page) — no-op locally. */
function writeStepSummary(markdown) {
  const p = process.env.GITHUB_STEP_SUMMARY;
  if (!p) return;
  try { require('fs').appendFileSync(p, markdown + '\n'); } catch (_e) { /* ignore */ }
}

module.exports = { createHealth, notify, writeStepSummary };
