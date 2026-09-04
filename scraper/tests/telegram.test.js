/**
 * Telegram parser tests — every case here is a real post shape that reached the
 * live board as junk. If one of these regresses, the board gets embarrassing
 * again, so they are the first thing the workflow runs.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');

const { parsePost, isVacancy, detectTitle, detectCompany } = require('../telegram/parser');
const { studentRejectReason } = require('../lib/filter');
const { makeJob, titleProblem } = require('../lib/normalize');

const FIXTURES = path.join(__dirname, 'fixtures');

function postsFromFixture(name) {
  const $ = cheerio.load(fs.readFileSync(path.join(FIXTURES, name), 'utf8'));
  const out = [];
  $('.tgme_widget_message').each((_, el) => {
    const dp = $(el).attr('data-post');
    if (!dp) return;
    const $t = $(el).find('.tgme_widget_message_text').first();
    $t.find('br').replaceWith('\n');
    const text = $t.text().trim();
    if (!text) return;
    const links = [];
    $t.find('a').each((_, a) => { const h = $(a).attr('href'); if (h) links.push(h); });
    out.push({
      channel: dp.split('/')[0], msgId: dp.split('/').pop(),
      postUrl: 'https://t.me/' + dp,
      dateISO: $(el).find('time').attr('datetime') || null,
      text, links,
    });
  });
  return out;
}

// ── The junk that actually made it onto the board ───────────────────────────
const JUNK = {
  'grant': 'Грант Tech Orda на обучение в Big Dream Lab School 🚀\nОткрыт конкурсный набор на онлайн-курс Vibe Coding / AI Engineering.\nУчастники, успешно прошедшие отбор, смогут получить грант 400 000 ₸ и бесплатно пройти 6-месячное обучение.\nТребования: быть студентом.',
  'club-recruitment': "AIESEC in Almaty запускает Recruitment Fall'26🔥\nЭто твоя возможность:\nРазвить лидерские скиллы на реальных проектах;\nОткрыть международные стажировки;\nТребования: студент 1-4 курса.\nЗаполни форму до 10 сентября.",
  'resume-ad': 'Поиск работы без хаоса: от сильного резюме до желаемого оффера\nПомогу составить резюме, которое заметят рекрутеры.\nКонсультация по карьере, обязанности разберём вместе.\nЗапись в личные сообщения.',
  'training-program': 'Boota Green Talent Academy — a complimentary 8-week training program focused on practical skills in green economy.\nWhat the program offers: 8 weeks of training, certificate, mentorship.\nRequirements: students and graduates.',
};

for (const [label, text] of Object.entries(JUNK)) {
  test(`isVacancy rejects ${label}`, () => {
    assert.equal(isVacancy(text), false, `"${label}" should not be treated as a vacancy`);
  });
}

// ── Real vacancies must survive ─────────────────────────────────────────────
const LABELLED = 'Компания: Danone, ТМ\nДолжность: Стажер в финансовый департамент\nУровень заработной платы: не указан\nСсылка на вакансию: https://my.hh.kz/2tP';

test('labelled post: title and company come from their labels', () => {
  assert.equal(isVacancy(LABELLED), true);
  assert.equal(detectTitle(LABELLED), 'Стажер в финансовый департамент');
  assert.equal(detectCompany(LABELLED), 'Danone, ТМ');
});

test('labelled post: the explicit apply link beats link-order heuristics', () => {
  const job = parsePost({
    channel: 'kbtucareer', msgId: '1', postUrl: 'https://t.me/kbtucareer/1',
    dateISO: new Date().toISOString(), text: LABELLED, links: ['https://t.me/kbtucareer'],
  });
  assert.ok(job);
  assert.equal(job.apply_url, 'https://my.hh.kz/2tP');
  assert.equal(job.source_type, 'external_link');
});

test('company falls back to the channel label, never "Unknown"', () => {
  const text = 'Мы ищем ассистента рекрутера\nОбязанности: помощь в подборе\nТребования: студент старших курсов\nРезюме на hr@example.kz';
  const job = parsePost(
    { channel: 'kbtucareer', msgId: '2', postUrl: 'u', dateISO: new Date().toISOString(), text, links: [] },
    { companyFallback: 'KBTU Career Center' });
  assert.ok(job);
  assert.notEqual(job.company, 'Unknown');
  assert.equal(job.company, 'KBTU Career Center');
});

// ── Title selection: the exact fragments that shipped to production ─────────
test('a post with no nameable role is dropped rather than titled with a fragment', () => {
  const text = ', напишите мне в личные сообщения в Телеграм @prozaitseva\nбуду рада помочь\nхорошие предложения уже разбирают';
  assert.equal(parsePost({ channel: 'c', msgId: '3', postUrl: 'u', dateISO: new Date().toISOString(), text, links: [] }), null);
});

test('titleProblem rejects the fragment titles found on the live board', () => {
  const bad = [
    'находится на стыке бизнес-аналитики, продаж и проектной деятельности',
    ', напишите мне в личные сообщения в Телеграм',
    'Сайт:',
    'работа',
    'ХВАТИТ ИСКАТЬ РАБОТУ — ПУСТЬ ОНА НАЙДЁТ ТЕБЯ!',
    'Toyota Center Karaganda приглашает в команду!',
  ];
  for (const t of bad) assert.ok(titleProblem(t), `expected "${t}" to be rejected`);
});

test('titleProblem accepts ordinary job titles', () => {
  for (const t of ['Стажер в отдел логистики', 'Junior Frontend Developer', 'Менеджер по продажам', 'Marketing Intern']) {
    assert.equal(titleProblem(t), null, `expected "${t}" to pass`);
  }
});

// ── End-to-end over real saved channel pages ────────────────────────────────
test('real channel pages yield only clean, student-suitable listings', () => {
  const kept = [];
  for (const fx of ['tg-kbtucareer.html', 'tg-youngcareer.html', 'tg-jobkz_1.html']) {
    for (const post of postsFromFixture(fx)) {
      const parsed = parsePost(post, { companyFallback: 'Career Center' });
      if (!parsed) continue;
      if (studentRejectReason(parsed.title, parsed.raw_text, parsed.tags)) continue;
      const job = makeJob(parsed);
      if (job) kept.push(job);
    }
  }
  // The fixtures contain real vacancies, so this must not collapse to zero —
  // an over-tightened filter is as much a bug as an over-loose one.
  assert.ok(kept.length >= 8, `expected ≥8 clean jobs from fixtures, got ${kept.length}`);
  for (const j of kept) {
    assert.equal(titleProblem(j.title), null, `dirty title survived: "${j.title}"`);
    assert.notEqual(j.company, 'Unknown');
    assert.ok(j.title.length >= 4);
  }
  // And none of the known junk headlines may appear.
  const titles = kept.map((j) => j.title.toLowerCase());
  for (const banned of ['грант', 'aiesec', 'recruitment fall', 'поиск работы без хаоса']) {
    assert.ok(!titles.some((t) => t.includes(banned)), `junk survived: ${banned}`);
  }
});
