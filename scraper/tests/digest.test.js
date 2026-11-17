const test = require('node:test');
const assert = require('node:assert');
const { buildDigest, run, selectRows, sendTelegram } = require('../digest');

const H = 3600e3;
const T0 = new Date('2026-11-17T04:00:00Z');
const row = (id, hoursBeforeT0, over = {}) => ({
  id, title: `Стажёр ${id}`, company: `ТОО Пример ${id}`, location: 'Алматы', salary_min: null, salary_max: null, currency: 'KZT',
  source: 'telegram_career', status: 'active', tags: ['telegram_career', 'стажировка'], description: 'Студентам, обучаем',
  created_at: new Date(T0.getTime() - hoursBeforeT0 * H).toISOString(), ...over,
});

test('lists only Telegram jobs first seen in the last 24h, each with a job-page URL', () => {
  const rows = [
    row(1, 2), row(2, 23.9),
    row(3, 25),                                  // older than 24h
    row(4, 3, { source: 'hh_kz' }),              // not Telegram
    row(5, 3, { status: 'inactive' }),
    row(6, 1, { title: 'Директор по развитию' }),// not student-suitable (senior title)
  ];
  const d = buildDigest(rows, { now: T0 });
  assert.deepEqual(d.items.map((i) => i.id), [1, 2]);
  for (const i of d.items) assert.equal(i.url, `https://steppeup.ai/job/${i.id}`);
  assert.match(d.text, /https:\/\/steppeup\.ai\/job\/1/);
  assert.match(d.text, /Стажёр 1/);
  assert.match(d.text, /ТОО Пример 1 · Алматы/);
});

test('two consecutive days produce no overlapping jobs', () => {
  // a job every 2 hours across 3 days, including exactly on the boundaries
  const rows = [];
  for (let h = 0; h <= 72; h += 2) rows.push(row(100 + h, 72 - h));  // created T0-72h … T0
  const day2 = new Date(T0.getTime() - 24 * H), day3 = T0;
  const a = buildDigest(rows, { now: day2, limit: 100 }).items.map((i) => i.id);
  const b = buildDigest(rows, { now: day3, limit: 100 }).items.map((i) => i.id);
  assert.ok(a.length > 0 && b.length > 0);
  assert.deepEqual(a.filter((id) => b.includes(id)), [], 'no job in both digests');
  for (const i of buildDigest(rows, { now: day3, limit: 100 }).items) assert.ok(i.url.startsWith('https://steppeup.ai/job/'));
});

test('pay appears when known; titles are HTML-escaped; reposts of one title appear once', () => {
  const rows = [
    row(1, 1, { salary_min: 150000, salary_max: 200000, title: 'Стажёр <b>&</b>' }),
    row(2, 2, { salary_min: 250000 }),
    row(3, 3, { title: 'Стажёр 2', company: 'ТОО Пример 2' }),
  ];
  const d = buildDigest(rows, { now: T0 });
  assert.match(d.text, /150 000–200 000 ₸/);
  assert.match(d.text, /от 250 000 ₸/);
  assert.ok(!d.text.includes('<b>&</b>'));
  assert.match(d.text, /Стажёр &lt;b&gt;&amp;&lt;\/b&gt;/);
  assert.equal(d.items.length, 2);
});

test('an empty day posts nothing', async () => {
  const lines = [];
  const d = await run({ argv: ['--dry-run'], now: T0, loader: async () => [], out: (m) => lines.push(m) });
  assert.equal(d.empty, true);
  assert.match(lines.join('\n'), /no new student-suitable/);
});

test('--dry-run prints the message and reads rows through the injected loader', async () => {
  const lines = []; let asked = null;
  await run({ argv: ['--dry-run'], now: T0, loader: async (w) => { asked = w; return [row(1, 2)]; }, out: (m) => lines.push(m) });
  assert.equal(asked.until.toISOString(), T0.toISOString());
  assert.equal(asked.since.toISOString(), new Date(T0.getTime() - 24 * H).toISOString());
  assert.match(lines.join('\n'), /DRY RUN/);
  assert.match(lines.join('\n'), /steppeup\.ai\/job\/1/);
});

test('real posting requires DIGEST_BOT_TOKEN and is never the default', async () => {
  await assert.rejects(run({ argv: ['--post'], env: {}, now: T0, loader: async () => [row(1, 2)], out: () => {} }), /DIGEST_BOT_TOKEN is not set/);
  await assert.rejects(sendTelegram('x', { env: {} }), /DIGEST_BOT_TOKEN is not set/);
  // without --post nothing is sent even if a sender is wired
  let sent = 0;
  await run({ argv: [], env: { DIGEST_BOT_TOKEN: 'x' }, now: T0, loader: async () => [row(1, 2)], sender: async () => { sent++; }, out: () => {} });
  assert.equal(sent, 0);
  // --dry-run wins over --post
  await run({ argv: ['--post', '--dry-run'], env: { DIGEST_BOT_TOKEN: 'x' }, now: T0, loader: async () => [row(1, 2)], sender: async () => { sent++; }, out: () => {} });
  assert.equal(sent, 0);
  // with the token and --post the sender gets the text; the token is not in the output
  const out = [];
  await run({ argv: ['--post'], env: { DIGEST_BOT_TOKEN: 'SECRET_TOKEN' }, now: T0, loader: async () => [row(1, 2)], sender: async (t) => { sent++; assert.match(t, /job\/1/); }, out: (m) => out.push(m) });
  assert.equal(sent, 1);
  assert.ok(!out.join('\n').includes('SECRET_TOKEN'));
});

test('sendTelegram posts to the channel with the bot token (fake fetch)', async () => {
  let call;
  await sendTelegram('hello', { env: { DIGEST_BOT_TOKEN: 'tok' }, fetchImpl: async (url, init) => { call = { url, body: JSON.parse(init.body) }; return { ok: true, status: 200 }; } });
  assert.match(call.url, /api\.telegram\.org\/bottok\/sendMessage/);
  assert.equal(call.body.chat_id, '@steppeup');
  assert.equal(call.body.parse_mode, 'HTML');
});

test('selectRows is half-open: a job at the lower bound is in, at the upper bound is out', () => {
  const since = new Date('2026-11-16T04:00:00Z'), until = new Date('2026-11-17T04:00:00Z');
  const rows = [row(1, 24), row(2, 0)];
  assert.deepEqual(selectRows(rows, { since, until }).map((r) => r.id), [1]);
});
