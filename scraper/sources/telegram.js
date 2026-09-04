/**
 * sources/telegram.js — university career-centre Telegram channels.
 *
 * Why this source needs the most care: it is the only source that scrapes
 * FREE-FORM HUMAN POSTS. hh.kz and enbek give us structured vacancies; a
 * Telegram channel gives us grants, hackathons, club recruitment, congratulation
 * posts and the occasional real vacancy, all in the same feed. Everything that
 * made the old board embarrassing (a grant listed as a job, a title reading
 * ", напишите мне в личные сообщения") came from accepting these posts loosely.
 *
 * The gate is therefore three-stage and every stage counts its rejections:
 *   1. parser.isVacancy      — is this a hiring post at all?
 *   2. parser.detectTitle    — can we name the ROLE? (no role → drop)
 *   3. lib/filter + makeJob  — is it student-suitable and well-formed?
 *
 * Freshness: posts older than `maxAgeDays` are skipped entirely. Channels pin
 * old posts and repost, and the old pipeline happily re-upserted a 358-day-old
 * post as a fresh job (there is one on the live board right now).
 */

const { CHANNELS } = require('../telegram/channels');
const { fetchChannel } = require('../telegram/fetcher');
const { parsePost } = require('../telegram/parser');

const SOURCE = 'telegram_career';

/** Telegram posts carry no machine-readable "still open" flag. */
async function verify() {
  // Deliberately always 'unknown': there is no cheap, reliable liveness signal
  // for a chat message (the post stays up forever whether or not the role is
  // filled). TTL expiry in cleanup-jobs.js is what retires these rows.
  return 'unknown';
}

async function canary(ctx) {
  try {
    const posts = await fetchChannel('kbtucareer', { http: ctx.http });
    const withText = posts.filter((p) => p.text && p.text.length > 40);
    if (posts.length === 0) return { ok: false, reason: 't.me/s/ returned no .tgme_widget_message nodes (page shape changed or channel private)' };
    if (withText.length < 3) return { ok: false, reason: `only ${withText.length} posts had extractable text (expected ≥3)` };
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: `fetch failed: ${e.message}` };
  }
}

async function scrape(ctx) {
  const { http, log, filter, normalize, limits = {} } = ctx;
  const maxAgeDays = limits.maxAgeDays || 21;
  const cutoff = Date.now() - maxAgeDays * 864e5;

  const jobs = [];
  const rejects = {};
  const perChannel = {};
  const notes = [];
  let emptyChannels = 0;

  const bump = (r) => { rejects[r] = (rejects[r] || 0) + 1; };

  for (const ch of CHANNELS) {
    const stat = { posts: 0, kept: 0, rejected: 0, noDate: 0, error: null };
    perChannel[ch.username] = stat;
    try {
      const posts = await fetchChannel(ch.username, { http });
      stat.posts = posts.length;
      if (posts.length === 0) {
        emptyChannels++;
        notes.push(`@${ch.username}: 0 posts parsed (channel private, renamed, or page shape changed)`);
      }

      for (const post of posts) {
        // Freshness first — cheapest check, and stops old pinned posts from
        // being resurrected as new listings on every run.
        const ts = post.dateISO ? Date.parse(post.dateISO) : NaN;
        if (!isFinite(ts)) { stat.rejected++; stat.noDate++; bump('no-date'); continue; }
        if (ts < cutoff) { stat.rejected++; bump('too-old'); continue; }

        const parsed = parsePost(post, { companyFallback: ch.label });
        if (!parsed) { stat.rejected++; bump(parsePost.lastReject || 'unparsed'); continue; }

        const reason = filter.studentRejectReason(parsed.title, parsed.raw_text, parsed.tags);
        if (reason) { stat.rejected++; bump(reason); continue; }

        const job = normalize.makeJob(parsed);
        if (!job) { stat.rejected++; bump(normalize.makeJob.lastReject || 'invalid'); continue; }

        jobs.push(job);
        stat.kept++;
      }
      // A channel where most posts carry no timestamp means the preview markup
      // changed; we drop undated posts (never guess "today"), so say so loudly.
      if (stat.posts >= 5 && stat.noDate / stat.posts > 0.5) {
        notes.push(`@${ch.username}: ${stat.noDate}/${stat.posts} posts had no parsable date — check t.me markup`);
      }
      log(`[telegram] @${ch.username}: ${stat.posts} posts → ${stat.kept} jobs (${stat.rejected} filtered)`);
    } catch (e) {
      stat.error = e.message;
      notes.push(`@${ch.username}: ${e.message}`);
      log(`[telegram] @${ch.username} ERROR: ${e.message}`);
    }
    await http.sleep(1200 + Math.random() * 1300); // polite, jittered
  }

  // Every channel empty means the t.me preview shape changed — that is a source
  // outage, not "no jobs today", and must not be reported as a quiet zero.
  if (emptyChannels === CHANNELS.length && CHANNELS.length > 0) {
    throw new Error(`all ${CHANNELS.length} channels returned 0 posts — t.me/s/ page shape changed or egress blocked`);
  }

  // Same post cross-posted to several channels: keep the first.
  const seenKey = new Set();
  const unique = jobs.filter((j) => {
    const k = `${j.title.toLowerCase()}|${j.company.toLowerCase()}`;
    if (seenKey.has(k)) { bump('duplicate-in-batch'); return false; }
    seenKey.add(k);
    return true;
  });

  return {
    jobs: unique,
    stats: { channels: CHANNELS.length, emptyChannels, rejects, perChannel, deduped: jobs.length - unique.length },
    notes,
  };
}

module.exports = { name: SOURCE, minExpected: 3, ttlDays: 21, scrape, canary, verify };
