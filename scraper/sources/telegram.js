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
 * The gate is therefore staged and every stage counts its rejections:
 *   1. parser.isVacancy      — is this a hiring post at all? (+ per-channel profile)
 *   2. parser.detectTitle    — can we name the ROLE? (no role → drop)
 *   3. lib/filter            — student-suitable? ('general' channels must show a
 *                              STRONG student signal, not just lack a negative one)
 *   4. Jev (optional)        — vacancy / student / Kazakhstan, and which candidate
 *                              is the apply target, title, employer; rules are the
 *                              fallback and the run log says which was used
 *   5. makeJob + repost dedupe (batch, and DB rows inside the TTL)
 *
 * ctx hooks (all optional, used by tests and the orchestrator):
 *   ctx.channels, ctx.fetchChannel  – replace the network
 *   ctx.judge                       – a createJudge()-shaped object (fake in tests)
 *   ctx.loadExisting()              – async () => active telegram rows in the TTL
 *                                     (source_id, source_channel, title, company,
 *                                     apply_url, source_type); absent in dry runs
 *
 * Freshness: posts older than `maxAgeDays` are skipped entirely. Channels pin
 * old posts and repost, and the old pipeline happily re-upserted a 358-day-old
 * post as a fresh job (there is one on the live board right now).
 */

const { CHANNELS } = require('../telegram/channels');
const { fetchChannel } = require('../telegram/fetcher');
const { parsePost } = require('../telegram/parser');
const { SOURCE_TYPES } = require('../telegram/apply');
const { createJudge, applyVerdict } = require('../telegram/jev');
const { CONCURRENCY } = require('../telegram/judge-config');
const { dedupeReposts } = require('../telegram/dedupe');

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
  const channels = ctx.channels || CHANNELS;
  const fetchPosts = ctx.fetchChannel || ((username) => fetchChannel(username, { http }));
  const sleep = ctx.sleep || (http && http.sleep ? (ms) => http.sleep(ms) : async () => {});

  const entries = [];      // { job, named } after every gate, before repost dedupe
  const rejects = {};
  const perChannel = {};
  const notes = [];
  let emptyChannels = 0;

  const bump = (r) => { rejects[r] = (rejects[r] || 0) + 1; };

  // Optional Jev. Without a key / SDK / on API failure everything below runs on rules.
  const judge = ctx.judge || await createJudge({ log });
  log(judge.mode === 'jev'
    ? '[telegram] judgments: Jev (TypeSafe) will judge posts that pass the rules; rules remain the fallback'
    : `[telegram] judgments: RULES ONLY — Jev not used (${judge.reason})`);

  // Rows already stored: used to keep earlier (possibly Jev-improved) fields
  // stable across the 8 runs a day, and to drop reposts.
  let existingRows = [];
  if (ctx.loadExisting) {
    try { existingRows = await ctx.loadExisting(); }
    catch (e) { notes.push(`existing-row lookup failed, repost check limited to this batch: ${e.message}`); }
  }
  const existingById = new Map(existingRows.map((r) => [r.source_id, r]));

  for (const ch of channels) {
    const stat = { posts: 0, kept: 0, rejected: 0, noDate: 0, jev: 0, rules: 0, error: null };
    perChannel[ch.username] = stat;
    const general = ch.kind === 'general';
    try {
      const posts = await fetchPosts(ch.username);
      stat.posts = posts.length;
      if (posts.length === 0) {
        emptyChannels++;
        notes.push(`@${ch.username}: 0 posts parsed (channel private, renamed, or page shape changed)`);
      }

      // Pass 1 (rules): freshness → parse → student gate.
      const pending = [];
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
        pending.push({ post, parsed });
      }

      // Pass 2 (Jev, optional): in small parallel batches.
      const verdicts = new Map();
      for (let i = 0; i < pending.length; i += CONCURRENCY) {
        await Promise.all(pending.slice(i, i + CONCURRENCY).map(async (item) => {
          const known = existingById.get(item.parsed.source_id);
          // A row the router already wrote keeps its fields: no second Jev call
          // and no flapping between runs. (Rows from the old logic are re-derived.)
          if (known && SOURCE_TYPES.includes(known.source_type)) {
            item.parsed.title = known.title || item.parsed.title;
            item.parsed.company = known.company || item.parsed.company;
            item.parsed.apply_url = known.apply_url || item.parsed.apply_url;
            item.parsed.source_type = known.source_type;
            item.parsed._companyFromPost = true;
            item.reused = true;
            return;
          }
          verdicts.set(item, await judge.assess(item.post, item.parsed));
        }));
      }

      // Pass 3: apply verdicts, strict gate for general channels, final checks.
      for (const item of pending) {
        const { parsed } = item;
        const verdict = verdicts.get(item) || null;
        if (item.reused) { /* already judged on an earlier run */ }
        else if (verdict) stat.jev++; else stat.rules++;

        const vr = applyVerdict(parsed, verdict, judge);
        if (vr) { stat.rejected++; bump(vr); continue; }

        // Big general channels: only 30–40% suit students, so a POSITIVE student
        // signal is required. Jev's studentFit (already checked) counts as one;
        // without a verdict the rules must find a strong keyword.
        if (general && !verdict && !item.reused &&
            !filter.isStudentFriendly(parsed.title, parsed.raw_text, parsed.tags, { strictPositive: true })) {
          stat.rejected++; bump('no-student-signal'); continue;
        }
        // A Jev-chosen title or employer may change what the filter sees.
        const reason = filter.studentRejectReason(parsed.title, parsed.raw_text, parsed.tags);
        if (reason) { stat.rejected++; bump(reason); continue; }

        const job = normalize.makeJob(parsed);
        if (!job) { stat.rejected++; bump(normalize.makeJob.lastReject || 'invalid'); continue; }

        entries.push({ job, named: !!parsed._companyFromPost });
        stat.kept++;
      }
      // A channel where most posts carry no timestamp means the preview markup
      // changed; we drop undated posts (never guess "today"), so say so loudly.
      if (stat.posts >= 5 && stat.noDate / stat.posts > 0.5) {
        notes.push(`@${ch.username}: ${stat.noDate}/${stat.posts} posts had no parsable date — check t.me markup`);
      }
      log(`[telegram] @${ch.username}: ${stat.posts} posts → ${stat.kept} jobs (${stat.rejected} filtered; judged by Jev ${stat.jev}, by rules ${stat.rules})`);
    } catch (e) {
      stat.error = e.message;
      notes.push(`@${ch.username}: ${e.message}`);
      log(`[telegram] @${ch.username} ERROR: ${e.message}`);
    }
    await sleep(1200 + Math.random() * 1300); // polite, jittered
  }

  // Every channel empty means the t.me preview shape changed — that is a source
  // outage, not "no jobs today", and must not be reported as a quiet zero.
  if (emptyChannels === channels.length && channels.length > 0) {
    throw new Error(`all ${channels.length} channels returned 0 posts — t.me/s/ page shape changed or egress blocked`);
  }

  // Reposts: same channel + same apply target / same title+employer / same text,
  // in this batch and against active rows already stored inside the TTL.
  const { kept: unique, dropped } = dedupeReposts(entries, { existingRows });
  if (dropped.batch) rejects['duplicate-in-batch'] = dropped.batch;
  if (dropped.db) rejects['duplicate-in-db'] = dropped.db;

  // Same post cross-posted to several channels: keep the first.
  const seenKey = new Set();
  const finalJobs = unique.filter((j) => {
    const k = `${j.title.toLowerCase()}|${j.company.toLowerCase()}`;
    if (seenKey.has(k)) { bump('duplicate-across-channels'); return false; }
    seenKey.add(k);
    return true;
  });

  const jevStats = { mode: judge.mode, reason: judge.reason, judgedByJev: judge.stats.jev, judgedByRules: judge.stats.rules, failedCalls: judge.stats.failed, overrides: judge.stats.overrides };
  log(judge.mode === 'jev' && !judge.stats.failed
    ? `[telegram] Jev judged ${jevStats.judgedByJev} posts, rules ${jevStats.judgedByRules}; Jev changed apply/title/employer on ${jevStats.overrides.apply}/${jevStats.overrides.title}/${jevStats.overrides.company}`
    : `[telegram] judged by Jev: ${jevStats.judgedByJev}, by rules: ${jevStats.judgedByRules} (${judge.reason}${judge.firstError ? '; first error: ' + judge.firstError : ''})`);
  const jevDrops = Object.entries(judge.stats.rejected || {});
  if (jevDrops.length) {
    const n = jevDrops.reduce((a, [, c]) => a + c, 0);
    notes.push(`Jev dropped ${n} post(s) the rules had kept: ${jevDrops.map(([k, c]) => `${k}=${c}`).join(', ')}`);
  }
  if (judge.mode !== 'jev') notes.push(`Jev not used: ${judge.reason}`);
  else if (judge.stats.failed) notes.push(`Jev: ${judge.stats.failed} call(s) failed, those posts fell back to rules (${judge.firstError || 'unknown error'})`);

  return {
    jobs: finalJobs,
    stats: { channels: channels.length, emptyChannels, rejects, perChannel, deduped: entries.length - finalJobs.length, jev: jevStats },
    notes,
  };
}

module.exports = { name: SOURCE, minExpected: 10, ttlDays: 21, scrape, canary, verify };
