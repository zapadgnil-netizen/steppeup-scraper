const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { parseChannelHtml } = require('../telegram/fetcher');
const { resolveApply } = require('../telegram/apply');

const html = fs.readFileSync(path.join(__dirname, 'fixtures', 'tg-inline-buttons.html'), 'utf8');

test('fetcher keeps anchor labels, inline buttons and the preview card', () => {
  const [post] = parseChannelHtml(html, 'examplecareers');
  assert.equal(post.msgId, '101');
  assert.equal(post.postUrl, 'https://t.me/examplecareers/101');
  assert.ok(post.textLinks.some((l) => l.href === 'mailto:hr@example.kz' && l.label === 'hr@example.kz'));
  assert.deepEqual(post.buttons.map((b) => [b.href, b.label]), [
    ['https://example.kz/apply/42', 'Откликнуться'],
    ['https://t.me/examplecareers', 'Наш канал'],
  ]);
  assert.equal(post.preview, 'https://example.kz/careers/marketing-intern');
  // legacy field: every href, in order
  assert.ok(post.links.includes('https://example.kz/apply/42'));
});

test('router picks the inline "Откликнуться" button over mail and preview', () => {
  const [post] = parseChannelHtml(html, 'examplecareers');
  const r = resolveApply(post);
  assert.equal(r.apply_url, 'https://example.kz/apply/42');
  assert.equal(r.source_type, 'site');
  // the channel link, the hashtag and the channel-name button are never candidates
  assert.ok(!r.candidates.some((c) => /t\.me\/examplecareers/.test(c.apply_url)));
});
