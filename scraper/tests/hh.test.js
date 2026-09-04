/**
 * tests/hh.test.js — parser + decision tests for sources/hh.js.
 * No network: everything runs against saved fixtures and a fake ctx.http.
 *
 *   node --test scraper/tests/hh.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const hh = require('../sources/hh');
const filter = require('../lib/filter');
const normalize = require('../lib/normalize');

const FIX = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');
const SEARCH_HTML = FIX('hh-search-stazher.html');
const VACANCY_ACTIVE = FIX('hh-vacancy-active.html');
const VACANCY_ARCHIVED = FIX('hh-vacancy-archived.html');
const NO_TEMPLATE_HTML = '<!doctype html><html><head><title>hh.kz</title></head><body><div id="HH-React-Root"></div><script>var x=1;</script></body></html>';

// A silent log + fake http so tests never touch the network.
function fakeCtx(routes, extra = {}) {
  const calls = [];
  const http = {
    calls,
    sleep: async () => {},
    async text(url, opts = {}) {
      calls.push(url);
      const r = routes(url);
      if (r instanceof Error) throw r;
      const status = r.status || 200;
      const allow = opts.allow || [];
      if (status >= 400 && !allow.includes(status)) {
        const { HttpError } = require('../lib/http');
        throw new HttpError(status, url, '');
      }
      return { status, body: r.body || '', headers: new Map() };
    },
  };
  return { http, log: () => {}, filter, normalize, limits: { maxPages: 3, maxJobs: 600, maxDetails: 150 }, dryRun: true, ...extra };
}

// ── contract ─────────────────────────────────────────────────────────────────
test('exports the SPEC contract', () => {
  assert.equal(hh.name, 'hh_kz');
  assert.equal(hh.minExpected, 40);
  assert.equal(hh.ttlDays, 21);
  for (const fn of ['scrape', 'canary', 'verify']) assert.equal(typeof hh[fn], 'function', fn);
});

// ── parseSearchPage ──────────────────────────────────────────────────────────
test('parseSearchPage: real entity-encoded fixture yields 50 vacancies, 11 entry-level', () => {
  const p = hh.parseSearchPage(SEARCH_HTML);
  assert.ok(p, 'template must parse');
  assert.equal(p.hasResultBlock, true);
  assert.equal(p.vacancies.length, 50);
  assert.equal(p.totalResults, 959);
  assert.equal(p.page, 0);
  assert.ok(Number.isInteger(p.lastPage) && p.lastPage >= 1, 'lastPage from paging');
  const entry = p.vacancies.filter(hh.isEntryLevel);
  assert.equal(entry.length, 11);
  for (const v of p.vacancies) { assert.ok(v.vacancyId); assert.ok(v.name); }
});

test('parseSearchPage: entity-encoded template (&#34;) decodes; raw JSON also works', () => {
  const state = { vacancySearchResult: { vacancies: [{ vacancyId: 1, name: 'Стажёр "QA"' }], totalResults: 1, paging: null, criteria: { page: 0 } } };
  const json = JSON.stringify(state);
  const encoded = json.replace(/&/g, '&amp;').replace(/"/g, '&#34;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  for (const payload of [encoded, json]) {
    const p = hh.parseSearchPage(`<html><body><template id="HH-Lux-InitialState">${payload}</template></body></html>`);
    assert.ok(p);
    assert.equal(p.vacancies[0].name, 'Стажёр "QA"');
    assert.equal(p.totalResults, 1);
    assert.equal(p.lastPage, null, 'single page → no lastPage');
  }
});

test('parseSearchPage: returns null when the template is missing (never an empty list)', () => {
  assert.equal(hh.parseSearchPage(NO_TEMPLATE_HTML), null);
  assert.equal(hh.parseSearchPage(''), null);
  assert.equal(hh.parseSearchPage('<template id="HH-Lux-InitialState">{not json</template>'), null);
});

test('parseSearchPage: state without vacancySearchResult is flagged, not treated as results', () => {
  const p = hh.parseSearchPage('<template id="HH-Lux-InitialState">{"somethingElse":1}</template>');
  assert.ok(p);
  assert.equal(p.hasResultBlock, false);
  assert.deepEqual(p.vacancies, []);
});

// ── vacancyToRaw ─────────────────────────────────────────────────────────────
test('vacancyToRaw: maps a real vacancy into makeJob raw fields', () => {
  const p = hh.parseSearchPage(SEARCH_HTML);
  const v = p.vacancies.find((x) => x.workExperience === 'noExperience');
  const raw = hh.vacancyToRaw(v);
  assert.equal(raw.source, 'hh_kz');
  assert.equal(raw.source_id, `hh_${v.vacancyId}`);
  assert.match(raw.source_url, /^https:\/\/hh\.kz\/vacancy\/\d+$/);
  assert.equal(raw.apply_url, raw.source_url);
  assert.equal(raw.title, v.name);
  assert.equal(raw.company, v.company.visibleName || v.company.name);
  assert.equal(raw.location, v.area.name);
  assert.equal(raw.posted_at, v.publicationTime.$);
  assert.ok(raw.tags.includes('Без опыта'));
  assert.ok(raw.tags.includes('hh.kz'));
  assert.ok(raw.description.length > raw.title.length, 'compact description built from facts');
  const job = normalize.makeJob(raw);
  assert.ok(job, 'makeJob accepts the raw: ' + normalize.makeJob.lastReject);
  assert.equal(job.currency, (v.compensation && v.compensation.currencyCode) || 'KZT');
  assert.equal(hh.vacancyToRaw({ vacancyId: 5, name: 'X', compensation: {} }).currency, 'KZT', 'currency defaults to KZT');
});

test('vacancyToRaw: tags for internship / part-time / remote (both signals) and url normalisation', () => {
  const v = {
    vacancyId: 42, name: 'Intern', internship: true, workExperience: 'between1And3',
    employment: { '@type': 'PART' }, '@workSchedule': 'fullDay',
    workFormats: [{ workFormatsElement: ['REMOTE'] }],
    links: { desktop: 'https://almaty.hh.kz/vacancy/42?from=search' },
    compensation: { from: 100000, to: null, currencyCode: 'KZT' },
    publicationTime: { $: '2026-09-01T10:00:00.000+03:00' },
  };
  const raw = hh.vacancyToRaw(v);
  assert.deepEqual(raw.tags, ['Стажировка', 'Неполный день', 'Удалённо', 'hh.kz']);
  assert.equal(raw.source_url, 'https://hh.kz/vacancy/42');
  assert.equal(raw.salary_min, 100000);
  assert.equal(raw.company, 'Компания');
  assert.equal(raw.location, 'Казахстан');
  assert.equal(hh.isRemote({ '@workSchedule': 'remote' }), true);
  assert.equal(hh.isRemote({ '@workSchedule': 'fullDay', workFormats: [{ workFormatsElement: ['ON_SITE'] }] }), false);
  assert.equal(hh.normalizeHhUrl('https://hh.ru/vacancy/7', 7), 'https://hh.kz/vacancy/7');
  assert.equal(hh.normalizeHhUrl(null, 7), 'https://hh.kz/vacancy/7');
  assert.equal(hh.vacancyToRaw({ name: 'no id' }), null);
  assert.equal(hh.vacancyToRaw({ vacancyId: 1 }), null);
});

// ── parseVacancyPage / decideLiveness ────────────────────────────────────────
test('parseVacancyPage: active fixture → plain-text description, key skills, not archived', () => {
  const p = hh.parseVacancyPage(VACANCY_ACTIVE);
  assert.ok(p);
  assert.equal(p.archived, false);
  assert.ok(p.description.length > 50);
  assert.ok(!/<[a-z]+>/i.test(p.description), 'HTML stripped');
  assert.ok(p.keySkills.length >= 1);
  assert.equal(p.status.active, true);
});

test('parseVacancyPage: archived fixture → archived=true; missing template → null', () => {
  const p = hh.parseVacancyPage(VACANCY_ARCHIVED);
  assert.ok(p);
  assert.equal(p.archived, true);
  assert.equal(hh.parseVacancyPage(NO_TEMPLATE_HTML), null);
  assert.equal(hh.parseVacancyPage('<template id="HH-Lux-InitialState">{"vacancySearchResult":{}}</template>'), null, 'no vacancyView → null');
});

test('decideLiveness: only definitive signals are dead', () => {
  const tpl = (vv) => `<template id="HH-Lux-InitialState">${JSON.stringify({ vacancyView: vv }).replace(/"/g, '&#34;')}</template>`;
  assert.equal(hh.decideLiveness(404, ''), 'dead');
  assert.equal(hh.decideLiveness(410, ''), 'dead');
  assert.equal(hh.decideLiveness(200, VACANCY_ARCHIVED), 'dead');
  assert.equal(hh.decideLiveness(200, tpl({ archived: true })), 'dead');
  assert.equal(hh.decideLiveness(200, tpl({ status: { archived: true } })), 'dead');
  assert.equal(hh.decideLiveness(200, tpl({ status: { disabled: true } })), 'dead');
  assert.equal(hh.decideLiveness(200, tpl({ status: { archived: false, disabled: false, active: true } })), 'alive');
  assert.equal(hh.decideLiveness(200, VACANCY_ACTIVE), 'alive');
  // Non-definitive → unknown, NEVER dead (403 once wiped the board).
  assert.equal(hh.decideLiveness(403, ''), 'unknown');
  assert.equal(hh.decideLiveness(429, ''), 'unknown');
  assert.equal(hh.decideLiveness(500, ''), 'unknown');
  assert.equal(hh.decideLiveness(0, ''), 'unknown');
  assert.equal(hh.decideLiveness(200, NO_TEMPLATE_HTML), 'unknown', '200 anti-bot page is not proof of life');
  // Free-text "vacancy-archived" in JS bundles must not count (incident 2).
  assert.equal(hh.decideLiveness(200, tpl({ status: { archived: false } }) + '<script>i18n["vacancy-archived"]="x"</script>'), 'alive');
});

test('verify: uses row.source_id (hh_ / legacy youth_hh_) and the fake http', async () => {
  const ctx = fakeCtx((url) => {
    if (url.endsWith('/vacancy/111')) return { status: 200, body: VACANCY_ACTIVE };
    if (url.endsWith('/vacancy/222')) return { status: 200, body: VACANCY_ARCHIVED };
    if (url.endsWith('/vacancy/333')) return { status: 404, body: '' };
    if (url.endsWith('/vacancy/444')) return { status: 403, body: 'blocked' };
    return new Error('ECONNRESET');
  });
  assert.equal(await hh.verify(ctx, { source_id: 'hh_111' }), 'alive');
  assert.equal(await hh.verify(ctx, { source_id: 'youth_hh_222' }), 'dead');
  assert.equal(await hh.verify(ctx, { source_id: 'hh_333' }), 'dead');
  assert.equal(await hh.verify(ctx, { source_id: 'hh_444' }), 'unknown');
  assert.equal(await hh.verify(ctx, { source_id: 'hh_555' }), 'unknown', 'network error → unknown');
  assert.equal(await hh.verify(ctx, { source_id: 'garbage' }), 'unknown');
  assert.equal(hh.hhIdFromRow({ source_id: 'x', source_url: 'https://hh.kz/vacancy/9?a=1' }), '9');
});

// ── scrape() end-to-end with fake http ───────────────────────────────────────
test('scrape: fixture search + detail pages → jobs with real descriptions and skill tags', async () => {
  const ctx = fakeCtx((url) => {
    if (url.startsWith('https://hh.kz/search/vacancy')) {
      const page = Number(new URL(url).searchParams.get('page'));
      // page 0 of every query serves the fixture; later pages repeat it → "nothing new" → stop
      return { status: 200, body: SEARCH_HTML, page };
    }
    if (url.startsWith('https://hh.kz/vacancy/')) return { status: 200, body: VACANCY_ACTIVE };
    return new Error('unexpected url ' + url);
  });
  const { jobs, stats, notes } = await hh.scrape(ctx);
  assert.ok(Array.isArray(notes));
  assert.equal(stats.templateMissing, 0);
  assert.ok(stats.pagesFetched >= 2, 'both queries fetched page 0');
  assert.equal(stats.rawSeen, 50 * stats.pagesFetched);
  assert.ok(stats.entryLevel >= 11);
  assert.equal(Object.values(stats.filterReasons).reduce((a, b) => a + b, 0), stats.rejectedByFilter, 'filter reasons add up');
  assert.ok(jobs.length >= 8 && jobs.length <= 11, `kept ${jobs.length}`);
  assert.equal(stats.kept, jobs.length);
  assert.equal(stats.detailsFetched, stats.candidates, 'every new candidate got a detail fetch');
  for (const j of jobs) {
    assert.equal(j.source, 'hh_kz');
    assert.match(j.source_id, /^hh_\d+$/);
    assert.ok(j.description.length > 50, 'real description from vacancy page');
    assert.ok(j.tags.includes('hh.kz'));
    assert.ok(j.tags.some((t) => /Активные продажи|Работа с документами/.test(t)), 'key skills became tags');
    assert.equal(filter.isStudentFriendly(j.title, j.description, j.tags, { structuredEntry: true }), true);
  }
  // no duplicate source_ids across overlapping queries
  assert.equal(new Set(jobs.map((j) => j.source_id)).size, jobs.length);
  // politeness: search pages were paged, details fetched once per candidate
  assert.equal(ctx.http.calls.filter((u) => u.includes('/vacancy/')).length, stats.candidates);
});

test('scrape: knownIds skips detail fetches; detail cap falls back to compact description; failed detail keeps the job', async () => {
  const p = hh.parseSearchPage(SEARCH_HTML);
  const entryIds = p.vacancies.filter(hh.isEntryLevel).map((v) => `hh_${v.vacancyId}`);
  const known = new Set(entryIds.slice(0, 3));
  let detailCalls = 0;
  const ctx = fakeCtx((url) => {
    if (url.startsWith('https://hh.kz/search/vacancy')) return { status: 200, body: SEARCH_HTML };
    detailCalls++;
    if (detailCalls === 1) return { status: 403, body: 'blocked' };
    if (detailCalls === 2) return new Error('ETIMEDOUT');
    return { status: 200, body: VACANCY_ACTIVE };
  }, { knownIds: known, limits: { maxPages: 1, maxJobs: 600, maxDetails: 4 } });
  const { jobs, stats, notes } = await hh.scrape(ctx);
  assert.equal(stats.detailsSkippedKnown, 3);
  assert.equal(stats.detailsFetched + stats.detailsFailed, 4, 'cap counts attempts');
  assert.equal(stats.detailsFailed, 2);
  assert.equal(stats.detailCapHit, true);
  assert.ok(notes.some((n) => /detail cap hit/.test(n)));
  assert.ok(jobs.length >= 8, 'failed details never drop jobs');
  const compact = jobs.filter((j) => /Компания:/.test(j.description));
  assert.ok(compact.length >= jobs.length - 2, 'jobs beyond the cap keep the compact description');
});

test('scrape: maxJobs and maxPages are respected; a page with nothing new stops the query', async () => {
  const ctx = fakeCtx((url) => {
    if (url.startsWith('https://hh.kz/search/vacancy')) return { status: 200, body: SEARCH_HTML };
    return { status: 200, body: VACANCY_ACTIVE };
  }, { limits: { maxPages: 5, maxJobs: 5, maxDetails: 0 } });
  const { jobs, stats } = await hh.scrape(ctx);
  assert.ok(jobs.length <= 5);
  assert.ok(stats.pagesFetched <= 2, 'stopped once maxJobs was reached');
  assert.equal(stats.detailsFetched, 0);
});

test('scrape: a page without the template counts as templateMissing (and is in notes)', async () => {
  const ctx = fakeCtx((url) => {
    if (url.startsWith('https://hh.kz/search/vacancy')) {
      const u = new URL(url);
      // first query fine, second query (label=internship) serves an anti-bot page
      return u.searchParams.get('label') === 'internship' ? { status: 200, body: NO_TEMPLATE_HTML } : { status: 200, body: SEARCH_HTML };
    }
    return { status: 200, body: VACANCY_ACTIVE };
  }, { limits: { maxPages: 2, maxJobs: 600, maxDetails: 0 } });
  const { jobs, stats, notes } = await hh.scrape(ctx);
  assert.equal(stats.templateMissing, 1);
  assert.ok(notes.some((n) => /HH-Lux-InitialState missing\/unparseable on https:\/\/hh\.kz\/search\/vacancy\?[^ ]*label=internship/.test(n)), notes.join('\n'));
  assert.ok(jobs.length > 0, 'the healthy query still produces jobs');
});

test('scrape: THROWS when every search page lacks the template (never a silent 0)', async () => {
  const ctx = fakeCtx(() => ({ status: 200, body: NO_TEMPLATE_HTML }));
  await assert.rejects(() => hh.scrape(ctx), (e) => /HH-Lux-InitialState missing\/unparseable/.test(e.message) && /soft-block/.test(e.message));
});

test('scrape: THROWS when every search page is an HTTP error (403 soft-block)', async () => {
  const ctx = fakeCtx(() => ({ status: 403, body: 'Forbidden' }));
  await assert.rejects(() => hh.scrape(ctx), (e) => /no search page could be fetched/.test(e.message) && /HTTP 403/.test(e.message));
});

// ── canary ───────────────────────────────────────────────────────────────────
test('canary: ok on fixture, specific reasons on failure', async () => {
  const okCtx = fakeCtx(() => ({ status: 200, body: SEARCH_HTML }));
  const r1 = await hh.canary(okCtx);
  assert.equal(r1.ok, true);
  assert.match(okCtx.http.calls[0], /experience=noExperience/);
  assert.match(okCtx.http.calls[0], /items_on_page=20/);

  assert.deepEqual((await hh.canary(fakeCtx(() => ({ status: 403, body: '' })))).ok, false);
  assert.match((await hh.canary(fakeCtx(() => ({ status: 403, body: '' })))).reason, /HTTP 403/);
  assert.match((await hh.canary(fakeCtx(() => ({ status: 200, body: NO_TEMPLATE_HTML })))).reason, /template missing/);
  const few = `<template id="HH-Lux-InitialState">${JSON.stringify({ vacancySearchResult: { vacancies: [{ vacancyId: 1, name: 'a' }], totalResults: 1 } })}</template>`;
  assert.match((await hh.canary(fakeCtx(() => ({ status: 200, body: few })))).reason, /parsed 1 vacancies/);
  assert.match((await hh.canary(fakeCtx(() => new Error('ENOTFOUND')))).reason, /network/);
});

// ── buildSearchUrl ───────────────────────────────────────────────────────────
test('buildSearchUrl: structured filters, newest first, explicit page size', () => {
  const u = new URL(hh.buildSearchUrl(hh.QUERIES[1].params, 2));
  assert.equal(u.origin + u.pathname, 'https://hh.kz/search/vacancy');
  assert.equal(u.searchParams.get('area'), '40');
  assert.equal(u.searchParams.get('experience'), 'noExperience');
  assert.equal(u.searchParams.get('order_by'), 'publication_time');
  assert.equal(u.searchParams.get('items_on_page'), '100');
  assert.equal(u.searchParams.get('page'), '2');
  assert.equal(new URL(hh.buildSearchUrl(hh.QUERIES[0].params, 0)).searchParams.get('label'), 'internship');
});

test('QUERIES: internship runs first with a bounded share so noExperience cannot starve it', () => {
  assert.equal(hh.QUERIES[0].label, 'internship');
  assert.ok(hh.QUERIES[0].share > 0 && hh.QUERIES[0].share < 1);
  assert.equal(hh.QUERIES[hh.QUERIES.length - 1].label, 'noExperience');
});

test('scrape: the second query still runs when the first one could fill maxJobs', async () => {
  const seenQueries = new Set();
  const ctx = fakeCtx((url) => {
    if (url.startsWith('https://hh.kz/search/vacancy')) {
      const u = new URL(url);
      seenQueries.add(u.searchParams.get('label') || u.searchParams.get('experience'));
      return { status: 200, body: SEARCH_HTML };
    }
    return { status: 200, body: VACANCY_ACTIVE };
  }, { limits: { maxPages: 6, maxJobs: 4, maxDetails: 0 } });
  const { jobs } = await hh.scrape(ctx);
  assert.ok(seenQueries.has('internship') && seenQueries.has('noExperience'), [...seenQueries].join(','));
  assert.ok(jobs.length <= 4);
});
