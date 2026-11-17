/**
 * Parser — turns one raw Telegram post into a structured job, or null if the
 * post isn't a vacancy. DETERMINISTIC: regex + keyword dictionaries only, no AI.
 *
 * SWAP POINT: `parsePost(rawPost)` is the single entry point. To plug in an AI
 * parser later, replace the body of parsePost (keep the same input/output shape)
 * — nothing else in the pipeline needs to change.
 *
 * Input  rawPost: { channel, msgId, postUrl, dateISO, text, links[] }
 * Output job | null:
 *   { source, source_id, source_url, apply_url, source_type, source_channel,
 *     title, company, location, type, salary_min, salary_max, currency,
 *     skills[], tags[], description, raw_text, posted_at, status }
 */

// ── Keyword dictionaries (RU / KZ / EN) ─────────────────────────────────────
const CITY_KEYWORDS = [
  ['Алматы', ['алматы', 'almaty', 'алмата']],
  ['Астана', ['астана', 'astana', 'нур-султан', 'nur-sultan']],
  ['Шымкент', ['шымкент', 'shymkent']],
  ['Караганда', ['караганда', 'karaganda', 'қарағанды']],
  ['Актобе', ['актобе', 'aktobe', 'ақтөбе']],
  ['Атырау', ['атырау', 'atyrau']],
  ['Павлодар', ['павлодар', 'pavlodar']],
  ['Тараз', ['тараз', 'taraz']],
  ['Усть-Каменогорск', ['усть-каменогорск', 'oskemen', 'өскемен']],
  ['Remote', ['удалённо', 'удаленно', 'remote', 'қашықтан', 'дистанционно', 'онлайн']],
];

const TYPE_RULES = [
  ['internship', ['стажировк', 'стажёр', 'стажер', 'тағылымдама', 'intern', 'trainee', 'практик']],
  ['part-time',  ['частичн', 'неполн', 'подработк', 'part-time', 'part time', 'жартылай', 'гибкий график', 'совмещ']],
  ['remote',     ['удалённо', 'удаленно', 'remote', 'қашықтан', 'дистанционно']],
];

const SALARY_KEYWORDS = ['зарплат', 'заработн', 'оклад', 'оплата', 'жалақы', 'salary', 'компенсаци', 'доход', 'з/п', 'зп'];

// Compact skills dictionary (canonical → match tokens). Mirrors the frontend's
// RESUME_SKILLS vocabulary so Telegram jobs and resumes match on the same terms.
const SKILLS = [
  ['Python', ['python', 'питон']], ['JavaScript', ['javascript', ' js ']], ['TypeScript', ['typescript']],
  ['Java', ['java']], ['C++', ['c++']], ['Go', ['golang']], ['PHP', ['php']],
  ['React', ['react']], ['Vue', ['vue']], ['Node.js', ['node.js', 'nodejs']], ['Flutter', ['flutter']],
  ['SQL', ['sql']], ['PostgreSQL', ['postgres']], ['MongoDB', ['mongodb', 'mongo']],
  ['Docker', ['docker']], ['Git', ['git', 'github']], ['Linux', ['linux']], ['AWS', ['aws']],
  ['Excel', ['excel', 'эксель', 'ms excel']], ['Power BI', ['power bi', 'powerbi']], ['Tableau', ['tableau']],
  ['1C', ['1с', '1c']], ['SAP', ['sap']], ['CRM', ['crm']], ['Jira', ['jira']],
  ['Figma', ['figma', 'фигма']], ['Photoshop', ['photoshop', 'фотошоп']], ['Canva', ['canva']],
  ['SMM', ['smm', 'social media']], ['SEO', ['seo']], ['Google Analytics', ['google analytics']],
  ['Machine Learning', ['machine learning', 'машинное обучение']], ['Data Science', ['data science', 'анализ данных']],
  ['Finance', ['финанс', 'қаржы']], ['Accounting', ['бухгалт', 'бухучет']], ['Marketing', ['маркетинг']],
  ['Sales', ['продаж', 'сату']], ['Management', ['менеджмент', 'управлени']], ['English', ['английск', 'english', 'ielts', 'b1', 'b2', 'upper-intermediate']],
];

// ── Helpers ────────────────────────────────────────────────────────────────
const { NOT_A_JOB } = require('../lib/filter');
const { titleProblem } = require('../lib/normalize');
const {
  hasRoleWord, TITLE_LABEL_RE, TITLE_VERB_RE, COMPANY_LABEL_RE, APPLY_LABEL_RE, SALARY_LABEL_RE,
  NOT_TITLE_LINE, PROSE_OPENER, sentenceCase, stripLead, cleanLine,
} = require('./roles');

const { resolveApply } = require('./apply');
const { channelByUsername } = require('./channels');
const { profileFor } = require('./profiles');

const lc = (s) => (s || '').toLowerCase();

// Is this post actually a job/internship vacancy (vs. an event, grant, course,
// club recruitment, ad, or news)?
//
// The old version accepted any post containing a loose "job signal" word, which
// is how grants ("Грант Tech Orda"), club recruitment ("AIESEC Recruitment
// Fall'26"), training academies and resume-service ads all ended up on the
// board. The gate is now: NOT-A-JOB veto (shared with lib/filter) → must have a
// role word → must have at least one hiring-structure signal.
function isVacancy(text, { titleFromProfile = false } = {}) {
  if (!text || text.replace(/\s/g, '').length < 60) return false;          // empty / media-only
  if (/please open telegram|view in telegram/i.test(text)) return false;    // media placeholder
  const t = lc(text);

  // 1. Hard veto: things career channels post that are not jobs. Reuse the
  //    shared list so the website, scraper and Telegram agree on what a job is.
  const strongJob = /вакансия|должность|стажировк|стажер|стажёр|intern|trainee|тағылымдама/.test(t);
  if (!strongJob) {
    for (const re of NOT_A_JOB) if (re.test(t)) return false;
  }
  // Programs/academies/grants are never vacancies even when they say "стажировка"
  // as a perk ("даёт доступ к стажировкам").
  if (/(грант|scholarship|стипенди)\w*\s|training\s+program|academy|академи[яю]\s|курс\s+подойд|онлайн-курс|обучающ\w+\s+программ/.test(t)
      && !/(вакансия|должность\s*:|мы\s+ищем|требуется\s+на\s+должность)/.test(t)) return false;
  if (/recruitment\s+(fall|spring|summer|winter)|набор\s+в\s+(команду\s+)?aiesec|enactus|волонт[её]р/.test(t)) return false;

  // 2. Must name a role somewhere.
  if (!titleFromProfile && !hasRoleWord(t)) return false; // a profile's labelled title is itself the role evidence

  // 3. Must look like an actual hiring post: structure or an explicit label.
  const structure = [
    /обязанност|требовани|условия\s+работы|что\s+мы\s+предлагаем|мы\s+предлагаем|responsibilities|requirements|qualifications/,
    /график\s+работы|полная\s+занятост|частичная\s+занятост|неполный\s+день|５\/２|5\/2/,
    /резюме\s+(на|по|отправ)|отклик|подать\s+заявку|apply|ссылка\s+на\s+вакансию|откликнуться/,
    /зарплат|оклад|заработной\s+платы|salary|жалақы/,
    /^\s*(должность|вакансия|позиция|position)\s*[:\-–—]/im,
    // NB: test against `t` (lower-cased), not `text` — real posts capitalise
    // "Обязанности:" / "Требования:" and a case-sensitive test silently
    // rejected every one of them.
  ].filter((re) => re.test(t)).length;
  return titleFromProfile || structure >= 1;
}

// Cities outside Kazakhstan that general job channels advertise (Dubai florists,
// Moscow call centres). Used only on a profile's explicit location field.
const FOREIGN_RE = /дубай|dubai|москв|moscow|санкт-петербург|петербург|минск|бишкек|ташкент|баку|тбилиси|стамбул|istanbul|варшав|берлин|лондон|london|нью-йорк|new york|сеул|пекин|шанхай|тбилис|ереван|киев|краков|прага|европ/i;

function detectCity(text) {
  const t = lc(text);
  for (const [city, kws] of CITY_KEYWORDS) if (kws.some((k) => t.includes(k))) return city;
  return 'Kazakhstan';
}

// Shift work ("за смену", "график 2/2") counts as part-time for the big general
// channels, where students mostly find café / retail / warehouse shifts.
const SHIFT_RE = /(?<![а-яё])смен[аыуео]|сменн|2\/2|вахт|по\s+сменам/i;

function detectType(text, { shiftAsPartTime = false } = {}) {
  const t = lc(text);
  for (const [type, kws] of TYPE_RULES) if (kws.some((k) => t.includes(k))) return type;
  if (shiftAsPartTime && SHIFT_RE.test(t)) return 'part-time';
  return 'full-time';
}

function detectSkills(text) {
  const t = lc(text);
  const out = [];
  for (const [canon, kws] of SKILLS) if (kws.some((k) => t.includes(k))) out.push(canon);
  return out;
}

// Parse a salary ONLY from the neighbourhood of a salary keyword, to avoid
// grabbing phone numbers, dates, or addresses. Returns { min, max }.
function detectSalary(text) {
  const t = lc(text);
  let ctx = '';
  for (const kw of SALARY_KEYWORDS) {
    const i = t.indexOf(kw);
    if (i !== -1) { ctx = text.slice(i, i + 90); break; }
  }
  if (!ctx) return { min: null, max: null };
  if (/не\s*указан|по\s*договор|по\s*итогам|договорн/i.test(ctx)) return { min: null, max: null };
  // number groups like "380.000", "150 000", "100000"
  const nums = (ctx.match(/\d[\d\s. ]{3,}/g) || [])
    .map((s) => parseInt(s.replace(/[\s. ]/g, ''), 10))
    .filter((n) => n >= 30000 && n <= 3000000); // plausible monthly KZT
  if (!nums.length) return { min: null, max: null };
  return { min: Math.min(...nums), max: nums.length > 1 ? Math.max(...nums) : null };
}

// ── Title ────────────────────────────────────────────────────────────────────
// Returns a ROLE, or null when the post has no recognisable one (caller drops
// the post). Order matters: an explicit label beats a guessed line, and a
// guessed line must contain a role word — otherwise we get sentence fragments
// like "находится на стыке бизнес-аналитики" (a real row from the old board).
function detectTitle(text) {
  // stripLead drops emoji / bullets so "💼 Вакансия: Стажёр" is still a label line.
  const lines = (text || '').split('\n').map((l) => stripLead(l)).filter(Boolean);

  // 1. Explicit label line: "Должность: Стажер в отдел логистики"
  for (const raw of lines) {
    const m = raw.match(TITLE_LABEL_RE);
    if (m) {
      const v = trimTitle(cleanLine(m[1]));
      if (v.length > 3 && !titleProblem(v)) return v;
    }
  }

  // 2. Verb pattern: "LG Electronics is looking for talented students!" /
  //    "в поиске молодых специалистов ... на позицию: Ассистента рекрутера"
  const onPosition = text.match(/на\s+(?:позицию|должность)\s*[:\-–—]?\s*([^\n.!]{3,80})/i);
  if (onPosition) {
    const v = trimTitle(cleanLine(onPosition[1]));
    if (hasRoleWord(v) && !titleProblem(v)) return v;
  }
  const verb = text.match(TITLE_VERB_RE);
  if (verb) {
    const v = trimTitle(cleanLine(verb[1]));
    if (hasRoleWord(v) && !titleProblem(v)) return v;
  }

  // 3. A standalone line that reads like a role. Prefer the earliest short one:
  //    posts usually lead with the role or put it right after the company.
  const candidates = lines
    .map(cleanLine)
    .filter((l) => l.length >= 4 && l.length <= 90 && hasRoleWord(l) && !titleProblem(l))
    // "Department: Marketing" / "Период стажировки не более 3-х месяцев" are
    // conditions of the role, not its name.
    .filter((l) => !NOT_TITLE_LINE.test(l) && !PROSE_OPENER.test(l) && !/https?:\/\/|www\.|@|(?:\+7|8)[\s(-]*\d{3}/i.test(l))
    // Drop lines that are clearly prose about the role rather than the role.
    .filter((l) => !/^(мы|наша|наш|это|для|в\s|на\s|с\s|по\s|при\s|из\s|от\s)/i.test(l))
    // Bullets and list items are body copy, never the headline role.
    .filter((l) => !/^[•·\-*–—+>]/.test(l))
    // Lines that start with a quantity are conditions, not roles
    // ("11 месяцев стажировки по трудовому договору").
    .filter((l) => !/^\d/.test(l))
    // Responsibility bullets often start with a verbal noun and contain a
    // department phrase ("Проверка и анализ данных по продажам и складам").
    .filter((l) => !/^(проверка|анализ|ведение|подготовка|составление|обработка|контроль|сопровождение|организация|формирование|участие|взаимодействие)\s/i.test(l))
    // English gerund/participle phrases ("Participating in various HR projects")
    // Any English gerund opener is a responsibility bullet, not a role
    // ("Gathering vacancy requirements and liaising with…").
    .filter((l) => !/^(?!marketing|engineering|accounting|consulting|trading|banking|recruiting|programming|advertising|publishing|training|testing)[a-z]+ing\s/i.test(l))
    // Email-subject / template instructions ("«Trainee Program – [Имя Фамилия]»")
    .filter((l) => !/[\[\]]|тема\s+письма|subject\s*:/i.test(l))
    .filter((l) => l.split(/\s+/).length <= 10);
  if (candidates.length) {
    candidates.sort((a, b) => a.length - b.length);
    // Shortest role-bearing line, but not absurdly short.
    const best = candidates.find((c) => c.length >= 8) || candidates[0];
    return trimTitle(best);
  }

  return null; // no role found → not usable as a listing
}

// Trim decoration that makes titles ugly without changing their meaning.
function trimTitle(s) {
  const out = cleanLine(s)
    .replace(/^\s*(?:ваканси[яи]|должность|позиция|position|role|job)\s*[:\-–—]\s*/i, '')
    .replace(/\s*job\s+pattern\s*:.*$/i, '')
    .replace(/\s*(уровень\s+)?(заработной\s+платы|зарплата|з\/п)\s*[:\-–—].*$/i, '')
    .replace(/\s*[—–-]\s*(?:заработн[а-яё]*|зарплат[а-яё]*|з\/п|оплат[а-яё]*)\s.*$/i, '')   // "Повар — заработная плата 300 000"
    .replace(/\s*\|\s*(?:набор|срочно|вакансия).*$/i, '')
    .replace(/[\s,.;:!\-–—]+$/, '')
    .slice(0, 120);
  // Capitalise a Cyrillic opener only: lowercase Latin tokens like "iOS" and
  // "frontend" are written that way on purpose.
  return /^[а-яё]/.test(out) ? out[0].toUpperCase() + out.slice(1) : out;
}

// ── Company ──────────────────────────────────────────────────────────────────
// Never returns 'Unknown': the caller supplies the channel label as a last
// resort, so a card always shows a human-meaningful source.
// strict:true (general channels, loosely-formatted profiles) keeps only the
// reliable signals — label, legal entity, "<Name> приглашает/ищет" — and skips
// the first-line guess that turned "СРОЧНО" / "Вакансия" into employers.
function detectCompany(text, fallback, { strict = false } = {}) {
  const lines = (text || '').split('\n').map((l) => l.trim()).filter(Boolean);

  // 1. Explicit label: "Компания: Danone, ТМ"
  for (const raw of lines) {
    const m = raw.match(COMPANY_LABEL_RE);
    if (m) {
      const v = cleanLine(m[1]);
      if (v.length > 1 && !/^(работает|предоставля|ищет|приглаша|занимается)/i.test(v)) return v.slice(0, 80);
    }
  }
  // 2. Legal entity anywhere: ТОО «Атлас Копко…», АО FlyArystan
  const legal = text.match(/((?:ТОО|АО|ИП|ЖШС|АҚ|LLP|LLC)\s+[«"']?[\wА-Яа-яЁё&.\- ]{2,50}[»"']?)/);
  if (legal) return cleanLine(legal[1]).slice(0, 80);
  // 3. "<Company> приглашает / ищет / объявляет"
  const verb = text.match(/(?:^|\n)\s*([A-ZА-ЯЁ][\wА-Яа-яЁё&.\-]*(?:\s+[A-ZА-ЯЁa-zа-яё][\wА-Яа-яЁё&.\-]*){0,3})\s+(?:приглашает|ищет|объявляет|запускает|набирает|is\s+looking|announces)/);
  if (verb) { const v = cleanLine(verb[1]); if (v.length > 2 && !hasRoleWord(v)) return v.slice(0, 80); }
  if (strict) return fallback || 'Компания';
  // 4. "стажировка в X" / "карьеру ... вместе с X"
  // "Начни карьеру в HR вместе с Air Astana" — the department is not the
  // employer, so skip department abbreviations and keep looking.
  const DEPT = /^(hr|it|pr|smm|seo|qa|r&d|hse|sales|finance|marketing|логистик|продаж|маркетинг)$/i;
  const prepRe = /(?:стажировк\w*|практик\w*|ваканси\w*|карьеру)\s+(?:в|вместе\s+с|с)\s+([A-ZА-ЯЁ][\wА-Яа-яЁё&.\-]+(?:\s+[A-ZА-ЯЁ][\wА-Яа-яЁё&.\-]+){0,3})/g;
  let pm;
  while ((pm = prepRe.exec(text)) !== null) {
    const v = cleanLine(pm[1]);
    if (v && !DEPT.test(v)) return v.slice(0, 80);
  }
  const together = text.match(/вместе\s+с\s+([A-ZА-ЯЁ][\wА-Яа-яЁё&.\-]+(?:\s+[A-ZА-ЯЁ][\wА-Яа-яЁё&.\-]+){0,2})/);
  if (together) { const v = cleanLine(together[1]); if (!DEPT.test(v)) return v.slice(0, 80); }
  // 5. First line, when it looks like a company name and not a role/sentence.
  const first = cleanLine(lines[0] || '');
  if (first && first.length >= 3 && first.length <= 60 && !hasRoleWord(first) &&
      first.split(/\s+/).length <= 5 && !/[.!?]$/.test(first) &&
      /^[A-ZА-ЯЁ«"']/.test(first) && !/^(hi|hello|привет|друзья|коллеги|внимание|срочно|горячая|ваканси|hot|urgent|новая|new|важно)/i.test(first)) {
    return first.slice(0, 80);
  }
  return fallback || 'Компания';
}

// ── Candidate lists (what Jev chooses between; also useful for debugging) ────
function titleCandidates(text, extTitle, picked) {
  const out = [];
  const add = (v) => {
    const t = trimTitle(sentenceCase(cleanLine(v || '')));
    if (!t || titleProblem(t) || NOT_TITLE_LINE.test(t) || PROSE_OPENER.test(t)) return;
    if (/https?:\/\/|www\.|@|(?:\+7|8)[\s(-]*\d{3}|^#/i.test(t)) return;
    if (!out.some((x) => x.toLowerCase() === t.toLowerCase())) out.push(t);
  };
  add(picked); add(extTitle);
  for (const l of (text || '').split('\n').map((x) => stripLead(x)).filter(Boolean).slice(0, 6)) {
    if (l.length <= 90 && hasRoleWord(l)) add(l);
  }
  return out.slice(0, 6);
}

function companyCandidates(text, extCompany, detected, fallback) {
  const out = [];
  const add = (v) => {
    const c = cleanLine(v || '').replace(/\s*\([^)]*$/, '').replace(/\s+(?:ищет|ищем|приглашает|объявляет|открывает|требуется|требуются|набирает)(?=\s|$).*$/i, '').trim();
    if (!c || c.split(/\s+/).length > 6 || c.length < 2 || c.length > 80 || c === fallback || /https?:|@/.test(c)) return;
    if (!out.some((x) => x.toLowerCase() === c.toLowerCase())) out.push(c);
  };
  add(extCompany); add(detected);
  for (const m of (text || '').matchAll(/((?:ТОО|АО|ИП|ЖШС|АҚ|LLP|LLC)\s+[«"'][^»"'\n]{2,50}[»"'])/g)) add(m[1]);
  for (const m of (text || '').matchAll(/(?:компания|company)\s*[:\-–—]?\s*([«"]?[A-ZА-ЯЁ][^\n,.;]{1,40})/gi)) add(m[1]);
  return out.slice(0, 6);
}

// ── THE SWAP POINT ───────────────────────────────────────────────────────────
// opts.companyFallback  – channel label, used only when the post names no employer
// opts.profile          – override the channel's layout profile (tests)
// opts.judge            – { title?, company? } already chosen by Jev (see jev.js);
//                         applied only when the rules found nothing better.
function parsePost(rawPost, opts = {}) {
  const { channel, msgId, postUrl, dateISO, text } = rawPost;
  const cfg = channelByUsername(channel);
  const profile = opts.profile !== undefined ? opts.profile : profileFor(cfg);
  const ext = (profile && profile(text)) || {};
  if (ext.reject) { parsePost.lastReject = ext.reject; return null; }
  if (ext.location && FOREIGN_RE.test(ext.location) && !CITY_KEYWORDS.some(([, kws]) => kws.some((k) => lc(ext.location).includes(k)))) {
    parsePost.lastReject = 'outside-kazakhstan'; return null;
  }
  if (!isVacancy(text, { titleFromProfile: !!ext.title })) { parsePost.lastReject = 'not-a-vacancy'; return null; }

  // Title: the channel's own layout first, then the generic detector.
  let title = null;
  if (ext.title) {
    const t = trimTitle(sentenceCase(ext.title));
    if (!titleProblem(t) && !NOT_TITLE_LINE.test(t)) title = t;
  }
  if (!title && ext.title && profile.strict) { parsePost.lastReject = 'bad-profile-title'; return null; }
  if (!title) title = detectTitle(text);
  if (!title) { parsePost.lastReject = 'no-role-in-post'; return null; }

  // Employer: profile first, then generic detection; the channel label is the
  // fallback only when the post names none.
  let company = null;
  if (ext.company) ext.company = ext.company.replace(/\s*\([^)]*$/, '').trim();
  if (ext.company && ext.company.length >= 2 && ext.company.length <= 80 && !/https?:|@|^\+?\d[\d\s()-]{6,}$/.test(ext.company)) company = ext.company;
  if (!company) company = detectCompany(text, opts.companyFallback, { strict: !!ext.strictCompany || (cfg && cfg.kind === 'general') });

  const detectedCompany = detectCompany(text, null, { strict: !!ext.strictCompany || (cfg && cfg.kind === 'general') });

  // One apply action per post (see telegram/apply.js for the data contract).
  const apply = resolveApply(rawPost, { ignoreHandles: opts.ignoreHandles });

  const salary = detectSalary(ext.pay && !/зарплат|оклад|salary/i.test(ext.pay) ? `Зарплата: ${ext.pay}\n${text}` : text);
  const general = cfg && cfg.kind === 'general';
  const jobType = detectType(text, { shiftAsPartTime: general });
  const typeTag = jobType === 'internship' ? 'стажировка'
    : jobType === 'part-time' ? 'part-time'
    : jobType === 'remote' ? 'remote' : null;
  const tags = ['telegram_career', `ch:${channel}`].concat(typeTag ? [typeTag] : []);

  parsePost.lastReject = null;
  return {
    source: 'telegram_career',
    source_id: `tg_${channel}_${msgId}`,
    source_url: postUrl,
    apply_url: apply.apply_url,
    source_type: apply.source_type,
    source_channel: channel,
    title,
    company,
    location: detectCity(ext.location || text),
    salary_min: salary.min,
    salary_max: salary.max,
    currency: 'KZT',
    skills: detectSkills(text),
    tags: tags,
    type: jobType,
    description: text.slice(0, 5000),
    raw_text: text,
    posted_at: dateISO || new Date().toISOString(),
    status: 'active',
    // In-memory only (makeJob drops them): kept for the Jev judge, dedupe and stats.
    _apply: apply,
    _candidates: {
      titles: titleCandidates(text, ext.title, title),
      companies: companyCandidates(text, ext.company, detectedCompany, opts.companyFallback),
    },
    _companyFromPost: company !== opts.companyFallback,
  };
}

module.exports = {
  parsePost, isVacancy, detectCity, detectType, detectSkills,
  detectSalary, detectTitle, detectCompany, trimTitle, titleCandidates, companyCandidates,
  CITY_KEYWORDS, TYPE_RULES, SKILLS,
};
