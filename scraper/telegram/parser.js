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
const lc = (s) => (s || '').toLowerCase();

// Is this post actually a job/internship vacancy (vs. an event, news, media post)?
function isVacancy(text) {
  if (!text || text.replace(/\s/g, '').length < 40) return false;          // empty / media-only
  if (/please open telegram|view in telegram/i.test(text)) return false;    // media placeholder
  const t = lc(text);
  const jobSignals = ['вакансия', 'должность', 'позиция', 'требуется', 'ищем', 'в поиске',
    'стажировк', 'стажёр', 'стажер', 'тағылымдама', 'intern', 'vacancy', 'hiring', 'job',
    'обязанности', 'требовани', 'резюме', 'отклик', 'трудоустройств', 'оклад', 'жалақы'];
  const eventSignals = ['лекция', 'вебинар', 'мастер-класс', 'митап', 'meetup', 'встреча состоится',
    'приглашаем на встречу', 'день открытых дверей'];
  // Reject posts whose headline is clearly an EVENT, not a vacancy.
  const firstLine = lc((text.split('\n').map((l) => l.trim()).find((l) => l.length > 4) || ''));
  if (/^(гостев\w* лекци|лекци|вебинар|мастер-?класс|митап|meetup|день открытых дверей|встреча с|приглашаем на (встреч|лекци|вебинар)|workshop|ярмарка)/.test(firstLine)) return false;

  const hasJob = jobSignals.some((k) => t.includes(k));
  const looksEvent = eventSignals.some((k) => t.includes(k));
  // An event post only counts if it ALSO clearly offers a vacancy/application.
  if (looksEvent && !/вакансия|ссылка на вакансию|резюме|отклик|apply/.test(t)) return false;
  return hasJob;
}

// Pick the external application link. Anything that isn't a Telegram/CDN URL wins;
// otherwise we fall back to the post URL and flag it telegram_direct.
function pickApplyUrl(links, postUrl) {
  const isInternal = (u) => /(^|\.)t\.me\//.test(u) || /telegram\.org|telesco\.pe|tg:\/\//.test(u);
  // Unwrap common email-security redirect wrappers (e.g. protect.checkpoint.com)
  // by preferring them as-is — they still resolve to the real apply page.
  const external = (links || []).find((u) => /^https?:\/\//.test(u) && !isInternal(u));
  if (external) return { apply_url: external, source_type: 'external_link' };
  // Also accept a bare email as an application target.
  return { apply_url: postUrl, source_type: 'telegram_direct' };
}

function detectCity(text) {
  const t = lc(text);
  for (const [city, kws] of CITY_KEYWORDS) if (kws.some((k) => t.includes(k))) return city;
  return 'Kazakhstan';
}

function detectType(text) {
  const t = lc(text);
  for (const [type, kws] of TYPE_RULES) if (kws.some((k) => t.includes(k))) return type;
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

function cleanLine(s) {
  return (s || '')
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}️‍]/gu, '') // emoji
    .replace(/[*_`#>]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Title: prefer an explicit label, else the first substantive line.
function detectTitle(text) {
  const labelRe = /(?:вакансия|должность|позиция|роль|position|job title|ваканси[яи]\s*:)\s*[:\-—]?\s*(.+)/i;
  for (const raw of text.split('\n')) {
    const m = raw.match(labelRe);
    if (m && cleanLine(m[1]).length > 2) return cleanLine(m[1]).slice(0, 120);
  }
  const lines = text.split('\n').map(cleanLine).filter((l) => l.length > 4 && l.length < 120);
  return lines.length ? lines[0].slice(0, 120) : 'Вакансия';
}

// Company: explicit label (must have a ':'/'—' separator so we don't match
// prose like "Компания работает в…"), or a legal-entity prefix, or a «quoted» name.
function detectCompany(text) {
  const labelRe = /(?:компания|работодатель|company|employer)\s*[:\-—]\s*([^\n.]{2,80})/i;
  for (const raw of text.split('\n')) {
    const m = raw.match(labelRe);
    if (m) {
      const v = cleanLine(m[1]);
      // Guard against label-as-prose ("компания работает/предоставляет/ищет…")
      if (v.length > 1 && !/^(работает|предоставля|ищет|приглаша|занимается)/i.test(v)) return v.slice(0, 80);
    }
  }
  const legal = text.match(/((?:ТОО|АО|ИП|ОО|АҚ|ЖШС)\s+[«"]?[\wА-Яа-яЁё.\-]{2,50}[»"]?)/);
  if (legal) return cleanLine(legal[1]).slice(0, 80);
  // "Стажировка в X", "практика в X", "вакансия в X"
  const prep = text.match(/(?:стажировк\w*|практик\w*|ваканси\w*|работа)\s+в\s+([A-ZА-ЯЁ][\wА-Яа-яЁё&.\-]+(?:\s+[A-ZА-ЯЁ][\wА-Яа-яЁё&.\-]+){0,3})/);
  if (prep) return cleanLine(prep[1]).slice(0, 80);
  // "X приглашает / ищет / запускает / открывает …"
  const verb = text.match(/(?:^|\n)\s*(?:компания\s+)?([A-ZА-ЯЁ][\wА-Яа-яЁё&.\-]+(?:\s+[A-ZА-ЯЁ][\wА-Яа-яЁё&.\-]+){0,3})\s+(?:приглашает|ищет|запускает|открывает|в поиске|набирает)/);
  if (verb) return cleanLine(verb[1]).slice(0, 80);
  const quoted = text.match(/[«"“]([^»"”\n]{2,60})[»"”]/);
  if (quoted) return cleanLine(quoted[1]).slice(0, 80);
  return 'Unknown';
}

// ── THE SWAP POINT ───────────────────────────────────────────────────────────
function parsePost(rawPost) {
  const { channel, msgId, postUrl, dateISO, text, links } = rawPost;
  if (!isVacancy(text)) return null;

  const { apply_url, source_type } = pickApplyUrl(links, postUrl);
  const salary = detectSalary(text);
  const jobType = detectType(text);
  // Fold the detected type into tags so the frontend's tag-based type detection
  // (mapSupabaseJob) picks it up — the jobs table has no dedicated `type` column.
  const typeTag = jobType === 'internship' ? 'стажировка'
    : jobType === 'part-time' ? 'part-time'
    : jobType === 'remote' ? 'remote' : null;
  const tags = ['telegram_career', `ch:${channel}`].concat(typeTag ? [typeTag] : []);

  return {
    source: 'telegram_career',
    source_id: `tg_${channel}_${msgId}`,
    source_url: postUrl,
    apply_url,
    source_type,
    source_channel: channel,
    title: detectTitle(text),
    company: detectCompany(text),
    location: detectCity(text),
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
  };
}

module.exports = {
  parsePost, isVacancy, pickApplyUrl, detectCity, detectType, detectSkills,
  detectSalary, detectTitle, detectCompany,
  CITY_KEYWORDS, TYPE_RULES, SKILLS,
};
