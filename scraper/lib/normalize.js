/**
 * lib/normalize.js — what a job row looks like. Every source funnels through
 * makeJob(); nothing else writes rows.
 *
 *   makeJob(raw)        → Job | null   (null = garbage, with reason in makeJob.lastReject)
 *   validateJob(row)    → string | null (reject reason for an existing DB row)
 *   toRow(job)          → object with only real `jobs` columns
 *   cleanTitle / cleanCompany / cleanLocation / canonicalCity
 */

const { decodeEntities } = require('./http');

// Only these keys are real columns on the `jobs` table. Anything else makes
// PostgREST reject the whole batch ("column does not exist").
const JOB_COLUMNS = [
  'source', 'source_id', 'source_url', 'apply_url', 'source_type', 'source_channel',
  'title', 'company', 'company_logo', 'location', 'description', 'raw_text',
  'salary_min', 'salary_max', 'currency', 'tags', 'status', 'posted_at',
];

// Canonical city names (RU) with aliases in RU/KZ/EN + hh.kz area ids.
const CITIES = [
  ['Алматы', ['алматы', 'almaty', 'алмата', 'алма-ата', 'алматинская область']],
  ['Астана', ['астана', 'astana', 'нур-султан', 'nur-sultan', 'nursultan']],
  ['Шымкент', ['шымкент', 'shymkent', 'чимкент']],
  ['Караганда', ['караганда', 'karaganda', 'қарағанды', 'karagandy']],
  ['Актобе', ['актобе', 'aktobe', 'ақтөбе']],
  ['Атырау', ['атырау', 'atyrau']],
  ['Павлодар', ['павлодар', 'pavlodar']],
  ['Тараз', ['тараз', 'taraz']],
  ['Усть-Каменогорск', ['усть-каменогорск', 'oskemen', 'өскемен', 'ust-kamenogorsk']],
  ['Семей', ['семей', 'semey']],
  ['Костанай', ['костанай', 'kostanay', 'қостанай']],
  ['Кызылорда', ['кызылорда', 'kyzylorda', 'қызылорда']],
  ['Уральск', ['уральск', 'oral', 'орал']],
  ['Петропавловск', ['петропавловск', 'petropavlovsk']],
  ['Актау', ['актау', 'aktau', 'ақтау']],
  ['Туркестан', ['туркестан', 'turkestan', 'түркістан']],
  ['Кокшетау', ['кокшетау', 'kokshetau', 'көкшетау']],
  ['Талдыкорган', ['талдыкорган', 'taldykorgan']],
  ['Темиртау', ['темиртау', 'temirtau']],
  ['Экибастуз', ['экибастуз', 'ekibastuz']],
];
const REMOTE_WORDS = ['удалённо', 'удаленно', 'remote', 'қашықтан', 'дистанционно', 'удаленная работа', 'удалённая работа'];

const lc = (s) => (s || '').toLowerCase();

function canonicalCity(text) {
  const t = lc(text);
  if (!t) return null;
  for (const [city, aliases] of CITIES) if (aliases.some((a) => t.includes(a))) return city;
  if (REMOTE_WORDS.some((w) => t.includes(w))) return 'Удалённо';
  return null;
}

/** Location: canonical city if we can find one; collapse enbek-style region soup. */
function cleanLocation(raw) {
  const s = decodeEntities(String(raw || '')).replace(/\s+/g, ' ').trim();
  if (!s) return 'Казахстан';
  const city = canonicalCity(s);
  if (city) return city;
  // "Область X, г.Y" → Y ; multiple concatenated regions → first city-looking token
  const m = s.match(/г\.\s*([А-ЯЁA-Z][\wА-Яа-яЁё-]{2,30})/);
  if (m) return canonicalCity(m[1]) || m[1];
  if (s.length > 40 || /область.*область/i.test(s)) return 'Казахстан';
  return s.slice(0, 40);
}

const EMOJI_RE = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}\u{FE0F}\u{200D}]/gu;

function cleanTitle(raw) {
  let s = decodeEntities(String(raw || ''))
    .replace(EMOJI_RE, '')
    .replace(/[*_`#>|]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  // Strip leading punctuation/fragments (", напишите мне…", "- Менеджер")
  s = s.replace(/^[\s,.;:!?\-–—•·«»"'()\[\]]+/, '');
  // Strip trailing salary/hashtag tails
  s = s.replace(/\s*(зарплата|з\/п|оклад|salary)\s*[:\-–—].*$/i, '').replace(/(\s*#\w+)+$/g, '').trim();
  // "Вакансия: X" / "Ищем X" / "Требуется X" → X
  s = s.replace(/^(ваканси[яи]|должность|позиция|position|job title|ищем|требуется|требуются|нужен|нужна|нужны|в поиске|открыта вакансия)\s*[:\-–—]?\s*/i, '');
  // Trailing punctuation
  s = s.replace(/[\s,.;:!\-–—]+$/, '').trim();
  return s.slice(0, 120);
}

function cleanCompany(raw) {
  let s = decodeEntities(String(raw || '')).replace(EMOJI_RE, '').replace(/\s+/g, ' ').trim();
  s = s.replace(/^(компания|работодатель|company|employer)\s*[:\-–—]?\s*/i, '');
  s = s.replace(/^[«"“']+|[»"”'.,]+$/g, '').trim();
  // Enbek prints the full legal form; keep it readable.
  s = s.replace(/^Товарищество с ограниченной ответственностью\s*/i, 'ТОО ')
       .replace(/^Индивидуальный предприниматель\s*/i, 'ИП ')
       .replace(/^Акционерное общество\s*/i, 'АО ');
  if (!s || /^(unknown|неизвестно|компания|организация|ип клиента\.?)$/i.test(s)) return 'Компания';
  return s.slice(0, 80);
}

// Tokens that legitimately start a lowercase job title.
const LOWERCASE_OK = /^(ios|android|frontend|front-end|backend|back-end|fullstack|full-stack|qa|ux|ui|smm|seo|php|node|nodejs|react|vue|python|java|javascript|typescript|devops|hr|it|b2b|b2c|1c|1с|erp|crm|seo-|smm-)\b/i;

/**
 * Checks that must run on the RAW title, before cleanTitle() strips the
 * punctuation they depend on. Returns a reject reason or null.
 */
function rawTitleProblem(raw) {
  const t = String(raw || '').trim();
  if (!t) return null;
  const letters = t.replace(/[^\p{L}]/gu, '');
  // Slogans: "ХВАТИТ ИСКАТЬ РАБОТУ — ПУСТЬ ОНА НАЙДЁТ ТЕБЯ!"
  if (letters.length > 8 && letters === letters.toUpperCase() && /[!?]/.test(t)) return 'title-shouty';
  if (/\?\s*$/.test(t) && t.split(/\s+/).length > 3) return 'title-question';
  return null;
}

/**
 * Title sanity: does this look like a job title (not a sentence fragment)?
 * Returns a reject reason or null.
 */
function titleProblem(title) {
  // Callers sometimes pass raw DB values (the cleanup sweep does). Strip the
  // leading punctuation cleanTitle would have removed so the shape checks below
  // judge the words, not the noise in front of them.
  const t = String(title || '').replace(/^[\s,.;:!?\-–—•·«»"'()\[\]]+/, '').trim();
  if (t.length < 4) return 'title-too-short';
  if (t.length > 120) return 'title-too-long';
  if (!/[A-Za-zА-Яа-яЁёӘәІіҢңҒғҮүҰұҚқӨөҺһ]{3}/.test(t)) return 'title-no-letters';
  // Sentence fragments: starts lowercase and reads like prose ("находится на стыке…")
  if (/^[a-zа-яё]/.test(t) && /\s(на|в|с|и|или|для|по|от|к|о)\s/.test(t) && t.split(' ').length > 5) return 'title-fragment';
  // Imperatives / calls to action
  if (/^(напишите|пишите|отправ|звоните|присоединяй|регистрир|заполни|переход|подпис|жми|успей|поспеши)/i.test(t)) return 'title-cta';
  // Questions / marketing
  if (/\?$/.test(t) && t.split(' ').length > 3) return 'title-question';
  if (/(приглашает|запускает|объявляет|проводит|открывает набор)/i.test(t) && !/(стаж|intern|ваканси|практик)/i.test(t)) return 'title-announcement';
  // Too many words → it's a sentence, not a title
  if (t.split(/\s+/).length > 12) return 'title-sentence';
  // A single short word is a stub, not a role ("работа", "Сайт:")
  const words = t.split(/\s+/);
  if (words.length === 1 && t.replace(/[^\p{L}]/gu, '').length < 8) return 'title-stub';
  // A label with nothing after it
  if (/[:：]$/.test(t)) return 'title-label-only';
  // Shouty marketing copy ("ХВАТИТ ИСКАТЬ РАБОТУ — ПУСТЬ ОНА НАЙДЁТ ТЕБЯ!")
  const letters = t.replace(/[^\p{L}]/gu, '');
  if (letters.length > 8 && letters === letters.toUpperCase() && /[!?]/.test(t)) return 'title-shouty';
  // Instructions to the reader rather than a role
  if (/(направлять|отправляйте|прошу\s+направ|присылайте)\s|резюме\s+(hr|на\s+почт)/i.test(t)) return 'title-instruction';
  // Real job titles are capitalised. A lowercase opener is almost always a
  // mid-sentence fragment lifted out of a post body — except for tech tokens
  // that are genuinely written lowercase (iOS, frontend, QA…).
  if (/^[a-zа-яё]/.test(t) && !LOWERCASE_OK.test(t)) return 'title-lowercase-fragment';
  return null;
}

function isoOrNow(v) {
  if (!v) return new Date().toISOString();
  const d = new Date(v);
  if (isNaN(d.getTime())) return new Date().toISOString();
  // Refuse absurd future dates (timezone slips) — clamp to now.
  if (d.getTime() > Date.now() + 6 * 3600e3) return new Date().toISOString();
  return d.toISOString();
}

function intOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : parseInt(String(v).replace(/[^\d]/g, ''), 10);
  if (!isFinite(n) || n <= 0) return null;
  return Math.round(n);
}

/** Build a validated job. Returns null (and sets makeJob.lastReject) for garbage. */
function makeJob(raw) {
  makeJob.lastReject = null;
  const reject = (r) => { makeJob.lastReject = r; return null; };
  if (!raw || !raw.source || !raw.source_id || !raw.source_url) return reject('missing-ids');

  const rtp = rawTitleProblem(raw.title);
  if (rtp) return reject(rtp);
  const title = cleanTitle(raw.title);
  const tp = titleProblem(title);
  if (tp) return reject(tp);

  let salary_min = intOrNull(raw.salary_min), salary_max = intOrNull(raw.salary_max);
  // Plausibility for KZT monthly figures; nuke nonsense (phone numbers, years)
  const cur = (raw.currency || 'KZT').toUpperCase();
  if (cur === 'KZT') {
    if (salary_min && (salary_min < 20000 || salary_min > 5000000)) salary_min = null;
    if (salary_max && (salary_max < 20000 || salary_max > 5000000)) salary_max = null;
  }
  if (salary_min && salary_max && salary_max < salary_min) [salary_min, salary_max] = [salary_max, salary_min];

  const tags = Array.from(new Set((raw.tags || []).map((t) => String(t).trim()).filter(Boolean))).slice(0, 12);

  return {
    source: raw.source,
    source_id: String(raw.source_id).slice(0, 120),
    source_url: String(raw.source_url).slice(0, 500),
    apply_url: raw.apply_url ? String(raw.apply_url).slice(0, 500) : null,
    source_type: raw.source_type || null,
    source_channel: raw.source_channel || null,
    title,
    company: cleanCompany(raw.company),
    company_logo: raw.company_logo || null,
    location: cleanLocation(raw.location),
    description: decodeEntities(String(raw.description || '')).replace(/\r/g, '').trim().slice(0, 5000),
    raw_text: raw.raw_text ? String(raw.raw_text).slice(0, 8000) : null,
    salary_min, salary_max,
    currency: cur,
    tags,
    status: 'active',
    posted_at: isoOrNow(raw.posted_at),
  };
}

/** Validate an existing DB row under current rules (used by cleanup's garbage sweep). */
function validateJob(row) {
  if (!row) return 'empty';
  const rtp = rawTitleProblem(row.title);
  if (rtp) return rtp;
  const tp = titleProblem(cleanTitle(row.title));
  if (tp) return tp;
  if (!row.source_url) return 'missing-url';
  return null;
}

function toRow(job) {
  const row = {};
  for (const k of JOB_COLUMNS) if (job[k] !== undefined) row[k] = job[k];
  return row;
}

module.exports = { makeJob, validateJob, toRow, cleanTitle, cleanCompany, cleanLocation, canonicalCity, titleProblem, rawTitleProblem, JOB_COLUMNS, CITIES };
