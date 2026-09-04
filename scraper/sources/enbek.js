/**
 * sources/enbek.js — enbek.kz (Электронная биржа труда, the state job board).
 *
 * ── FINDINGS (2026-09-03) — read before touching selectors ──────────────────
 *
 * Stack: Laravel + Livewire v3 (component `vacancy-list`). Pages are fully
 * SERVER-RENDERED — no JS needed. There is NO public JSON API:
 *   - `/ru/api/vacancy`               → 404 JSON "route could not be found"
 *   - `/api/vacancy/search`           → 302 to the homepage
 *   - `...search/vacancy?format=json` → ignored, HTML returned
 *   - the only XHR is `POST /livewire/update` (signed snapshot + CSRF) — not
 *     worth emulating because every filter is also honoured as a GET param.
 *
 * Search page:  GET https://www.enbek.kz/ru/search/vacancy?<params>
 *   prof=<text>        keyword / profession search. NB: the legacy scraper used
 *                      `key=` which the site silently IGNORES (snapshot showed
 *                      prof:"" and 43 187 unfiltered results — hence the plumber).
 *   experience=e1      "Без опыта" (e0 = any, e2..e4 = 1/3/5+ years). ~20k rows.
 *   tag=practice       "Профессиональная практика" (student practice slots, ~450)
 *   tag=youth          "Молодежи" (~2 300);  tag=school "Работа от 14 лет" (~50)
 *   region_id=<n>      75 = Алматы (ids in the sidebar `$set('region_id', n)`)
 *   period=1..4        last 24h / 3d / 7d / 14d;  sort=date | oplata | default
 *   page=<n>           10 cards per page, fixed (perPage/limit are ignored).
 *   Total pages are in the Livewire snapshot: `wire:snapshot` JSON →
 *   data.countPage / data.vacancyCount (HTML-entity encoded attribute).
 *
 * Card selectors (search page):
 *   div.item-list[wire:key="item-<id>"]          card container (numeric id!)
 *     .head .title a.stretched[href]             title text; href=/ru/vacancy/<slug>~<id>
 *     .subtitle                                  official profession name (optional)
 *     .profobl span                              professional area (optional)
 *     .price                                     "от 150 000 тг." / "от X до Y тг." (optional)
 *     li.company                                 employer (full legal form)
 *     li.location                                ONE element: "Область, г. Город" — the
 *                                                legacy bug selected [class*=location]
 *                                                across the sidebar region list.
 *     li.experience                              "Без опыта работы" | "N год/лет стажа"
 *     li.time / li.education                     schedule / education (optional)
 *     .forwhom span                              badges: "Для прохождения практики",
 *                                                "Работа от 14 лет", …
 *     .right-content .text-nowrap                "Опубликовано 03.09.2026"
 *   Cards carry NO description — the vacancy page does.
 *
 * Vacancy page:  GET https://www.enbek.kz/ru/vacancy/<slug>~<id>
 *   (`/ru/vacancy/<id>` and `/ru/vacancy/x~<id>` also work; slug is cosmetic.)
 *   <script type="application/ld+json"> schema.org JobPosting with title,
 *   hiringOrganization.name, datePosted (dd-mm-yyyy), validThrough, baseSalary,
 *   educationRequirements, experienceRequirements ("Без опыта" | "1 год" …).
 *   Its `description` is only the one-line profession name, so the body is
 *   parsed too:  .page.vacancy  h4.title, .price, ul.info li (span.label + span)
 *   for Тип занятости / График работы / Опыт работы / Образование, and
 *   .text .single-line (.label + .value) for Обязанности / Профессиональные
 *   навыки / Личные качества / Регион / Место работы.
 *   The employer block at the bottom is ALSO a `div.item-list` (no wire:key) —
 *   never select `.item-list` without the wire:key guard.
 *
 * Liveness:
 *   - bogus id             → HTTP 410 (title "Страница не найдена!")
 *   - archived/closed id   → HTTP 200 with
 *       <div class="alert alert-warning"> … "Данная вакансия находится в архиве.
 *       Это означает, что ее действие было приостановлено пользователем, либо
 *       она уже не актуальна." …
 *     Verified on ids 4000000 and 5500000; absent on live pages. That phrase is
 *     the only marker used to declare 'dead' on a 200.
 *
 * Rate limiting / bot protection: none observed for plain GETs with a browser
 * UA (hCaptcha only guards the feedback form). We still sleep 0.8–1.2 s.
 */

const cheerio = require('cheerio');

const BASE = 'https://www.enbek.kz';
const SEARCH_PATH = '/ru/search/vacancy';
const ARCHIVE_MARKER = /вакансия находится в архиве/i;

// Each entry is one search; pages 1..maxPages are fetched for each.
// `experience: 'e1'` makes the SITE do the "no experience" filtering, which is
// the structured signal we pass to filter.isStudentFriendly.
const DEFAULT_QUERIES = [
  { label: 'tag=practice', params: { tag: 'practice' } },              // student practice slots
  { label: 'tag=youth+e1', params: { tag: 'youth', experience: 'e1' } },
  { label: 'стажер', params: { prof: 'стажер', experience: 'e1' } },
  { label: 'стажировка', params: { prof: 'стажировка' } },
  { label: 'студент', params: { prof: 'студент', experience: 'e1' } },
  { label: 'без опыта', params: { prof: 'без опыта', experience: 'e1' } },
  { label: 'junior', params: { prof: 'junior' } },
  { label: 'помощник', params: { prof: 'помощник', experience: 'e1' } },
  { label: 'ассистент', params: { prof: 'ассистент', experience: 'e1' } },
  { label: 'подработка', params: { prof: 'подработка' } },
  { label: 'tag=school', params: { tag: 'school' } },                  // "Работа от 14 лет"
];

const squash = (s) => String(s || '').replace(/\s+/g, ' ').trim();

function searchUrl(params, page = 1) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') q.set(k, String(v));
  if (!q.has('sort')) q.set('sort', 'date');
  if (page > 1) q.set('page', String(page));
  return `${BASE}${SEARCH_PATH}?${q.toString()}`;
}

function absUrl(href) {
  if (!href) return null;
  if (/^https?:\/\//i.test(href)) return href;
  return BASE + (href.startsWith('/') ? href : '/' + href);
}

/** "от 271 000 до 321 000 тг." → { min: 271000, max: 321000 }; "от 150 000 тг." → { min: 150000, max: null } */
function parseSalary(text) {
  const t = squash(text).replace(/ /g, ' ');
  const num = (m) => (m ? parseInt(m[1].replace(/\D/g, ''), 10) : null);
  const min = num(t.match(/от\s*([\d\s]+)/i));
  const max = num(t.match(/до\s*([\d\s]+)/i));
  if (!min && !max) {
    const any = t.match(/(\d[\d\s]{4,})/);
    return { min: num(any), max: null };
  }
  return { min: min || null, max: max || null };
}

/** "Без опыта работы" → 0; "3 года стажа" → 3; unknown → null */
function parseExperienceYears(text) {
  const t = squash(text).toLowerCase();
  if (!t) return null;
  if (/без\s*опыта|опыт\s*не\s*требуется|не\s*требуется/.test(t)) return 0;
  const m = t.match(/(\d+)\s*(год|года|лет|жыл)/);
  if (m) return parseInt(m[1], 10);
  return null;
}

/** "Опубликовано 03.09.2026" / "03-09-2026" → "2026-09-03T00:00:00.000Z" (null if absent) */
function parseRuDate(text) {
  const m = squash(text).match(/(\d{2})[.\-](\d{2})[.\-](\d{4})/);
  if (!m) return null;
  const d = new Date(Date.UTC(+m[3], +m[2] - 1, +m[1]));
  return isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * The card's location is one string like "Карагандинская область, г. Темиртау"
 * or "Жамбылская область, Мойынкумский район, с.Кумозек". We want the settlement,
 * not the region soup — normalize.cleanLocation then maps it to a canonical city.
 */
function extractCity(location) {
  const loc = squash(location);
  if (!loc) return '';
  const city = loc.match(/(?:^|,)\s*(?:г\.|город)\s*([^,]+)/i);
  if (city) return city[1].trim();
  const village = loc.match(/(?:^|,)\s*(с\.|п\.|пос\.|ст\.|село|аул|пос[её]лок)\s*([^,]+)/i);
  if (village) return `${village[1].replace(/\.$/, '')}. ${village[2].trim()}`.replace(/^(село|аул|пос[её]лок)\./i, '$1');
  return loc.split(',')[0].trim();
}

function extractSnapshotMeta(html) {
  // Livewire keeps its component state in wire:snapshot="{...}" (entity-encoded).
  const m = html.match(/wire:snapshot="([^"]+)"/);
  if (!m) return {};
  const raw = m[1].replace(/&quot;/g, '"').replace(/&#34;/g, '"').replace(/&amp;/g, '&');
  try {
    const data = JSON.parse(raw).data || {};
    return {
      totalPages: Number(data.countPage) || null,
      totalCount: Number(data.vacancyCount) || null,
      prof: typeof data.prof === 'string' ? data.prof : null,
      experience: data.experience || null,
    };
  } catch (_e) { return {}; }
}

/**
 * Parse a search results page. Pure; no network.
 * Returns { cards: Card[], meta: { totalPages, totalCount, ... } }.
 */
function parseSearchPage(html) {
  const $ = cheerio.load(html);
  const cards = [];
  $('div.item-list').each((_, el) => {
    const $el = $(el);
    const key = $el.attr('wire:key') || '';
    const keyId = (key.match(/^item-(\d+)$/) || [])[1];
    const $a = $el.find('.head .title a').first();
    const href = $a.attr('href') || '';
    const hrefId = (href.match(/~(\d+)(?:[/?#]|$)/) || [])[1];
    const id = keyId || hrefId;
    if (!id) return; // the employer block on vacancy pages is also .item-list — skip
    const title = squash($a.text()) || squash($a.attr('title'));
    const location = squash($el.find('li.location').first().text());
    const experienceText = squash($el.find('li.experience').first().text());
    const badges = $el.find('.forwhom span').map((_, s) => squash($(s).text())).get().filter(Boolean);
    const posted = squash($el.find('.right-content').text());
    const salary = parseSalary($el.find('.price').first().text());
    cards.push({
      id,
      url: absUrl(href) || `${BASE}/ru/vacancy/${id}`,
      title,
      subtitle: squash($el.find('.subtitle').first().text()),
      area: squash($el.find('.profobl').first().text()),
      company: squash($el.find('li.company').first().text()),
      location,
      city: extractCity(location),
      experienceText,
      experienceYears: parseExperienceYears(experienceText),
      schedule: squash($el.find('li.time').first().text()),
      education: squash($el.find('li.education').first().text()),
      badges,
      salaryMin: salary.min,
      salaryMax: salary.max,
      postedAt: parseRuDate(posted),
    });
  });
  return { cards, meta: extractSnapshotMeta(html) };
}

/** Description assembled from card fields only (used when we don't fetch the detail page). */
function cardDescription(card) {
  const parts = [];
  if (card.subtitle && card.subtitle.toLowerCase() !== card.title.toLowerCase()) parts.push(card.subtitle + '.');
  if (card.area) parts.push(`Сфера: ${card.area}.`);
  if (card.schedule) parts.push(`График работы: ${card.schedule}.`);
  if (card.education) parts.push(`Образование: ${card.education}.`);
  if (card.experienceYears === 0) parts.push('Опыт работы: опыт не требуется.');
  else if (card.experienceText) parts.push(`Опыт работы: ${card.experienceText}.`);
  if (card.badges.length) parts.push(card.badges.join('. ') + '.');
  if (card.location) parts.push(`Регион: ${card.location}.`);
  return parts.join('\n');
}

function listText($, $node) {
  // <ul><li><p>…</p></li></ul> → "- …" lines; plain <p> → lines
  const items = $node.find('li');
  if (items.length) return items.map((_, li) => '- ' + squash($(li).text()).replace(/;$/, '')).get().join('\n');
  const paras = $node.find('p');
  if (paras.length) return paras.map((_, p) => squash($(p).text())).get().filter(Boolean).join('\n');
  return squash($node.text());
}

/**
 * Parse a single vacancy page. Pure; no network.
 * Returns { isVacancyPage, archived, id, title, company, location, city, salaryMin,
 *           salaryMax, experienceText, experienceYears, postedAt, description, ld }.
 */
function parseVacancyPage(html) {
  const $ = cheerio.load(html);
  const out = { isVacancyPage: false, archived: false, ld: null, description: '' };

  // Archive banner — the only definitive "closed" signal on a 200 page.
  $('.alert').each((_, el) => { if (ARCHIVE_MARKER.test($(el).text())) out.archived = true; });

  $('script[type="application/ld+json"]').each((_, el) => {
    if (out.ld) return;
    try {
      const j = JSON.parse($(el).contents().text());
      if (j && j['@type'] === 'JobPosting') out.ld = j;
    } catch (_e) { /* malformed → ignore, body parse below still works */ }
  });

  const $page = $('.page.vacancy');
  if (!out.ld && !$page.length) return out;
  out.isVacancyPage = true;

  const ld = out.ld || {};
  out.id = ld.identifier && ld.identifier.value ? String(ld.identifier.value) : null;
  out.title = squash($page.find('h4.title').first().text()) || squash(ld.title);
  out.company = squash((ld.hiringOrganization && ld.hiringOrganization.name) || '');
  const info = {};
  $page.find('ul.info li').each((_, li) => {
    const label = squash($(li).find('.label').text());
    const value = squash($(li).find('span').not('.label').text());
    if (label && value) info[label] = value;
  });
  const sections = {};
  $page.find('.single-line').each((_, el) => {
    const label = squash($(el).find('.label').first().text());
    const $v = $(el).find('.value').first();
    if (label && $v.length) sections[label] = listText($, $v);
  });
  const regionText = sections['Регион'] || squash((ld.jobLocation && ld.jobLocation.address && ld.jobLocation.address.addressLocality) || '').replace(/\s*\/\s*/g, ', ');
  out.location = regionText;
  out.city = extractCity(regionText);
  const sal = parseSalary($page.find('.price').first().text());
  if (!sal.min && ld.baseSalary && ld.baseSalary.value && ld.baseSalary.value.value) sal.min = Number(ld.baseSalary.value.value) || null;
  out.salaryMin = sal.min; out.salaryMax = sal.max;
  out.experienceText = info['Опыт работы'] || squash(ld.experienceRequirements || '');
  out.experienceYears = parseExperienceYears(out.experienceText);
  out.postedAt = parseRuDate($page.find('ul.info.small').text()) || parseRuDate(ld.datePosted || '');
  out.employmentType = info['Тип занятости'] || '';
  out.schedule = info['График работы'] || '';
  out.education = info['Образование'] || squash(ld.educationRequirements || '');
  out.practice = /для прохождения практики/i.test($page.find('.h5').text());

  const parts = [];
  const subtitle = squash($page.find('.subtitle').first().text());
  if (subtitle && subtitle.toLowerCase() !== (out.title || '').toLowerCase()) parts.push(subtitle + '.');
  if (out.practice) parts.push('Вакансия для прохождения практики студентами.');
  for (const key of ['Обязанности', 'Профессиональные навыки', 'Личные качества']) {
    if (sections[key]) parts.push(`${key}:\n${sections[key]}`);
  }
  const conds = [];
  for (const k of ['Тип занятости', 'График работы', 'Условия труда', 'Стажировка', 'Опыт работы', 'Образование']) if (info[k]) conds.push(`${k} — ${info[k]}`);
  if (out.experienceYears === 0 && !info['Опыт работы']) conds.push('Опыт работы — опыт не требуется');
  if (conds.length) parts.push('Условия: ' + conds.join('; ') + '.');
  if (sections['Место работы']) parts.push(`Место работы: ${sections['Место работы']}`);
  if (regionText) parts.push(`Регион: ${regionText}`);
  out.description = parts.join('\n\n').trim();
  return out;
}

const jitter = () => 800 + Math.floor(Math.random() * 400);

function buildJob(ctx, card, detail) {
  const tags = ['enbek.kz'];
  const expYears = detail && detail.experienceYears !== null && detail.experienceYears !== undefined ? detail.experienceYears : card.experienceYears;
  if (expYears === 0) tags.push('Без опыта');
  for (const b of card.badges) {
    if (/практик/i.test(b)) tags.push('Практика');
    else if (/от 14 лет/i.test(b)) tags.push('От 14 лет');
    else tags.push(b);
  }
  if (detail && detail.practice && !tags.includes('Практика')) tags.push('Практика');
  const schedule = (detail && detail.schedule) || card.schedule;
  if (/неполн|частичн|гибк/i.test(schedule)) tags.push('Частичная занятость');

  const description = (detail && detail.description) || cardDescription(card);
  return {
    raw: {
      source: 'enbek_kz',
      source_id: `enbek_${card.id}`,
      source_url: card.url,
      apply_url: card.url,
      title: card.title || (detail && detail.title),
      company: card.company || (detail && detail.company),
      location: card.city || (detail && detail.city) || card.location,
      description,
      salary_min: card.salaryMin || (detail && detail.salaryMin) || null,
      salary_max: card.salaryMax || (detail && detail.salaryMax) || null,
      currency: 'KZT',
      tags,
      posted_at: card.postedAt || (detail && detail.postedAt) || null,
    },
    structuredEntry: expYears === 0,
    expYears,
  };
}

async function scrape(ctx) {
  const { http, log = () => {}, filter, normalize } = ctx;
  const limits = ctx.limits || {};
  const maxPages = limits.maxPages || 3;
  const maxJobs = limits.maxJobs || 500;
  const maxDetails = limits.maxDetails === undefined ? 60 : limits.maxDetails;
  const known = ctx.knownIds instanceof Set ? ctx.knownIds : new Set();
  const queries = ctx.queries || DEFAULT_QUERIES;

  const stats = { pagesFetched: 0, emptyPages: 0, rawSeen: 0, dupes: 0, kept: 0, rejectedByFilter: 0, rejectReasons: {}, detailsFetched: 0, detailFailures: 0, byQuery: {} };
  const notes = [];
  const seen = new Set();
  const cards = [];
  let fetchErrors = 0;

  // 1. Collect cards from every query/page (dedupe by numeric id across queries).
  for (const q of queries) {
    let totalPages = null;
    for (let page = 1; page <= maxPages; page++) {
      if (totalPages !== null && page > totalPages) break;
      const url = searchUrl(q.params, page);
      let body;
      try {
        ({ body } = await http.text(url));
      } catch (e) {
        fetchErrors++;
        notes.push(`fetch failed ${url}: ${e.message}`);
        log(`[enbek] fetch failed ${url}: ${e.message}`);
        break;
      }
      stats.pagesFetched++;
      const { cards: pageCards, meta } = parseSearchPage(body);
      if (meta.totalPages) totalPages = meta.totalPages;
      if (pageCards.length === 0) {
        // A 200 with no cards is either a genuinely empty result (meta.totalCount === 0)
        // or a page-shape change. Distinguish so the alert is actionable.
        if (meta.totalCount === 0) { log(`[enbek] ${q.label} p${page}: 0 results`); break; }
        stats.emptyPages++;
        notes.push(`selector matched 0 cards on ${url} — page shape changed?`);
        break;
      }
      let fresh = 0;
      for (const c of pageCards) {
        stats.rawSeen++;
        if (seen.has(c.id)) { stats.dupes++; continue; }
        seen.add(c.id); fresh++;
        cards.push({ ...c, query: q.label });
      }
      stats.byQuery[q.label] = (stats.byQuery[q.label] || 0) + fresh;
      log(`[enbek] ${q.label} p${page}/${totalPages || '?'}: ${pageCards.length} cards, ${fresh} new (total ${meta.totalCount ?? '?'})`);
      if (pageCards.length < 10) break; // last page
      await http.sleep(jitter());
    }
  }

  if (stats.pagesFetched === 0) throw new Error(`enbek: no search page could be fetched (${fetchErrors} errors): ${notes.slice(0, 3).join(' | ')}`);
  if (cards.length === 0 && stats.emptyPages === stats.pagesFetched) {
    throw new Error(`enbek: every fetched page (${stats.pagesFetched}) returned 200 but matched 0 cards — selector 'div.item-list[wire:key=item-*]' no longer matches; page shape changed?`);
  }

  // 2. Detail pages for NEW ids only (cards have no description), capped.
  const jobs = [];
  for (const card of cards) {
    if (jobs.length >= maxJobs) break;
    const isKnown = known.has(`enbek_${card.id}`) || known.has(card.id);
    let detail = null;
    if (!isKnown && stats.detailsFetched < maxDetails) {
      try {
        await http.sleep(jitter());
        const { body } = await http.text(card.url);
        stats.detailsFetched++;
        const parsed = parseVacancyPage(body);
        if (parsed.isVacancyPage && !parsed.archived) detail = parsed;
        else if (parsed.archived) { stats.rejectReasons['archived'] = (stats.rejectReasons['archived'] || 0) + 1; continue; }
      } catch (e) {
        stats.detailFailures++;
        log(`[enbek] detail failed ${card.url}: ${e.message}`);
      }
    }

    const { raw, structuredEntry, expYears } = buildJob(ctx, card, detail);

    // The site's own "Опыт работы" field is a structured signal (like hh's
    // workExperience). Positive years = definitely not a student job; count it
    // separately so the reason is visible in the log.
    if (expYears > 0) {
      stats.rejectedByFilter++;
      stats.rejectReasons['site-requires-experience'] = (stats.rejectReasons['site-requires-experience'] || 0) + 1;
      continue;
    }
    if (!filter.isStudentFriendly(raw.title, raw.description, raw.tags, { structuredEntry })) {
      stats.rejectedByFilter++;
      const reason = filter.studentRejectReason ? (filter.studentRejectReason(raw.title, raw.description, raw.tags) || 'no-positive-signal') : 'filtered';
      stats.rejectReasons[reason] = (stats.rejectReasons[reason] || 0) + 1;
      continue;
    }
    const job = normalize.makeJob(raw);
    if (!job) {
      const reason = 'normalize:' + (normalize.makeJob.lastReject || 'rejected');
      stats.rejectReasons[reason] = (stats.rejectReasons[reason] || 0) + 1;
      continue;
    }
    jobs.push(job);
    stats.kept++;
  }

  if (stats.emptyPages) notes.push(`${stats.emptyPages} of ${stats.pagesFetched} pages matched 0 cards`);
  return { jobs, stats, notes };
}

async function canary(ctx) {
  const url = searchUrl({ experience: 'e1' });
  try {
    const { body } = await ctx.http.text(url);
    const { cards, meta } = parseSearchPage(body);
    const good = cards.filter((c) => c.title && c.url && /~\d+$/.test(c.url));
    if (good.length < 3) {
      return { ok: false, reason: `only ${good.length} well-formed cards parsed from ${url} (raw ${cards.length}, snapshot count ${meta.totalCount ?? 'n/a'}) — selectors stale?` };
    }
    if (meta.experience && meta.experience !== 'e1') {
      return { ok: false, reason: `experience=e1 GET param no longer honoured (snapshot says ${meta.experience})` };
    }
    return { ok: true, reason: `${good.length} cards parsed, ${meta.totalCount ?? '?'} no-experience vacancies on site` };
  } catch (e) {
    return { ok: false, reason: `${url}: ${e.message}` };
  }
}

async function verify(ctx, row) {
  if (!row || !row.source_url) return 'unknown';
  let r;
  try {
    r = await ctx.http.text(row.source_url, { allow: [404, 410, 403, 429, 500, 502, 503] });
  } catch (_e) {
    return 'unknown';
  }
  if (r.status === 404 || r.status === 410) return 'dead';
  if (r.status !== 200) return 'unknown';
  const v = parseVacancyPage(r.body);
  if (v.archived) return 'dead';
  if (v.isVacancyPage) return 'alive';
  return 'unknown'; // 200 but not a vacancy page (redirected to home/login?) — never kill on that
}

module.exports = {
  name: 'enbek_kz',
  minExpected: 5,
  ttlDays: 21,
  scrape,
  canary,
  verify,
  // exported for tests / debugging
  parseSearchPage,
  parseVacancyPage,
  parseSalary,
  parseExperienceYears,
  parseRuDate,
  extractCity,
  cardDescription,
  searchUrl,
  DEFAULT_QUERIES,
  ARCHIVE_MARKER,
};
