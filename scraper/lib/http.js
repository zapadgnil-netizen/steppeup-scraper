/**
 * lib/http.js — the only place that talks to the network.
 *
 * - timeout + retries with exponential backoff and jitter
 * - User-Agent rotation (real browser strings)
 * - 429/503 handled as "back off", 403 surfaced as-is (callers decide)
 * - HTML entity decoding helper (hh.kz encodes its embedded JSON as &#34; etc.)
 * - request budget so a runaway source can't eat the whole workflow timeout
 */

const fetch = require('node-fetch');

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:127.0) Gecko/20100101 Firefox/127.0',
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pickUA = () => USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];

class HttpError extends Error {
  constructor(status, url, body) {
    super(`HTTP ${status} for ${url}`);
    this.status = status; this.url = url; this.body = body;
  }
}

function createHttp({ log = console.log, budget = 2000, defaultTimeout = 20000 } = {}) {
  let used = 0;
  const stats = { requests: 0, retries: 0, failures: 0, byStatus: {} };

  async function request(url, { headers = {}, retries = 3, baseDelay = 1200, timeout = defaultTimeout, method = 'GET', body } = {}) {
    if (used >= budget) throw new Error(`http budget exhausted (${budget} requests)`);
    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
      used++; stats.requests++;
      try {
        const res = await fetch(url, {
          method, body, redirect: 'follow', timeout,
          headers: {
            'User-Agent': pickUA(),
            'Accept': 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
            'Accept-Language': 'ru-RU,ru;q=0.9,kk;q=0.8,en;q=0.7',
            ...headers,
          },
        });
        stats.byStatus[res.status] = (stats.byStatus[res.status] || 0) + 1;
        if (res.status === 429 || res.status === 503 || res.status === 502) {
          const wait = baseDelay * Math.pow(2, attempt) + Math.random() * 500;
          log(`[http] ${res.status} ${url} — backing off ${Math.round(wait)}ms`);
          stats.retries++;
          await sleep(wait);
          continue;
        }
        return res;
      } catch (e) {
        lastErr = e;
        stats.retries++;
        await sleep(baseDelay * Math.pow(2, attempt) + Math.random() * 300);
      }
    }
    stats.failures++;
    throw lastErr || new Error('fetch failed: ' + url);
  }

  /** GET text; throws HttpError on non-2xx (except when `allow` includes the status). */
  async function text(url, opts = {}) {
    const res = await request(url, opts);
    const allow = opts.allow || [];
    if (!res.ok && !allow.includes(res.status)) {
      let snippet = '';
      try { snippet = (await res.text()).slice(0, 200); } catch (_e) { /* ignore */ }
      throw new HttpError(res.status, url, snippet);
    }
    return { status: res.status, body: await res.text(), headers: res.headers };
  }

  /** GET JSON; same error semantics as text(). */
  async function json(url, opts = {}) {
    const r = await text(url, { ...opts, headers: { Accept: 'application/json', ...(opts.headers || {}) } });
    try { return { status: r.status, body: JSON.parse(r.body) }; }
    catch (e) { throw new Error(`bad JSON from ${url}: ${e.message}`); }
  }

  /** HEAD/GET status only — for liveness checks. Never throws on HTTP status. */
  async function status(url, opts = {}) {
    try { const res = await request(url, { ...opts, retries: 1 }); return res.status; }
    catch (_e) { return 0; }
  }

  return { request, text, json, status, sleep, stats, get used() { return used; } };
}

/** Decode the HTML entities that appear in attribute/template-embedded JSON. */
function decodeEntities(s) {
  if (!s || s.indexOf('&') === -1) return s;
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(parseInt(n, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
}

/**
 * Parse a JSON blob embedded in a <template id="..."> (hh.kz style). Handles
 * both raw and entity-encoded payloads. Returns null when absent/unparseable —
 * callers must treat null as "page shape changed", not "no results".
 */
function extractTemplateJson(html, templateId) {
  const re = new RegExp('<template[^>]*id="' + templateId + '"[^>]*>([\\s\\S]*?)</template>');
  const m = html.match(re);
  if (!m) return null;
  const raw = m[1].trim();
  for (const candidate of [raw, decodeEntities(raw)]) {
    try { return JSON.parse(candidate); } catch (_e) { /* try next */ }
  }
  return null;
}

function stripHtml(html) {
  if (!html) return '';
  return decodeEntities(String(html)
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|li|div|h\d|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, ' '))
    .replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
}

module.exports = { createHttp, decodeEntities, extractTemplateJson, stripHtml, HttpError, sleep, USER_AGENTS };
