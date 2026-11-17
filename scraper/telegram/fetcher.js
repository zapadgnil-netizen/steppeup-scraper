/**
 * Fetcher — the only module that talks to the network.
 *
 * Pulls the public web preview of a channel (https://t.me/s/<channel>), which
 * needs no API key and no auth, and extracts raw post records. Handles Telegram's
 * soft anti-scraping (occasional rate limits / challenges) with retries, delays,
 * and User-Agent rotation.
 *
 * Output: array of raw posts — { channel, msgId, postUrl, dateISO, text, links[],
 * textLinks[{href,label}], buttons[{href,label}], preview }
 * The parser turns each of these into a structured job; this module never
 * interprets job fields, it only acquires clean text + links.
 */

const fetch = require('node-fetch');
const cheerio = require('cheerio');

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0 Safari/537.36',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pickUA = () => USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];

// Raw HTML fetch with retry + backoff + UA rotation.
async function fetchHtml(url, { retries = 3, baseDelay = 1500 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': pickUA(),
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'ru-RU,ru;q=0.9,kk;q=0.8,en;q=0.7',
        },
        timeout: 15000,
      });
      if (res.status === 429 || res.status === 503) {
        // Rate-limited / challenged — back off and retry with a fresh UA.
        const wait = baseDelay * Math.pow(2, attempt);
        console.log(`[fetcher] ${res.status} on ${url} — backing off ${wait}ms`);
        await sleep(wait);
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (e) {
      lastErr = e;
      await sleep(baseDelay * Math.pow(2, attempt));
    }
  }
  throw lastErr || new Error('fetch failed');
}

// Pull the message text while preserving line breaks AND collecting every link
// found in the post: anchors in the body (href AND label — the label is often
// not the destination), inline URL buttons under the message
// (.tgme_widget_message_inline_button, e.g. "Откликнуться"), and the
// link-preview card. The apply router (telegram/apply.js) decides which of
// them is the application target; this module never ranks.
function extractMessage($, el) {
  const $msg = $(el);
  const $text = $msg.find('.tgme_widget_message_text').first();

  // Convert <br> to newlines so multi-line posts keep their structure.
  $text.find('br').replaceWith('\n');
  const text = $text.text().replace(/\u00a0/g, ' ').trim();

  const textLinks = [];
  $text.find('a').each((_, a) => {
    const href = $(a).attr('href');
    if (href) textLinks.push({ href, label: $(a).text().replace(/\s+/g, ' ').trim() });
  });
  const buttons = [];
  $msg.find('.tgme_widget_message_inline_button').each((_, a) => {
    const href = $(a).attr('href');
    if (href) buttons.push({ href, label: $(a).text().replace(/\s+/g, ' ').trim() });
  });
  const preview = $msg.find('.tgme_widget_message_link_preview').attr('href') || null;

  // Legacy flat list (kept for telegram/index.js and older callers).
  const links = textLinks.map((l) => l.href).concat(buttons.map((b) => b.href));
  if (preview) links.push(preview);

  return { text, links, textLinks, buttons, preview };
}

// Parse one t.me/s/<channel> page into raw posts. Pure (no network) so page
// shapes can be tested against saved fixtures.
function parseChannelHtml(html, username) {
  const $ = cheerio.load(html);
  const posts = [];
  $('.tgme_widget_message').each((_, el) => {
    const dataPost = $(el).attr('data-post'); // "channel/msgId"
    if (!dataPost) return;
    const msgId = dataPost.split('/').pop();
    const msg = extractMessage($, el);
    const dateISO = $(el).find('time').attr('datetime') || null;
    posts.push({ channel: username, msgId, postUrl: `https://t.me/${dataPost}`, dateISO, ...msg });
  });
  return posts;
}

// Fetch one channel's preview page and return its raw posts.
// `http` (from lib/http.createHttp) is preferred — it carries the shared retry,
// timeout, UA-rotation and request-budget policy. The built-in fetchHtml stays
// as a fallback so the legacy telegram/index.js entry point keeps working.
async function fetchChannel(username, { before = null, http = null } = {}) {
  const url = `https://t.me/s/${username}` + (before ? `?before=${before}` : '');
  const html = http ? (await http.text(url)).body : await fetchHtml(url);
  return parseChannelHtml(html, username);
}

module.exports = { fetchChannel, parseChannelHtml, fetchHtml, sleep };
