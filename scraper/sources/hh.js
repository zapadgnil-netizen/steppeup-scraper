/**
 * sources/hh.js — HeadHunter Kazakhstan (hh.kz) via the public HTML search page.
 *
 * READ THIS BEFORE CHANGING ANYTHING. This source has silently produced zero
 * rows twice while the CI run stayed green:
 *
 *   1. api.hh.ru returns 403 for every datacenter/CI IP. The public HTML page
 *      https://hh.kz/search/vacancy is NOT blocked and embeds the whole result
 *      set as JSON inside <template id="HH-Lux-InitialState">. We parse that.
 *   2. hh then started HTML-entity-encoding that JSON (`&#34;` for quotes).
 *      The old code did JSON.parse on the raw string, which threw, was caught,
 *      and turned into "0 vacancies" — every day, for weeks. lib/http's
 *      extractTemplateJson() decodes entities and is the ONLY parser allowed here.
 *
 * Therefore the rules in this file are:
 *   - A 200 page without a parseable template is a FAILURE (page shape changed
 *     or soft-block), never "no results". It is counted in stats.templateMissing,
 *     written to notes, and if it happens on every page scrape() THROWS so the
 *     orchestrator marks the source as crashed.
 *   - verify() never answers 'dead' on anything but a definitive signal
 *     (404/410 or a parsed structured archived flag). A previous version treated
 *     403 as dead and wiped the board.
 *   - Parsing is split into small pure functions that are unit-tested against
 *     saved fixtures (tests/fixtures/hh-*.html), so a shape change is a red test.
 *
 * hh.kz query parameters, verified live on 2026-09-03 (see tests + git history):
 *   - area=40 is all of Kazakhstan; 160 Алматы, 159 Астана, 182 Шымкент, 181 Караганда.
 *   - experience=noExperience is a real structured filter (criteria.experience).
 *   - items_on_page=100 is honoured; hh hard-caps paging at 20 pages (lastPage=19),
 *     i.e. at most 2000 results per query regardless of totalResults.
 *   - label=internship returns only vacancies with internship=true (any experience).
 *   - employment=probation is silently rewritten by hh into label=internship +
 *     experience=noExperience (a subset of the two queries above) — not used.
 *   - internship=true is ignored; search_field=name&text=стажировка returns ~1 hit
 *     (hh's lemmatiser), so keyword queries are not used for coverage any more.
 *   - Search payload has NO description; the vacancy page has one in
 *     state.vacancyView.description (HTML) plus vacancyView.keySkills.keySkill[].
 *   - Individual vacancy pages sometimes answer 403 even when search works.
 */

const { extractTemplateJson, stripHtml, HttpError } = require('../lib/http');

const SOURCE = 'hh_kz';
const SEARCH_URL = 'https://hh.kz/search/vacancy';
const VACANCY_URL = 'https://hh.kz/vacancy/';
const TEMPLATE_ID = 'HH-Lux-InitialState';
const PAGE_SIZE = 100;         // hh honours this; falls back to what the site returns
const AREA_KZ = 40;
const CITY_AREAS = [160, 159, 182, 181]; // Алматы, Астана, Шымкент, Караганда
const MAX_SKILL_TAGS = 5;

const HH_HEADERS = {
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'ru-RU,ru;q=0.9,kk;q=0.8,en;q=0.7',
};

// Query set. The internship label runs FIRST with a bounded share of maxJobs
// (it is the most student-relevant list and catches стажировки whose
// workExperience is not noExperience); the all-KZ no-experience list then fills
// whatever budget is left. Without the share, 6 pages x 100 of noExperience
// would exhaust maxJobs=600 on its own and the internship query would never run.
const QUERIES = [
  { label: 'internship', params: { area: AREA_KZ, label: 'internship' }, share: 0.35 },
  { label: 'noExperience', params: { area: AREA_KZ, experience: 'noExperience' }, share: 1 },
];

const DEFAULT_LIMITS = { maxPages: 6, maxJobs: 600, maxDetails: 150 };

// ── pure helpers ─────────────────────────────────────────────────────────────

function buildSearchUrl(params, page, perPage = PAGE_SIZE) {
  const q = new URLSearchParams({ ...params, order_by: 'publication_time', items_on_page: String(perPage), page: String(page) });
  return `${SEARCH_URL}?${q.toString()}`;
}

/** Old code did `.replace(...)` to collapse regional subdomains; keep that behaviour. */
function normalizeHhUrl(url, id) {
  const u = url || `${VACANCY_URL}${id}`;
  return String(u).replace(/\b[a-z-]+\.hh\.kz/, 'hh.kz').replace('hh.ru', 'hh.kz').split('?')[0];
}

function isEntryLevel(v) {
  return !!v && (v.workExperience === 'noExperience' || v.internship === true);
}

function isRemote(v) {
  if (!v) return false;
  if (v['@workSchedule'] === 'remote') return true;
  const wf = Array.isArray(v.workFormats) ? v.workFormats : [];
  return wf.some((f) => {
    if (typeof f === 'string') return f.toUpperCase() === 'REMOTE';
    const el = f && (f.workFormatsElement || f.workFormat || f['@type']);
    return Array.isArray(el) ? el.includes('REMOTE') : el === 'REMOTE';
  });
}

function tagsFor(v) {
  const tags = [];
  if (v.workExperience === 'noExperience') tags.push('Без опыта');
  if (v.internship === true) tags.push('Стажировка');
  if (v.employment && v.employment['@type'] === 'PART') tags.push('Неполный день');
  if (isRemote(v)) tags.push('Удалённо');
  tags.push('hh.kz');
  return tags;
}

/**
 * Parse a search page. Returns null when the template is missing/unparseable
 * (callers MUST treat that as a failure, not as an empty page). Otherwise:
 *   { vacancies, totalResults, page, lastPage, hasResultBlock }
 */
function parseSearchPage(html) {
  const state = extractTemplateJson(html || '', TEMPLATE_ID);
  if (!state) return null;
  const r = state.vacancySearchResult;
  if (!r || typeof r !== 'object') {
    return { vacancies: [], totalResults: null, page: null, lastPage: null, hasResultBlock: false };
  }
  const paging = r.paging || null;
  const lastPage = paging && paging.lastPage && Number.isInteger(paging.lastPage.page) ? paging.lastPage.page
    : (paging && Array.isArray(paging.pages) && paging.pages.length
      ? Math.max(...paging.pages.map((p) => (Number.isInteger(p.page) ? p.page : -1))) : null);
  return {
    vacancies: Array.isArray(r.vacancies) ? r.vacancies : [],
    totalResults: Number.isFinite(r.totalResults) ? r.totalResults : null,
    page: r.criteria && Number.isInteger(r.criteria.page) ? r.criteria.page : null,
    lastPage,
    hasResultBlock: true,
  };
}

/**
 * Search-result vacancy → raw fields for normalize.makeJob(). Returns null for
 * objects without an id/name. The description is a compact fact-sheet (there is
 * none in the search payload); scrape() replaces it with the real one when it
 * can fetch the vacancy page.
 */
function vacancyToRaw(v) {
  if (!v || v.vacancyId == null || !v.name) return null;
  const id = String(v.vacancyId);
  const tags = tagsFor(v);
  const company = (v.company && (v.company.visibleName || v.company.name)) || 'Компания';
  const location = (v.area && (typeof v.area === 'string' ? v.area : v.area.name)) || 'Казахстан';
  const comp = v.compensation || {};
  const url = normalizeHhUrl(v.links && v.links.desktop, id);
  const description = `${v.name}. ${tags.filter((t) => t !== 'hh.kz').join('. ')}. Компания: ${company}, ${location}.`;
  return {
    source: SOURCE,
    source_id: `hh_${id}`,
    source_url: url,
    apply_url: url,
    title: v.name,
    company,
    location,
    description,
    salary_min: comp.from || null,
    salary_max: comp.to || null,
    currency: comp.currencyCode || 'KZT',
    tags,
    posted_at: (v.publicationTime && v.publicationTime.$) || null,
  };
}

/**
 * Parse a vacancy page. Returns null when the template is missing or has no
 * vacancyView (soft-block / redirect / shape change). Otherwise:
 *   { description (plain text), descriptionHtml, keySkills[], archived, status }
 */
function parseVacancyPage(html) {
  const state = extractTemplateJson(html || '', TEMPLATE_ID);
  const vv = state && state.vacancyView;
  if (!vv || typeof vv !== 'object') return null;
  const status = vv.status && typeof vv.status === 'object' ? vv.status : {};
  const archived = vv.archived === true || status.archived === true || status.disabled === true;
  const ks = vv.keySkills && Array.isArray(vv.keySkills.keySkill) ? vv.keySkills.keySkill : [];
  const keySkills = ks.map((k) => (typeof k === 'string' ? k : k && (k.name || k.$))).filter(Boolean);
  const descriptionHtml = typeof vv.description === 'string' ? vv.description : '';
  return { description: stripHtml(descriptionHtml), descriptionHtml, keySkills, archived, status, name: vv.name || null };
}

/**
 * Liveness decision. ONLY definitive signals produce 'dead':
 *   404/410                         → dead
 *   200 + structured archived flag  → dead
 *   200 + parsed, not archived      → alive
 *   200 without parseable state     → unknown (anti-bot page is not proof of life)
 *   403/429/5xx/anything else       → unknown (NEVER dead — see file header)
 */
function decideLiveness(status, html) {
  if (status === 404 || status === 410) return 'dead';
  if (status === 200) {
    const parsed = parseVacancyPage(html);
    if (!parsed) return 'unknown';
    return parsed.archived ? 'dead' : 'alive';
  }
  return 'unknown';
}

function hhIdFromRow(row) {
  const m = String((row && row.source_id) || '').match(/(\d+)$/);
  if (m) return m[1];
  const u = String((row && row.source_url) || '').match(/\/vacancy\/(\d+)/);
  return u ? u[1] : null;
}

// ── contract ─────────────────────────────────────────────────────────────────

function mkLog(ctx) {
  const l = (ctx && ctx.log) || console.log;
  return (msg) => l(`[${SOURCE}] ${msg}`);
}

async function fetchSearch(ctx, url) {
  return ctx.http.text(url, { headers: HH_HEADERS });
}

async function scrape(ctx) {
  const log = mkLog(ctx);
  const limits = { ...DEFAULT_LIMITS, ...((ctx && ctx.limits) || {}) };
  const knownIds = ctx.knownIds instanceof Set ? ctx.knownIds : new Set(ctx.knownIds || []);
  const jitter = () => ctx.http.sleep(600 + Math.floor(Math.random() * 300));

  const stats = {
    pagesFetched: 0, pagesAttempted: 0, templateMissing: 0, httpErrors: 0,
    rawSeen: 0, entryLevel: 0, duplicates: 0, candidates: 0,
    rejectedByFilter: 0, filterReasons: {},
    detailsFetched: 0, detailsFailed: 0, detailsSkippedKnown: 0, detailCapHit: false,
    kept: 0, rejectReasons: {},
  };
  const notes = [];
  const note = (m) => { notes.push(m); log(m); };

  // vacancyId → search-result object (first sighting wins; queries overlap)
  const collected = new Map();
  let perPage = PAGE_SIZE;

  /**
   * Walk one query's pages until its budget (share of maxJobs, counted from
   * where the previous queries left off) or maxPages is exhausted.
   * Returns { hitHardCap } for the city fallback decision.
   */
  async function runQuery(q) {
    let hitHardCap = false;
    const share = Number.isFinite(q.share) && q.share > 0 ? Math.min(q.share, 1) : 1;
    const cap = Math.min(limits.maxJobs, collected.size + Math.ceil(limits.maxJobs * share));
    for (let page = 0; page < limits.maxPages; page++) {
      if (collected.size >= cap) { note(`${q.label}: budget of ${cap} jobs reached (maxJobs=${limits.maxJobs}, share=${share})`); break; }
      const url = buildSearchUrl(q.params, page, perPage);
      stats.pagesAttempted++;
      let res;
      try {
        res = await fetchSearch(ctx, url);
      } catch (e) {
        stats.httpErrors++;
        const status = e instanceof HttpError ? e.status : null;
        note(`HTTP ${status || 'error'} on ${url}${status === 403 ? ' — hh is blocking this IP (soft-block?)' : ''}: ${String(e.message || e).slice(0, 160)}`);
        break; // the next page of the same query will almost certainly fail the same way
      }
      const parsed = parseSearchPage(res.body);
      if (!parsed) {
        stats.templateMissing++;
        note(`${TEMPLATE_ID} missing/unparseable on ${url} — page shape changed or soft-block`);
        break;
      }
      if (!parsed.hasResultBlock) {
        stats.templateMissing++;
        note(`state.vacancySearchResult missing on ${url} — page shape changed`);
        break;
      }
      stats.pagesFetched++;
      stats.rawSeen += parsed.vacancies.length;

      // hh may quietly serve fewer than items_on_page (e.g. 50); adopt the
      // observed page size so the "short page == last page" heuristic stays right.
      if (page === 0 && parsed.vacancies.length > 0 && parsed.vacancies.length < perPage &&
          parsed.lastPage != null && parsed.lastPage > 0) {
        note(`items_on_page=${perPage} ignored by hh, got ${parsed.vacancies.length}; continuing with that page size`);
        perPage = parsed.vacancies.length;
      }

      let fresh = 0;
      for (const v of parsed.vacancies) {
        if (!isEntryLevel(v)) continue;
        stats.entryLevel++;
        const id = v && v.vacancyId != null ? String(v.vacancyId) : null;
        if (!id) continue;
        if (collected.has(id)) { stats.duplicates++; continue; }
        if (collected.size >= cap) break; // budget enforced mid-page too
        collected.set(id, v);
        fresh++;
      }
      log(`${q.label} page ${page}: ${parsed.vacancies.length} raw, ${fresh} new entry-level (total ${collected.size}, hh reports ${parsed.totalResults})`);

      if (fresh === 0) { note(`${q.label} page ${page} yielded nothing new — stopping this query`); break; }
      const isLast = parsed.vacancies.length < perPage || (parsed.lastPage != null && page >= parsed.lastPage);
      if (isLast) {
        // hh caps paging at 20 pages; if totalResults is beyond what paging can
        // show, per-city queries can surface the remainder.
        if (parsed.lastPage != null && parsed.totalResults != null && parsed.totalResults > (parsed.lastPage + 1) * perPage) hitHardCap = true;
        break;
      }
      await jitter();
    }
    return { hitHardCap };
  }

  let needCities = false;
  for (const q of QUERIES) {
    const { hitHardCap } = await runQuery(q);
    if (hitHardCap && q.label === 'noExperience') needCities = true;
    await jitter();
  }
  if (needCities && collected.size < limits.maxJobs) {
    note('all-KZ list hit hh paging cap; running per-city queries');
    for (const area of CITY_AREAS) {
      await runQuery({ label: `noExperience/area=${area}`, params: { area, experience: 'noExperience' } });
      if (collected.size >= limits.maxJobs) break;
      await jitter();
    }
  }

  // LOUD failure: nothing parsed at all. Returning [] here is exactly the
  // silent-zero incident this file exists to prevent.
  if (stats.pagesFetched === 0) {
    const why = stats.templateMissing > 0
      ? `${TEMPLATE_ID} missing/unparseable on every search page (${stats.templateMissing}) — page shape changed or soft-block`
      : `no search page could be fetched (${stats.httpErrors} HTTP errors)`;
    throw new Error(`hh_kz: ${why}. notes: ${notes.slice(0, 3).join(' | ')}`);
  }

  // ── build candidates, cheap pre-filter on title+tags ────────────────────
  const filterReject = (title, desc, tags) => {
    if (ctx.filter.isStudentFriendly(title, desc, tags, { structuredEntry: true })) return null;
    const reason = typeof ctx.filter.studentRejectReason === 'function'
      ? (ctx.filter.studentRejectReason(title, desc, tags) || 'no-positive-signal') : 'rejected';
    return reason;
  };
  const candidates = [];
  for (const v of collected.values()) {
    const raw = vacancyToRaw(v);
    if (!raw) { stats.rejectReasons['no-id-or-name'] = (stats.rejectReasons['no-id-or-name'] || 0) + 1; continue; }
    const r = filterReject(raw.title, raw.description, raw.tags);
    if (r) { stats.rejectedByFilter++; stats.filterReasons[r] = (stats.filterReasons[r] || 0) + 1; continue; }
    candidates.push(raw);
  }
  stats.candidates = candidates.length;

  // ── enrich NEW ids with the real description (capped, polite) ───────────
  for (const raw of candidates) {
    if (knownIds.has(raw.source_id)) { stats.detailsSkippedKnown++; continue; }
    if (stats.detailsFetched + stats.detailsFailed >= limits.maxDetails) {
      if (!stats.detailCapHit) { stats.detailCapHit = true; note(`detail cap hit (maxDetails=${limits.maxDetails}); remaining new jobs keep compact descriptions`); }
      continue;
    }
    const id = raw.source_id.replace(/^hh_/, '');
    try {
      const res = await ctx.http.text(VACANCY_URL + id, { headers: HH_HEADERS, allow: [403, 404, 410, 429] });
      const parsed = res.status === 200 ? parseVacancyPage(res.body) : null;
      if (parsed && parsed.description) {
        stats.detailsFetched++;
        raw.description = parsed.description;
        if (parsed.keySkills.length) {
          const base = raw.tags.filter((t) => t !== 'hh.kz');
          raw.tags = [...base, 'hh.kz', ...parsed.keySkills.slice(0, MAX_SKILL_TAGS)];
        }
      } else {
        stats.detailsFailed++;
        if (stats.detailsFailed <= 5) note(`detail ${id}: ${res.status === 200 ? 'vacancyView missing' : 'HTTP ' + res.status} — keeping compact description`);
      }
    } catch (e) {
      stats.detailsFailed++;
      if (stats.detailsFailed <= 5) note(`detail ${id} failed: ${String(e.message || e).slice(0, 120)} — keeping compact description`);
    }
    await ctx.http.sleep(500);
  }
  if (stats.detailsFailed > 5) note(`${stats.detailsFailed} detail fetches failed in total`);

  // ── final filter (description may now contain real text) + normalize ───
  const jobs = [];
  for (const raw of candidates) {
    const r = filterReject(raw.title, raw.description, raw.tags);
    if (r) { stats.rejectedByFilter++; stats.filterReasons[r] = (stats.filterReasons[r] || 0) + 1; continue; }
    const job = ctx.normalize.makeJob(raw);
    if (!job) {
      const why = ctx.normalize.makeJob.lastReject || 'unknown';
      stats.rejectReasons[why] = (stats.rejectReasons[why] || 0) + 1;
      continue;
    }
    jobs.push(job);
  }
  stats.kept = jobs.length;
  if (stats.templateMissing > 0) note(`${stats.templateMissing} search page(s) had no parseable template`);
  log(`done: ${stats.pagesFetched} pages, ${stats.rawSeen} raw, ${stats.entryLevel} entry-level, ${stats.kept} kept, ${stats.detailsFetched} details`);
  return { jobs, stats, notes };
}

/** Cheap self-test: can we still parse the search page? */
async function canary(ctx) {
  const url = buildSearchUrl({ area: AREA_KZ, experience: 'noExperience' }, 0, 20);
  let res;
  try {
    res = await fetchSearch(ctx, url);
  } catch (e) {
    const status = e instanceof HttpError ? e.status : null;
    return { ok: false, reason: status ? `HTTP ${status}` : `network: ${String(e.message || e).slice(0, 120)}` };
  }
  const parsed = parseSearchPage(res.body);
  if (!parsed) return { ok: false, reason: `template missing (${TEMPLATE_ID} absent or unparseable on ${url})` };
  if (!parsed.hasResultBlock) return { ok: false, reason: 'state.vacancySearchResult missing — page shape changed' };
  const good = parsed.vacancies.filter((v) => v && v.vacancyId != null && v.name).length;
  if (good < 5) return { ok: false, reason: `parsed ${good} vacancies with id+name (expected ≥5, totalResults=${parsed.totalResults})` };
  return { ok: true, reason: `parsed ${good} vacancies, totalResults=${parsed.totalResults}` };
}

/** Per-row liveness for cleanup. See decideLiveness() for the rules. */
async function verify(ctx, row) {
  const id = hhIdFromRow(row);
  if (!id) return 'unknown';
  try {
    const res = await ctx.http.text(VACANCY_URL + id, { headers: HH_HEADERS, allow: [404, 410, 403, 429] });
    return decideLiveness(res.status, res.body);
  } catch (_e) {
    return 'unknown'; // 5xx / network blip — leave the row alone, retry next run
  }
}

module.exports = {
  name: SOURCE,
  minExpected: 40,
  ttlDays: 21,
  scrape,
  canary,
  verify,
  // exported for tests
  parseSearchPage, vacancyToRaw, parseVacancyPage, decideLiveness,
  buildSearchUrl, normalizeHhUrl, isEntryLevel, isRemote, tagsFor, hhIdFromRow,
  QUERIES, CITY_AREAS, TEMPLATE_ID,
};
