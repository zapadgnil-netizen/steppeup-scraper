/**
 * Jev gate regressions — built from the SHAPES of real posts the first --rejudge
 * run wrongly cut (all contacts, names and addresses are invented). Fake Jev
 * client, no network. Scores are ones observed from the live model: the OLD
 * student-fit wording gave 0.16 / 0.28 / 0.03 to project, SMM and 1C posts and
 * 0.14-0.37 to shift/service posts; the new wording scores them ~0.9.
 */
const test = require('node:test');
const assert = require('node:assert');
const { createJudge, decideVerdict, buildRequest } = require('../telegram/jev');
const cfg = require('../telegram/judge-config');
const { scrape } = require('../sources/telegram');
const { channelByUsername } = require('../telegram/channels');
const filter = require('../lib/filter');
const normalize = require('../lib/normalize');

const fakeSdk = { choice: (q, options) => ({ type: 'choice', q, options }), noul: (q, criteria) => ({ type: 'noul', q, criteria }), TypeSafeClient: class {} };
const NOW = () => new Date().toISOString();
const post = (channel, msgId, text) => ({ channel, msgId: String(msgId), postUrl: `https://t.me/${channel}/${msgId}`, dateISO: NOW(), text, textLinks: [], buttons: [], preview: null });

const UIUX = post('studentworkz', 877, '📌🔥 Горячая вакансия\n\nИщем UI/UX дизайнера на проект | ExampleEdu\n\nExampleEdu — образовательная онлайн-платформа. Ищем UI/UX дизайнера для интерфейсов платформы.\nЗадачи: — user flow, wireframes — прототипы в Figma\nЧто важно: — портфолио, уверенная Figma — опыт в EdTech — плюс\n\nФормат: проектная работа, удалённо, оплата по договорённости.\nПришлите портфолио: @example_edu_hr');
const SMM = post('studentworkz', 883, '📌 Вакансия\nВАКАНСИЯ | SMM-СПЕЦИАЛИСТ\nВ клининговую компанию Example Clean требуется креативный SMM-специалист!\nОбязанности:\nВедение Instagram и TikTok.\nСоздание контент-плана, Reels, Stories.\nТребования:\nОпыт работы в SMM.\nУмение снимать и монтировать контент.\n📍 Город: Астана\n💰 Заработная плата: по результатам собеседования.\nРезюме: @example_smm_hr');
const ANALYST = post('studentworkz', 880, '📌 Вакансия\n\nАналитик 1С\n\nАлматы, пр. Примерный, 1\nГрафик: 5/2, 09:00–18:00\nФормат: офис / гибрид\n\nОбязанности:\n– Сбор и анализ требований\n– Тестирование решений и взаимодействие с разработчиками\n– Обучение пользователей\n\nТребования:\n– Знание конфигураций 1С\n– Умение анализировать бизнес-процессы\n\nУсловия:\n– Наставники и обучение в команде\n\nДля связи: @example_1c_hr');
const WAITER = post('almatyfoodwork', 1424, 'Вакансия: Официант\n\n📍 Город: Алматы, ул. Примерная 5\n\nВ кафе EXAMPLE\n\nГрафик 2/2 с 11:00 до 23:00\n\n💰 оклад + % от личной кассы\n\nПитание на смене\n\n📞 Контакт:\n+7 700 000 00 00');
const COURIER = post('almatyrabota1', 21380, 'ТРЕБУЕТСЯ КУРЬЕР В КОНДИТЕРСКУЮ\n\nУсловия:\n\n- График работы: 2/2, с 09:00 до 20:00\n- Оплата: 15 000 ₸ за смену\n- Обед за счёт компании\n\n📍 Адрес: г. Алматы, ул. Примерная, 7\n\n📞 По вопросам вакансии: +7 700 000 00 00\nwa.me/77000000000');
const GIRL35 = post('almatyrabota1', 21375, 'Продавец-кассир, ДЕВУШКА, до 35 лет\n\nГрафик: 2/2, с 10:00 до 22:00\nОплата: 12 000 ₸ за смену\n📍 Алматы, ул. Примерная, 3\n\n📞 +7 700 000 00 00');
const EXP3 = post('almatyrabota1', 21390, 'Менеджер по продажам\n\nТребования:\n• Опыт от 3 лет в продажах\n• Знание CRM\n\nОплата: 300 000 ₸\n📍 Алматы\n\n📞 +7 700 000 00 00');
const CLIENTS = post('almaty_rabota', 14755, 'Менеджер по работе с клиентами\n\nОбязанности:\n• Консультирование клиентов\n• Ведение базы\n\nГрафик: 5/2\nОплата: 250 000 ₸\n📍 Алматы\n\n📞 +7 700 000 00 00');

const verdict = (v, s, k = 0.97) => ({ answers: { isVacancy: { noul: v }, studentFit: { noul: s }, kzRelevant: { noul: k }, applyTarget: { choice: 'none' } } });
const fakeClient = (byMsg) => ({ calls: [], async systemOne(req) { this.calls.push(req); const m = /./.exec(''); return byMsg(req); } });
const judgeWith = (fn) => { const client = fakeClient(fn); return createJudge({ env: { TYPESAFE_API_KEY: 'k' }, client, sdk: fakeSdk }).then((judge) => ({ judge, client })); };

async function run(posts, student, { rejudge = false, existing = [], judge } = {}) {
  const channel = channelByUsername(posts[0].channel);
  const logs = [];
  const rejudgeState = { deactivate: [] };
  const j = judge || (await judgeWith((req) => { const id = req.state.post; const hit = posts.find((p) => id.startsWith(p.text.slice(0, 20))); return verdict(0.98, student(hit)); })).judge;
  const r = await scrape({
    log: (m) => logs.push(m), filter, normalize, limits: { maxAgeDays: 21 }, channels: [channel], judge: j, rejudge, rejudgeState,
    fetchChannel: async () => posts, sleep: async () => {}, loadExisting: async () => existing,
  });
  return { r, logs, rejudgeState };
}

const titles = (r) => r.jobs.map((j) => j.title);

test('project UI/UX, SMM and 1C-analyst posts in a student channel are kept at the scores the OLD wording gave them', async () => {
  const scores = new Map([[UIUX, 0.16], [SMM, 0.28], [ANALYST, 0.2]]);
  const { r } = await run([UIUX, SMM, ANALYST], (p) => scores.get(p));
  assert.equal(r.jobs.length, 3, JSON.stringify(r.stats.rejects));
  const kept = r.stats.jev.decisions.filter((d) => d.act === 'keep');
  assert.ok(kept.some((d) => /student=0\.28<0\.3 kept: rules/.test(d.why)));
});

test('waiter and courier shift posts in a general Almaty channel are kept at observed low-middle scores', async () => {
  for (const [p, score] of [[WAITER, 0.37], [COURIER, 0.22]]) {
    const { r } = await run([p], () => score);
    assert.equal(r.jobs.length, 1, `${p.msgId}: ${JSON.stringify(r.stats.rejects)}`);
  }
});

test('Jev leaning "no" does not cut a post with no rule support only when it is not below the soft line', async () => {
  // no student/shift/part-time wording, general channel
  const keep = await run([CLIENTS], () => 0.35);
  assert.equal(keep.r.jobs.length, 1);
  const drop = await run([CLIENTS], () => 0.25);
  assert.equal(drop.r.jobs.length, 0);
  assert.equal(drop.r.stats.rejects['jev-not-student'], 1);
  assert.match(drop.r.stats.jev.decisions[0].why, /no rule support/);
});

test('Jev very sure (< CONFIDENT_NO) cuts even a post the rules back', async () => {
  const { r } = await run([UIUX], () => 0.05);
  assert.equal(r.jobs.length, 0);
  assert.equal(r.stats.jev.decisions[0].act, 'drop');
  assert.match(r.stats.jev.decisions[0].why, /confident/);
});

test('hard rules still drop gendered/age-limited and explicit-experience posts, with or without Jev', async () => {
  for (const p of [GIRL35, EXP3]) {
    const off = await run([p], () => 0.9, { judge: await createJudge({ env: {}, sdk: fakeSdk }) });
    assert.equal(off.r.jobs.length, 0, `rules only: ${p.msgId}`);
    const on = await run([p], () => 0.9);
    assert.equal(on.r.jobs.length, 0, `jev on: ${p.msgId}`);
  }
  assert.equal(filter.studentRejectReason('Курьер', 'Возраст: 28–45 лет, свой авто', []), 'age-gender-restricted');
  assert.equal(filter.studentRejectReason('Официант', 'Питание на смене. Не студенты!', []), 'excludes-students');
});

test('student signal ignores the channel-handle tag and counts shift / project / student-channel context', () => {
  assert.equal(filter.studentSignal('Менеджер', 'Офис 5/2', ['ch:studentworkz']), null);
  assert.match(filter.studentSignal('Официант', 'График 2/2', []), /kw:/);
  assert.match(filter.studentSignal('Менеджер', 'Офис 5/2', [], { kind: 'career' }), /channel:career/);
});

test('Jev sees the channel kind and audience in state', () => {
  const p = require('../telegram/parser').parsePost(WAITER, { companyFallback: 'x' });
  const general = buildRequest(fakeSdk, WAITER, p, { kind: 'general' });
  const career = buildRequest(fakeSdk, UIUX, p, { kind: 'career' });
  assert.match(general.state.channel_audience, /general city job board/);
  assert.match(career.state.channel_audience, /student job/);
  assert.match(general.questions.studentFit.q, /student or recent graduate/);
  assert.match(general.questions.studentFit.criteria.true, /waiter, courier/);
});

// ── re-judge protection and circuit breaker ─────────────────────────────────
const stored = (p) => ({ source_id: `tg_${p.channel}_${p.msgId}`, source_channel: p.channel, title: 'old', company: 'x', apply_url: p.postUrl, source_type: 'telegram_post' });

test('rejudge: a live row is NOT retired by Jev alone, even at a very low score', async () => {
  const { r, rejudgeState } = await run([ANALYST], () => 0.02, { rejudge: true, existing: [stored(ANALYST)] });
  assert.deepEqual(rejudgeState.deactivate, []);
  assert.equal(r.stats.jev.decisions[0].act, 'protect');
});

test('rejudge: a live row is NOT retired when Jev is only mildly negative, even if the rules reject', async () => {
  const { rejudgeState } = await run([GIRL35], () => 0.25, { rejudge: true, existing: [stored(GIRL35)] });
  assert.deepEqual(rejudgeState.deactivate, []);
});

test('rejudge: rules reject AND Jev very sure retires the row', async () => {
  const { r, rejudgeState } = await run([GIRL35], () => 0.07, { rejudge: true, existing: [stored(GIRL35), ...Array.from({ length: 9 }, (_, i) => ({ ...stored(GIRL35), source_id: `tg_other_${i}` }))] });
  assert.deepEqual(rejudgeState.deactivate, [stored(GIRL35).source_id]);
  assert.equal(r.stats.jev.decisions[0].act, 'deactivate');
  assert.ok(!r.stats.rejudge.breaker);
});

test('rejudge circuit breaker: retiring more than 15% of active rows retires NONE and says so', async () => {
  const posts = Array.from({ length: 6 }, (_, i) => post('almatyrabota1', 300 + i, `Продавец-кассир, ДЕВУШКА, до 35 лет\n\nГрафик 2/2\n📍 Алматы, ул. Примерная ${i}\n📞 +7 700 000 00 0${i}`));
  const existing = posts.map(stored).concat(Array.from({ length: 14 }, (_, i) => ({ ...stored(posts[0]), source_id: `tg_other_${i}` })));
  const { r, logs, rejudgeState } = await run(posts, () => 0.02, { rejudge: true, existing });
  assert.deepEqual(rejudgeState.deactivate, []);
  assert.deepEqual(rejudgeState.breaker, { wanted: 6, active: 20, allowed: 3 });
  assert.deepEqual(r.stats.rejudge.breaker, { wanted: 6, active: 20, allowed: 3 });
  assert.equal(r.stats.rejudge.deactivated, 0);
  assert.ok(r.notes.some((n) => /CIRCUIT BREAKER.*NONE/.test(n)));
  assert.ok(logs.some((l) => /!!!.*CIRCUIT BREAKER/.test(l)));
});

// ── debuggability ───────────────────────────────────────────────────────────
test('decision log is compact: capped, titles cut, no contacts', async () => {
  const many = Array.from({ length: 130 }, (_, i) => post('almatyrabota1', 500 + i, `Консультант по продажам ${i}\n\nКонсультирование клиентов\nГрафик: 5/2\n📍 Алматы\n📞 +7 700 000 00 00\nhr@example.kz @example_hr`));
  const { r } = await run(many, () => 0.2);
  const d = r.stats.jev.decisions;
  assert.equal(d.length, cfg.MAX_DECISIONS_LOGGED);
  assert.ok(r.stats.jev.decisionsTotal >= 130);
  for (const x of d) {
    assert.ok(x.t.length <= 60);
    assert.doesNotMatch(JSON.stringify(x), /@\w|\+7|\d{3}\s\d{2}\s\d{2}|example\.kz/);
    assert.deepEqual(Object.keys(x).sort(), ['act', 'ch', 'id', 't', 'v', 'why']);
  }
  assert.ok(JSON.stringify(d).length < 30000);
});

test('decideVerdict: soft zone with support keeps, confident always rejects', () => {
  const v = { vacancy: 0.9, studentFit: 0.2, kazakhstan: 0.9 };
  assert.equal(decideVerdict(v, { student: 'kw:смен' }).reject, null);
  assert.equal(decideVerdict(v, {}).reject, 'jev-not-student');
  assert.equal(decideVerdict({ ...v, studentFit: 0.1 }, { student: 'kw:смен' }).reject, 'jev-not-student');
  assert.equal(decideVerdict(null, {}).reject, null);
});
