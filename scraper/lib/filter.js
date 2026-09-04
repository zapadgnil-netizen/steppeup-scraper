/**
 * lib/filter.js — THE student-suitability filter. Single source of truth for the
 * scraper side. The website has a mirror in index.html (isStudentSuitable);
 * keep the two in sync when rules change.
 *
 * studentRejectReason(title, description, tags) → string | null
 * isStudentFriendly(title, description, tags, { structuredEntry }) → boolean
 *
 * Design: a hard REJECT gate (experience required, senior title, excludes
 * students, discriminatory, digest, not-a-job) followed by a POSITIVE signal
 * requirement. Sources with structured data (hh.kz workExperience ===
 * 'noExperience') pass `structuredEntry: true` and skip the keyword requirement.
 */

const POSITIVE = [
  // RU
  'стажер', 'стажёр', 'стажировк', 'junior', 'джуниор', 'начинающ', 'без опыта',
  'студент', 'практика', 'практикант', 'intern', 'trainee', 'entry level', 'entry-level',
  'помощник', 'ассистент', 'частичная занятость', 'подработка', 'гибкий график',
  'молодой специалист', 'выпускник', 'обучение с нуля', 'обучаем', 'опыт не требуется',
  // KZ
  'тағылымдама', 'студентт', 'тәжірибесіз', 'жас маман',
  // EN
  'internship', 'graduate', 'student', 'no experience', 'fresh graduate', 'beginner', 'part-time',
];

// Things that are posted in career channels but are NOT jobs.
// NB: JS \b does not work next to Cyrillic, so word boundaries are emulated
// with lookarounds via w().
const W = '[a-zа-яёәіңғүұқөһ]';
const w = (alts) => new RegExp(`(?<!${W})(?:${alts})(?!${W})`, 'i');
const NOT_A_JOB = [
  w('грант|гранты|грантов|стипенди\\w*|scholarship'),
  w('хакатон\\w*|hackathon|олимпиад\\w*|конкурс\\w*|competition|contest'),
  w('вебинар\\w*|webinar|лекци\\w*|мастер-?класс\\w*|митап\\w*|meetup|workshop|воркшоп\\w*|семинар\\w*|конференци\\w*|форум\\w*'),
  // NB: bare 'курс' is NOT enough — "студент старших курсов" and "студент 3
  // курса" appear in genuine student vacancies. Require course context.
  /(?:онлайн-|online\s+)курс|курс(?:ы|ов)\s+(?:по|программирован|английск|дизайн|аналитик)|записаться\s+на\s+курс|bootcamp|буткемп/i,
  /обучени[ея]\s+(?:в|на|по)\s|школ[аы]\s+(?:программирован|дизайн|аналитик)/i,
  /набор\s+в\s+(?:клуб|организаци|команду\s+aiesec|волонт)|recruitment\s+(?:fall|spring|summer)|волонт[её]р/i,
  /ярмарка\s+вакансий|career\s+fair|день\s+открытых\s+дверей|open\s+day/i,
  w('розыгрыш\\w*|giveaway|скидк\\w*'),
  /(резюме\s+(?:за|под)\s+\d|поможем\s+с\s+резюме|консультаци[яи]\s+по\s+карьер|карьерн\w+\s+консульт)/i,
];

function studentRejectReason(title, description, tags = []) {
  const titleText = (title || '').toLowerCase();
  const t = `${titleText} ${(description || '').toLowerCase()} ${(tags || []).join(' ').toLowerCase()}`;

  // 0. Not a job at all (grant / event / course / ad) — judged mostly by title
  //    A title that names an actual role/internship wins over event words
  //    ("Стажировка в X (форум выпускников)" is still an internship).
  const strongJob = /стажировк|стажер|стажёр|intern|trainee|ваканси|junior|джуниор|тағылымдама/.test(titleText);
  if (!strongJob) {
    for (const re of NOT_A_JOB) if (re.test(titleText)) return 'not-a-job';
  }
  if (/поиск\s+работы\s+без|как\s+найти\s+работу|карьерный\s+гид/i.test(titleText)) return 'not-a-job';

  // 1. Explicitly excludes students
  if (/студент\w*[^.]{0,25}(не\s*беспоко|не\s*обраща|не\s*подход|не\s*рассматр)|без\s*студент|не\s*для\s*студент/.test(t))
    return 'excludes-students';

  // 1b. Roles that legally require a completed degree or licence: hh.kz marks
  //     plenty of these "no experience required", but a student cannot take a
  //     doctor's or lawyer's post. (Assistant/intern variants still pass.)
  if (/врач|доктор\s|фельдшер|провизор|нотариус|адвокат|аудитор|машинист\s+(?:тепловоза|электровоза)|пилот|капитан\s+судна/.test(titleText)
      && !/помощник|ассистент|стажер|стажёр|практикант|intern/.test(titleText))
    return 'requires-licence';

  // 2. Senior / management role by title (\b doesn't work before Cyrillic → substrings)
  if (/\b(senior|middle|lead|head|principal|chief|cto|cfo|ceo|expert)\b|сень[оё]р|синьор|мидл|тимлид|руководител|начальник|директор|главн(ый|ого|ая)|заведующ|управляющ|ведущий\s+специалист|эксперт|старший/.test(titleText))
    return 'senior-title';

  // 3. Requires prior experience (unless it also welcomes no-experience)
  const requiresExp = /опыт\s*работы\s*(от|не\s*менее|обязателен|:)|с\s*опытом|опыт\s*от\s*\d|обязателен\s*опыт|требуется\s*опыт|опыт\s*не\s*менее|стаж\s*(работы\s*)?(от|не\s*менее)|experience\s*(required|of\s*\d)|\d\+?\s*years?\s*of\s*experience|от\s*\d\s*(года|лет)\s*опыт|опыт\s*в\s*(сфере|продаж|данной)\s*\w*\s*от/.test(t);
  const welcomesNoExp = /без\s*опыта|опыт\s*не\s*требуется|опыта\s*не\s*требуется|можно\s*без\s*опыта|no\s*experience|обучение\s*с\s*нуля|обучаем|стажировк|стажер|стажёр|intern|тәжірибесіз/.test(t);
  if (requiresExp && !welcomesNoExp) return 'requires-experience';

  // 4. Age / gender restriction (discriminatory; usually not student roles)
  if (/(женщин\w*|мужчин\w*|девушк\w*|парн\w*|парень|жен\.|муж\.)\s*(от|до)?\s*\d{2}/.test(t))
    return 'age-gender-restricted';

  // 5. Multi-job digest (several vacancies mashed into one post)
  const c = (re) => (t.match(re) || []).length;
  if (c(/зарплата/g) >= 3 || c(/обязанности/g) >= 2 || c(/требовани[ея]/g) >= 3 || c(/ваканси[яи]\s*[:№#]/g) >= 2)
    return 'multi-job-digest';

  return null;
}

function isStudentFriendly(title, description, tags = [], { structuredEntry = false } = {}) {
  if (studentRejectReason(title, description, tags)) return false;
  if (structuredEntry) return true;
  const fullText = `${title || ''} ${description || ''} ${(tags || []).join(' ')}`.toLowerCase();
  return POSITIVE.some((kw) => fullText.includes(kw));
}

module.exports = { studentRejectReason, isStudentFriendly, POSITIVE, NOT_A_JOB };
