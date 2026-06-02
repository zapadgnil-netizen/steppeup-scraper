# SteppeUp — Telegram Career-Channel Scraper

Pulls job/internship posts from Kazakhstan university career-center Telegram
channels and feeds **student-suitable** listings into the existing Supabase
`jobs` table. Zero cost, no Telegram API key, deterministic parsing (no AI).

## How it works

It scrapes the public web preview `https://t.me/s/<channel>` — no auth, no API
key. Each post is parsed with regex + keyword dictionaries, run through a
student-suitability gate, deduplicated, and upserted.

```
fetcher.js  →  parser.js  →  (student gate)  →  inserter.js  →  Supabase jobs
   network      text→job        index.js          dedup+upsert
```

| File | Responsibility |
|------|----------------|
| `channels.js` | The list of channels to scrape |
| `fetcher.js`  | Network only: fetch `t.me/s/`, UA rotation, retries, extract raw posts |
| `parser.js`   | `parsePost(rawPost)` → structured job (the **swap point** for AI later) |
| `inserter.js` | Dedup (apply_url + title/company) and upsert |
| `index.js`    | Orchestrator: loop channels → parse → filter → dedup → insert → log |
| `migration.sql` | One-time Supabase schema change |

## Setup (one time)

1. Run `migration.sql` in the Supabase SQL Editor (adds `apply_url`,
   `source_channel`, `raw_text`, `source_type` columns to `jobs`).
2. Ensure repo secrets `SUPABASE_URL` and `SUPABASE_SERVICE_KEY` exist
   (Settings → Secrets and variables → Actions). The main scraper already uses these.
3. The workflow at `.github/workflows/telegram-scrape.yml` runs every 8 hours.

## Running locally

```bash
cd scraper
npm install
node telegram/index.js --dry-run    # fetch + parse, print results, NO DB writes
node telegram/index.js              # live (needs the two SUPABASE_* env vars)
```

## Add / remove a channel

Edit `channels.js`. To **add**, append a line:

```js
{ username: 'some_channel', label: 'Some Career Center', focus: 'it', enabled: true },
```

`username` is the @handle without the `@`. To **remove**, delete the line or set
`enabled: false`. Verify a channel is scrapable by opening `https://t.me/s/<username>`
in a browser — if you see posts there, the scraper can read them. (Channels with
no public preview, like `center_career_iitu` currently, simply return 0 posts.)

## Adjust scrape frequency

Edit the `cron` in `.github/workflows/telegram-scrape.yml`. Examples:

- `0 */8 * * *` — every 8 hours (default)
- `0 */6 * * *` — every 6 hours
- `0 6,18 * * *` — twice a day at 06:00 and 18:00 UTC (Almaty is UTC+5)

## The `apply_url` rule

The parser extracts the **external** application link (job portal, company page,
Google Form, etc.) and stores it as `apply_url` with `source_type: 'external_link'`.
If a post has no external link, it stores the Telegram post URL as a fallback and
flags it `source_type: 'telegram_direct'`. The frontend links the job card to
`apply_url` when present.

## Student-suitability gate

`index.js → studentRejectReason()` drops posts that require experience, are
senior/management roles, restrict by age/gender, or exclude students. It mirrors
the gate in `scrape-jobs.js` and the client-side `isStudentSuitable` in
`index.html`. **If you change one, change all three.** (Note: JS `\b` does not
work before Cyrillic, so Cyrillic title terms are matched as plain substrings.)

## Debugging failed parses

- Run `--dry-run` and read the per-channel line: `[channel] N posts → M jobs (K filtered)`.
  - `0 posts` → channel has no public preview or handle is wrong.
  - `posts but 0 jobs` → posts aren't vacancies (events/news) or `isVacancy()` is too strict.
- To inspect one channel's raw output, in a Node REPL:
  ```js
  const { fetchChannel } = require('./fetcher');
  const { parsePost } = require('./parser');
  fetchChannel('kbtucareer').then(ps => ps.forEach(p => console.log(parsePost(p))));
  ```
- Each stored job keeps `raw_text` (full original post) so you can re-run the
  parser offline against real text without re-scraping.
- Run history is written to the `scraping_logs` table (`source = 'telegram_career'`).

## Swapping in an AI parser later

Replace the body of `parsePost(rawPost)` in `parser.js`. Keep the same input
(`{ channel, msgId, postUrl, dateISO, text, links }`) and output shape (the job
object). Nothing else in the pipeline changes.

## Notes

- New jobs use `source: 'telegram_career'` — distinct from the older low-quality
  `'telegram'` feed, so you can filter or retire that separately.
- Multi-vacancy posts are parsed as a single job (title from the first role).
  Splitting them is a future enhancement.
```
