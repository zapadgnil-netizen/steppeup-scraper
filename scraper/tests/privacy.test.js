// The repo is public: saved fixtures must not carry a real person's contact.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');
const { CHANNELS_ALL } = require('../telegram/channels');

const FIXTURES = ['tg-almaty_rabota.html', 'tg-inline-buttons.html', 'tg-kimepcareercenter.html'];
const PUBLIC = new Set(CHANNELS_ALL.map((c) => c.username.toLowerCase()));
for (const c of CHANNELS_ALL) for (const h of c.footerHandles || []) PUBLIC.add(String(h).replace(/^@/, '').toLowerCase());

for (const f of FIXTURES) {
  test(`${f}: only invented contacts (phones 000, example.* mails/handles)`, () => {
    const $ = cheerio.load(fs.readFileSync(path.join(__dirname, 'fixtures', f), 'utf8'));
    const texts = [];
    $('.tgme_widget_message_text, .tgme_widget_message_inline_button').each((_, el) => texts.push($(el).text()));
    $('a').each((_, a) => texts.push($(a).attr('href') || ''));
    const all = texts.join('\n');
    for (const m of all.matchAll(/\+?\d[\d\s().-]{8,}\d/g)) {
      const d = m[0].replace(/\D/g, '');
      if (d.length < 10 || d.length > 15) continue;
      if (/^\d{4,7}\s*-\s*\d{4,7}$/.test(m[0])) continue; // salary range
      if (/^\d+$/.test(m[0]) && /\/|vacanc|_R-/i.test(all.slice(Math.max(0, m.index - 30), m.index))) continue; // ids inside URLs
      assert.match(d, /0{6,}/, `phone-like value in ${f}: ${m[0].slice(0, 4)}…`);
    }
    for (const m of all.matchAll(/[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)/g)) assert.match(m[1], /^example\./i, `email domain in ${f}`);
    for (const m of all.matchAll(/(?<![\w@.\/])@([A-Za-z][A-Za-z0-9_]{3,})/g)) {
      assert.ok(/^example/i.test(m[1]) || PUBLIC.has(m[1].toLowerCase()), `handle @${m[1].slice(0, 3)}… in ${f}`);
    }
  });
}
