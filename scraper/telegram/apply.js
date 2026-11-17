/**
 * telegram/apply.js — the APPLY ROUTER: one apply action per post.
 *
 * Founder's rule: a Telegram-sourced job sends the student straight to the real
 * application destination, never back to the Telegram channel.
 *
 * DATA CONTRACT (the site derives its button from jobs.apply_url + source_type):
 *
 *   source_type      apply_url
 *   form             https:// form (Google Forms, forms.gle, Typeform, …)
 *   site             https:// employer / job-board / vacancy page
 *   email            mailto:<address>
 *   whatsapp         https://wa.me/<digits>
 *   phone            tel:+<digits>
 *   telegram_dm      https://t.me/<username>   (an HR person)
 *   telegram_bot     https://t.me/<botname>
 *   telegram_post    the post URL (the post offers no other way to apply)
 *
 * Pipeline: collect candidates (text anchors by HREF not label, inline buttons,
 * preview card, plain-text emails / phones / @usernames) → drop everything that
 * points back at Telegram itself (own channel, footer handles, invites, folders,
 * channel messages, hashtags) → score by kind and by the apply cue in or next to
 * the candidate → best wins. rankCandidates() is also what the optional Jev
 * judge chooses from, so rules and Jev share one candidate list.
 */

const { channelByUsername, footerHandlesFor } = require('./channels');

// JS \b does not work next to Cyrillic; emulate it with lookarounds.
const W = '[a-zа-яёәіңғүұқөһ0-9_]';
// NB: JS \w is ASCII-only, so inside the alternations it is rewritten to the W class.
const word = (alts) => new RegExp(`(?<!${W})(?:${alts.replace(/\\w/g, W)})(?!${W})`, 'i');

// Cues that a line tells the candidate how to apply.
const STRONG_CUE = word('резюме|отклик\\w*|подат\\w*|подач\\w*|подать|заявк\\w*|анкет\\w*|apply|cv|send|направля\\w*|направь\\w*|отправ\\w*|присыла\\w*|ссылка\\s+на\\s+вакансию|ссылка\\s+для\\s+отклика');
const WEAK_CUE = word('контакт\\w*|писать|пишите|напишите|звоните|звонить|тел|тел\\.|телефон\\w*|whats\\s?app|whatsapp|ватсап\\w*|вотсап\\w*|уатсап\\w*|уотсап\\w*|wa|связ\\w*|обращ\\w*|hr');
// Lines that point at the channel / company rather than the application.
const NEGATIVE_CUE = word('подпис\\w*|канал\\w*|подпишись|о\\s+компании|сайт\\s+компании|наш\\s+сайт|instagram|инстаграм|реклам\\w*|разместить\\s+вакансию|модератор\\w*|channel|follow');
// Anchor/button labels that promote the channel itself ("Разместить вакансию",
// "В группу Работа Алматы"): the href is an ad contact or a sister channel.
const PROMO_LABEL = word('разместить|выложить|предложить\\s+вакансию|предложка|реклам\\w*|в\\s+группу|подписа\\w*|подпиш\\w*|заб\\w+\\s+папку|папк\\w*|канал\\w*|channel');
// A contact block that belongs to a university career centre, not the employer
// ("Please send all inquiries to: … Career Center … e-mail:…").
const INTERMEDIARY = /career\s*cent(?:er|re)|центр[а-я]*\s+карьеры|карьерн\w+\s+центр/i;
const WHATSAPP_CUE = /whats\s?app|whatsap|ватсап|вотсап|уатсап|уотсап|(?<![a-zа-яё0-9_])w\/?a(?![a-zа-яё0-9_])/i;

const FORM_RE = /docs\.google\.com\/forms|forms\.gle|forms\.office\.com|forms\.yandex|typeform\.com|tally\.so|jotform|airtable\.com\/shr|survey|\/forms?\/|anket|anketa/i;
const SOCIAL_HOSTS = /(^|\.)(instagram\.com|facebook\.com|fb\.com|tiktok\.com|youtube\.com|youtu\.be|vk\.com|twitter\.com|x\.com|threads\.net|ok\.ru|t\.co|telegra\.ph|telesco\.pe|telegram\.org)$/i;
const JOB_BOARD_RE = /(^|\.)(hh\.kz|hh\.ru|headhunter\.|linkedin\.com|lnkd\.in|enbek\.kz|rabota\.kz|jobs\.kz|kolesa\.kz|glassdoor\.|indeed\.|workable\.com|lever\.co|greenhouse\.io|smartrecruiters\.com|teamtailor\.com|recruitee\.com|ashbyhq\.com|breezy\.hr|bamboohr\.com|rabota\.by|zarplata\.ru|superjob\.ru)/i;
const VACANCY_PATH_RE = /vacanc|vakans|\/jobs?\b|\/job\/|career|karier|kariera|\/apply|\/hire|\/join|\/work|rabota|vacancy|\/positions?|\/opening|\/intern|\/internship|\/recruit/i;

// ── contact normalisers ─────────────────────────────────────────────────────

/** Any Kazakhstan phone spelling → 11 digits starting with 7, or null. */
function normalizePhone(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (digits.length !== 11 || !/^[78]/.test(digits)) return null;
  const national = digits.slice(1);
  if (national[0] !== '7') return null; // Kazakhstan numbers are 7xx…; 9xx is Russia
  return '7' + national;
}

// A digit run that is really an amount: a currency right after it, or two
// thousands-groups joined by a hyphen ("87 000-170 000").
const MONEY_AFTER = /^\s*(?:₸|тг\b|тенге|kzt|usd|\$|€|₽|руб)/i;
const THOUSANDS_RANGE = /\d\s?\d{3}\s*-\s*\d{1,3}\s?\d{3}(?!\d)/;
function looksLikeMoney(text, m) {
  const after = text.slice(m.index + m[0].length, m.index + m[0].length + 12);
  return MONEY_AFTER.test(after) || THOUSANDS_RANGE.test(m[0]);
}

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
const PHONE_RE = /(?<![\d])(\+?[78])((?:[\s\-().]*\d){10})(?![\d])/g;
const USERNAME_RE = /(?<![\w@./:%\-])@([A-Za-z][A-Za-z0-9_]{4,31})(?![\w@])/g;
const URL_RE = /https?:\/\/[^\s<>"'«»)]+/gi;

/** decodeURIComponent that never throws (a stray "%" in a link must not sink a channel). */
function safeDecode(v) {
  try { return decodeURIComponent(v); } catch { return null; }
}

const MAX_URL_LENGTH = 1000;
// Hosts that cannot be a real application page: bare names, IP literals, local names.
function publicHost(host) {
  if (!host || !host.includes('.')) return false;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':')) return false;
  return !/(^|\.)(localhost|local|internal|lan|home|test|invalid)$/i.test(host);
}

/** Strip tracking params and upgrade http → https. */
function normalizeUrl(href) {
  let u = String(href || '').trim().replace(/&amp;/gi, '&').replace(/[.,;:!?)»]+$/, '');
  if (!/^https?:\/\//i.test(u) || u.length > MAX_URL_LENGTH) return null;
  u = u.replace(/^http:\/\//i, 'https://');
  let url;
  try { url = new URL(u); } catch { return null; }
  if (url.username || url.password || !publicHost(url.hostname)) return null;
  for (const k of [...url.searchParams.keys()]) if (/^(utm_|fbclid|gclid|yclid|igshid)/i.test(k)) url.searchParams.delete(k);
  const out = url.toString();
  return out.length > MAX_URL_LENGTH ? null : out;
}

function urlKey(u) {
  try {
    const x = new URL(u);
    return (x.hostname.replace(/^www\./, '') + x.pathname.replace(/\/$/, '') + x.search).toLowerCase();
  } catch { return String(u).toLowerCase(); }
}

// ── classify one href ───────────────────────────────────────────────────────

/**
 * href → candidate descriptor, or { ignore: reason }.
 * `skip` is the lowercase set of handles that must never be chosen.
 */
function classifyHref(href, skip) {
  const raw = String(href || '').trim();
  if (!raw) return { ignore: 'empty' };
  if (/^(\?|#)/.test(raw) || /^\/\?q=/.test(raw)) return { ignore: 'hashtag' };

  // mailto: and the malformed auto-link http://E-mail:someone@domain.kz/
  const mailto = raw.match(/^mailto:([^?\s]+)/i);
  if (mailto) { const a = safeDecode(mailto[1]); return a == null ? { ignore: 'bad-email' } : emailCandidate(a); }
  const weird = raw.match(/^https?:\/\/(?:e-?mail:)?([^/@\s:]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})\/?$/i);
  if (weird) return emailCandidate(weird[1]);

  const tel = raw.match(/^tel:(.+)$/i);
  if (tel) {
    const dec = safeDecode(tel[1]);
    const p = dec == null ? null : normalizePhone(dec);
    return p ? { kind: 'phone', value: p } : { ignore: 'foreign-phone' };
  }

  // WhatsApp
  const wa = raw.match(/^(?:https?:)?\/\/(?:www\.)?(?:wa\.me\/|api\.whatsapp\.com\/send\/?\?(?:.*&)?phone=|web\.whatsapp\.com\/send\/?\?(?:.*&)?phone=|wa\.link\/)\+?(\d{9,15})/i);
  if (wa) {
    // Channels often print the national number without the country code
    // (wa.me/7010000000): add it, or the link opens a wrong/foreign chat.
    const digits = wa[1].length === 10 && wa[1][0] === '7' ? '7' + wa[1] : wa[1];
    return { kind: 'whatsapp', value: digits };
  }
  if (/chat\.whatsapp\.com/i.test(raw)) return { ignore: 'whatsapp-group' };
  if (/^(?:https?:)?\/\/(?:www\.)?wa\.me\/message\//i.test(raw)) return { kind: 'whatsapp', value: raw.replace(/^(?:https?:)?\/\//, '').replace(/^www\./, ''), link: 'https://' + raw.replace(/^(?:https?:)?\/\//, '').replace(/^www\./, '') };

  // Telegram
  const tg = raw.match(/^(?:https?:)?\/\/(?:www\.)?(?:t|telegram)\.me\/(.*)$/i);
  const tgScheme = raw.match(/^tg:\/\/resolve\?(?:.*&)?domain=([A-Za-z0-9_]+)/i);
  if (tg || tgScheme) {
    const rest = tgScheme ? tgScheme[1] : tg[1];
    if (/^(\+|joinchat\/|addlist\/|s\/|c\/|share\/|setlanguage|proxy|socks|boost|iv\?)/i.test(rest)) return { ignore: 'telegram-invite-or-folder' };
    const segs = rest.split(/[?#]/)[0].split('/').filter(Boolean);
    const name = segs[0] || '';
    if (segs.length > 1) return { ignore: 'channel-message' };
    if (!/^[A-Za-z][A-Za-z0-9_]{3,31}$/.test(name)) return { ignore: 'not-a-username' };
    if (skip.has(name.toLowerCase())) return { ignore: 'own-channel-or-footer' };
    if (/bot$/i.test(name)) {
      const start = rest.match(/[?&]start=([^&#]+)/);
      // Telegram allows only A-Z a-z 0-9 _ - in a start payload.
      return { kind: 'telegram_bot', value: name, start: start && /^[A-Za-z0-9_-]{1,64}$/.test(start[1]) ? start[1] : null };
    }
    return { kind: 'telegram_dm', value: name };
  }

  if (!/^https?:\/\//i.test(raw)) return { ignore: 'not-a-web-url' };
  let host;
  try { host = new URL(raw).hostname.toLowerCase(); } catch { return { ignore: 'bad-url' }; }
  if (SOCIAL_HOSTS.test(host)) return { ignore: 'social' };
  // Resume BOARD pages are for employers, not for the applicant.
  if (/hh\.(kz|ru)\/(applicant\/resumes|resume)/i.test(raw) || /\/(resumes?|cv-base|search\/resume)\b/i.test(raw)) return { ignore: 'resume-board' };
  const url = normalizeUrl(raw);
  if (!url) return { ignore: 'bad-url' };
  if (FORM_RE.test(url)) return { kind: 'form', value: url };
  return { kind: 'site', value: url };
}

// local part: dot-separated atoms (no leading / trailing / double dot); domain: labels of
// letters, digits and inner hyphens, ending in a 2+ letter TLD.
const STRICT_EMAIL = /^[A-Za-z0-9_%+-]+(?:\.[A-Za-z0-9_%+-]+)*@(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\.)+[A-Za-z]{2,}$/;
function emailCandidate(addr) {
  const a = String(addr).trim();
  return a.length <= 254 && STRICT_EMAIL.test(a) ? { kind: 'email', value: a.toLowerCase() } : { ignore: 'bad-email' };
}

// ── candidate extraction ────────────────────────────────────────────────────

/** The three lines above `index` plus its own line. */
function blockAbove(text, index) {
  if (index < 0) return '';
  let start = lineAt(text, index).start;
  for (let i = 0; i < 3 && start > 0; i++) start = lineAt(text, start - 2).start;
  return text.slice(start, lineAt(text, index).end);
}

function lineAt(text, index) {
  const start = text.lastIndexOf('\n', index - 1) + 1;
  let end = text.indexOf('\n', index);
  if (end === -1) end = text.length;
  return { start, end, line: text.slice(start, end) };
}

/** The line holding `needle` plus, for a bare value line, the line above it. */
function contextFor(text, index) {
  if (index < 0) return '';
  const { start, line } = lineAt(text, index);
  let ctx = line;
  const bare = line.trim().split(/\s+/).length <= 3; // "+7 700 …" alone on a line: the cue is above
  if (bare && start > 0) ctx = lineAt(text, start - 2).line + '\n' + line;
  return ctx;
}

function buildSkip(channel, extra) {
  const set = new Set([String(channel || '').toLowerCase()]);
  const cfg = channelByUsername(channel);
  if (cfg) set.add(cfg.username.toLowerCase());
  for (const h of footerHandlesFor(channel)) set.add(String(h).replace(/^@/, '').toLowerCase());
  for (const h of extra || []) set.add(String(h).replace(/^@/, '').toLowerCase());
  return set;
}

/**
 * Every plausible application target in the post, best first. Each item:
 * { kind, value, apply_url, source_type, label, from, score, cue }
 */
function rankCandidates(post, opts = {}) {
  const text = post.text || '';
  const channel = post.channel || '';
  const skip = buildSkip(channel, opts.ignoreHandles);
  const found = new Map(); // dedupe key → candidate (highest score wins)

  const add = (desc, { label = '', from, context = '', position = 0, block = '' }) => {
    if (!desc || desc.ignore) return;
    if ((from === 'text_link' || from === 'inline_button') && PROMO_LABEL.test(label)) return;
    const cand = finish(desc, { label, from, context, position, intermediary: INTERMEDIARY.test(block) });
    if (!cand) return;
    const key = cand.kind === 'site' || cand.kind === 'form' ? 'u:' + urlKey(cand.apply_url) : 'k:' + cand.apply_url.toLowerCase();
    const prev = found.get(key);
    if (!prev || cand.score > prev.score) found.set(key, cand);
  };

  const linkList = (post.textLinks && post.textLinks.length) ? post.textLinks
    : (post.links || []).map((href) => ({ href, label: '' }));
  let order = 0;
  for (const l of linkList) {
    const href = typeof l === 'string' ? l : l.href;
    const label = typeof l === 'string' ? '' : (l.label || '');
    const idx = label ? text.indexOf(label) : (href ? text.indexOf(href) : -1);
    add(classifyHref(href, skip), { label, from: 'text_link', context: contextFor(text, idx), block: blockAbove(text, idx), position: order++ });
  }
  for (const b of post.buttons || []) {
    add(classifyHref(b.href, skip), { label: b.label || '', from: 'inline_button', context: b.label || '', position: order++ });
  }
  if (post.preview) add(classifyHref(post.preview, skip), { label: 'link preview', from: 'preview', position: order++ });

  // Plain text: URLs that were not auto-linked, emails, phones, @usernames.
  for (const m of text.matchAll(URL_RE)) add(classifyHref(m[0], skip), { label: m[0], from: 'plain_text', context: contextFor(text, m.index), block: blockAbove(text, m.index), position: order++ });
  for (const m of text.matchAll(EMAIL_RE)) add(emailCandidate(m[0]), { label: m[0], from: 'plain_text', context: contextFor(text, m.index), block: blockAbove(text, m.index), position: order++ });
  for (const m of text.matchAll(PHONE_RE)) {
    const phone = normalizePhone(m[0]);
    if (!phone || looksLikeMoney(text, m)) continue;
    const ctx = contextFor(text, m.index);
    const near = text.slice(Math.max(0, m.index - 40), m.index + m[0].length + 25);
    const isWa = WHATSAPP_CUE.test(lineAt(text, m.index).line) || WHATSAPP_CUE.test(ctx) || WHATSAPP_CUE.test(near);
    add({ kind: isWa ? 'whatsapp' : 'phone', value: phone }, { label: m[0].trim(), from: 'plain_text', context: ctx, block: blockAbove(text, m.index), position: order++ });
  }
  for (const m of text.matchAll(USERNAME_RE)) {
    add(classifyHref('https://t.me/' + m[1], skip), { label: m[0], from: 'plain_text', context: contextFor(text, m.index), block: blockAbove(text, m.index), position: order++ });
  }

  // The same phone as a WhatsApp link AND as plain text is one candidate.
  const list = [...found.values()];
  const waDigits = new Set(list.filter((c) => c.kind === 'whatsapp').map((c) => c.value));
  const merged = list.filter((c) => !(c.kind === 'phone' && waDigits.has(c.value)));
  merged.sort((a, b) => b.score - a.score || a.position - b.position);
  return merged.map(({ position, ...c }, i) => ({ id: `c${i}`, ...c }));
}

function finish(desc, { label, from, context, position, intermediary = false }) {
  let apply_url, source_type = desc.kind;
  switch (desc.kind) {
    case 'email': apply_url = `mailto:${desc.value}`; break;
    case 'whatsapp': apply_url = desc.link || `https://wa.me/${desc.value}`; break;
    case 'phone': apply_url = `tel:+${desc.value}`; break;
    case 'telegram_dm': apply_url = `https://t.me/${desc.value}`; break;
    case 'telegram_bot': apply_url = `https://t.me/${desc.value}${desc.start ? `?start=${desc.start}` : ''}`; break;
    case 'form': case 'site': apply_url = desc.value; break;
    default: return null;
  }

  // Score: kind first, then how clearly the surrounding words say "apply here".
  let score = 0;
  let isHome = false, isSpecific = false;
  if (desc.kind === 'site' || desc.kind === 'form') {
    const u = new URL(apply_url);
    isHome = (u.pathname === '/' || u.pathname === '') && !u.search;
    isSpecific = !isHome && (VACANCY_PATH_RE.test(u.pathname + u.search) || (JOB_BOARD_RE.test(u.hostname) && /vacanc|\/jobs?\b|\/job\/|\d{5,}/i.test(u.pathname)));
  }
  switch (desc.kind) {
    case 'form': score = 80; break;
    case 'site': score = isSpecific ? 70 : isHome ? 25 : 40; break;
    case 'email': score = 60; break;
    case 'whatsapp': score = 58; break;
    case 'phone': score = 55; break;
    case 'telegram_bot': score = 52; break;
    case 'telegram_dm': score = 48; break;
  }
  if (from === 'preview') score -= 10;
  if (from === 'inline_button') score += 15;
  let cue = 0;
  if (STRONG_CUE.test(context)) cue = 35;
  else if (WEAK_CUE.test(context) || (desc.kind === 'whatsapp' || desc.kind === 'phone' || desc.kind === 'email') && /контакт|тел|whats/i.test(context)) cue = 25;
  // Button text is the strongest cue of all ("Откликнуться").
  if (from === 'inline_button' && cue) cue += 5;
  score += cue;
  if (NEGATIVE_CUE.test(context) && cue < 35) score -= 30;
  if (desc.kind === 'site' && isHome && cue === 0) score -= 10;
  // The career centre's own inquiry block ranks below the employer's route.
  if (intermediary) score -= 40;

  return { kind: desc.kind, value: desc.value, apply_url, source_type, label, from, cue, score, position };
}

/**
 * The single apply action for a post.
 * → { apply_url, source_type, candidates, chosen }
 * `chosen` is the candidate used, or null when the post URL is the fallback.
 */
function resolveApply(post, opts = {}) {
  const candidates = rankCandidates(post, opts);
  return applyFrom(candidates, candidates[0] || null, post.postUrl);
}

function applyFrom(candidates, chosen, postUrl) {
  if (!chosen) return { apply_url: postUrl, source_type: 'telegram_post', candidates, chosen: null };
  return { apply_url: chosen.apply_url, source_type: chosen.source_type, candidates, chosen };
}

const SOURCE_TYPES = ['form', 'site', 'email', 'whatsapp', 'phone', 'telegram_dm', 'telegram_bot', 'telegram_post'];

module.exports = { resolveApply, rankCandidates, applyFrom, classifyHref, normalizePhone, normalizeUrl, SOURCE_TYPES };
