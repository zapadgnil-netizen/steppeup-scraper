/**
 * GET /sitemap.xml  (rewritten to /api/sitemap by vercel.json)
 *
 * The home page plus every ACTIVE job.  Active-only is enforced twice: the
 * query filters status=eq.active and RLS hides everything else from the anon
 * key.  A job that expires (status != 'active') therefore disappears the next
 * time the sitemap is rebuilt, i.e. within the CDN window below.
 */
const SITE = 'https://steppeup.ai';
const DEFAULT_SB_URL = 'https://wiijdddhzddqgntfdbsx.supabase.co';
const DEFAULT_SB_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IndpaWpkZGRoemRkcWdudGZkYnN4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzE1NDI0NjIsImV4cCI6MjA4NzExODQ2Mn0.rQyTBlIA1WVU-KfFyF8sXK8GVZUL9m9yFIHTydXPHe0';
const PAGE_SIZE = 1000;          // PostgREST default max rows per request
const MAX_URLS = 50000;          // sitemap protocol limit per file
const TOTAL_BUDGET_MS = 25000;   // well inside any plan's function duration
const CACHE = 'public, s-maxage=3600, stale-while-revalidate=86400';

function xmlEscape(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function isoDate(value) {
  const d = new Date(value);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

function buildSitemap(jobs, nowIso) {
  const out = ['<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    '<url><loc>' + SITE + '/</loc><lastmod>' + xmlEscape(nowIso) + '</lastmod></url>'];
  jobs.slice(0, MAX_URLS - 1).forEach(function (job) {
    const id = String(job.id);
    if (!/^[1-9]\d{0,17}$/.test(id)) return;
    const lastmod = isoDate(job.updated_at) || isoDate(job.posted_at) || isoDate(job.created_at);
    out.push('<url><loc>' + SITE + '/job/' + id + '</loc>' + (lastmod ? '<lastmod>' + lastmod + '</lastmod>' : '') + '</url>');
  });
  out.push('</urlset>');
  return out.join('\n') + '\n';
}

// Keyset pagination (id > last, ordered by id) stays correct if rows change
// between pages: no row is skipped or repeated.  We stop only on an EMPTY page,
// never on a short one: PostgREST may cap a page below our limit (max-rows), and a
// short page would then silently drop the rest of the jobs.
async function fetchActiveJobs(doFetch, env) {
  const base = (env.SUPABASE_URL || DEFAULT_SB_URL).replace(/\/$/, '');
  const key = env.SUPABASE_ANON_KEY || DEFAULT_SB_ANON_KEY;
  const deadline = Date.now() + TOTAL_BUDGET_MS;
  const jobs = [];
  let last = 0;
  while (jobs.length < MAX_URLS) {
    if (Date.now() > deadline) throw new Error('sitemap time budget exceeded');
    const url = base + '/rest/v1/jobs?status=eq.active&id=gt.' + last +
      '&select=id,updated_at,posted_at,created_at&order=id.asc&limit=' + PAGE_SIZE;
    const res = await doFetch(url, {
      headers: { apikey: key, Authorization: 'Bearer ' + key },
      signal: AbortSignal.timeout(8000)
    });
    if (!res.ok) throw new Error('jobs page failed: HTTP ' + res.status);
    const rows = await res.json();
    if (!Array.isArray(rows)) throw new Error('unexpected jobs response');
    if (rows.length === 0) break;
    const next = Number(rows[rows.length - 1].id);
    if (!Number.isSafeInteger(next) || next <= last) throw new Error('jobs paging did not advance');
    jobs.push.apply(jobs, rows);
    last = next;
  }
  return jobs;
}

function createSitemapHandler(deps) {
  const doFetch = (deps && deps.fetch) || function () { return fetch.apply(null, arguments); };
  const env = (deps && deps.env) || process.env;
  return async function sitemap(req, res) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.statusCode = 405; res.setHeader('Allow', 'GET, HEAD'); res.end('Method not allowed'); return;
    }
    try {
      const jobs = await fetchActiveJobs(doFetch, env);
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/xml; charset=utf-8');
      res.setHeader('Cache-Control', CACHE);
      res.end(buildSitemap(jobs, new Date().toISOString()));
    } catch (err) {
      // Never cache a partial or empty sitemap.
      console.error('[SITEMAP] build failed:', err.message);
      res.statusCode = 503;
      res.setHeader('Retry-After', '300');
      res.setHeader('Cache-Control', 'no-store');
      res.end('Sitemap temporarily unavailable');
    }
  };
}

module.exports = createSitemapHandler();
module.exports.createSitemapHandler = createSitemapHandler;
module.exports.buildSitemap = buildSitemap;
module.exports.fetchActiveJobs = fetchActiveJobs;
