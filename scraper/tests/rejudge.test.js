/**
 * One-time "re-judge with Jev" mode — fake DB rows, fake Jev client, no network.
 * Default runs keep stored fields; --rejudge overwrites them, but only when Jev
 * is really available, and only deactivates stored telegram rows Jev now rejects.
 */
const test = require('node:test');
const assert = require('node:assert');
const { createJudge } = require('../telegram/jev');
const { scrape } = require('../sources/telegram');
const { createDb } = require('../lib/db');
const filter = require('../lib/filter');
const normalize = require('../lib/normalize');

const fakeSdk = { choice: (q, options) => ({ type: 'choice', q, options }), noul: (q) => ({ type: 'noul', q }), TypeSafeClient: class {} };
const POST = {
  channel: 'kimepcareercenter', msgId: '7', postUrl: 'https://t.me/kimepcareercenter/7', dateISO: new Date().toISOString(),
  text: 'Job Vacancies\n\nPOSITION\nСтажер в отдел маркетинга\n\nCOMPANY\nExample Bank\n\nLOCATION\nAlmaty\n\nОбязанности: помощь. Требования: студент.\nРезюме: hr@example.kz, WhatsApp +7 700 000 00 00',
  textLinks: [], buttons: [], preview: null,
};
const answers = (over = {}) => ({
  isVacancy: { noul: 0.95 }, studentFit: { noul: 0.9 }, kzRelevant: { noul: 0.97 },
  applyTarget: { choice: 'c0' }, ...over,
});
const fakeClient = (fn) => ({ calls: [], async systemOne(req) { this.calls.push(req); return fn(req); } });
const STORED = { source_id: 'tg_kimepcareercenter_7', source_channel: 'kimepcareercenter', title: 'Специалистов по направлениям: инженер-электрик', company: 'KIMEP Career Center', apply_url: 'https://t.me/kimepcareercenter/7', source_type: 'telegram_post' };

const ctxFor = (over = {}) => {
  const logs = [];
  const rejudgeState = { deactivate: [] };
  return { logs, rejudgeState, ctx: {
    log: (m) => logs.push(m), filter, normalize, limits: { maxAgeDays: 21 },
    channels: [{ username: 'kimepcareercenter', label: 'KIMEP Career Center', kind: 'career' }],
    fetchChannel: async () => [POST], sleep: async () => {},
    loadExisting: async () => [STORED], rejudgeState, ...over,
  } };
};
const jevJudge = (fn) => { const client = fakeClient(fn); return createJudge({ env: { TYPESAFE_API_KEY: 'k' }, client, sdk: fakeSdk }).then((judge) => ({ judge, client })); };

test('default run: stored fields are kept, no Jev call, nothing deactivated', async () => {
  const { judge, client } = await jevJudge(() => ({ answers: answers() }));
  const { ctx, rejudgeState } = ctxFor({ judge });
  const r = await scrape(ctx);
  assert.equal(client.calls.length, 0);
  assert.equal(r.jobs[0].title, STORED.title);
  assert.equal(r.jobs[0].company, 'KIMEP Career Center');
  assert.deepEqual(rejudgeState.deactivate, []);
});

test('--rejudge with Jev: fresh title, company and apply overwrite the stored ones', async () => {
  const { judge, client } = await jevJudge(() => ({ answers: answers() }));
  const { ctx } = ctxFor({ judge, rejudge: true });
  const r = await scrape(ctx);
  assert.equal(client.calls.length, 1);
  assert.equal(r.jobs.length, 1);
  assert.equal(r.jobs[0].title, 'Стажер в отдел маркетинга');
  assert.equal(r.jobs[0].company, 'Example Bank');
  assert.notEqual(r.jobs[0].apply_url, STORED.apply_url);
  assert.ok(r.jobs[0].source_type && r.jobs[0].source_type !== 'telegram_post');
});

test('--rejudge with Jev: a failed Jev call keeps the stored fields instead of rule output', async () => {
  const { judge } = await jevJudge(() => { throw new Error('boom'); });
  const { ctx } = ctxFor({ judge, rejudge: true });
  const r = await scrape(ctx);
  assert.equal(r.jobs[0].title, STORED.title);
  assert.equal(r.jobs[0].apply_url, STORED.apply_url);
});

test('--rejudge without Jev: refuses, logs why, returns nothing, deactivates nothing', async () => {
  const judge = await createJudge({ env: {}, sdk: fakeSdk });
  const { ctx, logs, rejudgeState } = ctxFor({ judge, rejudge: true });
  let fetched = 0;
  ctx.fetchChannel = async () => { fetched++; return [POST]; };
  const r = await scrape(ctx);
  assert.deepEqual(r.jobs, []);
  assert.equal(fetched, 0);
  assert.equal(rejudgeState.refused, true);
  assert.deepEqual(rejudgeState.deactivate, []);
  assert.ok(logs.some((l) => /REJUDGE REFUSED.*TYPESAFE_API_KEY is not set/.test(l)));
});

const GENDERED = { ...POST, text: 'Job Vacancies\n\nPOSITION\nПродавец-кассир, ДЕВУШКА, до 35 лет\n\nCOMPANY\nExample Shop\n\nLOCATION\nAlmaty\n\nОбязанности: касса. Резюме: WhatsApp +7 700 000 00 00' };

test('--rejudge: a stored row is retired only when the rules reject AND Jev is very sure; default runs never do', async () => {
  const sure = () => ({ answers: answers({ studentFit: { noul: 0.05 } }) });
  const on = await jevJudge(sure);
  const a = ctxFor({ judge: on.judge, rejudge: true, fetchChannel: async () => [GENDERED] });
  const ra = await scrape(a.ctx);
  assert.equal(ra.jobs.length, 0);
  assert.deepEqual(a.rejudgeState.deactivate, ['tg_kimepcareercenter_7']);
  assert.equal(ra.stats.rejudge.deactivated, 1);
  assert.equal(ra.stats.jev.decisions[0].act, 'deactivate');

  // rules reject but Jev is only mildly negative: the live row is kept
  const mild = await jevJudge(() => ({ answers: answers({ studentFit: { noul: 0.25 } }) }));
  const m = ctxFor({ judge: mild.judge, rejudge: true, fetchChannel: async () => [GENDERED] });
  await scrape(m.ctx);
  assert.deepEqual(m.rejudgeState.deactivate, []);

  // Jev very sure but the rules back the post (clean student post, career channel): kept
  const lone = await jevJudge(() => ({ answers: answers({ studentFit: { noul: 0.02 } }) }));
  const c = ctxFor({ judge: lone.judge, rejudge: true });
  const rc = await scrape(c.ctx);
  assert.deepEqual(c.rejudgeState.deactivate, []);
  assert.equal(rc.stats.jev.decisions[0].act, 'protect');

  const off = await jevJudge(sure);
  const b = ctxFor({ judge: off.judge, fetchChannel: async () => [GENDERED] });
  await scrape(b.ctx);
  assert.deepEqual(b.rejudgeState.deactivate, []);
});

test('--rejudge: a rejected post with no stored row, or a stored row not fetched this run, is not deactivated', async () => {
  const reject = () => ({ answers: answers({ isVacancy: { noul: 0.1 } }) });
  const { judge } = await jevJudge(reject);
  const a = ctxFor({ judge, rejudge: true, loadExisting: async () => [{ ...STORED, source_id: 'tg_kimepcareercenter_999' }] });
  await scrape(a.ctx);
  assert.deepEqual(a.rejudgeState.deactivate, []);
});

// ── db.deactivateRows: scoped to one source, active rows only ───────────────
test('db.deactivateRows only touches the named source and ids', async () => {
  const calls = [];
  const q = (name) => { const o = { name, ops: [] }; const p = new Proxy(o, { get: (t, k) => (k === 'then' ? (f) => { calls.push(o.ops); return Promise.resolve({ data: [{ id: 1 }], error: null }).then(f); } : (...a) => { o.ops.push([k, ...a]); return p; }) }); return p; };
  const db = createDb({ client: { from: (t) => q(t) }, log: () => {} });
  const n = await db.deactivateRows('telegram_career', ['a', 'b']);
  assert.equal(n, 1);
  const ops = JSON.stringify(calls[0]);
  assert.match(ops, /"update",\{"status":"inactive"\}/);
  assert.match(ops, /"eq","source","telegram_career"/);
  assert.match(ops, /"eq","status","active"/);
  assert.match(ops, /"in","source_id",\["a","b"\]/);
  assert.equal(await db.deactivateRows('telegram_career', []), 0);
});
