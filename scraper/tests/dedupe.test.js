const test = require('node:test');
const assert = require('node:assert');
const { dedupeReposts } = require('../telegram/dedupe');
const { parsePost } = require('../telegram/parser');
const { makeJob } = require('../lib/normalize');
const { scrape } = require('../sources/telegram');
const filter = require('../lib/filter');
const normalize = require('../lib/normalize');

const NOW = new Date().toISOString();
const jobkz = (id, title, company, contact, extra = '') => ({
  channel: 'jobkz_1', msgId: String(id), postUrl: `https://t.me/jobkz_1/${id}`, dateISO: NOW, textLinks: [], buttons: [], preview: null,
  text: `🔍\n\n🧰 Вакансия: ${title}\n${company ? `🏢 Компания: ${company}\n` : ''}📍 Алматы\n\n🎯 Обязанности:\n- Работа с клиентами и подготовка отчётов${extra}\n\n📱 ${contact}\n\n#вакансия\n🔍\n#JobKZ\nt.me/jobkz_1`,
});
const job = (post) => ({ job: makeJob(parsePost(post, { companyFallback: 'JobKZ' })), named: /🏢/.test(post.text) });

test('recurring post with a different phone each time is stored once (same title + employer)', () => {
  const a = job(jobkz(1, 'Менеджер по продажам', 'ТОО Пример', 'Тел: +7 700 000 00 01'));
  const b = job(jobkz(9, 'Менеджер по продажам', 'ТОО Пример', 'Тел: +7 700 000 00 02'));
  const { kept, dropped } = dedupeReposts([a, b]);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].source_id, 'tg_jobkz_1_1');
  assert.equal(dropped.batch, 1);
});

test('the same announcement in three languages with one contact is stored once', () => {
  const ru = jobkz(1, 'Менеджер по продажам', 'ТОО Пример', 'WhatsApp: +7 700 000 00 01');
  const en = jobkz(2, 'Sales Manager', 'ТОО Пример', 'WhatsApp: +7 700 000 00 01');
  const kk = jobkz(3, 'Сату менеджері', 'ТОО Пример', 'WhatsApp: +7 700 000 00 01');
  const { kept } = dedupeReposts([ru, en, kk].map(job));
  assert.equal(kept.length, 1);
});

test('different vacancies sharing one HR contact on one channel are NOT merged by title, but the same contact is', () => {
  // different contact + title = kept (a shared contact alone only merges same-announcement posts, see hardening.test.js)
  const a = job(jobkz(1, 'Бухгалтер', 'ТОО Пример', 'Тел: +7 700 000 00 01'));
  const b = job(jobkz(2, 'Курьер', 'ТОО Другое', 'Тел: +7 700 000 00 02'));
  assert.equal(dedupeReposts([a, b]).kept.length, 2);
});

test('unnamed employers (channel-label fallback) are not merged on title alone', () => {
  const a = job(jobkz(1, 'Менеджер по продажам', null, 'Тел: +7 700 000 00 01', '\n- Первая компания'));
  const b = job(jobkz(2, 'Менеджер по продажам', null, 'Тел: +7 700 000 00 02', '\n- Совсем другая вакансия про другое'));
  assert.equal(dedupeReposts([a, b]).kept.length, 2);
});

test('same title and employer on a DIFFERENT channel is not a repost', () => {
  const a = job(jobkz(1, 'Менеджер по продажам', 'ТОО Пример', 'Тел: +7 700 000 00 01'));
  const other = { ...a.job, source_id: 'tg_other_5', source_channel: 'other' };
  assert.equal(dedupeReposts([a, { job: other, named: true }]).kept.length, 2);
});

test('DB check: an active row inside the TTL wins, and a row never duplicates itself', () => {
  const a = job(jobkz(20, 'Менеджер по продажам', 'ТОО Пример', 'Тел: +7 700 000 00 09'));
  const row = { source_id: 'tg_jobkz_1_3', source_channel: 'jobkz_1', title: 'Менеджер по продажам', company: 'ТОО Пример', apply_url: 'tel:+77000000001', source_type: 'phone' };
  const r = dedupeReposts([a], { existingRows: [row] });
  assert.equal(r.kept.length, 0);
  assert.equal(r.dropped.db, 1);
  // the same source_id coming back is an update, not a duplicate
  const same = { ...row, source_id: a.job.source_id };
  assert.equal(dedupeReposts([a], { existingRows: [same] }).kept.length, 1);
});

test('DB check by apply page works for rows whose company was the channel label; a shared phone alone does not merge', () => {
  const a = job(jobkz(21, 'Курьер', null, 'Тел: +7 700 000 00 05'));
  const site = { source_id: 'tg_jobkz_1_4', source_channel: 'jobkz_1', title: 'Другое название', company: 'JobKZ', apply_url: 'https://jobs.example.kz/apply/9', source_type: 'site' };
  const sameSite = { job: { ...a.job, apply_url: site.apply_url, source_type: 'site' }, named: false };
  assert.equal(dedupeReposts([sameSite], { existingRows: [site] }).dropped.db, 1);
  const phoneRow = { ...site, apply_url: a.job.apply_url, source_type: 'phone' };
  assert.equal(dedupeReposts([a], { existingRows: [phoneRow] }).dropped.db, 0);
});

test('scrape() applies the injected DB loader and reports counts', async () => {
  const posts = [jobkz(30, 'Менеджер по продажам', 'ТОО Пример', 'Тел: +7 700 000 00 07')];
  const ctx = {
    log: () => {}, filter, normalize, limits: { maxAgeDays: 21 }, sleep: async () => {},
    channels: [{ username: 'jobkz_1', label: 'JobKZ', kind: 'career', profile: 'jobkz' }],
    fetchChannel: async () => posts,
    judge: { mode: 'rules', reason: 'test', stats: { jev: 0, rules: 0, failed: 0, rejected: {}, overrides: { apply: 0, title: 0, company: 0 } }, assess: async () => null },
    loadExisting: async () => [{ source_id: 'tg_jobkz_1_2', source_channel: 'jobkz_1', title: 'Менеджер по продажам', company: 'ТОО Пример', apply_url: 'tel:+77000000003', source_type: 'phone' }],
  };
  const r = await scrape(ctx);
  assert.equal(r.jobs.length, 0);
  assert.equal(r.stats.rejects['duplicate-in-db'], 1);
});

test('scrape() works without a DB loader (dry run): batch-level dedupe only', async () => {
  const posts = [jobkz(30, 'Менеджер по продажам', 'ТОО Пример', 'Тел: +7 700 000 00 07'), jobkz(31, 'Менеджер по продажам', 'ТОО Пример', 'Тел: +7 700 000 00 08')];
  const ctx = {
    log: () => {}, filter, normalize, limits: { maxAgeDays: 21 }, sleep: async () => {},
    channels: [{ username: 'jobkz_1', label: 'JobKZ', kind: 'career', profile: 'jobkz' }],
    fetchChannel: async () => posts,
    judge: { mode: 'rules', reason: 'test', stats: { jev: 0, rules: 0, failed: 0, rejected: {}, overrides: { apply: 0, title: 0, company: 0 } }, assess: async () => null },
  };
  const r = await scrape(ctx);
  assert.equal(r.jobs.length, 1);
  assert.equal(r.stats.rejects['duplicate-in-batch'], 1);
});
