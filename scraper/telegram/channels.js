/**
 * Telegram channels to scrape.
 *
 * To ADD a channel: append an object below. `username` is the @handle without
 * the '@'. `priority` channels are confirmed active career centers; `watch`
 * channels are official university channels that only occasionally post jobs
 * (we still scrape them, but expect a lower hit rate).
 *
 * To REMOVE a channel: delete its line (or set enabled:false).
 */

const CHANNELS = [
  // ── Confirmed active career centers ──────────────────────────────────────
  { username: 'kbtucareer',          label: 'KBTU Career Center',   focus: 'general', enabled: true },
  { username: 'careercenterkaznmu',  label: 'KazNMU Career',        focus: 'medical', enabled: true },
  { username: 'center_career_iitu',  label: 'IITU Career Center',   focus: 'it',      enabled: true },
  { username: 'beam_iitu',           label: 'IITU / Beam',          focus: 'it',      enabled: true },
  { username: 'beam_vacancies',      label: 'Beam.kz Vacancies',    focus: 'general', enabled: true },
  { username: 'youngcareer',         label: 'Young Career',         focus: 'general', enabled: true },
  { username: 'jobkz_1',             label: 'JobKZ',                focus: 'general', enabled: true },

  // ── Official university channels (occasional job posts) ──────────────────
  { username: 'farabi_university',            label: 'Al-Farabi KazNU', focus: 'general', enabled: true },
  { username: 'enuofficial',                  label: 'ENU',             focus: 'general', enabled: true },
  { username: 'Satbayev_University_Official',  label: 'Satbayev Univ',   focus: 'general', enabled: true },
  { username: 'kimep_university',             label: 'KIMEP',           focus: 'general', enabled: true },
  { username: 'narxoz_channel',               label: 'Narxoz',          focus: 'general', enabled: true },
  { username: 'sdu_university',               label: 'SDU',             focus: 'general', enabled: true },
];

module.exports = { CHANNELS: CHANNELS.filter(c => c.enabled !== false) };
