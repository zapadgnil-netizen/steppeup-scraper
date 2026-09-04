# SteppeUp scraper v2 — contract

Read this before touching anything under `scraper/`.

## Why v2 exists

Every incident so far had the same shape: a source silently produced 0 rows (or
cleanup silently deleted rows) while the GitHub Actions run stayed green.
Examples: api.hh.ru 403 treated as "job dead"; `vacancy-archived` grepped from
JS bundles; upserts failing on a missing unique index; and most recently hh.kz
HTML-entity-encoding its embedded JSON (`&#34;`) so `JSON.parse` threw and the
hh source returned **zero jobs every day for weeks** while 33 Telegram posts kept
the health gate above 25.

v2 rules, in priority order:

1. **A source that produces nothing must fail loudly, never quietly.** Every
   source declares a minimum expected yield; below it the run is marked
   `degraded` and the failure reason is printed in the first 20 lines of the log
   and pushed to the alert channel.
2. **Never delete on ambiguity.** Only definitive signals deactivate a job
   (404/410, structured "archived" flag, age past a per-source TTL).
3. **One filter, one normalizer.** `lib/filter.js` and `lib/normalize.js` are
   the only places that decide "is this a student job" and "what does a job row
   look like". Sources must not reimplement them.
4. **Parsers are tested against saved fixtures**, so a page-shape change shows
   up as a red test, not as an empty board.

## Source module contract

Each source lives at `scraper/sources/<name>.js` and exports:

```js
module.exports = {
  name: 'hh_kz',                 // value written to jobs.source
  minExpected: 30,               // below this the run is 'degraded' (0 = optional source)
  ttlDays: 21,                   // cleanup deactivates rows older than this
  async scrape(ctx) -> { jobs: Job[], stats: object, notes: string[] },
  async canary(ctx) -> { ok: boolean, reason?: string },   // cheap self-test: "can I still parse this site?"
  async verify(ctx, row) -> 'alive' | 'dead' | 'unknown',  // optional per-row liveness for cleanup
};
```

`ctx` = `{ http, log, filter, normalize, limits: { maxJobs, maxPages }, dryRun }`
— all from `lib/`. Sources must use `ctx.http` (retry/timeout/UA rotation/entity
decoding built in) and must not import `node-fetch` directly.

`Job` is whatever `normalize.makeJob({...})` returns. Sources pass raw fields;
`makeJob` cleans title/company/location, validates, and rejects garbage
(returns `null`). Sources must only push non-null results.

Required raw fields for `makeJob`: `source, source_id, source_url, title`.
Optional: `company, location, description, salary_min, salary_max, currency,
tags[], posted_at, apply_url, source_type, source_channel, raw_text,
company_logo`.

## Orchestrator (`scrape-jobs.js`)

- Runs `canary()` for every source first. A failed canary is reported but the
  source's `scrape()` still runs (the canary is diagnostic, not a gate).
- Runs sources concurrently, each wrapped so one crash can't sink the run.
- Applies `filter.isStudentFriendly` (sources may pre-filter but the orchestrator
  is the authority).
- Upserts via `lib/db.js` (batch → per-row fallback → verify), then writes one
  `scraping_logs` row per source **and** one summary row, then evaluates health:
  - any source below `minExpected` → `degraded`
  - active count on board < `MIN_ACTIVE_HEALTHY` → `failed`
  - `degraded` exits 0 but alerts; `failed` exits 1 (GitHub emails) and alerts.
- Alerts go through `lib/health.notify()` — Telegram bot if
  `ALERT_TELEGRAM_BOT_TOKEN` + `ALERT_TELEGRAM_CHAT_ID` are set, else stdout.

## Cleanup (`cleanup-jobs.js`)

- Pass 1: per-source TTL expiry (uses each source's `ttlDays`; `partner` exempt).
- Pass 2: per-row `verify()` for sources that implement it, with the mass-kill
  circuit breaker (>40% dead of ≥20 checked → abort, alert).
- Pass 3: self-heal — recently-deactivated rows that `verify()` says are alive
  come back.
- Pass 4: garbage sweep — active rows that fail `normalize.validateJob()` or
  `filter` under current rules get deactivated (bounded per run, reported).

## Testing

`npm test` runs `node --test tests/`. Fixtures under `tests/fixtures/` are real
saved pages. Add a fixture whenever you rely on a page shape.
