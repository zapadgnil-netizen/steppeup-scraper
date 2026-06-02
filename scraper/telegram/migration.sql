-- ════════════════════════════════════════════════════════════════════════
--  SteppeUp — Telegram scraper migration
--  Run ONCE in Supabase SQL Editor (Dashboard → SQL Editor → paste → Run).
--  Safe to re-run: every statement is idempotent (IF NOT EXISTS).
-- ════════════════════════════════════════════════════════════════════════

-- ── OPTION A (RECOMMENDED, what the scraper uses) ───────────────────────────
-- Extend the existing `jobs` table with Telegram-specific columns. This keeps
-- one unified table, so the frontend, match engine, and student-suitability
-- filter all keep working with zero changes.

ALTER TABLE jobs ADD COLUMN IF NOT EXISTS apply_url      TEXT;   -- external application link (job portal / form / email)
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS source_channel TEXT;   -- e.g. 'kbtucareer' (without @)
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS raw_text       TEXT;   -- full original post text, for reprocessing/debugging
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS source_type    TEXT;   -- 'external_link' | 'telegram_direct'

-- Helpful indexes for dedup-by-apply_url and channel filtering
CREATE INDEX IF NOT EXISTS idx_jobs_apply_url      ON jobs(apply_url);
CREATE INDEX IF NOT EXISTS idx_jobs_source_channel ON jobs(source_channel);

-- The scraper writes source = 'telegram_career' so these curated career-center
-- jobs are distinguishable from the older low-quality 'telegram' feed.


-- ── OPTION B (ALTERNATIVE, separate table) ─────────────────────────────────
-- If you would rather isolate Telegram jobs, create a dedicated table instead.
-- NOTE: choosing this means the frontend must query and merge TWO tables, and
-- the match engine + student filter must be re-pointed. Not recommended.
--
-- CREATE TABLE IF NOT EXISTS telegram_jobs (
--   id             BIGSERIAL PRIMARY KEY,
--   source_id      TEXT NOT NULL UNIQUE,         -- 'tg_<channel>_<msgId>'
--   source_channel TEXT NOT NULL,                -- 'kbtucareer'
--   source_url     TEXT NOT NULL,                -- the t.me/<channel>/<msgId> post URL
--   apply_url      TEXT,                          -- external application link
--   source_type    TEXT DEFAULT 'telegram_direct',-- 'external_link' | 'telegram_direct'
--   title          TEXT NOT NULL,
--   company        TEXT DEFAULT 'Unknown',
--   location       TEXT DEFAULT 'Kazakhstan',
--   description    TEXT,
--   raw_text       TEXT,
--   salary_min     INTEGER,
--   salary_max     INTEGER,
--   currency       TEXT DEFAULT 'KZT',
--   tags           TEXT[],
--   skills         TEXT[],
--   type           TEXT,                          -- 'internship' | 'part-time' | ...
--   status         TEXT DEFAULT 'active',
--   posted_at      TIMESTAMPTZ DEFAULT NOW(),
--   created_at     TIMESTAMPTZ DEFAULT NOW()
-- );
-- ALTER TABLE telegram_jobs ENABLE ROW LEVEL SECURITY;
-- CREATE POLICY "Public read telegram_jobs" ON telegram_jobs FOR SELECT USING (status = 'active');
-- CREATE POLICY "Service role full access tg" ON telegram_jobs FOR ALL USING (auth.role() = 'service_role');
