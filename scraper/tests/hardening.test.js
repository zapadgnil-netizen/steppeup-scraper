/**
 * Regression tests from the pre-push review: each one failed before its fix.
 */
const test = require('node:test');
const assert = require('node:assert');
const { resolveApply, classifyHref } = require('../telegram/apply');
const { dedupeReposts } = require('../telegram/dedupe');
const { createJudge, scrub } = require('../telegram/jev');

const P = (text, extra = {}) => ({ channel: 'zzchan', postUrl: 'https://t.me/zzchan/5', text, ...extra });
const FALLBACK = ['https://t.me/zzchan/5', 'telegram_post'];
const route = (post) => { const r = resolveApply(post); return [r.apply_url, r.source_type]; };

test('a salary range is never a phone number', () => {
  for (const pay of ['Зарплата 87 000-170 000 тг', 'ЗП от 77 000-150 000', 'Оклад 87 000 - 170 000 ₸', 'Доход 8 777 777 777 7 тенге']) {
    assert.deepEqual(route(P(`Менеджер\n${pay}`)), FALLBACK, pay);
  }
});

test('real phone spellings still work next to a salary line', () => {
  const r = route(P('Менеджер\nЗарплата 87 000-170 000 тг\nТел: 8 701 123-45-67'));
  assert.deepEqual(r, ['tel:+77011234567', 'phone']);
});

test('a malformed %-escape in a mailto:/tel: link cannot crash the router', () => {
  for (const href of ['mailto:%E0%A4%A@example.kz', 'tel:%zz']) {
    assert.doesNotThrow(() => resolveApply(P('Менеджер', { textLinks: [{ href, label: 'x' }] })), href);
    assert.deepEqual(route(P('Менеджер', { textLinks: [{ href, label: 'x' }] })), FALLBACK, href);
  }
});

test('only sane web URLs are emitted: length cap, no credentials, no local or bare hosts', () => {
  const link = (href) => route(P('Менеджер', { textLinks: [{ href, label: 'Откликнуться' }] }));
  assert.deepEqual(link('https://example.com/vacancy/' + 'a'.repeat(3000)), FALLBACK);
  assert.deepEqual(link('https://user:pw@example.com/vacancy/1'), FALLBACK);
  for (const h of ['http://localhost/vacancy', 'https://127.0.0.1/vacancy', 'https://192.168.0.1/vacancy', 'https://intranet/vacancy']) assert.deepEqual(link(h), FALLBACK, h);
  assert.deepEqual(link('http://example.com/vacancy/1'), ['https://example.com/vacancy/1', 'site']);
});

test('a bot ?start= payload is kept only when it is Telegram-safe', () => {
  assert.equal(classifyHref('https://t.me/Example_bot?start=abc_DEF-1', new Set()).start, 'abc_DEF-1');
  assert.equal(classifyHref('https://t.me/Example_bot?start=a"c<b', new Set()).start, null);
});

test('mailto: is built only from a strictly valid address', () => {
  for (const bad of ['a..b@example.kz', '.a@example.kz', 'a.@example.kz', 'a@b.c', 'a@-example.kz', 'a@example-.kz', 'a@example..kz']) {
    assert.deepEqual(route(P('Менеджер', { textLinks: [{ href: `mailto:${bad}`, label: 'mail' }] })), FALLBACK, bad);
  }
  assert.deepEqual(route(P('Менеджер\nРезюме: First.Last+cv@Example.kz')), ['mailto:first.last+cv@example.kz', 'email']);
});

// ── repost dedupe must not swallow DIFFERENT vacancies that share a recruiter ──
const mk = (id, title, apply_url, source_type, daysAgo = 0) => ({
  source_id: `tg_jobkz_1_${id}`, source_channel: 'jobkz_1', title, company: 'ТОО Пример', apply_url, source_type,
  posted_at: new Date(Date.now() - daysAgo * 864e5).toISOString(), raw_text: `Вакансия ${title}`,
});

test('DB: a different vacancy from the same recruiter phone/email is NOT dropped as a repost', () => {
  const row = { ...mk(1, 'Бухгалтер', 'tel:+77000000001', 'phone', 5) };
  const incoming = { job: mk(9, 'Курьер', 'tel:+77000000001', 'phone', 0), named: false };
  const r = dedupeReposts([incoming], { existingRows: [row] });
  assert.equal(r.kept.length, 1);
  assert.equal(r.dropped.db, 0);
});

test('batch: the same recruiter contact on different DAYS is two vacancies, same day is one announcement', () => {
  const a = { job: mk(1, 'Бухгалтер', 'mailto:hr@example.kz', 'email', 6), named: false };
  const b = { job: mk(2, 'Курьер', 'mailto:hr@example.kz', 'email', 0), named: false };
  assert.equal(dedupeReposts([a, b]).kept.length, 2);
  const c = { job: mk(3, 'Accountant', 'mailto:hr@example.kz', 'email', 0), named: false };
  assert.equal(dedupeReposts([b, c]).kept.length, 1);
});

test('a specific https apply page still identifies a repost against the DB', () => {
  const row = mk(1, 'Бухгалтер', 'https://jobs.example.kz/apply/1', 'site', 5);
  const incoming = { job: mk(9, 'Другое название', 'https://jobs.example.kz/apply/1', 'site', 0), named: false };
  assert.equal(dedupeReposts([incoming], { existingRows: [row] }).dropped.db, 1);
});

// ── key hygiene ──
test('scrub removes the exact configured key even when it has no apikey_ prefix', () => {
  const key = 'sk-live-ABCDEF1234567890';
  assert.ok(!scrub(`401 for ${key}`, { env: { TYPESAFE_API_KEY: key } }).includes(key));
});

test('a failing Jev call whose message holds a non-prefixed key never reaches log, reason or stats', async () => {
  const key = 'sk-live-ABCDEF1234567890';
  const lines = [];
  const client = { async systemOne() { throw new Error(`bad key ${key}`); } };
  const sdk = { choice: () => ({}), noul: () => ({}) };
  const j = await createJudge({ env: { TYPESAFE_API_KEY: key }, client, sdk, log: (m) => lines.push(m) });
  const post = { channel: 'c', text: 't' }, parsed = {};
  for (let i = 0; i < 4; i++) assert.equal(await j.assess(post, parsed), null);
  assert.ok(!JSON.stringify([lines, j.reason, j.firstError, j.stats]).includes(key));
});

test('assess never throws even if building the request does', async () => {
  const client = { async systemOne() { return { answers: {} }; } };
  const sdk = { choice: () => { throw new Error('boom'); }, noul: () => ({}) };
  const j = await createJudge({ env: { TYPESAFE_API_KEY: 'k' }, client, sdk });
  const parsed = { _apply: { candidates: [{ id: 'c0', kind: 'email', value: 'a@b.kz', label: '' }] } };
  assert.equal(await j.assess({ channel: 'c', text: 't' }, parsed), null);
  assert.equal(j.stats.failed, 1);
});

test('posts Jev drops that the rules kept are named in the run notes, never silent', async () => {
  const { scrape } = require('../sources/telegram');
  const filter = require('../lib/filter');
  const normalize = require('../lib/normalize');
  const post = {
    channel: 'kimepcareercenter', msgId: '7', postUrl: 'https://t.me/kimepcareercenter/7', dateISO: new Date().toISOString(),
    text: 'Job Vacancies\n\nPOSITION\nСтажер в отдел маркетинга\n\nCOMPANY\nExample Bank\n\nLOCATION\nAlmaty\n\nОбязанности: помощь. Требования: студент.\nРезюме: hr@example.kz',
    textLinks: [], buttons: [], preview: null,
  };
  const client = { async systemOne() { return { answers: { isVacancy: { noul: 0.1 }, studentFit: { noul: 0.9 }, kzRelevant: { noul: 0.9 } } }; } };
  const judge = await createJudge({ env: { TYPESAFE_API_KEY: 'k' }, client, sdk: { choice: () => ({}), noul: () => ({}) } });
  const r = await scrape({ log() {}, filter, normalize, limits: { maxAgeDays: 21 }, judge, sleep: async () => {},
    channels: [{ username: 'kimepcareercenter', label: 'KIMEP Career Center', kind: 'career' }], fetchChannel: async () => [post] });
  assert.equal(r.jobs.length, 0);
  assert.ok(r.notes.some((n) => /Jev dropped 1 post/.test(n) && /jev-not-vacancy/.test(n)), JSON.stringify(r.notes));
});
