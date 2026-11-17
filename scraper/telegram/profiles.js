/**
 * telegram/profiles.js — per-channel layouts.
 *
 * Every channel formats its posts its own way (@jobkz_1: emoji-labelled lines,
 * @kimepcareercenter: upper-case POSITION / COMPANY blocks, the Almaty channels:
 * a bare headline and a phone). One catch-all parser got employer and title
 * wrong on exactly those channels (every @jobkz_1 row had company "JobKZ"), so
 * a channel names a PROFILE in channels.js and the profile's small extractor is
 * consulted BEFORE the generic detectTitle / detectCompany.
 *
 *   extract(text) → { title?, company?, location?, pay?, reject? }
 *
 * Any field it cannot read is left out (the generic parser fills the gap).
 * `reject` drops the post with that reason (e.g. a @jobkz_1 post with no vacancy
 * line is channel promotion). The channel label stays the company fallback ONLY
 * when neither the profile nor the generic parser finds an employer.
 */

const { hasRoleWord, stripLead, cleanLine, NOT_TITLE_LINE, PROSE_OPENER, toNominative } = require('./roles');

const rawLines = (text) => String(text || '').split('\n').map((l) => l.trim()).filter(Boolean);
const TITLE_PREFIX = /^(?:ваканси[яи]|vacancy|должность|position|позиция|вакансия\s+на\s+должность)\s*[:|\-–—]?\s*/i;
const COMPANY_PREFIX = /^(?:компания|company|работодатель|employer|организация)\s*[:\-–—]?\s*/i;

// Strip quotes that WRAP the value ("The System", «Name»); keep balanced inner ones (ТОО «Name»).
const unquote = (s) => {
  const v = cleanLine(s);
  const m = v.match(/^[«"“'`](.*)[»"”'`]$/);
  return m && !/[«»"“”]/.test(m[1]) ? m[1].trim() : v;
};

/** "Label: value" (label already stripped of emoji) → value, or null. */
function labelled(lines, labelRe) {
  for (const raw of lines) {
    const m = stripLead(raw).match(new RegExp(`^(?:${labelRe.source})\\s*[:：\\-–—|]\\s*(.+)$`, labelRe.flags.replace('g', '')));
    if (m) return m[m.length - 1];
  }
  return null;
}

// A 🏢 line is sometimes a sentence ("Компания «Name» объявляет набор:",
// "В ГРУППУ КОМПАНИЙ ASSU (г. Алматы) ТРЕБУЮТСЯ СОТРУДНИКИ!"): pull the name out.
function companyFromLine(v) {
  let s = unquote(v.replace(COMPANY_PREFIX, ''));
  // "Компания по оптовой торговле ГСМ": the prefix is part of a description, keep it
  if (/^[а-яё]/.test(s) && COMPANY_PREFIX.test(v) && !/[:：]/.test(v.slice(0, 12))) s = cleanLine(v);
  const legal = s.match(/((?:ТОО|АО|ИП|ЖШС|АҚ|LLP|LLC|ГКП[^«"]{0,20})\s*[«"][^»"]{2,60}[»"])/);
  if (legal) return cleanLine(legal[1]);
  const quoted = s.match(/[«"]([^»"]{2,60})[»"]/);
  if (quoted && /объявляет|ищет|приглашает|требу|набор/i.test(s)) return cleanLine(quoted[1]);
  const group = s.match(/групп[а-яё]*\s+компаний\s+(.+?)\s*(?:\(|требу|$)/i);
  if (group) return cleanLine(group[1]);
  return s.replace(/\s*(?:объявляет\s+набор|ищет|приглашает)\W*$/i, '').replace(/\s*\([^)]*\)\s*$/, '').trim();
}

// "Head of Middle Office | Алматы" → "Head of Middle Office"
function stripCityTail(title) {
  const m = title.match(/^(.+?)\s*\|\s*([^|]+)$/);
  return m && /алматы|астана|шымкент|караганд|актобе|атырау|павлодар|almaty|astana|shymkent|remote|удал/i.test(m[2]) ? m[1].trim() : title;
}

// ── jobkz: 🧰 title · 🏢 company · 📍 city · 💰 pay ─────────────────────────
function jobkz(text) {
  const lines = rawLines(text);
  const pick = (emoji) => {
    const l = lines.find((x) => x.startsWith(emoji));
    return l ? cleanLine(l.slice(emoji.length)) : null;
  };
  const t = pick('🧰');
  if (t === null) return { reject: 'no-vacancy-line' }; // promo / ad / folder post
  const out = {};
  const title = stripCityTail(unquote(t.replace(TITLE_PREFIX, '').replace(/^[|\-–—]\s*/, '')));
  if (title) out.title = title;
  const c = pick('🏢');
  if (c) { const company = companyFromLine(c); if (company) out.company = company; }
  const loc = pick('📍') || pick('🏙');
  if (loc) out.location = cleanLine(loc.replace(/^(?:локация|город|location|city|адрес)\s*[:\-–—]?\s*/i, ''));
  const pay = pick('💰');
  if (pay) out.pay = cleanLine(pay.replace(/^(?:зарплата|salary|оплата|з\/п)\s*[:\-–—]?\s*/i, ''));
  return out;
}

// ── kimep: POSITION / COMPANY / LOCATION (value on the same or the next line)
function kimep(text) {
  const lines = rawLines(text);
  const LABEL = /^(POSITION|COMPANY|LOCATION|JOB STATUS|REQUIREMENTS|DUTIES|DEADLINE|SALARY|CONDITIONS|BENEFITS)\b\s*[:\-–—]?\s*(.*)$/;
  const grab = (name) => {
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(LABEL);
      if (!m || m[1] !== name) continue;
      if (m[2]) return unquote(m[2]);
      const next = lines[i + 1];
      if (next && !LABEL.test(next)) return unquote(next);
    }
    return null;
  };
  const out = {};
  const title = grab('POSITION'), company = grab('COMPANY'), loc = grab('LOCATION'), pay = grab('SALARY');
  if (title) out.title = title;
  if (company) out.company = company;
  if (loc) out.location = loc;
  if (pay) out.pay = pay;
  return out;
}

// ── iitu: "💼 Вакансия: X" / bare emoji headline; "Компания: Y" ──────────────
function iitu(text) {
  const lines = rawLines(text);
  const out = {};
  const t = labelled(lines, /(?:вакансия|должность|position|vacancy)/i);
  if (t) out.title = unquote(t);
  else {
    const first = cleanLine(stripLead(lines[0] || ''));
    const ishet = first.match(/^(.{2,40}?)\s+ищет\s+(.{4,80})$/i);
    if (ishet && hasRoleWord(ishet[2])) { out.title = toNominative(ishet[2]); out.company = unquote(ishet[1]); }
    else if (first && first.length <= 90 && hasRoleWord(first) && !NOT_TITLE_LINE.test(first)) out.title = first;
  }
  const c = labelled(lines, /(?:компания|company|работодатель)/i);
  if (c) out.company = unquote(c);
  return out;
}

// ── careerhub: "1. ТОО Пример вакансия: Роль" or a headline + "Компания:" ───
function careerhub(text) {
  const lines = rawLines(text);
  const m = stripLead(lines[0] || '').match(/^(.+?)\s+ваканси[яи]\s*:\s*(.+)$/i);
  if (m) return { company: unquote(m[1]), title: unquote(m[2]) };
  const out = {};
  const t = labelled(lines, /(?:вакансия|должность|position)/i);
  if (t) out.title = unquote(t);
  else {
    const first = cleanLine(stripLead(lines[0] || ''));
    if (first && first.length <= 100 && hasRoleWord(first) && !NOT_TITLE_LINE.test(first)) out.title = first;
  }
  const c = labelled(lines, /(?:компания|company|работодатель)/i);
  if (c) out.company = unquote(c);
  const loc = labelled(lines, /(?:локация|location|город)/i);
  if (loc) out.location = cleanLine(loc);
  return out;
}

// ── careercentervacancies: "<Company> приглашает студентов на стажировку …" ─
const PRACTICE_NOUN = [
  [/производственн[а-яё]+\s+практик[а-яё]*/i, 'Производственная практика'],
  [/стажировк[а-яё]*/i, 'Стажировка'],
  [/практик[а-яё]*/i, 'Практика'],
];
function careercentervacancies(text) {
  const first = stripLead(rawLines(text)[0] || '');
  const out = {};
  const inCompany = first.match(/^в\s+компании\s+(.+?)\s+открыта\s+вакансия\s+(.+?)[.!]?$/i);
  if (inCompany) return { company: unquote(inCompany[1]), title: toNominative(cleanLine(inCompany[2])) };
  const co = first.match(/^(?:компания|отель|банк|ресторан|холдинг|корпорация)?\s*(.+?)\s+(?:приглашает|объявляет|открывает|предлагает)(?=\s|$)/i);
  if (co && co[1].length <= 60 && !/^центр\s+карьеры/i.test(co[1])) out.company = unquote(co[1]);
  const on = first.match(/на\s+((?:производственн[а-яё]+\s+)?(?:стажировк[а-яё]+|практик[а-яё]+))\s*(?:(в|по)\s+(.+?))?\s*[!.]?$/i);
  if (on) {
    const noun = PRACTICE_NOUN.find(([re]) => re.test(on[1]));
    const tail = on[2] && on[3] ? ` ${on[2].toLowerCase()} ${on[3].replace(/\s*\([^)]*\)\s*$/, '').trim()}` : '';
    if (noun) out.title = cleanLine(noun[1] + tail);
  }
  return out;
}

// ── studentworkz: "📌 Вакансия" heading, then the role; "В <employer>" ─────
const VERB_LEAD = /^(?:нужен|нужна|нужны|ищем|ищу|требуется|требуются|в\s+поиске)\s+/i;
function studentworkz(text) {
  const lines = rawLines(text).map((l) => cleanLine(stripLead(l)));
  const head = lines.findIndex((l) => /^(?:горячая\s+)?ваканси[яи]\s*[:—\-–]?\s*$/i.test(l));
  const out = { strictCompany: true };
  const body = head === -1 ? lines : lines.slice(head + 1);
  for (const l of body.slice(0, 5)) {
    const co = l.match(/^[Вв]\s+([^,.!?]{2,40})$/);
    if (co && !out.company && /^[A-ZА-ЯЁ«"]/.test(co[1]) && l.split(/\s+/).length <= 4 && !/^в\s+(?:магазин|кафе|компанию|нашу|мою|команду)/i.test(l)) { out.company = unquote(co[1]); continue; }
    if (out.title || /^https?:/i.test(l) || NOT_TITLE_LINE.test(l) || /^в\s/i.test(l)) continue;
    let cand = l.replace(/^ваканси[яи]\s*[:—\-–]\s*/i, '').replace(VERB_LEAD, '');
    cand = toNominative(cand.split(/[,.!‼]/)[0].replace(/\s+в\s+(?:штат|команду)$/i, '').trim());
    if (cand.length >= 4 && cand.length <= 90 && hasRoleWord(cand)) {
      out.title = /^[А-ЯЁ\s\-–/]+$/.test(cand) ? cand[0] + cand.slice(1).toLowerCase() : cand[0].toUpperCase() + cand.slice(1);
    }
  }
  return out;
}

// ── almaty: headline role, "Требуется:" block, "В <place>" employer ─────────
const REQUIRED_LINE = /^(?:требуется|требуются|ищем|нужен|нужна|нужны|в\s+поиске)\s*[:\-–—]?\s*$/i;
function almaty(text) {
  const lines = rawLines(text).map((l) => cleanLine(stripLead(l))).filter(Boolean);
  const out = { strictCompany: true };
  const head = lines.slice(0, 8);
  for (let i = 0; i < head.length; i++) {
    const l = head[i];
    if (!out.company) {
      // "В Loft Park", "В ТЦ «Спутник»", "В компанию QazPost": one optional lowercase
      // noun, then a capitalised or quoted name.
      const co = l.match(/^[Вв]\s+(?:[а-яё]+\s+)?(«[^»]{2,40}»|"[^"]{2,40}"|[^\s«"][^\n]{1,40})$/);
      if (co) {
        const name = co[1];
        const lead = l.match(/^[Вв]\s+([а-яё]+)\s+/);
        const cand = (/^[«"]/.test(name) || /^[A-ZА-ЯЁ]/.test(name)) ? unquote(name) : null;
        if (cand && cand.split(/\s+/).length <= 4 && !hasRoleWord(cand) && !/^(?:нашу|нашей|мою|команд|штат|связи)/i.test(lead ? lead[1] : '')) out.company = cand;
      }
    }
    if (out.title) continue;
    if (REQUIRED_LINE.test(l)) {
      const nxt = (head[i + 1] || '').replace(/[,.;]+\s*$/, '').trim();
      if (nxt && nxt.length <= 70) out.title = nxt[0].toUpperCase() + nxt.slice(1);
      continue;
    }
    const verb = l.match(/(?:^|\s)(?:требуется|требуются|ищет|ищем|нужен|нужна|нужны)\s*[:\-–—]?\s+(.{3,70})$/i);
    if (verb && hasRoleWord(verb[1])) { out.title = toNominative(verb[1].replace(/[.!,]+$/, '').trim()); continue; }
    const v2 = l.replace(/^ваканси[яи]\s*[:\-–—]\s*/i, '');
    if (i < 2 && v2.length >= 4 && v2.length <= 80 && hasRoleWord(v2) && !NOT_TITLE_LINE.test(v2) && !PROSE_OPENER.test(v2) && !/^(?:в|на|для|с)\s/i.test(v2) && !/\d{3}\s?\d{3}/.test(v2)) out.title = v2;
  }
  return out;
}

// ── it_internships_kz: hashtag lines, headline, "<Company> - IT-компания…" ──
function itinternships(text) {
  const lines = rawLines(text).filter((l) => !/^(?:#\S+\s*)+$/.test(l)).map((l) => cleanLine(stripLead(l)));
  const out = {};
  const first = lines[0] || '';
  const poisk = first.match(/(?:в\s+(?:активном\s+)?поиске|ищет|ищем)\s+(.{4,60}?)(?:\s+на\s+проект|\s+в\s+команду|\s+для\s+|$)/i);
  if (first && first.length <= 90 && hasRoleWord(first) && !NOT_TITLE_LINE.test(first) && !PROSE_OPENER.test(first) && !/^(?:компания|привет)/i.test(first)) out.title = first;
  else if (poisk && hasRoleWord(poisk[1])) out.title = poisk[1].trim();
  for (const l of lines.slice(0, 5)) {
    const m = l.match(/^([A-ZА-ЯЁ][\wА-Яа-яЁё&.'’\- ]{1,40}?)\s+[-–—]\s+(?:IT-компания|компания|стартап|it\s+company|startup)/i);
    if (m) { out.company = unquote(m[1]); break; }
    const legal = l.match(/^компания\s+((?:АО|ТОО|ИП|LLP)\s*[«"][^»"]{2,50}[»"]|[A-ZА-ЯЁ][\w&.\-]+(?:\s+[A-ZА-ЯЁ][\w&.\-]+){0,2})/i);
    if (legal) { out.company = unquote(legal[1]); break; }
  }
  return out;
}

// A profile that read a role title from the channel's own layout has found
// hiring evidence, so the parser skips its "needs hiring-structure words" test.
jobkz.strict = true; kimep.strict = true; // an explicit title label that fails sanity must not fall back to a guessed line
const PROFILES = { jobkz, kimep, iitu, careerhub, careercentervacancies, studentworkz, almaty, itinternships };

/** Extractor for a channel config's `profile` key; null when it has none. */
function profileFor(channelCfg) {
  const key = channelCfg && channelCfg.profile;
  return key && PROFILES[key] ? PROFILES[key] : null;
}

module.exports = { PROFILES, profileFor, labelled };
