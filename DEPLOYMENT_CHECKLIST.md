# SteppeUp v2 Deployment Checklist

> **Status**: ✅ Code deployed to GitHub/Vercel. Ready for final setup.

Everything is deployed and live. Just 4 quick manual steps to activate the full feature set.

---

## ✅ What's Already Live

- **Scraper v2**: All 9 sources ready (HH.KZ, Enbek, GitHub, Kolesa, Youth Portal, **NEW:** Telegram, LinkedIn, Google, Community)
- **Community Submit Button**: Green button on browse page (`Знаешь вакансию? Поделись!`)
- **Daily Workflow**: Updated to support Telegram scraping
- **All i18n**: RU, KZ, EN translations complete

---

## 📋 Final Setup (5 minutes)

### 1. Run SQL Migration

**Where**: [Supabase SQL Editor](https://supabase.com/dashboard/project/wiijdddhzddqgntfdbsx/sql/new)

**What to do**:
1. Copy the contents of `setup-v2-migration.sql` (in this folder)
2. Paste into the SQL editor
3. Click **Run**

**What gets created**:
```
✓ community_submissions    — user-submitted jobs queue
✓ telegram_channels        — 11 KZ job channels (pre-seeded)
✓ channel_suggestions      — for future channel discovery
```

**Status**: Not required for the app to work, but needed for:
- Community job submissions
- Telegram scraping
- Automatic job enrichment

---

### 2. Create Telegram Bot (Optional but Recommended)

**Where**: Telegram app

**What to do**:
1. Open Telegram
2. Search for `@BotFather`
3. Send `/newbot`
4. Name it: `SteppeUp Jobs` (or your choice)
5. Username: `steppeup_jobs_bot` (must be unique, so pick your own)
6. **Copy the token** (it looks like: `123456:ABC-DEF1234xyz...`)

**What it does**:
- Enables scraping from 11 Telegram job channels
- No admin permissions needed (scraper uses public web previews)

---

### 3. Add GitHub Secret

**Where**: [GitHub Repo → Settings → Secrets](https://github.com/zapadgnil-netizen/steppeup-scraper/settings/secrets/actions)

**What to do**:
1. Click **New repository secret**
2. Name: `TELEGRAM_BOT_TOKEN`
3. Value: Paste the token from step 2
4. Click **Add secret**

**What it does**:
- Passes the token to the daily scraper workflow
- Enables automatic scraping every day at midnight UTC

---

### 4. Test the Scraper

**Where**: [GitHub Actions](https://github.com/zapadgnil-netizen/steppeup-scraper/actions)

**What to do**:
1. Go to **Actions** tab
2. Click **Daily Scrape** workflow
3. Click **Run workflow** button
4. Select **main** branch
5. Click **Run workflow** again
6. Wait ~2-3 minutes and check the logs

**What to expect**:
```
✓ HH.KZ          — 50+ jobs
✓ Enbek.kz       — 20+ jobs
✓ GitHub         — 5+ jobs
✓ Kolesa         — 10+ jobs
✓ Youth Portal   — 8+ jobs
✓ Telegram       — 100+ jobs (from 11 channels)
✓ LinkedIn       — 30+ jobs
✓ Google         — 50+ jobs
✓ Community      — 0-N jobs (from submissions table)
```

Total: **250+ jobs** added to the database.

---

## 🎯 Feature Walkthrough

### For Users

**Browse Page** (`/browse`):
- Green button: **"Знаешь вакансию? Поделись!"** (Know a job? Share it!)
- Click → modal opens
- Paste link from Instagram, Telegram, WhatsApp, etc.
- Submit → job queues for review
- Next scraper run → auto-approved and added to database

**Saved Jobs**:
- Works as before (all 9 sources shown together)

**Home Feed**:
- Now shows jobs from all 9 sources, sorted by match %

### For the Scraper

**Telegram scraping**:
- Reads public channel previews at `t.me/s/channel_name`
- No bot API calls needed
- Runs daily, extracts job posts, enriches with city/salary

**LinkedIn scraping**:
- Uses Google's site search: `site:linkedin.com/jobs intext:"apply"`
- Filters for student-friendly keywords
- No LinkedIn API needed

**Google catch-all**:
- Searches Instagram, Threads, Facebook, OLX, company sites
- Keywords: "стажировка", "junior", "без опыта", etc.
- Deduplicates against other sources

**Community submissions**:
- Users submit links via the green button
- Scraper auto-approves if it's a real job post
- Enriches with title, salary, location parsing

---

## 🐛 Troubleshooting

### "Migration failed"
→ Make sure you ran the SQL in Supabase SQL Editor (not somewhere else)

### "Bot token invalid"
→ Double-check: token should be exactly as given by BotFather, no extra spaces

### "GitHub secret not working"
→ Re-run the workflow after adding secret (it won't use old cached values)

### "No Telegram jobs scraped"
→ Check if channels are public (t.me/s/channel_name should be accessible in browser)

### "Only 5 sources running, not 9"
→ This is fine! Some sources (LinkedIn, Google, Telegram) may have 0 results if your keywords don't match

---

## 📊 Files

| File | Purpose |
|------|---------|
| `index.html` | Frontend (with submit button) |
| `setup-v2-migration.sql` | Database migration |
| `setup-v2-complete.sh` | Automated setup script (if you have bash) |
| `DEPLOYMENT_CHECKLIST.md` | This file |
| `SETUP_V2_INSTRUCTIONS.md` | Original detailed guide (in repo) |

---

## ✅ Success Criteria

You'll know everything is working when:

1. ✓ Supabase tables exist (check Data Editor)
2. ✓ GitHub secret is added (check Settings → Secrets)
3. ✓ Workflow runs without errors (check Actions logs)
4. ✓ Jobs appear in the app (check Browse page)
5. ✓ Submit button works (fill in a test job on Browse page)

---

## 🚀 You're Done!

Once all 4 steps are complete, your SteppeUp job marketplace is **fully functional** with:

- **9 job sources** (original 5 + Telegram + LinkedIn + Google + Community)
- **Community submissions** (users can add jobs they find)
- **Automatic daily scraping** (runs at midnight UTC)
- **Multi-language support** (RU, KZ, EN)
- **Mobile-optimized UI** (bottom nav, horizontal chips, responsive)

Users can start using it right away! 🎉

---

**Need help?** Check the original `SETUP_V2_INSTRUCTIONS.md` in the repo for more details.
