/**
 * telegram/jev.js — optional Jev (TypeSafe AI) judgments with a rule fallback.
 *
 * Jev is asked, per post that already passed the rules: is it a vacancy, does it
 * suit a student, is it in Kazakhstan, which candidate is the apply target, which
 * candidate line is the role title, which candidate is the employer.
 *
 * FALLBACK CONTRACT — the scraper must always finish:
 *   - TYPESAFE_API_KEY unset            → mode 'rules', reason says so
 *   - @typesafe-ai/sdk not installed    → mode 'rules'
 *   - a call fails                      → that post stays on rules; after
 *                                         MAX_CONSECUTIVE_FAILURES the run stops asking
 * The SDK is loaded lazily and the key is never logged or put in an error.
 * Tests inject `client` and `sdk` (fake) so nothing touches the network.
 */

const cfg = require('./judge-config');

/** Strip anything that looks like a key out of text that may be logged. */
const scrub = (s, { env = process.env } = {}) => {
  let t = String(s || '');
  const key = env && env.TYPESAFE_API_KEY;
  if (key && key.length >= 6) t = t.split(key).join('[redacted]'); // the exact key, whatever its format
  return scrubPatterns(t);
};
const scrubPatterns = (s) => String(s || '').replace(/apikey_[A-Za-z0-9_\-]+/g, '[redacted]').replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]').slice(0, 200);

async function defaultLoadSdk() {
  try { return require('@typesafe-ai/sdk'); } catch (_) { /* fall through to ESM */ }
  try { return await import('@typesafe-ai/sdk'); } catch (_) { return null; }
}

/**
 * createJudge({ env, log, client?, sdk?, loadSdk? }) →
 *   { mode: 'jev' | 'rules', reason, stats, assess(post, parsed) }
 */
async function createJudge({ env = process.env, log = () => {}, client = null, sdk = null, loadSdk = defaultLoadSdk } = {}) {
  const stats = { jev: 0, rules: 0, failed: 0, rejected: {}, overrides: { apply: 0, title: 0, company: 0 } };
  const rulesOnly = (reason) => ({ mode: 'rules', reason, stats, assess: async () => { stats.rules++; return null; } });

  if (!client && !(env && env.TYPESAFE_API_KEY)) return rulesOnly('TYPESAFE_API_KEY is not set');
  if (!sdk) sdk = await loadSdk();
  if (!sdk || typeof sdk.choice !== 'function' || typeof sdk.noul !== 'function') return rulesOnly('@typesafe-ai/sdk could not be loaded');
  if (!client) {
    try { client = new sdk.TypeSafeClient(); }
    catch (e) { return rulesOnly('Jev client could not start: ' + scrub(e.message, { env })); }
  }

  let consecutive = 0, disabled = false, firstError = null;

  const judge = {
    mode: 'jev',
    reason: 'TYPESAFE_API_KEY present',
    stats,
    /** → verdict | null (null = judged by rules). Never throws. */
    async assess(post, parsed, meta) {
      if (disabled) { stats.rules++; return null; }
      try {
        const { state, questions } = buildRequest(sdk, post, parsed, meta);
        const { answers } = await client.systemOne({ state, questions });
        consecutive = 0;
        stats.jev++;
        return readVerdict(answers);
      } catch (e) {
        stats.failed++; stats.rules++; consecutive++;
        if (!firstError) { firstError = scrub(e && e.message, { env }); judge.firstError = firstError; }
        if (consecutive >= cfg.MAX_CONSECUTIVE_FAILURES && !disabled) {
          disabled = true;
          judge.reason = `Jev disabled after ${consecutive} failed calls in a row (${firstError}); remaining posts judged by rules`;
          log(`[jev] ${judge.reason}`);
        }
        return null;
      }
    },
  };
  return judge;
}

/** A NOUL entry is a string, or { instructions, criteria: { true, false } }. */
const noulQ = (sdk, def) => (typeof def === 'string' ? sdk.noul(def) : sdk.noul(def.instructions, def.criteria));

/** state + questions for one post. Candidate ids are stable (c0.., t0.., e0..). */
function buildRequest(sdk, post, parsed, meta = {}) {
  const apply = ((parsed._apply && parsed._apply.candidates) || []).slice(0, cfg.MAX_CANDIDATES);
  const titles = ((parsed._candidates && parsed._candidates.titles) || []).slice(0, cfg.MAX_CANDIDATES);
  const employers = ((parsed._candidates && parsed._candidates.companies) || []).slice(0, cfg.MAX_CANDIDATES);

  const state = {
    channel: post.channel,
    channel_audience: cfg.CHANNEL_AUDIENCE[meta.kind] || cfg.CHANNEL_AUDIENCE.general,
    post: String(post.text || '').slice(0, cfg.MAX_POST_CHARS),
    candidates: apply.map(({ id, kind, value, label }) => ({ id, kind, value, label })),
    title_candidates: titles.map((text, i) => ({ id: `t${i}`, text })),
    employer_candidates: employers.map((text, i) => ({ id: `e${i}`, text })),
  };

  const questions = {
    isVacancy: noulQ(sdk, cfg.NOUL.isVacancy),
    studentFit: noulQ(sdk, cfg.NOUL.studentFit),
    kzRelevant: noulQ(sdk, cfg.NOUL.kzRelevant),
  };
  if (apply.length) {
    const options = {};
    for (const c of apply) options[c.id] = `${c.kind}: ${c.value}${c.label && c.label !== c.value ? ` (shown as "${c.label}")` : ''}`;
    options.none = cfg.NONE.applyTarget;
    questions.applyTarget = sdk.choice(cfg.CHOICE.applyTarget, options);
  }
  if (titles.length >= 2) {
    const options = {};
    titles.forEach((t, i) => { options[`t${i}`] = t; });
    options.none = cfg.NONE.titleLine;
    questions.titleLine = sdk.choice(cfg.CHOICE.titleLine, options);
  }
  if (employers.length >= 2) {
    const options = {};
    employers.forEach((t, i) => { options[`e${i}`] = t; });
    options.none = cfg.NONE.employer;
    questions.employer = sdk.choice(cfg.CHOICE.employer, options);
  }
  return { state, questions };
}

function readVerdict(answers) {
  const noulOf = (a) => (a && typeof a.noul === 'number' ? a.noul : null);
  const choiceOf = (a) => (a && typeof a.choice === 'string' ? a.choice : undefined);
  return {
    vacancy: noulOf(answers.isVacancy),
    studentFit: noulOf(answers.studentFit),
    kazakhstan: noulOf(answers.kzRelevant),
    applyId: choiceOf(answers.applyTarget),
    titleId: choiceOf(answers.titleLine),
    employerId: choiceOf(answers.employer),
  };
}

const DIMS = [
  ['vacancy', 'vacancy', 'jev-not-vacancy'],
  ['studentFit', 'student', 'jev-not-student'],
  ['kazakhstan', 'kz', 'jev-not-kz'],
];

/**
 * Combine a Jev verdict with what the rules know. Jev does NOT cut by itself
 * unless it is very sure:
 *   score < CONFIDENT_NO            → drop (Jev very confident, rules or not)
 *   CONFIDENT_NO <= score < SOFT    → drop only if the rules found NO positive
 *                                     signal for that dimension; otherwise keep
 *   score >= SOFT                   → fine
 * `support` = { vacancy, student, kz }: truthy when the rules back that dimension
 * (student: a positive student signal; vacancy: the parser accepted the post;
 * kz: a Kazakhstan city or tenge pay). Returns
 *   { reject: reason|null, dim, score, confident, rulesAgree, notes: [..] }
 * `notes` lists every dimension where Jev leaned "no" (for the run log).
 */
function decideVerdict(verdict, support = {}) {
  const out = { reject: null, dim: null, score: null, confident: false, rulesAgree: false, notes: [] };
  if (!verdict) return out;
  for (const [key, dim, reason] of DIMS) {
    const sc = verdict[key];
    if (sc === null || sc === undefined) continue;
    if (sc < cfg.CONFIDENT_NO[key]) {
      out.notes.push(`${dim}=${sc.toFixed(2)}<${cfg.CONFIDENT_NO[key]} confident`);
      if (!out.reject || sc < out.score) Object.assign(out, { reject: reason, dim, score: sc, confident: true, rulesAgree: !support[dim] });
    } else if (sc < cfg.SOFT[key]) {
      if (support[dim]) out.notes.push(`${dim}=${sc.toFixed(2)}<${cfg.SOFT[key]} kept: rules ${typeof support[dim] === 'string' ? support[dim] : 'support'}`);
      else {
        out.notes.push(`${dim}=${sc.toFixed(2)}<${cfg.SOFT[key]} no rule support`);
        if (!out.reject) Object.assign(out, { reject: reason, dim, score: sc, confident: false, rulesAgree: true });
      }
    }
  }
  return out;
}

/**
 * Apply a verdict to a parsed job. Returns a reject reason, or null to keep.
 * Mutates `parsed` (title / company / apply) when Jev chose a candidate.
 * opts.support feeds decideVerdict; opts.out (object) receives the decision.
 */
function applyVerdict(parsed, verdict, judge, opts = {}) {
  if (!verdict) return null;
  const reject = (r) => { if (judge) judge.stats.rejected[r] = (judge.stats.rejected[r] || 0) + 1; return r; };
  const decision = decideVerdict(verdict, opts.support || { vacancy: true });
  if (opts.out) opts.out.decision = decision;
  if (decision.reject) return reject(decision.reject);

  const bump = (k) => { if (judge) judge.stats.overrides[k]++; };

  // Apply target: Jev picks among the rule-extracted candidates.
  const cands = (parsed._apply && parsed._apply.candidates) || [];
  if (verdict.applyId) {
    if (verdict.applyId === 'none') {
      // Jev says nothing listed is an application route. Keep the rules' pick
      // only when it sat next to an explicit apply cue; otherwise the post URL.
      const top = parsed._apply.chosen;
      if (!top || !top.cue) {
        if (parsed.source_type !== 'telegram_post') bump('apply');
        parsed.apply_url = parsed.source_url; parsed.source_type = 'telegram_post';
      }
    } else {
      const c = cands.find((x) => x.id === verdict.applyId);
      if (c && c.apply_url !== parsed.apply_url) { parsed.apply_url = c.apply_url; parsed.source_type = c.source_type; bump('apply'); }
    }
  }
  const titles = (parsed._candidates && parsed._candidates.titles) || [];
  if (verdict.titleId && verdict.titleId !== 'none') {
    const t = titles[Number(String(verdict.titleId).slice(1))];
    if (t && t !== parsed.title) { parsed.title = t; bump('title'); }
  }
  const companies = (parsed._candidates && parsed._candidates.companies) || [];
  if (verdict.employerId && verdict.employerId !== 'none') {
    const c = companies[Number(String(verdict.employerId).slice(1))];
    if (c && c !== parsed.company) { parsed.company = c; parsed._companyFromPost = true; bump('company'); }
  }
  return null;
}

module.exports = { createJudge, applyVerdict, decideVerdict, buildRequest, scrub };
