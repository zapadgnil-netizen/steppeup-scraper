/**
 * telegram/roles.js — the vocabulary that decides "is this line a job title?".
 *
 * Extracted into its own module because BOTH the title detector and the
 * is-this-a-vacancy gate need it, and because it is the single thing most
 * likely to need tuning as channels change what they post.
 */

// Role nouns, RU + KZ + EN. Matched as substrings (JS \b doesn't work next to
// Cyrillic), so keep stems short enough to catch declensions: 'менеджер' also
// matches 'менеджера', 'менеджеру'.
const ROLE_WORDS = [
  // generic
  'стажер', 'стажёр', 'стажировк', 'практикант', 'intern', 'trainee', 'тағылымдама',
  'ассистент', 'помощник', 'assistant', 'junior', 'джуниор',
  // functions
  'менеджер', 'manager', 'специалист', 'specialist', 'аналитик', 'analyst',
  'разработчик', 'developer', 'программист', 'engineer', 'инженер',
  'дизайнер', 'designer', 'маркетолог', 'marketer', 'marketing',
  'рекрутер', 'recruiter', 'консультант', 'consultant', 'координатор', 'coordinator',
  'бухгалтер', 'accountant', 'экономист', 'юрист', 'lawyer', 'переводчик', 'translator',
  'оператор', 'operator', 'администратор', 'administrator', 'секретар',
  'копирайтер', 'copywriter', 'редактор', 'editor', 'контент-менеджер',
  'тестировщик', 'тестер', 'преподавател', 'учител', 'репетитор', 'тренер',
  'продавец', 'кассир', 'курьер', 'официант', 'бариста', 'промоутер', 'мерчендайзер',
  'агент', 'представител', 'супервайзер', 'кладовщик', 'логист', 'диспетчер',
  'мобилограф', 'видеограф', 'фотограф', 'графическ', 'креатор', 'повар', 'грузчик', 'уборщик', 'охранник', 'водитель',
  'сборщик', 'комплектовщик', 'пекарь', 'мойщик', 'бармен', 'хостес', 'раздатчик', 'консультант',
  'лаборант', 'техник', 'механик', 'электрик', 'сантехник', 'сварщик',
  // tech / english shorthands
  'frontend', 'front-end', 'backend', 'back-end', 'fullstack', 'full-stack',
  'qa ', 'qa-', 'devops', 'data scientist', 'data analyst', 'smm', 'seo',
  'ux', 'ui/', 'ui ', 'python', 'java', 'react',
  // roles by department phrasing
  'по продажам', 'по маркетингу', 'по персоналу', 'по работе с', 'по подбору',
  'sales', 'hr ', 'hr-', 'finance', 'scriptwriter', 'writer', 'associate',
];

// Lines that look like a label introducing the role.
const TITLE_LABEL_RE =
  /^\s*(?:должность|вакансия|позиция|роль|position|job title|role|job)\s*[:\-–—]\s*(.+)$/i;

// "Ищем/требуется/в поиске <role>" — the role follows the verb.
const TITLE_VERB_RE =
  /(?:^|\n)\s*(?:мы\s+)?(?:ищем|ищет|требуется|требуются|нужен|нужна|нужны|в\s+поиске|открыта\s+вакансия|открыт\s+набор|приглашаем\s+на\s+(?:позицию|должность)|is\s+looking\s+for|we\s+are\s+hiring)\s*[:\-–—]?\s*([^\n]{3,90})/i;

const COMPANY_LABEL_RE =
  /^\s*(?:компания|работодател[ья]|company|employer|организация)\s*[:\-–—]\s*(.+)$/i;

const APPLY_LABEL_RE =
  /^\s*(?:ссылка\s+на\s+вакансию|ссылка|откликнуться|apply|подать\s+заявку|link)\s*[:\-–—]?\s*(\S+)/i;

const SALARY_LABEL_RE =
  /^\s*(?:уровень\s+заработной\s+платы|заработная\s+плата|зарплата|оклад|salary|з\/п|жалақы)\s*[:\-–—]\s*(.+)$/i;

// Lines that carry a LABEL with a value ("Department: Marketing", "Период
// стажировки не более 3-х месяцев", "График: 5/2") describe conditions of the
// role, never its name. Real titles that reached the board came from here.
const NOT_TITLE_LINE =
  /^\s*(?:department|dept|отдел|департамент|период|срок|длительность|продолжительность|график|формат|занятость|локация|location|город|адрес|зарплат|заработн|оплата|условия|требования|обязанности|опыт|образование|язык|контакт|дедлайн|deadline|сайт|ссылка|e-?mail|тел|телефон|возраст|пол|вид\s+деятельности|тип\s+занятости|компания|company|employer|подать|заявк|apply|регистрац|ссылка|номер)[\p{L}\s]{0,24}(?:[:：]|\s+не\s+(?:более|менее)|\s+от\s+\d)/iu;

// Sentence openers: a line that starts like this is prose, not a role name.
const PROSE_OPENER = /^(?:также|будем|просим|рады|хотите|хочешь|дружишь|сделай|начни|начните|присоединяй|приглашаем|start\s+your|join\s+us|are\s+you|looking\s+for|мы\s|наша|наш\s|реальн|креативн|перспектив|возможност|в\s+команду|түйінде|ұсын|отправ|направ)/i;

/** "КОНСУЛЬТАНТА ПО ПРОДАЖАМ" → "Консультант по продажам" (all-caps Cyrillic only). */
function sentenceCase(s) {
  const v = String(s || '');
  return /[а-яё]/i.test(v) && !/[a-z]/.test(v) && v === v.toUpperCase() && v.replace(/[^а-яё]/gi, '').length >= 6
    ? v[0] + v.slice(1).toLowerCase() : v;
}

/** Strip emoji / bullets / numbering from the start of a line. */
function stripLead(line) {
  return String(line || '').replace(/^[^\p{L}\p{N}«"'(\[]+/u, '').replace(/^\d+[.)]\s+/, '').trim();
}

/** Remove emoji, markdown noise and extra whitespace from a captured value. */
function cleanLine(s) {
  return (s || '')
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}️‍]/gu, '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')   // zero-width spaces pasted into titles
    .replace(/ĸ/g, 'к')                      // "Ваĸансия": Latin kra standing in for Cyrillic к
    .replace(/[*_`#>]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * "ищем графического дизайнера" → "графический дизайнер": the verb patterns
 * ("ищет X", "вакансия X") leave the role in the genitive. Only the leading
 * (adjective +) noun is converted; anything unrecognised is returned as is.
 */
function toNominative(phrase) {
  const words = String(phrase || '').trim().split(/\s+/);
  const conv = (w, isNoun) => {
    const l = w.toLowerCase();
    if (!isNoun) return l.endsWith('ского') ? w.slice(0, -3) + 'ий' : l.endsWith('ого') ? w.slice(0, -3) + 'ый' : l.endsWith('его') ? w.slice(0, -3) + 'ий' : w;
    return /[бвгджзклмнпрстфхцчшщ]а$/i.test(w) ? w.slice(0, -1) : w;
  };
  const isRoleNoun = (w) => /[бвгджзклмнпрстфхцчшщ]а$/i.test(w) && ROLE_WORDS.some((r) => w.toLowerCase().startsWith(r));
  if (words[0] && isRoleNoun(words[0])) words[0] = conv(words[0], true);
  else if (words[1] && /(?:ого|его)$/i.test(words[0]) && isRoleNoun(words[1])) { words[0] = conv(words[0], false); words[1] = conv(words[1], true); }
  const out = words.join(' ');
  return out.replace(/^[а-яё]/, (c) => c.toUpperCase());
}

function hasRoleWord(text) {
  const t = (text || '').toLowerCase();
  return ROLE_WORDS.some((w) => t.includes(w));
}

module.exports = {
  ROLE_WORDS, hasRoleWord, NOT_TITLE_LINE, PROSE_OPENER, sentenceCase, stripLead, cleanLine, toNominative,
  TITLE_LABEL_RE, TITLE_VERB_RE, COMPANY_LABEL_RE, APPLY_LABEL_RE, SALARY_LABEL_RE,
};
