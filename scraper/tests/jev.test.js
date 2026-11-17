/**
 * Jev integration — no network: a fake client and a fake SDK are injected.
 * The contract: with no key / no SDK / a failing API the scraper still finishes
 * on rules, and says so.
 */
const test = require('node:test');
const assert = require('node:assert');
const { createJudge, applyVerdict, buildRequest } = require('../telegram/jev');
const { CONFIDENT_NO } = require('../telegram/judge-config');
const { parsePost } = require('../telegram/parser');
const { scrape } = require('../sources/telegram');
const filter = require('../lib/filter');
const normalize = require('../lib/normalize');

const fakeSdk = { choice: (q, options) => ({ type: 'choice', q, options }), noul: (q) => ({ type: 'noul', q }), TypeSafeClient: class {} };
const NOW = new Date().toISOString();
const POST = {
  channel: 'kimepcareercenter', msgId: '7', postUrl: 'https://t.me/kimepcareercenter/7', dateISO: NOW,
  text: 'Job Vacancies\n\nPOSITION\nСтажер в отдел маркетинга\n\nCOMPANY\nExample Bank\n\nLOCATION\nAlmaty\n\nОбязанности: помощь. Требования: студент.\nРезюме: hr@example.kz, WhatsApp +7 700 000 00 00',
  textLinks: [], buttons: [], preview: null,
};
const parsed = () => parsePost(POST, { companyFallback: 'KIMEP Career Center' });

const answers = (over = {}) => ({
  isVacancy: { type: 'noul', noul: 0.95 }, studentFit: { type: 'noul', noul: 0.9 }, kzRelevant: { type: 'noul', noul: 0.97 },
  applyTarget: { type: 'choice', choice: 'c0', confidence: 0.8 }, ...over,
});
const fakeClient = (fn) => ({ calls: [], async systemOne(req) { this.calls.push(req); return fn(req); } });

test('no TYPESAFE_API_KEY → rules mode, says why, never calls anything', async () => {
  const j = await createJudge({ env: {}, sdk: fakeSdk });
  assert.equal(j.mode, 'rules');
  assert.match(j.reason, /TYPESAFE_API_KEY is not set/);
  assert.equal(await j.assess({}, {}), null);
});

test('SDK missing → rules mode', async () => {
  const j = await createJudge({ env: { TYPESAFE_API_KEY: 'apikey_x' }, loadSdk: async () => null });
  assert.equal(j.mode, 'rules');
  assert.match(j.reason, /sdk could not be loaded/i);
});

test('the request carries state candidates and typed questions', async () => {
  const p = parsed();
  const { state, questions } = buildRequest(fakeSdk, POST, p);
  assert.equal(state.channel, 'kimepcareercenter');
  assert.ok(state.candidates.length >= 2); // email + whatsapp
  assert.ok(state.post.length <= 3000);
  assert.deepEqual(Object.keys(questions).slice(0, 3), ['isVacancy', 'studentFit', 'kzRelevant']);
  assert.ok(questions.applyTarget.options.none);
});

test('Jev verdict is read, thresholds reject, choices override the rule pick', async () => {
  const client = fakeClient(() => ({ answers: answers() }));
  const j = await createJudge({ env: { TYPESAFE_API_KEY: 'k' }, client, sdk: fakeSdk });
  const p = parsed();
  const rulesPick = p.apply_url;
  // choose the SECOND candidate to prove the override
  client.systemOne = async function (req) { this.calls.push(req); return { answers: answers({ applyTarget: { choice: 'c1' } }) }; };
  const v = await j.assess(POST, p);
  assert.equal(v.vacancy, 0.95);
  assert.equal(applyVerdict(p, v, j), null);
  assert.notEqual(p.apply_url, rulesPick);
  assert.equal(j.stats.jev, 1);
  assert.equal(j.stats.overrides.apply, 1);

  const bad = [
    [{ isVacancy: { noul: CONFIDENT_NO.vacancy - 0.01 } }, 'jev-not-vacancy'],
    [{ studentFit: { noul: CONFIDENT_NO.studentFit - 0.01 } }, 'jev-not-student'],
    [{ kzRelevant: { noul: CONFIDENT_NO.kazakhstan - 0.01 } }, 'jev-not-kz'],
  ];
  for (const [over, reason] of bad) {
    client.systemOne = async () => ({ answers: answers(over) });
    const verdict = await j.assess(POST, parsed());
    // very confident "no" cuts even when the rules back the post
    assert.equal(applyVerdict(parsed(), verdict, j, { support: { vacancy: 'parser', student: 'kw:студент', kz: 'city' } }), reason);
  }
});

test('Jev can choose the title line and the employer among extracted candidates', () => {
  const p = parsed();
  p._candidates = { titles: ['Стажер в отдел маркетинга', 'Customer Support'], companies: ['Example Bank', 'Other LLP'] };
  assert.equal(applyVerdict(p, { vacancy: 1, studentFit: 1, kazakhstan: 1, titleId: 't1', employerId: 'e1' }, null), null);
  assert.equal(p.title, 'Customer Support');
  assert.equal(p.company, 'Other LLP');
});

test('"none of the candidates" keeps a cue-backed rule pick, otherwise falls back to the post URL', () => {
  const p = parsed();
  const cued = p._apply.chosen;
  assert.ok(cued.cue > 0);
  applyVerdict(p, { vacancy: 1, studentFit: 1, kazakhstan: 1, applyId: 'none' }, null);
  assert.notEqual(p.source_type, 'telegram_post');
  const q = parsePost({ ...POST, text: POST.text.replace(/Резюме:.*/, 'Контакт: hr@example.kz') }, {});
  q._apply.chosen.cue = 0;
  applyVerdict(q, { vacancy: 1, studentFit: 1, kazakhstan: 1, applyId: 'none' }, null);
  assert.deepEqual([q.apply_url, q.source_type], [q.source_url, 'telegram_post']);
});

test('API failures fall back to rules, are counted, and stop after 3 in a row; the key never leaks', async () => {
  const SECRET = 'apikey_SECRET123456';
  const client = fakeClient(() => { throw new Error(`401 invalid key ${SECRET}`); });
  const lines = [];
  const j = await createJudge({ env: { TYPESAFE_API_KEY: SECRET }, client, sdk: fakeSdk, log: (m) => lines.push(m) });
  for (let i = 0; i < 5; i++) assert.equal(await j.assess(POST, parsed()), null);
  assert.equal(client.calls.length, 3, 'stops asking after 3 consecutive failures');
  assert.equal(j.stats.failed, 3);
  assert.equal(j.stats.rules, 5);
  const everything = JSON.stringify([j.reason, j.firstError, lines, j.stats]);
  assert.ok(!everything.includes(SECRET), 'key must not appear in logs or stats');
  assert.match(j.reason, /disabled after 3 failed calls/);
});

// ── end to end through sources/telegram.js, still without network ───────────
const ctxFor = (over = {}) => {
  const logs = [];
  return { logs, ctx: {
    log: (m) => logs.push(m), filter, normalize, limits: { maxAgeDays: 21 },
    channels: [{ username: 'kimepcareercenter', label: 'KIMEP Career Center', kind: 'career' }],
    fetchChannel: async () => [POST], sleep: async () => {}, ...over,
  } };
};

test('scrape without a key: finishes on rules and the log and stats say so', async () => {
  const { ctx, logs } = ctxFor({ judge: await createJudge({ env: {}, sdk: fakeSdk }) });
  const r = await scrape(ctx);
  assert.equal(r.jobs.length, 1);
  assert.equal(r.stats.jev.mode, 'rules');
  assert.equal(r.stats.jev.judgedByRules, 1);
  assert.equal(r.stats.jev.judgedByJev, 0);
  assert.ok(logs.some((l) => /RULES ONLY/.test(l)));
  assert.ok(r.notes.some((n) => /Jev not used/.test(n)));
});

test('scrape with Jev: verdict rejections are counted per reason', async () => {
  const client = fakeClient(() => ({ answers: answers({ isVacancy: { noul: 0.1 } }) }));
  const judge = await createJudge({ env: { TYPESAFE_API_KEY: 'k' }, client, sdk: fakeSdk });
  const { ctx } = ctxFor({ judge });
  const r = await scrape(ctx);
  assert.equal(r.jobs.length, 0);
  assert.equal(r.stats.rejects['jev-not-vacancy'], 1);
  assert.equal(r.stats.jev.judgedByJev, 1);
});

test('scrape: a row already stored by the router keeps its fields and costs no Jev call', async () => {
  const client = fakeClient(() => ({ answers: answers() }));
  const judge = await createJudge({ env: { TYPESAFE_API_KEY: 'k' }, client, sdk: fakeSdk });
  const { ctx } = ctxFor({
    judge,
    loadExisting: async () => [{ source_id: 'tg_kimepcareercenter_7', source_channel: 'kimepcareercenter', title: 'Стажер в отдел маркетинга', company: 'Example Bank', apply_url: 'tel:+77000000000', source_type: 'phone' }],
  });
  const r = await scrape(ctx);
  assert.equal(client.calls.length, 0);
  assert.equal(r.jobs.length, 1);
  assert.equal(r.jobs[0].apply_url, 'tel:+77000000000');
});
