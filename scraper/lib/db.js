/**
 * lib/db.js — Supabase access. Hardened upsert (batch → per-row → update/insert
 * fallback → write verification), active-count, run logging.
 *
 * Production public.scraping_logs (verified 2026-09-13) is
 *   id, ran_at, jobs_found, jobs_removed, status, details
 * — there is no `source` column. Keep source/metrics in details (PGRST204
 * if `source` is sent as a column). Logging stays best-effort, never fatal.
 *
 * Board counts: `{ count:'exact', head:true }` has returned an error object
 * with an empty message. The only extra diagnostic is often the outer HTTP
 * status/statusText on the PostgREST response. Retry GET Range 0-0; keep both
 * HEAD and GET failure text. Do not coerce a missing count to 0.
 * Live workflow rerun is what confirms recovery.
 */

const { createClient } = require('@supabase/supabase-js');
const WebSocket = require('ws');
const { toRow } = require('./normalize');

function formatPgError(error, fallback = 'unknown error') {
  if (error == null || error === '') return fallback;
  if (typeof error === 'string') return error.trim() || fallback;
  const parts = [];
  if (error.message) parts.push(String(error.message));
  if (error.code) parts.push('code=' + error.code);
  if (error.details) parts.push(String(error.details));
  if (error.hint) parts.push('hint=' + error.hint);
  if (error.status != null && error.status !== '') parts.push('status=' + error.status);
  if (parts.length) return parts.join(' | ');
  return fallback;
}

function formatHttpStatus(res = {}) {
  if (res.status == null && (res.statusText == null || res.statusText === '')) return '';
  const code = res.status == null ? '' : String(res.status);
  const text = (res.statusText == null || res.statusText === '') ? '' : String(res.statusText);
  if (code && text) return 'http ' + code + ' ' + text;
  if (code) return 'http ' + code;
  return 'http ' + text;
}

/** Null/undefined must not become 0: Number(null) === 0. */
function asNonNegativeInt(count) {
  if (count == null) return null;
  if (typeof count !== 'number' || !Number.isInteger(count) || count < 0) return null;
  return count;
}

function formatCountFailure(res = {}, fallback = 'empty error') {
  const parts = [];
  if (res.error) parts.push(formatPgError(res.error, fallback));
  else if (asNonNegativeInt(res.count) == null) parts.push('missing exact count');
  const http = formatHttpStatus(res);
  if (http) parts.push(http);
  return parts.length ? parts.join(' | ') : fallback;
}

function parseExactCount(res = {}, { label = 'count' } = {}) {
  const n = asNonNegativeInt(res.count);
  if (res.error || n == null) {
    throw new Error(label + ': ' + formatCountFailure(res, 'empty error'));
  }
  return n;
}

/** Compatible insert row for production scraping_logs — no `source` column. */
function scrapingLogPayload({ source, jobs_found = 0, jobs_removed = 0, status = 'success', details = {} } = {}) {
  const extra = (details && typeof details === 'object' && !Array.isArray(details)) ? details : { value: details };
  return {
    jobs_found,
    jobs_removed,
    status,
    details: { ...extra, source },
  };
}

async function countActive(client, { log = console.log, source } = {}) {
  const run = ({ head }) => {
    let q = client.from('jobs').select('id', { count: 'exact', head }).eq('status', 'active');
    if (source) q = q.eq('source', source);
    if (!head) q = q.range(0, 0);
    return q;
  };

  const headRes = await run({ head: true });
  const headCount = asNonNegativeInt(headRes.count);
  if (!headRes.error && headCount != null) return headCount;

  const headWhy = formatCountFailure(headRes, 'empty error');
  log(`[db] HEAD active count failed (${headWhy}); retrying GET range 0-0`);

  const getRes = await run({ head: false });
  const getCount = asNonNegativeInt(getRes.count);
  if (!getRes.error && getCount != null) return getCount;

  const getWhy = formatCountFailure(getRes, 'empty error');
  throw new Error('activeCount: GET failed (' + getWhy + '); HEAD also failed (' + headWhy + ')');
}

function createDb({ url, key, log = console.log, client = null } = {}) {
  if (!client) {
    if (!url || !key) return null;
    client = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false },
      realtime: { transport: WebSocket },
    });
  }

  /** Upsert jobs; never lets one bad row sink the batch. Returns counts. */
  async function upsertJobs(jobs, { batchSize = 50 } = {}) {
    const rows = jobs.map(toRow);
    let ok = 0, errors = 0; const errorSamples = [];
    for (let i = 0; i < rows.length; i += batchSize) {
      const batch = rows.slice(i, i + batchSize);
      const { error } = await client.from('jobs').upsert(batch, { onConflict: 'source_id', ignoreDuplicates: false });
      if (!error) { ok += batch.length; continue; }
      log(`[db] batch upsert FAILED (${error.code || '?'}): ${error.message} — retrying per-row`);
      for (const row of batch) {
        const { error: e1 } = await client.from('jobs').upsert(row, { onConflict: 'source_id', ignoreDuplicates: false });
        if (!e1) { ok++; continue; }
        const { data: existing } = await client.from('jobs').select('id').eq('source_id', row.source_id).limit(1);
        const op = existing && existing.length
          ? client.from('jobs').update(row).eq('id', existing[0].id)
          : client.from('jobs').insert(row);
        const { error: e2 } = await op;
        if (!e2) { ok++; continue; }
        errors++;
        if (errorSamples.length < 5) errorSamples.push(`${row.source_id}: (${e2.code || '?'}) ${e2.message}`);
      }
    }
    // Missing count ≠ "0 present".
    let verified = null;
    if (rows.length) {
      const sample = rows.slice(0, 10).map((r) => r.source_id);
      const { count, error } = await client.from('jobs').select('id', { count: 'exact', head: true }).in('source_id', sample);
      const n = asNonNegativeInt(count);
      if (!error && n != null) verified = { present: n, sampled: sample.length };
    }
    return { ok, errors, errorSamples, verified };
  }

  async function activeCount(source) {
    return countActive(client, { log, source });
  }

  // Same all-source scan as v2: every `source` value present on active rows,
  // not a hardcoded list. Errors throw (caller records the problem).
  async function activeCountsBySource() {
    const res = await client.from('jobs').select('source').eq('status', 'active').limit(5000);
    if (res.error) throw new Error('activeCountsBySource: ' + formatCountFailure(res, 'empty error'));
    const out = {};
    for (const r of res.data || []) out[r.source] = (out[r.source] || 0) + 1;
    return out;
  }

  /**
   * Active rows of one source posted inside the TTL — the repost check and the
   * "keep what an earlier run decided" lookup. Read-only. Throws on error so the
   * caller can say the check was skipped (never silently pretend there were none).
   */
  async function recentRows(source, { sinceDays = 21, limit = 3000 } = {}) {
    const since = new Date(Date.now() - sinceDays * 864e5).toISOString();
    const res = await client.from('jobs')
      .select('source_id, source_channel, title, company, apply_url, source_type, posted_at')
      .eq('source', source).eq('status', 'active').gte('posted_at', since)
      .order('posted_at', { ascending: false }).limit(limit);
    if (res.error) throw new Error('recentRows: ' + formatPgError(res.error));
    return res.data || [];
  }

  /** Write one scraping_logs row; failures are reported but never fatal. */
  async function logRun(row) {
    try {
      const { error } = await client.from('scraping_logs').insert(scrapingLogPayload(row));
      if (error) { log(`[db] scraping_logs insert failed (${error.code || '?'}): ${formatPgError(error)}`); return false; }
      return true;
    } catch (e) { log(`[db] scraping_logs insert threw: ${e.message}`); return false; }
  }

  return { client, upsertJobs, activeCount, activeCountsBySource, recentRows, logRun };
}

module.exports = {
  createDb,
  formatPgError,
  formatCountFailure,
  asNonNegativeInt,
  scrapingLogPayload,
  parseExactCount,
  countActive,
};
