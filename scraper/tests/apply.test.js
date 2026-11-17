/**
 * Apply router tests. Every contact here is invented (+7 700 000 00 00,
 * hr@example.kz, @example_hr) but the post SHAPES are the real ones measured on
 * 346 vacancies from 21 channels: channel footer links next to a plain-text
 * contact, anchor text that hides the real href, malformed e-mail auto-links.
 */

const test = require('node:test');
const assert = require('node:assert');
const { resolveApply, rankCandidates, normalizePhone } = require('../telegram/apply');

const post = (over) => ({
  channel: 'jobkz_1', msgId: '1', postUrl: 'https://t.me/jobkz_1/1',
  text: 'Вакансия: Менеджер\nОбязанности: продажи', textLinks: [], buttons: [], preview: null, ...over,
});
const FOOTER = [
  { href: 'http://t.me/jobkz_1', label: 't.me/jobkz_1' },
  { href: 'http://t.me/jobkz_cv', label: 't.me/jobkz_cv' },
];

test('channel footer links plus a plain-text HR email resolve to the email', () => {
  const r = resolveApply(post({ text: 'Вакансия: Менеджер\nРезюме: hr@example.kz\nt.me/jobkz_1\nt.me/jobkz_cv', textLinks: FOOTER }));
  assert.deepEqual([r.apply_url, r.source_type], ['mailto:hr@example.kz', 'email']);
});

test('"Резюме отправлять на WhatsApp" resolves to wa.me', () => {
  const r = resolveApply(post({ text: 'Менеджер\nРезюме отправлять на WhatsApp: +7 700 000 00 00', textLinks: FOOTER }));
  assert.deepEqual([r.apply_url, r.source_type], ['https://wa.me/77000000000', 'whatsapp']);
});

test('cyrillic WhatsApp spellings count as a WhatsApp cue', () => {
  for (const cue of ['ватсап', 'Ватсап', 'уатсап', 'WA', 'whatsapp']) {
    const r = resolveApply(post({ text: `Менеджер\nПишите в ${cue} 8 701 000 00 00` }));
    assert.equal(r.source_type, 'whatsapp', cue);
    assert.equal(r.apply_url, 'https://wa.me/77010000000', cue);
  }
});

test('a phone without a WhatsApp cue becomes tel:', () => {
  const r = resolveApply(post({ text: 'Менеджер\nТел.: 87010000000' }));
  assert.deepEqual([r.apply_url, r.source_type], ['tel:+77010000000', 'phone']);
});

test('phones are normalised from every Kazakhstan spelling', () => {
  for (const raw of ['+7 700 000 00 00', '8 700 000 00 00', '87000000000', '+7(700)000-00-00', '7 700 000 00 00']) {
    assert.equal(normalizePhone(raw), '77000000000', raw);
  }
  assert.equal(normalizePhone('+7 (7172) 00-00-00'), '77172000000');
  assert.equal(normalizePhone('250 000 - 300 000'), null);
});

test('salary ranges and dates are not mistaken for phones', () => {
  const r = resolveApply(post({ text: 'Менеджер\nЗарплата 250 000 - 300 000 тг\nДо 15.11.2026' }));
  assert.equal(r.source_type, 'telegram_post');
});

test('a plain WhatsApp link is normalised to https://wa.me/<digits>', () => {
  const r = resolveApply(post({ textLinks: [{ href: 'http://wa.me/+77000000000', label: 'wa.me/+77000000000' }] }));
  assert.deepEqual([r.apply_url, r.source_type], ['https://wa.me/77000000000', 'whatsapp']);
  const r2 = resolveApply(post({ textLinks: [{ href: 'https://api.whatsapp.com/send?phone=77000000000&text=hi', label: 'link' }] }));
  assert.equal(r2.apply_url, 'https://wa.me/77000000000');
});

test('employer home page loses to a forms.gle link', () => {
  const r = resolveApply(post({
    text: 'Менеджер\nСайт компании: https://example.kz\nАнкета: https://forms.gle/AbCd',
    textLinks: [{ href: 'https://example.kz/', label: 'https://example.kz' }, { href: 'https://forms.gle/AbCd', label: 'https://forms.gle/AbCd' }, ...FOOTER],
  }));
  assert.deepEqual([r.apply_url, r.source_type], ['https://forms.gle/AbCd', 'form']);
});

test('the href is used, not the anchor label', () => {
  const r = resolveApply(post({
    text: 'Менеджер\nПодать заявку',
    textLinks: [{ href: 'https://docs.google.com/forms/d/e/abc/viewform', label: 'Подать заявку' }],
  }));
  assert.equal(r.apply_url, 'https://docs.google.com/forms/d/e/abc/viewform');
  assert.equal(r.source_type, 'form');
});

test('a specific vacancy page beats the employer home page', () => {
  const r = resolveApply(post({
    text: 'Менеджер\nhttps://example.kz/ https://example.kz/careers/intern-1',
    textLinks: [{ href: 'https://example.kz/', label: 'example.kz' }, { href: 'https://example.kz/careers/intern-1', label: 'link' }],
  }));
  assert.equal(r.apply_url, 'https://example.kz/careers/intern-1');
  assert.equal(r.source_type, 'site');
});

test('an HR email in the text beats a generic site link', () => {
  const r = resolveApply(post({
    text: 'Менеджер\nО компании: https://example.kz\nРезюме направлять на hr@example.kz',
    textLinks: [{ href: 'https://example.kz/', label: 'https://example.kz' }],
  }));
  assert.equal(r.apply_url, 'mailto:hr@example.kz');
});

test('a post whose only link is t.me/addlist resolves to the post itself', () => {
  const r = resolveApply(post({
    text: 'Менеджер\nПодписывайся на папку',
    textLinks: [{ href: 'https://t.me/addlist/AbCdEf', label: 'папка' }, ...FOOTER],
  }));
  assert.deepEqual([r.apply_url, r.source_type], ['https://t.me/jobkz_1/1', 'telegram_post']);
});

test('never choose: own channel, invites, folders, channel messages, hashtags, footer handles', () => {
  const links = [
    'https://t.me/jobkz_1', 'http://t.me/jobkz_1', 'https://t.me/jobkz_cv', 'https://t.me/+AbCdEfGh', 'https://t.me/joinchat/AbCd',
    'https://t.me/addlist/AbCd', 'https://t.me/s/jobkz_1', 'https://t.me/otherchannel/123', '?q=%23engineering', 'https://t.me/c/123/45',
  ].map((href) => ({ href, label: href }));
  const r = resolveApply(post({ text: 'Менеджер\n@jobkz_1 @jobkz_cv', textLinks: links }));
  assert.equal(r.source_type, 'telegram_post');
  assert.equal(r.candidates.length, 0);
});

test('malformed e-mail auto-links are emails', () => {
  const r = resolveApply(post({ text: 'Менеджер\nE-mail:someone@example.kz', textLinks: [{ href: 'http://E-mail:someone@example.kz/', label: 'E-mail:someone@example.kz' }] }));
  assert.deepEqual([r.apply_url, r.source_type], ['mailto:someone@example.kz', 'email']);
});

test('mailto links keep only the address', () => {
  const r = resolveApply(post({ textLinks: [{ href: 'mailto:HR@Example.kz?subject=CV', label: 'hr' }] }));
  assert.equal(r.apply_url, 'mailto:hr@example.kz');
});

test('an HR @username becomes a t.me DM link, a bot becomes telegram_bot', () => {
  const dm = resolveApply(post({ text: 'Менеджер\nРезюме писать @example_hr' }));
  assert.deepEqual([dm.apply_url, dm.source_type], ['https://t.me/example_hr', 'telegram_dm']);
  const bot = resolveApply(post({ text: 'Менеджер\nОтклик через бота @example_jobs_bot' }));
  assert.deepEqual([bot.apply_url, bot.source_type], ['https://t.me/example_jobs_bot', 'telegram_bot']);
});

test('the @ in an e-mail address is not a username', () => {
  const c = rankCandidates(post({ text: 'Менеджер\nhr@example.kz' }));
  assert.deepEqual(c.map((x) => x.kind), ['email']);
});

test('inline URL buttons are candidates', () => {
  const r = resolveApply(post({ text: 'Менеджер', buttons: [{ href: 'https://example.kz/apply/42', label: 'Откликнуться' }] }));
  assert.deepEqual([r.apply_url, r.source_type], ['https://example.kz/apply/42', 'site']);
});

test('the link preview card is a last-resort candidate', () => {
  const r = resolveApply(post({ text: 'Менеджер', preview: 'https://example.kz/jobs/42' }));
  assert.equal(r.apply_url, 'https://example.kz/jobs/42');
});

test('http links are upgraded to https; tracking params dropped', () => {
  const r = resolveApply(post({ textLinks: [{ href: 'http://example.kz/jobs/42?utm_source=tg&id=7', label: 'x' }] }));
  assert.equal(r.apply_url, 'https://example.kz/jobs/42?id=7');
});

test('a post offering nothing falls back to the post URL', () => {
  const r = resolveApply(post({ text: 'Менеджер, звоните' }));
  assert.deepEqual([r.apply_url, r.source_type], ['https://t.me/jobkz_1/1', 'telegram_post']);
});

test('social profiles and resume boards are not apply targets', () => {
  const r = resolveApply(post({ textLinks: [
    { href: 'https://www.instagram.com/example', label: 'insta' },
    { href: 'https://hh.kz/applicant/resumes', label: 'resumes' },
  ] }));
  assert.equal(r.source_type, 'telegram_post');
});

test('legacy posts that only carry a links[] array still work', () => {
  const r = resolveApply(post({ links: ['http://t.me/jobkz_1', 'https://forms.gle/x1'] }));
  assert.deepEqual([r.apply_url, r.source_type], ['https://forms.gle/x1', 'form']);
});

test('anchors that promote the channel (ad contact, sister groups) are not candidates', () => {
  const r = resolveApply(post({
    channel: 'almatyfoodwork',
    text: 'Требуются повара\nПо всем вопросам: 8 701 000 00 00\nВыложить вакансию\nВ группу Работа Алматы',
    textLinks: [{ href: 'https://t.me/example_ads', label: 'Выложить вакансию' }, { href: 'https://t.me/example_group', label: 'В группу Работа Алматы' }],
  }));
  assert.deepEqual([r.apply_url, r.source_type], ['tel:+77010000000', 'phone']);
});

test('a career-centre inquiry block ranks below the employer route', () => {
  const r = resolveApply(post({
    channel: 'kimepcareercenter',
    text: 'POSITION\nCustomer Support\nДля отклика заполни форму https://jobs.example.kz/apply/1\n\nPlease send all inquiries to:\nCareer Center\nTel +7 701 000 00 00\ne-mail:career@example.kz',
    textLinks: [{ href: 'https://jobs.example.kz/apply/1', label: 'https://jobs.example.kz/apply/1' }, { href: 'http://e-mail:career@example.kz/', label: 'e-mail:career@example.kz' }],
  }));
  assert.equal(r.apply_url, 'https://jobs.example.kz/apply/1');
});

test('the career-centre contact is still used when it is all the post offers', () => {
  const r = resolveApply(post({ text: 'Стажёр\nPlease send all inquiries to:\nCareer Center\ne-mail: career@example.kz' }));
  assert.equal(r.apply_url, 'mailto:career@example.kz');
});

test('HTML-escaped ampersands in hrefs are decoded', () => {
  const r = resolveApply(post({ textLinks: [{ href: 'https://example.kz/jobs/42?id=7&amp;utm_medium=x', label: 'x' }] }));
  assert.equal(r.apply_url, 'https://example.kz/jobs/42?id=7');
});

test('a Moscow number is not a Kazakhstan phone', () => {
  const r = resolveApply(post({ text: 'Менеджер\nКонтакты: +7 495 000 00 00' }));
  assert.equal(r.source_type, 'telegram_post');
});

test('a WhatsApp link printed without the country code is completed and merged with the plain phone', () => {
  const r = resolveApply(post({ text: 'Продавец\nОбращаться: 8 701 000 00 00\nwa.me/7010000000', textLinks: [{ href: 'https://wa.me/7010000000', label: 'wa.me/7010000000' }] }));
  assert.deepEqual([r.apply_url, r.source_type], ['https://wa.me/77010000000', 'whatsapp']);
  assert.equal(r.candidates.length, 1, 'link and plain-text phone are one candidate');
});
