-- ═══════════════════════════════════════════════════════════
--  SteppeUp v2 — New Tables for Social Scraping
--  Run this in Supabase SQL Editor AFTER setup-database.sql
-- ═══════════════════════════════════════════════════════════

-- ── Community Submissions ────────────────────────────────────
-- Users can submit job links they find on Instagram, WhatsApp,
-- Telegram, Threads, etc. The scraper auto-approves valid ones.
CREATE TABLE IF NOT EXISTS community_submissions (
  id          UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  title       TEXT NOT NULL,
  company     TEXT,
  location    TEXT,
  description TEXT,
  source_url  TEXT NOT NULL,
  tags        TEXT[],
  submitted_by TEXT,                    -- anonymous user fingerprint or name
  status      TEXT DEFAULT 'pending',   -- 'pending' | 'approved' | 'rejected'
  review_note TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_submissions_status ON community_submissions(status);
CREATE INDEX IF NOT EXISTS idx_submissions_created ON community_submissions(created_at DESC);

-- RLS: Anyone can submit, only service role can update
ALTER TABLE community_submissions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can submit jobs"
  ON community_submissions FOR INSERT
  WITH CHECK (true);

CREATE POLICY "Anyone can read approved"
  ON community_submissions FOR SELECT
  USING (true);

CREATE POLICY "Service role manages submissions"
  ON community_submissions FOR ALL
  USING (auth.role() = 'service_role');


-- ── Telegram Channel Registry ────────────────────────────────
-- Track which channels we're scraping and their health stats
CREATE TABLE IF NOT EXISTS telegram_channels (
  id          UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  channel_username TEXT NOT NULL UNIQUE,  -- e.g. 'rabota_almaty'
  channel_title    TEXT,
  category    TEXT DEFAULT 'general',     -- 'general' | 'it' | 'student' | 'freelance'
  city        TEXT,                       -- primary city if location-specific
  is_active   BOOLEAN DEFAULT true,
  jobs_found  INTEGER DEFAULT 0,         -- running total
  last_scraped TIMESTAMPTZ,
  added_by    TEXT DEFAULT 'system',     -- 'system' or user who suggested it
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE telegram_channels ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Public read channels"
  ON telegram_channels FOR SELECT
  USING (true);

CREATE POLICY "Service role manage channels"
  ON telegram_channels FOR ALL
  USING (auth.role() = 'service_role');

-- Seed with known KZ job channels
INSERT INTO telegram_channels (channel_username, channel_title, category, city) VALUES
  ('rabota_almaty', 'Работа Алматы', 'general', 'Almaty'),
  ('rabota_astana_kz', 'Работа Астана', 'general', 'Astana'),
  ('jobs_kz', 'Jobs KZ', 'general', NULL),
  ('vakansii_almaty', 'Вакансии Алматы', 'general', 'Almaty'),
  ('vakansii_astana', 'Вакансии Астана', 'general', 'Astana'),
  ('it_jobs_kz', 'IT Jobs KZ', 'it', NULL),
  ('devkz', 'Dev KZ', 'it', NULL),
  ('kz_it_jobs', 'KZ IT Jobs', 'it', NULL),
  ('freelance_kz', 'Freelance KZ', 'freelance', NULL),
  ('podrabotka_almaty', 'Подработка Алматы', 'student', 'Almaty'),
  ('podrabotka_astana', 'Подработка Астана', 'student', 'Astana')
ON CONFLICT (channel_username) DO NOTHING;


-- ── Channel Suggestion (users can suggest new channels) ──────
CREATE TABLE IF NOT EXISTS channel_suggestions (
  id          UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  channel_url TEXT NOT NULL,
  suggested_by TEXT,
  status      TEXT DEFAULT 'pending',
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE channel_suggestions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can suggest channels"
  ON channel_suggestions FOR INSERT
  WITH CHECK (true);

CREATE POLICY "Service role manage suggestions"
  ON channel_suggestions FOR ALL
  USING (auth.role() = 'service_role');
