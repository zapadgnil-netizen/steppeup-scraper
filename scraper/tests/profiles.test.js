/**
 * Per-channel profiles: each channel's own format is read by its own small
 * extractor BEFORE the generic detectTitle/detectCompany. Posts below are
 * invented but keep the real line shapes (emoji-labelled @jobkz_1, upper-case
 * KIMEP blocks, …).
 */
const test = require('node:test');
const assert = require('node:assert');
const { parsePost, detectTitle } = require('../telegram/parser');
const { channelByUsername } = require('../telegram/channels');

const NOW = new Date().toISOString();
const parse = (channel, text, over = {}) => {
  const cfg = channelByUsername(channel);
  return parsePost({ channel, msgId: '1', postUrl: `https://t.me/${channel}/1`, dateISO: NOW, text, textLinks: [], buttons: [], preview: null, ...over },
    { companyFallback: cfg ? cfg.label : channel });
};

// ── @jobkz_1 ────────────────────────────────────────────────────────────────
const JOBKZ = (title, company, extra = '') => `🔍\n\n🧰 ${title}\n${company ? `🏢 ${company}\n` : ''}📍 Локация: г. Алматы\n💰 Зарплата: от 250 000 до 300 000 тг\n\n🎯 Что предстоит делать:\n- Работа с клиентами\n\nРезюме: hr@example.kz\n${extra}\n#вакансия\n🔍\n#JobKZ\nt.me/jobkz_1`;

test('jobkz_1: employer comes from the 🏢 line, never the channel label', () => {
  const j = parse('jobkz_1', JOBKZ('Вакансия: Менеджер по продажам', 'Компания: ТОО «Пример»'));
  assert.equal(j.title, 'Менеджер по продажам');
  assert.equal(j.company, 'ТОО «Пример»');
  assert.equal(j.location, 'Алматы');
  assert.equal(j.salary_min, 250000);
});

test('jobkz_1: every 🧰 / 🏢 label variant is understood', () => {
  const cases = [
    ['Vacancy: Sales Manager', 'Company: Example LLP', 'Sales Manager', 'Example LLP'],
    ['Должность: Ассистент менеджера', 'Example Group', 'Ассистент менеджера', 'Example Group'],
    ['Бухгалтер', 'ТОО Пример', 'Бухгалтер', 'ТОО Пример'],
    ['ВАКАНСИЯ | Администратор', 'Компания: Кафе Пример', 'Администратор', 'Кафе Пример'],
  ];
  for (const [t, c, title, company] of cases) {
    const j = parse('jobkz_1', JOBKZ(t, c));
    assert.ok(j, t);
    assert.equal(j.title, title);
    assert.equal(j.company, company);
  }
});

test('jobkz_1: with no 🏢 line the channel label is the fallback', () => {
  const j = parse('jobkz_1', JOBKZ('Курьер', null));
  assert.equal(j.company, 'JobKZ');
});

test('jobkz_1: a post with no 🧰 vacancy line is channel promotion, not a job', () => {
  const folder = '🔍\n\nГде искать свежие вакансии для работы?\nМы собрали каналы с вакансиями в одну папку, менеджер по продажам или курьер.\nОбязанности и требования внутри.\n\n👉 Забрать папку: t.me/addlist/AbC';
  assert.equal(parse('jobkz_1', folder), null);
  assert.equal(parsePost.lastReject, 'no-vacancy-line');
});

test('jobkz_1: a vacancy outside Kazakhstan is dropped', () => {
  const j = parse('jobkz_1', JOBKZ('ВАКАНСИЯ | ФЛОРИСТ', 'Example').replace('г. Алматы', 'ДУБАЙ'));
  assert.equal(j, null);
  assert.equal(parsePost.lastReject, 'outside-kazakhstan');
});

// ── @kimepcareercenter ──────────────────────────────────────────────────────
test('kimepcareercenter: POSITION / COMPANY / LOCATION blocks', () => {
  const text = 'Job Vacancies\n\nPOSITION\nСтажер\n\nCOMPANY\nExample Financial Services\n\nLOCATION\nAlmaty\n\nJOB STATUS\nfull time\n\nREQUIREMENTS\nСтуденты старших курсов\nDUTIES\nПомощь команде\n\nПрошу резюме на hr@example.kz';
  const j = parse('kimepcareercenter', text);
  assert.equal(j.title, 'Стажер');
  assert.equal(j.company, 'Example Financial Services');
  assert.equal(j.location, 'Алматы');
});

test('kimepcareercenter: same-line labels and a quoted employer', () => {
  const text = 'Job Vacancies\n\nPOSITION Личный ассистент руководителя\n\nCOMPANY "The Example System"\n\nLOCATION Astana\n\nОбязанности: помощь, резюме на hr@example.kz';
  const j = parse('kimepcareercenter', text);
  assert.equal(j.title, 'Личный ассистент руководителя');
  assert.equal(j.company, 'The Example System');
  assert.equal(j.location, 'Астана');
});

// ── @career_center_iitu ─────────────────────────────────────────────────────
test('career_center_iitu: 💼 Вакансия / Компания labels, and a bare emoji headline', () => {
  const a = parse('career_center_iitu', '💼 Вакансия: Разработчик 1С\nКомпания: Example Logistics\nЗарплата: 200 000–350 000 ₸\n\n📌 Обязанности:\n— разработка\n\n📞 Отклик: hr@example.kz');
  assert.equal(a.title, 'Разработчик 1С');
  assert.equal(a.company, 'Example Logistics');
  const b = parse('career_center_iitu', '💻 Стажёр в IT-отдел\n\nЗаработная плата: от 150 000 ₸\nОпыт работы: не требуется\n\nОбязанности:\n— поддержка\n\n📩 Контакты: +7 700 000 00 00');
  assert.equal(b.title, 'Стажёр в IT-отдел');
});

// ── @career_hub_kz ──────────────────────────────────────────────────────────
test('career_hub_kz: "<N>. <employer> вакансия: <title>" and labelled blocks', () => {
  const a = parse('career_hub_kz', '1. ТОО Пример Казахстан вакансия: Оператор колл-центра (работа на дому)\nПодать заявку', { textLinks: [{ href: 'https://example.kz/apply', label: 'Подать заявку' }] });
  assert.equal(a.title, 'Оператор колл-центра (работа на дому)');
  assert.equal(a.company, 'ТОО Пример Казахстан');
  const b = parse('career_hub_kz', 'Контент-инженер (начинающий специалист)\n\nКомпания: example.kz\n\nЛокация: г. Алматы\nГрафик: 5/2\nОбязанности: наполнение\nРезюме: hr@example.kz');
  assert.equal(b.title, 'Контент-инженер (начинающий специалист)');
  assert.equal(b.company, 'example.kz');
});

// ── @careercentervacancies ──────────────────────────────────────────────────
test('careercentervacancies: "<Company> приглашает студентов на стажировку в …"', () => {
  const j = parse('careercentervacancies', 'Отель Example Inn Astana приглашает студентов на стажировку в Департамент финансов!\n\nТребования к кандидатам:\n• Студенты 3-4 курсов\n\nРезюме отправлять на hr@example.kz');
  assert.equal(j.company, 'Example Inn Astana');
  assert.equal(j.title, 'Стажировка в Департамент финансов');
});

// ── @studentworkz ───────────────────────────────────────────────────────────
test('studentworkz: heading line, then the role; "В <employer>" names the employer', () => {
  const a = parse('studentworkz', '📌 Вакансия\n\nМОБИЛОГРАФ\n\n📍 Город: Алматы\n\nВ магазин требуется мобилограф без опыта, обучаем. Обязанности: съёмка.\nПишите @example_hr');
  assert.equal(a.title, 'Мобилограф');
  const b = parse('studentworkz', '📌🔥 Горячая вакансия\n\nВ ExampleMedia\n\nИщем графического дизайнера в штат, для соцсетей. Обязанности: визуал.\nЗарплата: 250 000 тг\nПишите @example_hr');
  assert.equal(b.company, 'ExampleMedia');
  assert.match(b.title, /графическ/i);
});

// ── Almaty general channels ─────────────────────────────────────────────────
test('almaty channels: the role is the first line or follows "Требуется:"; "В <place>" names the employer', () => {
  const a = parse('almaty_rabota', 'Продавец-консультант\n85000 - 85000 ₸\n\nТребования:\n• Опыт работы: не требуется\n\nТелефон: +7 700 000 00 00');
  assert.equal(a.title, 'Продавец-консультант');
  const b = parse('almatyrabota1', 'В ТЦ «Пример»\nАдрес: Абая - Ленина\nТребуется:\nпродавец консультант,\nпромоутер.\nПодработка для студентов, обучаем.\nТел: 8 701 000 00 00');
  assert.match(b.title, /продавец консультант/i);
  assert.match(b.company, /Пример/);
});

// ── @it_internships_kz ──────────────────────────────────────────────────────
test('it_internships_kz: hashtag lines are skipped, title is the first real line', () => {
  const j = parse('it_internships_kz', '#алматы #python #java\n\nBackend Intern (Python / Java)\n\nExample Digital - IT-компания из Казахстана, которая разрабатывает CRM-системы.\nОбязанности: разработка. Требования: студент.\n\nРезюме: hr@example.kz');
  assert.equal(j.title, 'Backend Intern (Python / Java)');
  assert.equal(j.company, 'Example Digital');
});

// ── Fragments that reached the board ────────────────────────────────────────
test('"Department: Marketing" and "Период стажировки …" are never titles', () => {
  const t1 = 'Department: Marketing\nМы приглашаем студентов\nТребования: студент\nОбязанности: помощь\nРезюме: hr@example.kz';
  assert.equal(detectTitle(t1), null);
  const t2 = 'Период стажировки не более 3-х месяцев\nТребования: студент\nОбязанности: помощь команде\nРезюме: hr@example.kz';
  assert.equal(detectTitle(t2), null);
  const t3 = 'Marketing Intern\nDepartment: Marketing\nПериод стажировки не более 3-х месяцев\nОбязанности: помощь';
  assert.equal(detectTitle(t3), 'Marketing Intern');
});

test('generic parser: a label line behind an emoji is still read ("💼 Вакансия: X")', () => {
  assert.equal(detectTitle('💼 Вакансия: Стажёр-аналитик\nОбязанности: отчёты'), 'Стажёр-аналитик');
});

// ── Layout quirks measured on live @jobkz_1 / IITU / careercentervacancies ─
test('jobkz_1: the 🏢 line may be a sentence; zero-width spaces and look-alike letters are cleaned', () => {
  const a = parse('jobkz_1', JOBKZ('Вакансия: Транспортный координатор', 'Компания «Интертаско» объявляет набор:'));
  assert.equal(a.company, 'Интертаско');
  const b = parse('jobkz_1', JOBKZ('Вакансия: Бухгалтер', 'Компания по оптовой торговле ГСМ'));
  assert.equal(b.company, 'Компания по оптовой торговле ГСМ');
  const c = parse('jobkz_1', JOBKZ('​Ваĸансия: Менеджер по развитию партнёрсĸого ĸанала', null));
  assert.equal(c.title, 'Менеджер по развитию партнёрского канала');
  const d = parse('jobkz_1', JOBKZ('Head of Middle Office | Алматы', 'Example Bank'));
  assert.equal(d.title, 'Head of Middle Office');
});

test('career_center_iitu: "<Employer> ищет <role>" headline', () => {
  const j = parse('career_center_iitu', 'Relog ищет стажёра по внедрению IT-продукта\n\nОбязанности:\n— внедрение\n\nКонтакты: hr@example.kz');
  assert.equal(j.company, 'Relog');
  assert.equal(j.title, 'Стажёр по внедрению IT-продукта');
});

test('a "Подать заявку: <url>" line is never the title', () => {
  const j = parse('careercentervacancies', 'Подать заявку: https://internship.example.kz\nОбязанности: помощь команде\nТребования: студент');
  assert.equal(j, null);
});

test('general channels: shift work is tagged part-time', () => {
  const j = parse('almatyfoodwork', 'Требуется повар\nГрафик: 2/2, 19 000 тг за смену\nОбучаем, подходит студентам\nТел: 8 701 000 00 00');
  assert.ok(j.tags.includes('part-time'), JSON.stringify(j.tags));
});

test('"Ассистент руководителя" is an assistant role, not a senior one', () => {
  const { studentRejectReason } = require('../lib/filter');
  assert.equal(studentRejectReason('Стажёр / Ассистент руководителя', 'студент'), null);
  assert.equal(studentRejectReason('Руководитель отдела продаж', 'студент'), 'senior-title');
});

test('titles never carry salary tails, phones or prose openers', () => {
  const { trimTitle } = require('../telegram/parser');
  assert.equal(trimTitle('Повар — заработная плата 300 000 тенге'), 'Повар');
  assert.equal(detectTitle('Также будем рады резюме специалистов из других городов\nОбязанности: помощь\nРезюме на hr@example.kz'), null);
  assert.equal(detectTitle('Номер: +7 700 000 00 00 HR отдел\nОбязанности: помощь\nТребования: студент'), null);
});

test('general channels never guess an employer from the first line', () => {
  const j = parse('almatyfoodwork', 'СРОЧНО\nТребуется официант в кафе\nГрафик: 2/2\nПодходит студентам\nТел: 8 701 000 00 00');
  assert.equal(j.company, 'Общепит Алматы');
});

test('all-caps Cyrillic headlines are sentence-cased and put in the nominative', () => {
  const j = parse('almatyrabota1', 'Крупный fashion brand ИЩЕТ КОНСУЛЬТАНТА ПО ПРОДАЖАМ\nПодработка для студентов\nТел: 8 701 000 00 00');
  assert.equal(j.title, 'Консультант по продажам');
});

test('calls to action and slogans are not titles (live examples)', () => {
  for (const line of ['Түйіндемеңізді HR мамандарына ұсыныңыз', 'Реальные перспективы карьерного роста до инженера', 'Креативных, инициативных и ответственных специалистов', 'В команду Example Studio Project Manager']) {
    assert.equal(detectTitle(`${line}\nОбязанности: помощь команде\nТребования: студент\nРезюме: hr@example.kz`), null, line);
  }
});

test('employer candidates are clipped at the verb ("Kreston ищет стажёра" → "Kreston")', () => {
  const { companyCandidates } = require('../telegram/parser');
  const c = companyCandidates('Компания Kreston Global ищет стажёра юриста\nОбязанности: помощь', null, null, 'Chan');
  assert.deepEqual(c, ['Kreston Global']);
});
