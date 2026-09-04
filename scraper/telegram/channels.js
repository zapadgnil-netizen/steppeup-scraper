/**
 * Telegram channels to scrape.
 *
 * Each entry:
 *   username  – the @handle without the '@' (case-insensitive on Telegram, but
 *               keep the canonical spelling; it becomes part of source_id).
 *   label     – human-readable name. ALSO used as the fallback `company` when a
 *               post names no employer (tagged `via:<username>`), so keep it
 *               short and recognisable ("KBTU Career Center", not "ЦЕНТР…").
 *   kind      – 'career'     = a career-center / vacancies channel; almost every
 *                              post is a job, so expect a high hit rate.
 *               'university' = an official university channel that only
 *                              occasionally posts jobs among news/events.
 *   focus     – rough subject area, informational only.
 *   enabled   – false = skipped by CHANNELS (kept in ALL_CHANNELS for reference).
 *
 * How to ADD a channel:
 *   1. Open https://t.me/s/<username> in a browser. If you see a page titled
 *      "Telegram: Contact @<username>" with NO messages, the channel has no
 *      public web preview (private / non-existent) and CANNOT be scraped —
 *      don't add it.
 *   2. Append an object below with kind:'career' or 'university'.
 *   3. Run `node tests/telegram.test.js` and a dry run of sources/telegram.js;
 *      check the new channel's per-channel stats line.
 *
 * How to REMOVE a channel: set enabled:false with a dated comment saying why
 * (so the next person doesn't re-add it), or delete the line.
 *
 * Liveness check 2026-09-03 (every channel fetched once from the scraper):
 *   kbtucareer 19 msgs (last 2026-09-02) · careercenterkaznmu 20 (2026-07-20,
 *   mostly photo-only posts) · beam_iitu 20 (last post 2022-10-12 — stale) ·
 *   youngcareer 16 (2025-11-01) · jobkz_1 11 (2026-09-03) · enuofficial 5 ·
 *   Satbayev_University_Official 18 · kimep_university 18 (last 2023-02-12 —
 *   stale) · narxoz_channel 20 · sdu_university 5.
 *   center_career_iitu, beam_vacancies, farabi_university → HTTP 200 but the
 *   "Telegram: Contact @…" page with zero messages (no public preview).
 */

const CHANNELS_ALL = [
  // ── Career-center / vacancy channels ─────────────────────────────────────
  { username: 'kbtucareer',          label: 'KBTU Career Center',   kind: 'career', focus: 'general', enabled: true },
  { username: 'careercenterkaznmu',  label: 'KazNMU Career Center', kind: 'career', focus: 'medical', enabled: true },
  // 2026-09-03: no public preview ("Telegram: Contact @center_career_iitu", 0 messages) — private or renamed.
  { username: 'center_career_iitu',  label: 'IITU Career Center',   kind: 'career', focus: 'it',      enabled: false },
  // 2026-09-03: resolves, but the last post is from 2022-10-12. Harmless (freshness gate skips it) — disable if it stays dead.
  { username: 'beam_iitu',           label: 'IITU / Beam',          kind: 'career', focus: 'it',      enabled: true },
  // 2026-09-03: no public preview ("Telegram: Contact @beam_vacancies", 0 messages).
  { username: 'beam_vacancies',      label: 'Beam.kz Vacancies',    kind: 'career', focus: 'general', enabled: false },
  // 2026-09-03: renamed to "Young Career: Social Impact Jobs Europe and Central Asia" on 2025-09-09 —
  // posts are UN/NGO roles in Rome/Brussels/Copenhagen, not Kazakhstan; last post 2025-11-01.
  { username: 'youngcareer',         label: 'Young Career',         kind: 'career', focus: 'general', enabled: false },
  { username: 'jobkz_1',             label: 'JobKZ',                kind: 'career', focus: 'general', enabled: true },

  // ── Official university channels (occasional job posts among news) ──────
  // 2026-09-03: no public preview ("Telegram: Contact @farabi_university", 0 messages).
  { username: 'farabi_university',            label: 'Al-Farabi KazNU', kind: 'university', focus: 'general', enabled: false },
  { username: 'enuofficial',                  label: 'ENU',             kind: 'university', focus: 'general', enabled: true },
  { username: 'Satbayev_University_Official',  label: 'Satbayev Univ',   kind: 'university', focus: 'general', enabled: true },
  // 2026-09-03: resolves, last post 2023-02-12 — stale.
  { username: 'kimep_university',             label: 'KIMEP',           kind: 'university', focus: 'general', enabled: true },
  { username: 'narxoz_channel',               label: 'Narxoz',          kind: 'university', focus: 'general', enabled: true },
  { username: 'sdu_university',               label: 'SDU',             kind: 'university', focus: 'general', enabled: true },
];

const CHANNELS = CHANNELS_ALL.filter((c) => c.enabled !== false);

/** Channel config by username (case-insensitive); null if unknown. */
function channelByUsername(username) {
  const u = String(username || '').toLowerCase();
  return CHANNELS_ALL.find((c) => c.username.toLowerCase() === u) || null;
}

/** Human label for a channel — used as the fallback employer name. */
function labelFor(username) {
  const c = channelByUsername(username);
  return c ? c.label : `@${username}`;
}

module.exports = { CHANNELS, CHANNELS_ALL, channelByUsername, labelFor };
