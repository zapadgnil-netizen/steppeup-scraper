/**
 * Channel list + saved pages for the channels added 2026-11-16:
 * tg-kimepcareercenter.html (a career centre, POSITION/COMPANY blocks) and
 * tg-almaty_rabota.html (a big general Almaty channel, mostly phone/WhatsApp).
 * Contacts in both fixtures are replaced with invented ones; the page shape is real.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { CHANNELS, CHANNELS_ALL, channelByUsername } = require('../telegram/channels');
const { parseChannelHtml } = require('../telegram/fetcher');
const { parsePost } = require('../telegram/parser');
const { SOURCE_TYPES } = require('../telegram/apply');
const { scrape } = require('../sources/telegram');
const filter = require('../lib/filter');
const normalize = require('../lib/normalize');

const page = (name, username) => parseChannelHtml(fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8'), username);

test('the 2026-11-16 channel list: additions, the corrected IITU handle, the dead handles', () => {
  const on = (u) => (channelByUsername(u) || {}).enabled === true;
  for (const u of ['kimepcareercenter', 'almaucareercenter', 'ccaues', 'careercentervacancies', 'career_center_iitu', 'sucareercenter', 'career_hub_kz', 'it_internships_kz', 'studentworkz']) {
    assert.ok(on(u), `${u} should be enabled`);
    assert.equal(channelByUsername(u).kind, 'career');
  }
  for (const u of ['almaty_rabota', 'almaty_rabota01', 'almatyrabota1', 'almatyfoodwork']) {
    assert.ok(on(u), `${u} should be enabled`);
    assert.equal(channelByUsername(u).kind, 'general');
  }
  assert.equal(on('beam_iitu'), false, 'beam_iitu last posted 2022');
  assert.equal(on('center_career_iitu'), false, 'center_career_iitu does not exist');
  assert.equal(on('beam_vacancies'), false);
  assert.equal(on('youngcareer'), false);
  assert.equal(on('farabi_university'), false);
  assert.equal(new Set(CHANNELS_ALL.map((c) => c.username.toLowerCase())).size, CHANNELS_ALL.length, 'no duplicate handles');
  for (const c of CHANNELS) assert.ok(['career', 'university', 'general'].includes(c.kind), c.username);
});

test('kimepcareercenter page: titles, employers from COMPANY blocks, never a link back to the channel', () => {
  const posts = page('tg-kimepcareercenter.html', 'kimepcareercenter');
  assert.ok(posts.length >= 10);
  const jobs = posts.map((p) => parsePost(p, { companyFallback: 'KIMEP Career Center' })).filter(Boolean);
  assert.ok(jobs.length >= 5, `expected ≥5 vacancies, got ${jobs.length}`);
  for (const j of jobs) {
    assert.ok(j.title.length >= 4);
    assert.notEqual(j.company, 'KIMEP Career Center', `employer fell back to the channel label for "${j.title}"`);
    assert.ok(SOURCE_TYPES.includes(j.source_type), j.source_type);
    assert.ok(!/t\.me\/kimepcareercenter/i.test(j.apply_url), j.apply_url);
  }
  // the e-mail written as a malformed auto-link (http://e-mail:…) resolves to mailto:
  assert.ok(jobs.some((j) => j.apply_url === 'mailto:hr@example.kz' && j.source_type === 'email'));
});

test('almaty_rabota page: phone / WhatsApp routes, no ad contact, student gate is strict', async () => {
  const posts = page('tg-almaty_rabota.html', 'almaty_rabota');
  const jobs = posts.map((p) => parsePost(p, { companyFallback: 'Вакансии Алматы' })).filter(Boolean);
  assert.ok(jobs.length >= 6, `expected ≥6 vacancies, got ${jobs.length}`);
  const phoneish = jobs.filter((j) => ['phone', 'whatsapp'].includes(j.source_type)).length;
  assert.ok(phoneish / jobs.length >= 0.6, `most apply by phone/WhatsApp, got ${phoneish}/${jobs.length}`);
  for (const j of jobs) {
    assert.ok(!/t\.me\/(almaty_rabota|example_hr)\b/i.test(j.apply_url), `channel / ad contact chosen: ${j.apply_url}`);
  }

  // Through the source: only posts with a STRONG student signal survive, and
  // shift/part-time roles carry the part-time tag.
  const logs = [];
  const result = await scrape({
    log: (m) => logs.push(m), filter, normalize, limits: { maxAgeDays: 36500 }, sleep: async () => {},
    channels: [channelByUsername('almaty_rabota')], fetchChannel: async () => posts,
    judge: { mode: 'rules', reason: 'test', stats: { jev: 0, rules: 0, failed: 0, rejected: {}, overrides: { apply: 0, title: 0, company: 0 } }, assess: async () => null },
  });
  assert.ok(result.jobs.length < jobs.length, 'strict gate must drop posts without a student signal');
  assert.ok(result.stats.rejects['no-student-signal'] > 0);
  for (const j of result.jobs) {
    assert.ok(filter.isStudentFriendly(j.title, j.raw_text, j.tags, { strictPositive: true }), `no strong signal: ${j.title}`);
  }
});

test('strict gate: weak keywords (ассистент, помощник) do not pass a general channel', () => {
  assert.equal(filter.isStudentFriendly('Помощник повара', 'Требуется помощник повара, обязанности: помощь', [], { strictPositive: true }), false);
  assert.equal(filter.isStudentFriendly('Помощник повара', 'Подходит студентам, подработка', [], { strictPositive: true }), true);
  assert.equal(filter.isStudentFriendly('Помощник повара', 'Требуется помощник повара', []), true, 'career channels keep the weaker rule');
});

test('general channels: a post without a student signal is dropped, one with it is kept and tagged part-time', async () => {
  const mk = (id, text) => ({ channel: 'almatyrabota1', msgId: String(id), postUrl: `https://t.me/almatyrabota1/${id}`, dateISO: new Date().toISOString(), text, textLinks: [], buttons: [], preview: null });
  const posts = [
    mk(1, 'Продавец-консультант\nОбязанности: работа с покупателями\nТребования: ответственность\nТел: +7 700 000 00 01'),
    mk(2, 'Продавец-консультант в магазин\nПодработка для студентов, график 2/2, оплата за смену\nОбязанности: работа с покупателями\nТел: +7 700 000 00 02'),
  ];
  const r = await scrape({
    log: () => {}, filter, normalize, limits: { maxAgeDays: 21 }, sleep: async () => {},
    channels: [channelByUsername('almatyrabota1')], fetchChannel: async () => posts,
    judge: { mode: 'rules', reason: 'test', stats: { jev: 0, rules: 0, failed: 0, rejected: {}, overrides: { apply: 0, title: 0, company: 0 } }, assess: async () => null },
  });
  assert.equal(r.jobs.length, 1);
  assert.equal(r.jobs[0].source_id, 'tg_almatyrabota1_2');
  assert.ok(r.jobs[0].tags.includes('part-time'));
  assert.equal(r.stats.rejects['no-student-signal'], 1);
});
