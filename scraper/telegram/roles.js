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

function hasRoleWord(text) {
  const t = (text || '').toLowerCase();
  return ROLE_WORDS.some((w) => t.includes(w));
}

module.exports = {
  ROLE_WORDS, hasRoleWord,
  TITLE_LABEL_RE, TITLE_VERB_RE, COMPANY_LABEL_RE, APPLY_LABEL_RE, SALARY_LABEL_RE,
};
