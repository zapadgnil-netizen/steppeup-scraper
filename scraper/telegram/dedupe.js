/**
 * telegram/dedupe.js — one vacancy, stored once.
 *
 * Channels repost: a recurring @jobkz_1 vacancy comes back every few days with a
 * different phone number; the same announcement appears in Russian, Kazakh and
 * English on one day. Three keys catch these (all scoped to ONE channel):
 *
 *   apply  same channel + same resolved apply target. A web page (form / site)
 *          identifies a vacancy anywhere in the TTL. A person's contact (email,
 *          phone, WhatsApp, Telegram) is shared by ALL of that recruiter's
 *          vacancies, so it only merges posts made within CONTACT_WINDOW_HOURS of
 *          each other (the same announcement in ru/kk/en) and never against
 *          stored rows. telegram_post is never keyed: its target is the post.
 *   name   same channel + same normalised title + same employer — only when the
 *          post NAMED the employer (an unnamed "Менеджер | JobKZ" says nothing)
 *   text   same channel + same opening text (first ~200 letters, contacts removed)
 *
 * Within a batch the first post wins. Against the database, an active row inside
 * the TTL wins (the existing listing is kept, the repost is dropped). The DB side
 * is a plain array of rows so dry runs and tests inject their own.
 */

const { labelFor } = require('./channels');

const WEB_TYPES = ['form', 'site'];
const CONTACT_WINDOW_HOURS = 36;

const norm = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

function textFingerprint(raw) {
  const t = norm(String(raw || '').replace(/https?:\/\/\S+|[\w.+-]+@[\w-]+\.[\w.-]+|@\w+|[+\d][\d\s()-]{8,}/g, ' ')).replace(/\s+/g, ' ');
  return t.length >= 40 ? t.slice(0, 200) : null;
}

/** meta.named — did the post itself name the employer? */
function keysFor(job, { named = true } = {}) {
  const ch = String(job.source_channel || '').toLowerCase();
  const keys = [];
  if (job.apply_url && WEB_TYPES.includes(job.source_type)) keys.push(`${ch}|apply|${String(job.apply_url).toLowerCase()}`);
  if (named) keys.push(`${ch}|name|${norm(job.title)}|${norm(job.company)}`);
  const fp = textFingerprint(job.raw_text);
  if (fp) keys.push(`${ch}|text|${fp}`);
  return keys;
}

/** The recruiter-contact key (batch only, time-windowed), or null. */
function contactKey(job) {
  if (!job.apply_url || !job.source_type || job.source_type === 'telegram_post' || WEB_TYPES.includes(job.source_type)) return null;
  return `${String(job.source_channel || '').toLowerCase()}|contact|${String(job.apply_url).toLowerCase()}`;
}

/** Keys for a row already stored (no raw_text there, so no text key). */
function keysForRow(row) {
  const ch = String(row.source_channel || '').toLowerCase();
  const keys = [];
  if (row.apply_url && WEB_TYPES.includes(row.source_type)) keys.push(`${ch}|apply|${String(row.apply_url).toLowerCase()}`);
  const named = norm(row.company) !== norm(labelFor(row.source_channel));
  if (named) keys.push(`${ch}|name|${norm(row.title)}|${norm(row.company)}`);
  const fp = textFingerprint(row.raw_text);
  if (fp) keys.push(`${ch}|text|${fp}`);
  return keys;
}

/**
 * entries: [{ job, named }] → { kept: job[], dropped: { batch, db } }
 * existingRows: rows already active in the DB within the TTL.
 */
function dedupeReposts(entries, { existingRows = [] } = {}) {
  const dbKeys = new Map(); // key → source_id
  for (const r of existingRows) for (const k of keysForRow(r)) if (!dbKeys.has(k)) dbKeys.set(k, r.source_id);

  const seen = new Set();
  const contactSeen = new Map(); // contact key → posted_at (ms) of every kept post using it
  const kept = [];
  const dropped = { batch: 0, db: 0 };
  for (const { job, named } of entries) {
    const keys = keysFor(job, { named });
    // A row never duplicates ITSELF: the same source_id in the DB is an update.
    const dbHit = keys.some((k) => dbKeys.has(k) && dbKeys.get(k) !== job.source_id);
    if (dbHit) { dropped.db++; continue; }
    const ck = contactKey(job);
    const at = Date.parse(job.posted_at);
    const sameAnnouncement = ck && isFinite(at) && (contactSeen.get(ck) || []).some((t) => Math.abs(t - at) <= CONTACT_WINDOW_HOURS * 36e5);
    if (sameAnnouncement || keys.some((k) => seen.has(k))) { dropped.batch++; continue; }
    keys.forEach((k) => seen.add(k));
    if (ck && isFinite(at)) contactSeen.set(ck, [...(contactSeen.get(ck) || []), at]);
    kept.push(job);
  }
  return { kept, dropped };
}

module.exports = { dedupeReposts, keysFor, keysForRow, textFingerprint, norm };
