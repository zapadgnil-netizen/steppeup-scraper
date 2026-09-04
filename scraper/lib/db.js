/**
 * lib/db.js — Supabase access. Hardened upsert (batch → per-row → update/insert
 * fallback → write verification), active-count, run logging.
 */

const { createClient } = require('@supabase/supabase-js');
const WebSocket = require('ws');
const { toRow } = require('./normalize');

function createDb({ url, key, log = console.log }) {
  if (!url || !key) return null;
  const client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    realtime: { transport: WebSocket },
  });

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
    // Verify a sample actually landed.
    let verified = null;
    if (rows.length) {
      const sample = rows.slice(0, 10).map((r) => r.source_id);
      const { count, error } = await client.from('jobs').select('id', { count: 'exact', head: true }).in('source_id', sample);
      verified = error ? null : { present: count || 0, sampled: sample.length };
    }
    return { ok, errors, errorSamples, verified };
  }

  async function activeCount(source) {
    let q = client.from('jobs').select('id', { count: 'exact', head: true }).eq('status', 'active');
    if (source) q = q.eq('source', source);
    const { count, error } = await q;
    if (error) throw new Error('activeCount: ' + error.message);
    return count || 0;
  }

  async function activeCountsBySource() {
    const { data, error } = await client.from('jobs').select('source').eq('status', 'active').limit(5000);
    if (error) throw new Error('activeCountsBySource: ' + error.message);
    const out = {};
    for (const r of data || []) out[r.source] = (out[r.source] || 0) + 1;
    return out;
  }

  /** Write one scraping_logs row; failures are reported but never fatal. */
  async function logRun({ source, jobs_found = 0, jobs_removed = 0, status = 'success', details = {} }) {
    try {
      const { error } = await client.from('scraping_logs').insert({ source, jobs_found, jobs_removed, status, details });
      if (error) { log(`[db] scraping_logs insert failed (${error.code || '?'}): ${error.message}`); return false; }
      return true;
    } catch (e) { log(`[db] scraping_logs insert threw: ${e.message}`); return false; }
  }

  return { client, upsertJobs, activeCount, activeCountsBySource, logRun };
}

module.exports = { createDb };
