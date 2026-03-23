# 🚀 SteppeUp v2 Quick Start (4 Steps, 5 Minutes)

Everything is deployed. Just activate it.

---

## Step 1: SQL Migration (2 min)

```
1. Go to: https://supabase.com/dashboard/project/wiijdddhzddqgntfdbsx/sql/new
2. Copy setup-v2-migration.sql (entire file)
3. Paste into the editor
4. Click Run ✓
```

**Creates**:
- `community_submissions` table
- `telegram_channels` table (11 KZ channels pre-seeded)
- `channel_suggestions` table

---

## Step 2: Telegram Bot (1 min, Optional)

```
1. Open Telegram app
2. Search: @BotFather
3. Send: /newbot
4. Name: SteppeUp Jobs
5. Username: steppeup_jobs_bot (pick unique one)
6. Copy token (save it)
```

---

## Step 3: GitHub Secret (1 min)

```
1. Go to: https://github.com/zapadgnil-netizen/steppeup-scraper/settings/secrets/actions
2. Click: New repository secret
3. Name: TELEGRAM_BOT_TOKEN
4. Value: (paste token from step 2)
5. Click: Add secret ✓
```

---

## Step 4: Test Scraper (2 min)

```
1. Go to: https://github.com/zapadgnil-netizen/steppeup-scraper/actions
2. Click: Daily Scrape (left sidebar)
3. Click: Run workflow (top right)
4. Click: Run workflow (confirm)
5. Wait 2-3 min, check logs
```

**Expected output**:
```
✓ hh.kz          50+ jobs
✓ enbek.kz       20+ jobs
✓ telegram       100+ jobs
✓ linkedin       30+ jobs
✓ google         50+ jobs
✓ community      0-N jobs
... (all 9 sources)
```

---

## ✅ Done!

Your SteppeUp marketplace is now:

- 🔴 **Live at**: https://steppeup-scraper.vercel.app
- 🔥 **9 job sources** running automatically
- 💬 **Community submit** button active (green button on browse page)
- 🤖 **Daily scraping** enabled (midnight UTC)

---

## 📱 Users Can Now:

1. **Browse** jobs from 9 sources
2. **Search** by title/company
3. **Filter** by city, type, experience, etc.
4. **Save** favorite jobs
5. **Match** skills with jobs
6. **Submit** jobs they find (Instagram, Telegram, WhatsApp, etc.)

---

## 🎯 How Community Submit Works:

**User clicks** green button on browse page
→ **Modal opens** (3 fields required: title, URL; optional: company, location, note)
→ **Submits** → **Goes to** `community_submissions` table
→ **Next scraper run** → **Auto-approved** if it's a real job post
→ **Appears** in browse page alongside other 8 sources

---

**All set!** 🎉
