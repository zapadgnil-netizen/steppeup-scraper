/**
 * GET /job/:id  (rewritten to /api/job-page?id=:id by vercel.json)
 *
 * Returns the real index.html with the <head> rewritten for one job, JobPosting
 * JSON-LD, and a <noscript> summary, so link previews (Telegram, WhatsApp) and
 * crawlers see the job without running JavaScript.  The client router still
 * boots as usual and opens the job from the URL.
 *
 * Job text is untrusted: every injected value is HTML-escaped, JSON-LD is made
 * safe inside <script>, and for source = 'telegram_career' contact details
 * (e-mail, phone, @username, t.me links) are masked in everything we inject.
 *
 * index.html is bundled with this function (vercel.json -> functions ->
 * includeFiles), so the shell and the function always come from the same
 * deployment and cannot drift apart.
 */
const fs = require('fs');
const path = require('path');

const SITE = 'https://steppeup.ai';
// Public by design (same values as index.html); RLS exposes active jobs only.
const DEFAULT_SB_URL = 'https://wiijdddhzddqgntfdbsx.supabase.co';
const DEFAULT_SB_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IndpaWpkZGRoemRkcWdudGZkYnN4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzE1NDI0NjIsImV4cCI6MjA4NzExODQ2Mn0.rQyTBlIA1WVU-KfFyF8sXK8GVZUL9m9yFIHTydXPHe0';

const JOB_SELECT = 'id,source,title,company,location,description,salary_min,salary_max,currency,tags,status,posted_at,created_at,updated_at';
const MASK = '[контакт скрыт]';
const OK_CACHE = 'public, s-maxage=300, stale-while-revalidate=3600';
const MISS_CACHE = 'public, s-maxage=60, stale-while-revalidate=300';

// ---------------------------------------------------------------- helpers

function esc(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// JSON that is safe to embed inside <script type="application/ld+json">.
function safeJson(obj) {
  return JSON.stringify(obj)
    .replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

function parseJobId(raw) {
  if (typeof raw !== 'string') return null;
  return /^[1-9]\d{0,17}$/.test(raw) ? raw : null;
}

// Kazakh/Russian numbers are written as country code + 3 + 3 + 2 + 2 digits, with
// any of space - . ( ) between the groups.  Requiring that shape (instead of "any
// 10 digits") keeps salary ranges such as 70000-80000 or 70 000-80 000 intact.
const PHONE_SEP = '[\\s\\-.]*';
const PHONE_RE = new RegExp(
  '(?<![\\w+])(?:' +
    '(?:\\+\\s?7|[78])' + PHONE_SEP + '\\(?\\d{3}\\)?' + PHONE_SEP + '\\d{3}' + PHONE_SEP + '\\d{2}' + PHONE_SEP + '\\d{2}' +
  '|' +
    '(?:\\+\\s?7|8)' + PHONE_SEP + '\\(\\d{3,5}\\)' + PHONE_SEP + '\\d{2,3}' + PHONE_SEP + '\\d{2}' + PHONE_SEP + '\\d{2}' +
  '|' +
    '\\(?[67]\\d{2}\\)?' + PHONE_SEP + '\\d{3}' + PHONE_SEP + '\\d{2}' + PHONE_SEP + '\\d{2}' +
  ')(?!\\d)', 'g');

function maskContacts(text) {
  return String(text == null ? '' : text)
    .replace(/[A-Za-z0-9._%+\-]+@[A-Za-z0-9\-]+(?:\.[A-Za-z0-9\-]+)+/g, MASK)
    .replace(/(?:https?:\/\/)?(?:www\.)?(?:t\.me|telegram\.me|telegram\.dog|wa\.me|api\.whatsapp\.com|chat\.whatsapp\.com)\/[^\s,;)]*/gi, MASK)
    .replace(PHONE_RE, MASK)
    .replace(/(^|[^\w@/.])@[A-Za-z][A-Za-z0-9_]{2,}/g, function (m, before) { return before + MASK; });
}

function plainText(value) {
  return String(value == null ? '' : value)
    .replace(/<\/?[A-Za-z!][^>]*>/g, ' ')   // real tags only: keep "<1 года", ">18"
    .replace(/[\u2028\u2029]/g, ' ')
    .replace(/[ \t\r\f\v]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}

function truncate(text, max) {
  const flat = String(text).replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  const sp = cut.lastIndexOf(' ');
  return (sp > max * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s.,;:\-–—]+$/, '') + '…';
}

function employmentTypeFromTags(tags) {
  if (!Array.isArray(tags)) return undefined;
  const joined = tags.join(' ').toLowerCase();
  if (/стажиров|intern/.test(joined)) return 'INTERN';
  if (/неполный день|частичная занятость|part[\s-]?time/.test(joined)) return 'PART_TIME';
  return undefined;
}

function groupDigits(n) {
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, '\u00a0');
}

const CURRENCY_SIGN = { KZT: '₸', USD: '$', EUR: '€', RUB: '₽' };

function payText(job) {
  const min = Number(job.salary_min) > 0 ? Number(job.salary_min) : 0;
  const max = Number(job.salary_max) > 0 ? Number(job.salary_max) : 0;
  if (!min && !max) return '';
  const cur = CURRENCY_SIGN[job.currency] || job.currency || '₸';
  if (min && max && min !== max) return 'от ' + groupDigits(min) + ' до ' + groupDigits(max) + ' ' + cur;
  if (min && max) return groupDigits(min) + ' ' + cur;
  return (min ? 'от ' + groupDigits(min) : 'до ' + groupDigits(max)) + ' ' + cur;
}

// ---------------------------------------------------------------- rendering

function view(job) {
  const clean = job.source === 'telegram_career' ? maskContacts : function (s) { return s; };
  const text = function (v) { return clean(plainText(v)); };
  return {
    id: String(job.id),
    title: text(job.title).replace(/\s+/g, ' '),
    company: text(job.company).replace(/\s+/g, ' '),
    city: text(job.location).replace(/\s+/g, ' '),
    description: text(job.description),
    pay: payText(job),
    employmentType: employmentTypeFromTags(job.tags),
    datePosted: job.posted_at || job.created_at || undefined
  };
}

function buildMeta(v) {
  const where = [v.company, v.city].filter(Boolean).join(', ');
  const title = v.title + (where ? ' — ' + where : '') + ' | SteppeUp';
  const lead = 'Вакансия: ' + v.title + (v.company ? ' в ' + v.company : '') + (v.city ? ', ' + v.city : '') + '.';
  const parts = [lead];
  if (v.pay) parts.push('Зарплата: ' + v.pay + '.');
  const room = 200 - parts.join(' ').length;
  if (room > 40 && v.description) parts.push(truncate(v.description, room));
  const description = parts.join(' ');
  const ogTitle = v.title + (where ? ' — ' + where : '');
  return { title: title, description: description, ogTitle: ogTitle };
}

function buildJsonLd(v) {
  const ld = {
    '@context': 'https://schema.org',
    '@type': 'JobPosting',
    title: v.title,
    description: v.description || v.title,
    url: SITE + '/job/' + v.id,
    hiringOrganization: { '@type': 'Organization', name: v.company }
  };
  if (v.datePosted) ld.datePosted = v.datePosted;
  if (v.city) {
    ld.jobLocation = {
      '@type': 'Place',
      address: { '@type': 'PostalAddress', addressLocality: v.city, addressCountry: 'KZ' }
    };
  }
  if (v.employmentType) ld.employmentType = v.employmentType;
  if (v._salary) ld.baseSalary = v._salary;
  return ld;
}

function salaryObject(job) {
  const min = Number(job.salary_min) > 0 ? Number(job.salary_min) : 0;
  const max = Number(job.salary_max) > 0 ? Number(job.salary_max) : 0;
  if (!min && !max) return null;
  const value = { '@type': 'QuantitativeValue', unitText: 'MONTH' };
  if (min && max && min !== max) { value.minValue = min; value.maxValue = max; }
  else value.value = min || max;
  return { '@type': 'MonetaryAmount', currency: job.currency || 'KZT', value: value };
}

// ---- head rewriting --------------------------------------------------------
// Every tag we rewrite must exist EXACTLY ONCE in <head>; anything else means
// index.html drifted and we must not emit a page that quietly keeps the home
// page's tags.  Errors are thrown here, caught by the handler (which then serves
// the plain shell, uncached and noindex) and caught earlier by the tests, which
// render the real index.html.
//
// All replacements use a function or slicing, never a replacement string, so "$&",
// "$1", "$`", "$'" in job text stay literal.
function shellError(msg) { return new Error('index.html shell: ' + msg); }

function splitHead(html) {
  const i = html.indexOf('</head>');
  if (i < 0) throw shellError('no </head>');
  return { head: html.slice(0, i), rest: html.slice(i) };
}

function tagMatches(head, tagName, attrName, attrValue) {
  const tagRe = new RegExp('<' + tagName + '\\b(?:"[^"]*"|\'[^\']*\'|[^>"\'])*>', 'gi');
  const attrRe = new RegExp('\\s' + attrName + '\\s*=\\s*(?:"' + attrValue + '"|\'' + attrValue + '\')', 'i');
  const found = [];
  let m;
  while ((m = tagRe.exec(head)) !== null) {
    if (attrRe.test(m[0])) found.push({ start: m.index, end: m.index + m[0].length });
  }
  return found;
}

function replaceTag(head, tagName, attrName, attrValue, replacement) {
  const found = tagMatches(head, tagName, attrName, attrValue);
  if (found.length !== 1) throw shellError('expected exactly one <' + tagName + ' ' + attrName + '="' + attrValue + '">, found ' + found.length);
  return head.slice(0, found[0].start) + replacement + head.slice(found[0].end);
}

function setTitle(head, v) {
  const re = /<title\b[^>]*>[\s\S]*?<\/title>/gi;
  const found = head.match(re) || [];
  if (found.length !== 1) throw shellError('expected exactly one <title>, found ' + found.length);
  return head.replace(re, function () { return '<title>' + esc(v) + '</title>'; });
}
function setNamedMeta(head, name, v) { return replaceTag(head, 'meta', 'name', name, '<meta name="' + name + '" content="' + esc(v) + '">'); }
function setPropMeta(head, prop, v) { return replaceTag(head, 'meta', 'property', prop, '<meta property="' + prop + '" content="' + esc(v) + '">'); }
function setCanonical(head, url) { return replaceTag(head, 'link', 'rel', 'canonical', '<link rel="canonical" href="' + esc(url) + '">'); }
function removeCanonical(head) { return replaceTag(head, 'link', 'rel', 'canonical', ''); }
function setRobots(head, content) { return replaceTag(head, 'meta', 'name', 'robots', '<meta name="robots" content="' + content + '">'); }
function afterBodyStart(rest, block) {
  const re = /<body\b[^>]*>/i;
  if (!re.test(rest)) throw shellError('no <body> after </head>');
  return rest.replace(re, function (m) { return m + block; });
}

function renderJobPage(shell, job) {
  const v = view(job);
  v._salary = salaryObject(job);
  const m = buildMeta(v);
  const url = SITE + '/job/' + v.id;

  const parts = splitHead(shell);
  let head = parts.head;
  head = setTitle(head, m.title);
  head = setNamedMeta(head, 'description', m.description);
  head = setCanonical(head, url);
  head = setPropMeta(head, 'og:title', m.ogTitle);
  head = setPropMeta(head, 'og:description', m.description);
  head = setPropMeta(head, 'og:url', url);
  head = setNamedMeta(head, 'twitter:title', m.ogTitle);
  head = setNamedMeta(head, 'twitter:description', m.description);
  head += '<script type="application/ld+json" id="jobposting-ld">' + safeJson(buildJsonLd(v)) + '</script>\n';

  const where = [v.company, v.city].filter(Boolean).join(', ');
  const noscript = '<noscript><main style="max-width:720px;margin:24px auto;padding:0 16px;font-family:sans-serif">' +
    '<h1>' + esc(v.title) + '</h1>' +
    (where ? '<p>' + esc(where) + '</p>' : '') +
    (v.pay ? '<p>' + esc(v.pay) + '</p>' : '') +
    (v.description ? '<p style="white-space:pre-line">' + esc(truncate(v.description, 800)) + '</p>' : '') +
    '<p><a href="/">Все вакансии на SteppeUp</a></p>' +
    '<p>Для отклика включите JavaScript.</p></main></noscript>';
  return head + afterBodyStart(parts.rest, noscript);
}

function renderNotFoundPage(shell, options) {
  const unavailable = options && options.unavailable;
  const title = unavailable ? 'Вакансия временно недоступна | SteppeUp' : 'Вакансия не найдена | SteppeUp';
  const desc = unavailable
    ? 'Не удалось загрузить вакансию. Попробуйте позже.'
    : 'Эта вакансия закрыта или не существует. Посмотрите другие вакансии на SteppeUp.';
  const parts = splitHead(shell);
  let head = parts.head;
  head = setTitle(head, title);
  head = setNamedMeta(head, 'description', desc);
  head = setPropMeta(head, 'og:title', title);
  head = setPropMeta(head, 'og:description', desc);
  head = setPropMeta(head, 'og:url', SITE + '/');
  head = setNamedMeta(head, 'twitter:title', title);
  head = setNamedMeta(head, 'twitter:description', desc);
  head = removeCanonical(head);
  head = setRobots(head, 'noindex,follow');
  return head + afterBodyStart(parts.rest,
    '<noscript><main style="max-width:720px;margin:24px auto;padding:0 16px;font-family:sans-serif">' +
    '<h1>' + esc(title.replace(' | SteppeUp', '')) + '</h1>' +
    '<p><a href="/">Все вакансии на SteppeUp</a></p></main></noscript>');
}

// ---------------------------------------------------------------- data

let shellCache = null;
function loadShell() {
  // Deployment bundles are immutable, so reading once per instance is safe.
  if (shellCache) return shellCache;
  const candidates = [
    path.join(__dirname, '..', 'index.html'),
    path.join(process.cwd(), 'index.html')
  ];
  for (const file of candidates) {
    try { shellCache = fs.readFileSync(file, 'utf8'); return shellCache; } catch (e) { /* try next */ }
  }
  throw new Error('index.html is not bundled with the function');
}

async function fetchJob(id) {
  const base = (process.env.SUPABASE_URL || DEFAULT_SB_URL).replace(/\/$/, '');
  const url = base + '/rest/v1/jobs?id=eq.' + id + '&status=eq.active&select=' + JOB_SELECT + '&limit=1';
  // The anon key is enough (RLS shows active jobs only) and keeps the service
  // key out of this public, cacheable route.
  const key = process.env.SUPABASE_ANON_KEY || DEFAULT_SB_ANON_KEY;
  const res = await fetch(url, {
    headers: { apikey: key, Authorization: 'Bearer ' + key, Accept: 'application/json' },
    signal: AbortSignal.timeout(6000)
  });
  if (!res.ok) throw new Error('jobs lookup failed: HTTP ' + res.status);
  const rows = await res.json();
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

// ---------------------------------------------------------------- handler

function idFrom(req) {
  if (req.query && req.query.id !== undefined) return req.query.id;
  const m = String(req.url || '').match(/^\/job\/([^/?#]+)/);
  return m ? m[1] : undefined;
}

function send(res, status, html, cache) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', cache);
  res.end(html);
}

// If the shell can no longer be rewritten (index.html drifted), users still get
// the working app, but never with another page's tags, never cached, never indexed.
function sendRender(res, status, cache, shell, render) {
  let html;
  try { html = render(); } catch (err) {
    console.error('[JOB-PAGE] head rewrite failed, serving plain shell:', err.message);
    res.setHeader('X-Robots-Tag', 'noindex');
    send(res, status, shell, 'no-store');
    return;
  }
  send(res, status, html, cache);
}

function createJobPageHandler(deps) {
  const getShell = (deps && deps.loadShell) || loadShell;
  const getJob = (deps && deps.fetchJob) || fetchJob;
  return async function jobPage(req, res) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.statusCode = 405;
      res.setHeader('Allow', 'GET, HEAD');
      res.end('Method not allowed');
      return;
    }
    let shell;
    try { shell = getShell(); } catch (err) {
      console.error('[JOB-PAGE] shell unavailable:', err.message);
      res.statusCode = 500;
      res.setHeader('Cache-Control', 'no-store');
      res.end('Service unavailable');
      return;
    }
    const id = parseJobId(idFrom(req));
    if (!id) { sendRender(res, 404, MISS_CACHE, shell, function () { return renderNotFoundPage(shell); }); return; }
    let job;
    try { job = await getJob(id); } catch (err) {
      console.error('[JOB-PAGE] lookup failed for', id, err.message);
      res.setHeader('Retry-After', '30');
      sendRender(res, 503, 'no-store', shell, function () { return renderNotFoundPage(shell, { unavailable: true }); });
      return;
    }
    if (!job) { sendRender(res, 404, MISS_CACHE, shell, function () { return renderNotFoundPage(shell); }); return; }
    sendRender(res, 200, OK_CACHE, shell, function () { return renderJobPage(shell, job); });
  };
}

module.exports = createJobPageHandler();
module.exports.createJobPageHandler = createJobPageHandler;
module.exports.renderJobPage = renderJobPage;
module.exports.renderNotFoundPage = renderNotFoundPage;
module.exports.maskContacts = maskContacts;
module.exports.parseJobId = parseJobId;
module.exports.employmentTypeFromTags = employmentTypeFromTags;
module.exports.JOB_SELECT = JOB_SELECT;
