/**
 * SteppeUp Job Scraper v2
 * Runs daily via GitHub Actions (free). Scrapes KZ job sites + social platforms
 * for student-friendly positions, upserts to Supabase, and removes stale listings.
 *
 * Sources:
 *   1. hh.kz (HeadHunter) — public API, no auth needed
 *   2. enbek.kz — government employment portal
 *   3. GitHub Jobs (KZ-related tech)
 *   4. Kolesa Group careers (via hh.kz employer API — their site blocks datacenter IPs)
 *   5. Youth employment portal
 *   ── NEW ──────────────────────────────────
 *   6. Telegram channels — public KZ job channels via Bot API
 *   7. JSearch (RapidAPI) — aggregates LinkedIn + Indeed + Glassdoor,
 *      filtered to internships & entry-level in Kazakhstan only.
 *      Free tier: 200 req/month (~6 queries/day, fits perfectly).
 *      Requires JSEARCH_API_KEY secret in GitHub Actions.
 *   8. Community submissions — user-submitted jobs from Supabase queue
 */

const fetch = require('node-fetch');
const cheerio = require('cheerio');
const { createClient } = require('@supabase/supabase-js');

// ── Config ────────────────────────────────────────────────────
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const JSEARCH_API_KEY   = process.env.JSEARCH_API_KEY || '';
const DRY_RUN = process.argv.includes('--dry-run');

if (!DRY_RUN && (!SUPABASE_URL || !SUPABASE_KEY)) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY env vars');
  process.exit(1);
}

const db = DRY_RUN ? null : createClient(SUPABASE_URL, SUPABASE_KEY);

// Student-friendly keywords (RU + EN)
const STUDENT_KEYWORDS_RU = [
  'стажер', 'стажёр', 'стажировка', 'junior', 'джуниор', 'начинающий',
  'без опыта', 'студент', 'практика', 'intern', 'trainee', 'entry level',
  'помощник', 'ассистент', 'частичная занятость', 'подработка', 'гибкий график'
];

const STUDENT_KEYWORDS_EN = [
  'intern', 'internship', 'junior', 'entry level', 'entry-level', 'graduate',
  'trainee', 'assistant', 'part-time', 'student', 'no experience', 'starter',
  'associate', 'fresh graduate', 'beginner'
];

const ALL_KEYWORDS = [...STUDENT_KEYWORDS_RU, ...STUDENT_KEYWORDS_EN];

// Negative keywords that disqualify a job from being student-friendly
const NON_STUDENT_KEYWORDS = [
  'senior', 'сеньор', 'синьор', 'middle', 'мидл', 'lead', 'руководитель',
  'начальник', 'директор', 'главный', 'эксперт', 'expert', 'head',
  'опыт от 1', 'опыт от 2', 'опыт от 3', 'опыт работы от 1', 'опыт работы от 2',
  'опыт работы от 3', 'от 1 года', 'от 2 лет', 'от 3 лет', 'от 3-х лет',
  'коммерческий опыт', 'опыт коммерческой'
];

// Kazakhstan city mapping
const KZ_CITIES = {
  160: 'Almaty', 159: 'Astana', 181: 'Karaganda', 182: 'Shymkent',
  183: 'Aktobe', 184: 'Atyrau', 185: 'Kostanay', 186: 'Pavlodar',
  187: 'Semey', 188: 'Ust-Kamenogorsk', 189: 'Oral', 190: 'Aktau',
  191: 'Taraz', 192: 'Petropavlovsk', 193: 'Kyzylorda', 194: 'Turkestan',
  195: 'Taldykorgan', 196: 'Ekibastuz', 197: 'Temirtau', 198: 'Rudny'
};

// KZ city names for detecting location in unstructured text
const KZ_CITY_NAMES = [
  'almaty', 'алматы', 'астана', 'astana', 'нур-султан', 'nur-sultan',
  'караганда', 'karaganda', 'шымкент', 'shymkent', 'актобе', 'aktobe',
  'атырау', 'atyrau', 'костанай', 'kostanay', 'павлодар', 'pavlodar',
  'семей', 'semey', 'усть-каменогорск', 'актау', 'aktau', 'тараз', 'taraz',
  'петропавловск', 'кызылорда', 'туркестан', 'талдыкорган', 'экибастуз',
  'рудный', 'удаленно', 'remote', 'удалённо', 'дистанционно'
];

// ── Helpers ───────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function isStudentFriendly(title, description, tags = []) {
  const titleText = (title || '').toLowerCase();
  const fullText = `${title} ${description || ''} ${tags.join(' ')}`.toLowerCase();

  if (['senior', 'middle', 'lead', 'сеньор', 'мидл', 'ведущий', 'руководитель', 'директор', 'главный', 'head', 'эксперт'].some(kw => titleText.includes(kw))) {
    return false;
  }

  if (NON_STUDENT_KEYWORDS.some(kw => fullText.includes(kw))) {
    if (!fullText.includes('без опыта') && !fullText.includes('опыт не требуется')) {
      return false;
    }
  }

  return ALL_KEYWORDS.some(kw => fullText.includes(kw));
}

function extractSalary(salaryObj) {
  if (!salaryObj) return { min: null, max: null, currency: 'KZT' };
  return {
    min: salaryObj.from || null,
    max: salaryObj.to || null,
    currency: salaryObj.currency || 'KZT'
  };
}

function cleanHtml(html) {
  if (!html) return '';
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 5000);
}

const log = (src, msg) => console.log(`[${src}] ${msg}`);

/**
 * Extract city from unstructured text (for Telegram/social posts)
 */
function extractCity(text) {
  const lower = (text || '').toLowerCase();
  for (const city of KZ_CITY_NAMES) {
    if (lower.includes(city)) {
      // Return capitalized version
      if (city === 'удаленно' || city === 'remote' || city === 'удалённо' || city === 'дистанционно') return 'Remote';
      return city.charAt(0).toUpperCase() + city.slice(1);
    }
  }
  return 'Kazakhstan';
}

/**
 * Extract salary from unstructured text (handles "от 150 000" / "150-300k" / etc.)
 */
function extractSalaryFromText(text) {
  if (!text) return { min: null, max: null, currency: 'KZT' };

  // Detect currency
  let currency = 'KZT';
  if (/\$|usd|долл/i.test(text)) currency = 'USD';
  else if (/€|eur|евро/i.test(text)) currency = 'EUR';
  else if (/₽|rub|руб/i.test(text)) currency = 'RUB';

  // Pattern: "от 150 000 до 300 000" or "150000-300000"
  const rangeMatch = text.match(/(?:от\s*)?(\d[\d\s]{2,})\s*(?:[-–—до]+)\s*(\d[\d\s]{2,})/i);
  if (rangeMatch) {
    return {
      min: parseInt(rangeMatch[1].replace(/\s/g, '')),
      max: parseInt(rangeMatch[2].replace(/\s/g, '')),
      currency
    };
  }

  // Pattern: "от 150 000" (just minimum)
  const fromMatch = text.match(/от\s*(\d[\d\s]{2,})/i);
  if (fromMatch) {
    return { min: parseInt(fromMatch[1].replace(/\s/g, '')), max: null, currency };
  }

  // Pattern: "до 300 000" (just maximum)
  const toMatch = text.match(/до\s*(\d[\d\s]{2,})/i);
  if (toMatch) {
    return { min: null, max: parseInt(toMatch[1].replace(/\s/g, '')), currency };
  }

  // Pattern: standalone number like "200000 тенге"
  const singleMatch = text.match(/(\d{5,})\s*(?:тг|тенге|kzt|₸)/i);
  if (singleMatch) {
    return { min: parseInt(singleMatch[1]), max: parseInt(singleMatch[1]), currency: 'KZT' };
  }

  return { min: null, max: null, currency };
}

/**
 * Check if a Telegram message looks like a job posting
 * (not just chat noise or news)
 */
function looksLikeJobPost(text) {
  const lower = (text || '').toLowerCase();
  const jobSignals = [
    'вакансия', 'ищем', 'требуется', 'набираем', 'открыта позиция',
    'hiring', 'we are looking', 'job opening', 'vacancy', 'position open',
    'приглашаем', 'нужен', 'нужна', 'ищу сотрудника', 'оплата',
    'зарплата', 'з/п', 'оклад', 'salary', 'резюме', 'откликнуться',
    'обязанности', 'требования', 'условия', 'график работы',
    'responsibilities', 'requirements', 'apply', 'отправляйте',
    'стажер', 'стажировка', 'intern', 'trainee', 'junior'
  ];
  // Need at least 2 job signals to qualify (reduces false positives)
  const matches = jobSignals.filter(s => lower.includes(s));
  return matches.length >= 2;
}

// ══════════════════════════════════════════════════════════════
//  Source 1: HeadHunter (hh.kz)
// ══════════════════════════════════════════════════════════════
async function scrapeHH() {
  const jobs = [];
  const queries = [
    'стажер', 'стажировка', 'junior', 'intern', 'студент',
    'без опыта', 'начинающий', 'подработка'
  ];

  for (const query of queries) {
    try {
      const url = `https://api.hh.ru/vacancies?area=40&text=${encodeURIComponent(query)}&per_page=50&order_by=publication_time&period=3`;
      const res = await fetch(url, {
        headers: { 'User-Agent': 'SteppeUp-Bot/1.0 (student-jobs-kz)' }
      });

      if (!res.ok) {
        log('hh.kz', `Query "${query}" failed: ${res.status}`);
        continue;
      }

      const data = await res.json();
      for (const v of (data.items || [])) {
        let description = v.snippet?.responsibility || v.snippet?.requirement || '';
        try {
          const detailRes = await fetch(`https://api.hh.ru/vacancies/${v.id}`, {
            headers: { 'User-Agent': 'SteppeUp-Bot/1.0 (student-jobs-kz)' }
          });
          if (detailRes.ok) {
            const detail = await detailRes.json();
            description = cleanHtml(detail.description) || description;
          }
        } catch (e) { /* use snippet */ }

        const salary = extractSalary(v.salary);
        const tags = [
          v.schedule?.name,
          v.experience?.name,
          v.employment?.name,
          ...(v.professional_roles || []).map(r => r.name)
        ].filter(Boolean);

        if (!isStudentFriendly(v.name, description, tags)) continue;

        jobs.push({
          source: 'hh_kz',
          source_id: `hh_${v.id}`,
          source_url: (v.alternate_url || `https://hh.kz/vacancy/${v.id}`).replace('hh.ru', 'hh.kz'),
          title: v.name,
          company: v.employer?.name || 'Unknown',
          company_logo: v.employer?.logo_urls?.['90'] || null,
          location: v.area?.name || 'Kazakhstan',
          description,
          salary_min: salary.min,
          salary_max: salary.max,
          currency: salary.currency,
          tags,
          status: 'active',
          posted_at: v.published_at || new Date().toISOString()
        });

        await sleep(200);
      }

      log('hh.kz', `Query "${query}": found ${data.items?.length || 0} vacancies`);
      await sleep(500);
    } catch (e) {
      log('hh.kz', `Error on "${query}": ${e.message}`);
    }
  }

  const seen = new Set();
  const unique = jobs.filter(j => {
    if (seen.has(j.source_id)) return false;
    seen.add(j.source_id);
    return true;
  });

  log('hh.kz', `Total unique jobs: ${unique.length}`);
  return unique;
}

// ══════════════════════════════════════════════════════════════
//  Source 2: Enbek.kz (Government Portal)
// ══════════════════════════════════════════════════════════════
async function scrapeEnbek() {
  const jobs = [];

  try {
    const queries = ['стажер', 'студент', 'junior', 'без опыта'];

    for (const query of queries) {
      try {
        const url = `https://www.enbek.kz/ru/search/vacancy?key=${encodeURIComponent(query)}&sort=date`;
        // AbortController with 15s timeout to prevent enbek.kz ETIMEDOUT hangs (site often down)
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 15000);
        const res = await fetch(url, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; SteppeUp-Bot/1.0)',
            'Accept': 'text/html,application/xhtml+xml',
            'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.8'
          },
          signal: controller.signal
        });
        clearTimeout(timeout);

        if (!res.ok) {
          log('enbek.kz', `Query "${query}" failed: ${res.status}`);
          continue;
        }

        const html = await res.text();
        const $ = cheerio.load(html);

        $('a.vacancy-card, .vacancy-item, [class*="vacancy"]').each((_, el) => {
          const $el = $(el);
          const title = $el.find('h3, .vacancy-title, .title').text().trim() ||
            $el.find('a').first().text().trim();
          const company = $el.find('.company-name, .employer, [class*="company"]').text().trim();
          const location = $el.find('.location, .city, [class*="location"]').text().trim() || 'Kazakhstan';
          const link = $el.attr('href') || $el.find('a').attr('href') || '';
          const fullLink = link.startsWith('http') ? link : `https://www.enbek.kz${link}`;
          const salaryText = $el.find('.salary, [class*="salary"]').text().trim();
          const description = $el.find('.description, .snippet, p').text().trim().slice(0, 5000);

          if (title && title.length > 3 && isStudentFriendly(title, description)) {
            let salaryMin = null, salaryMax = null;
            const salaryMatch = salaryText.match(/(\d[\d\s]*)/g);
            if (salaryMatch) {
              const nums = salaryMatch.map(s => parseInt(s.replace(/\s/g, '')));
              salaryMin = nums[0] || null;
              salaryMax = nums[1] || nums[0] || null;
            }

            jobs.push({
              source: 'enbek_kz',
              source_id: `enbek_${Buffer.from(fullLink).toString('base64').slice(0, 32)}`,
              source_url: fullLink,
              title,
              company: company || 'Enbek.kz Listing',
              company_logo: null,
              location,
              description,
              salary_min: salaryMin,
              salary_max: salaryMax,
              currency: 'KZT',
              tags: ['enbek.kz', 'verified'],
              status: 'active',
              posted_at: new Date().toISOString()
            });
          }
        });

        log('enbek.kz', `Query "${query}": parsed page`);
        await sleep(1000);
      } catch (e) {
        const isTimeout = e.name === 'AbortError' || e.code === 'ETIMEDOUT' || e.code === 'ECONNRESET';
        log('enbek.kz', `${isTimeout ? 'Timeout' : 'Error'} on "${query}": ${e.message}`);
      }
    }
  } catch (e) {
    log('enbek.kz', `Scraper error: ${e.message}`);
  }

  const seen = new Set();
  const unique = jobs.filter(j => {
    if (seen.has(j.source_id)) return false;
    seen.add(j.source_id);
    return true;
  });

  log('enbek.kz', `Total unique jobs: ${unique.length}`);
  return unique;
}

// ══════════════════════════════════════════════════════════════
//  Source 3: GitHub Jobs (KZ tech companies)
// ══════════════════════════════════════════════════════════════
async function scrapeGitHubJobs() {
  const jobs = [];

  try {
    const queries = [
      'label:job location:kazakhstan',
      'hiring intern kazakhstan',
      'вакансия стажер казахстан'
    ];

    for (const query of queries) {
      try {
        const url = `https://api.github.com/search/issues?q=${encodeURIComponent(query + ' is:open')}&sort=created&order=desc&per_page=20`;
        const res = await fetch(url, {
          headers: {
            'User-Agent': 'SteppeUp-Bot/1.0',
            'Accept': 'application/vnd.github.v3+json'
          }
        });

        if (!res.ok) continue;
        const data = await res.json();

        for (const issue of (data.items || [])) {
          const title = issue.title;
          const body = (issue.body || '').slice(0, 5000);
          const labels = (issue.labels || []).map(l => l.name);
          const repoName = issue.repository_url?.split('/').slice(-2).join('/') || '';

          if (isStudentFriendly(title, body)) {
            jobs.push({
              source: 'github_kz',
              source_id: `gh_${issue.id}`,
              source_url: issue.html_url,
              title,
              company: repoName || 'GitHub Listing',
              company_logo: issue.user?.avatar_url || null,
              location: 'Remote / Kazakhstan',
              description: cleanHtml(body),
              salary_min: null,
              salary_max: null,
              currency: 'KZT',
              tags: ['github', 'tech', ...labels],
              status: 'active',
              posted_at: issue.created_at
            });
          }
        }

        log('github', `Query "${query.slice(0, 30)}...": ${data.items?.length || 0} results`);
        await sleep(1000);
      } catch (e) {
        log('github', `Error: ${e.message}`);
      }
    }
  } catch (e) {
    log('github', `Scraper error: ${e.message}`);
  }

  log('github', `Total jobs: ${jobs.length}`);
  return jobs;
}

// ══════════════════════════════════════════════════════════════
//  Source 4: Kolesa Group Careers (via hh.kz employer API)
// ══════════════════════════════════════════════════════════════
// kolesa.group is a Nuxt.js SPA that serves empty __NUXT__={} to datacenter IPs,
// so we can't scrape it from GitHub Actions. Instead, we pull Kolesa Group vacancies
// from hh.kz using their employer ID (40662). This is reliable and always works.
async function scrapeKolesa() {
  const jobs = [];
  const KOLESA_EMPLOYER_ID = 40662;

  try {
    // Fetch all open vacancies for Kolesa Group from hh.kz API
    const url = `https://api.hh.ru/vacancies?employer_id=${KOLESA_EMPLOYER_ID}&area=40&per_page=100&order_by=publication_time`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'SteppeUp-Bot/1.0 (student-jobs-kz)' }
    });

    if (!res.ok) {
      log('kolesa', `hh.kz API failed: ${res.status} ${res.statusText}`);
      return jobs;
    }

    const data = await res.json();
    log('kolesa', `hh.kz returned ${data.items?.length || 0} Kolesa Group vacancies`);

    for (const v of (data.items || [])) {
      // Fetch full vacancy details for description
      let description = v.snippet?.responsibility || v.snippet?.requirement || '';
      try {
        const detailRes = await fetch(`https://api.hh.ru/vacancies/${v.id}`, {
          headers: { 'User-Agent': 'SteppeUp-Bot/1.0 (student-jobs-kz)' }
        });
        if (detailRes.ok) {
          const detail = await detailRes.json();
          description = cleanHtml(detail.description) || description;
        }
      } catch (e) { /* use snippet */ }

      const salary = extractSalary(v.salary);
      const tags = [
        'kolesa', 'tech',
        v.schedule?.name,
        v.experience?.name,
        v.employment?.name,
        ...(v.professional_roles || []).map(r => r.name)
      ].filter(Boolean);

      jobs.push({
        source: 'kolesa_group',
        source_id: `kolesa_hh_${v.id}`,
        source_url: (v.alternate_url || `https://hh.kz/vacancy/${v.id}`).replace('hh.ru', 'hh.kz'),
        title: v.name,
        company: 'Kolesa Group',
        company_logo: v.employer?.logo_urls?.['90'] || null,
        location: v.area?.name || 'Almaty',
        description,
        salary_min: salary.min,
        salary_max: salary.max,
        currency: salary.currency,
        tags,
        status: 'active',
        posted_at: v.published_at || new Date().toISOString()
      });

      await sleep(200); // be nice to the API
    }
  } catch (e) {
    log('kolesa', `Error: ${e.message}`);
  }

  log('kolesa', `Total jobs: ${jobs.length}`);
  return jobs;
}

// ══════════════════════════════════════════════════════════════
//  Source 5: Youth Employment Portal
// ══════════════════════════════════════════════════════════════
async function scrapeYouthPortal() {
  const jobs = [];

  try {
    const url = `https://api.hh.ru/vacancies?area=40&text=${encodeURIComponent('Жас маман OR zhasproject OR молодой специалист OR первое рабочее место')}&per_page=30&order_by=publication_time&period=7`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'SteppeUp-Bot/1.0 (student-jobs-kz)' }
    });

    if (res.ok) {
      const data = await res.json();
      for (const v of (data.items || [])) {
        const description = v.snippet?.responsibility || v.snippet?.requirement || '';
        const tags = ['youth', 'zhasproject', 'government-program', v.experience?.name, v.employment?.name].filter(Boolean);

        if (!isStudentFriendly(v.name, description, tags)) continue;

        const salary = extractSalary(v.salary);
        jobs.push({
          source: 'youth_portal',
          source_id: `youth_hh_${v.id}`,
          source_url: (v.alternate_url || `https://hh.kz/vacancy/${v.id}`).replace('hh.ru', 'hh.kz'),
          title: v.name,
          company: v.employer?.name || 'Unknown',
          company_logo: v.employer?.logo_urls?.['90'] || null,
          location: v.area?.name || 'Kazakhstan',
          description,
          salary_min: salary.min,
          salary_max: salary.max,
          currency: salary.currency,
          tags,
          status: 'active',
          posted_at: v.published_at
        });
      }
    }
  } catch (e) {
    log('youth', `Error: ${e.message}`);
  }

  log('youth', `Total jobs: ${jobs.length}`);
  return jobs;
}

// ══════════════════════════════════════════════════════════════
//  ★ Source 6: Telegram Channels (NEW)
//  Uses Telegram Bot API to read public KZ job channels.
//  Requires TELEGRAM_BOT_TOKEN env var.
//  The bot must be added to each channel (or channels must be public).
// ══════════════════════════════════════════════════════════════

// Popular KZ job channels — add/remove as you find more
// Verified active channels from TGStat.com/kz/career (March 2026)
const TELEGRAM_CHANNELS = [
  // ── Top KZ Job Channels (10K+ subscribers, active daily) ──
  '@almaty_rabota01',       // Ярмарка вакансий Алматы — 38K subs
  '@jobkz_1',               // JobKZ: вакансии/работа в Казахстане — 32K subs
  '@workitkz',              // IT Вакансии Казахстан — 31K subs
  '@astana_job_vakansii',   // Работа в Астане | Вакансии — 22K subs
  '@devkz_jobs',            // Dev KZ | Vacancy (IT) — 22K subs
  '@zhumys_astana_kz',      // Работа в Астане | Жұмыс — 18K subs
  '@Astana_rabota',         // Работа в Астане — 14K subs
  '@almaty_rabota_work',    // Работа в Алматы | Ярмарка вакансий — 11K subs
  '@digitaljobkz',          // Вакансии Казахстан Digital & Education
  '@rabota_almaty',         // Работа в Алмате — 4K subs (less active)
];

async function scrapeTelegram() {
  const jobs = [];

  for (const channel of TELEGRAM_CHANNELS) {
    try {
      // Use Telegram's public web preview — no bot token or membership needed!
      const channelName = channel.replace('@', '');
      const webUrl = `https://t.me/s/${channelName}`;
      const webRes = await fetch(webUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; SteppeUp-Bot/1.0)',
          'Accept': 'text/html',
          'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.8'
        }
      });

      if (!webRes.ok) {
        log('telegram', `Web preview failed for ${channel}: ${webRes.status}`);
        continue;
      }

      const html = await webRes.text();
      const $ = cheerio.load(html);

      // Parse messages from Telegram's public web view
      $('.tgme_widget_message_wrap, .tgme_widget_message').each((_, el) => {
        const $msg = $(el);
        const msgText = $msg.find('.tgme_widget_message_text, .js-message_text').text().trim();
        const msgDate = $msg.find('.tgme_widget_message_date time').attr('datetime') || '';
        const msgLink = $msg.find('.tgme_widget_message_date').attr('href') || '';
        const msgId = msgLink.split('/').pop() || '';

        // Skip if too short or too old
        if (!msgText || msgText.length < 50) return;

        // Only process messages from last 7 days
        if (msgDate) {
          const postAge = Date.now() - new Date(msgDate).getTime();
          if (postAge > 7 * 24 * 60 * 60 * 1000) return;
        }

        // Check if it looks like a job posting
        if (!looksLikeJobPost(msgText)) return;

        // Check if student-friendly
        if (!isStudentFriendly('', msgText)) {
          // Even if no explicit student keywords, include if it says
          // "без опыта" or similar and passes the job-post filter
          const lower = msgText.toLowerCase();
          const hasNoExpReq = lower.includes('без опыта') || lower.includes('опыт не требуется') ||
            lower.includes('no experience') || lower.includes('обучим');
          if (!hasNoExpReq) return;
        }

        // Extract structured info from unstructured message
        const city = extractCity(msgText);
        const salary = extractSalaryFromText(msgText);

        // Try to extract job title (usually first line or after "Вакансия:")
        let title = '';
        const titleMatch = msgText.match(/(?:вакансия|позиция|ищем|требуется|hiring|position)[:\s]*([^\n]+)/i);
        if (titleMatch) {
          title = titleMatch[1].trim().slice(0, 120);
        } else {
          // First line as title
          title = msgText.split('\n')[0].trim().slice(0, 120);
        }

        // Try to extract company name
        let company = channelName;
        const companyMatch = msgText.match(/(?:компания|company)[:\s]*([^\n,]+)/i);
        if (companyMatch) {
          company = companyMatch[1].trim();
        }

        const sourceUrl = msgLink.startsWith('http') ? msgLink : `https://t.me/${channelName}/${msgId}`;

        jobs.push({
          source: 'telegram',
          source_id: `tg_${channel.replace('@', '')}_${msgId || Date.now()}`,
          source_url: sourceUrl,
          title: title || 'Job Posting',
          company,
          company_logo: null,
          location: city,
          description: msgText.slice(0, 5000),
          salary_min: salary.min,
          salary_max: salary.max,
          currency: salary.currency,
          tags: ['telegram', channel.replace('@', '')],
          status: 'active',
          posted_at: msgDate || new Date().toISOString()
        });
      });

      log('telegram', `${channel}: parsed ${jobs.length} potential jobs so far`);
      await sleep(1000); // be nice
    } catch (e) {
      log('telegram', `Error on ${channel}: ${e.message}`);
    }
  }

  // Deduplicate (similar titles from crossposted jobs)
  const seen = new Set();
  const unique = jobs.filter(j => {
    // Use a fingerprint of title + company to catch crossposts
    const fingerprint = `${j.title.toLowerCase().slice(0, 50)}_${j.company.toLowerCase().slice(0, 30)}`;
    if (seen.has(j.source_id) || seen.has(fingerprint)) return false;
    seen.add(j.source_id);
    seen.add(fingerprint);
    return true;
  });

  log('telegram', `Total unique Telegram jobs: ${unique.length}`);
  return unique;
}

// ══════════════════════════════════════════════════════════════
//  ★ Source 7: LinkedIn Jobs via Google (NEW)
//  LinkedIn blocks direct scraping, but Google indexes their
//  public job pages. We search Google for LinkedIn KZ job posts.
// ══════════════════════════════════════════════════════════════
async function scrapeLinkedInViaGoogle() {
  const jobs = [];

  const queries = [
    'site:linkedin.com/jobs intern kazakhstan',
    'site:linkedin.com/jobs стажер казахстан',
    'site:linkedin.com/jobs junior almaty',
    'site:linkedin.com/jobs "entry level" astana',
    'site:linkedin.com/jobs student kazakhstan',
    'site:linkedin.com/jobs стажировка алматы',
  ];

  for (const query of queries) {
    try {
      // Use Google's public search (no API key needed)
      // Note: Google may rate-limit, so we're conservative
      const googleUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}&num=15&tbs=qdr:w`; // last week
      const res = await fetch(googleUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml',
          'Accept-Language': 'en-US,en;q=0.9,ru;q=0.8'
        }
      });

      if (!res.ok) {
        log('linkedin', `Google search failed for "${query.slice(0, 40)}": ${res.status}`);
        continue;
      }

      const html = await res.text();
      const $ = cheerio.load(html);

      // Parse Google search results
      $('div.g, div[data-sokoban-container]').each((_, el) => {
        const $el = $(el);
        const link = $el.find('a').first().attr('href') || '';
        const title = $el.find('h3').first().text().trim();
        const snippet = $el.find('.VwiC3b, .st, [data-sncf]').text().trim();

        // Only keep LinkedIn job links
        if (!link.includes('linkedin.com/jobs') || !title) return;

        // Extract company from snippet or title
        // LinkedIn titles are usually "Job Title - Company Name - Location"
        const parts = title.split(/\s*[-–—|]\s*/);
        const jobTitle = parts[0] || title;
        const company = parts[1] || 'LinkedIn Listing';
        const location = extractCity(title + ' ' + snippet);

        if (isStudentFriendly(jobTitle, snippet)) {
          const salary = extractSalaryFromText(snippet);
          jobs.push({
            source: 'linkedin',
            source_id: `li_${Buffer.from(link).toString('base64').slice(0, 32)}`,
            source_url: link,
            title: jobTitle.slice(0, 150),
            company: company.slice(0, 100),
            company_logo: null,
            location,
            description: snippet.slice(0, 5000),
            salary_min: salary.min,
            salary_max: salary.max,
            currency: salary.currency,
            tags: ['linkedin'],
            status: 'active',
            posted_at: new Date().toISOString()
          });
        }
      });

      log('linkedin', `Query "${query.slice(0, 40)}...": parsed Google results`);
      await sleep(3000); // be very conservative with Google
    } catch (e) {
      log('linkedin', `Error: ${e.message}`);
    }
  }

  const seen = new Set();
  const unique = jobs.filter(j => {
    if (seen.has(j.source_id)) return false;
    seen.add(j.source_id);
    return true;
  });

  log('linkedin', `Total LinkedIn jobs: ${unique.length}`);
  return unique;
}

// ══════════════════════════════════════════════════════════════
//  ★ Source 8: Google Jobs Catch-All (NEW)
//  Catches jobs posted on Instagram, Facebook, company sites,
//  Threads, random forums — anything Google indexes.
// ══════════════════════════════════════════════════════════════
async function scrapeGoogleJobs() {
  const jobs = [];

  // These queries catch what slips through other scrapers
  const queries = [
    'вакансия стажер казахстан -site:hh.kz -site:hh.ru -site:enbek.kz -site:linkedin.com',
    'intern hiring almaty -site:hh.kz -site:hh.ru -site:linkedin.com',
    '"ищем стажера" алматы OR астана',
    '"мы ищем" junior казахстан',
    'стажировка 2025 2026 алматы OR астана OR казахстан',
    'hiring "no experience" kazakhstan almaty OR astana',
  ];

  for (const query of queries) {
    try {
      const googleUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}&num=10&tbs=qdr:w`;
      const res = await fetch(googleUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html',
          'Accept-Language': 'en-US,en;q=0.9,ru;q=0.8'
        }
      });

      if (!res.ok) {
        log('google', `Search failed: ${res.status}`);
        continue;
      }

      const html = await res.text();
      const $ = cheerio.load(html);

      $('div.g, div[data-sokoban-container]').each((_, el) => {
        const $el = $(el);
        const link = $el.find('a').first().attr('href') || '';
        const title = $el.find('h3').first().text().trim();
        const snippet = $el.find('.VwiC3b, .st, [data-sncf]').text().trim();

        if (!link || !title || link.includes('google.com')) return;

        // Determine the source platform
        let sourceName = 'web';
        if (link.includes('instagram.com')) sourceName = 'instagram';
        else if (link.includes('threads.net')) sourceName = 'threads';
        else if (link.includes('facebook.com')) sourceName = 'facebook';
        else if (link.includes('twitter.com') || link.includes('x.com')) sourceName = 'twitter';
        else if (link.includes('olx.kz')) sourceName = 'olx_kz';

        const fullText = `${title} ${snippet}`;
        if (!isStudentFriendly(title, snippet) && !looksLikeJobPost(fullText)) return;

        const salary = extractSalaryFromText(fullText);
        const location = extractCity(fullText);

        jobs.push({
          source: sourceName,
          source_id: `google_${Buffer.from(link).toString('base64').slice(0, 32)}`,
          source_url: link,
          title: title.slice(0, 150),
          company: sourceName === 'olx_kz' ? 'OLX.kz Listing' : 'Web Listing',
          company_logo: null,
          location,
          description: snippet.slice(0, 5000),
          salary_min: salary.min,
          salary_max: salary.max,
          currency: salary.currency,
          tags: [sourceName, 'google-discovery'],
          status: 'active',
          posted_at: new Date().toISOString()
        });
      });

      log('google', `Query "${query.slice(0, 50)}...": parsed`);
      await sleep(4000); // very conservative with Google
    } catch (e) {
      log('google', `Error: ${e.message}`);
    }
  }

  const seen = new Set();
  const unique = jobs.filter(j => {
    if (seen.has(j.source_id)) return false;
    seen.add(j.source_id);
    return true;
  });

  log('google', `Total Google-discovered jobs: ${unique.length}`);
  return unique;
}

// ══════════════════════════════════════════════════════════════
//  ★ Source 9: Community Submissions (NEW)
//  Users submit job links via the app → goes to a queue table
//  → scraper approves and migrates them to main jobs table
// ══════════════════════════════════════════════════════════════
async function processCommunitySubmissions() {
  const jobs = [];

  if (!db) {
    log('community', 'No DB connection — skipping');
    return jobs;
  }

  try {
    // Fetch pending submissions
    const { data: submissions, error } = await db
      .from('community_submissions')
      .select('*')
      .eq('status', 'pending')
      .limit(50);

    if (error) {
      log('community', `Error fetching submissions: ${error.message}`);
      return jobs;
    }

    if (!submissions || submissions.length === 0) {
      log('community', 'No pending submissions');
      return jobs;
    }

    log('community', `Found ${submissions.length} pending submissions`);

    for (const sub of submissions) {
      try {
        // Basic validation
        if (!sub.title || sub.title.length < 3) {
          await db.from('community_submissions').update({ status: 'rejected', review_note: 'Title too short' }).eq('id', sub.id);
          continue;
        }

        // Auto-approve if it has enough detail
        const hasCompany = sub.company && sub.company.length > 1;
        const hasDescription = sub.description && sub.description.length > 20;
        const hasUrl = sub.source_url && sub.source_url.startsWith('http');

        if (!hasUrl) {
          await db.from('community_submissions').update({ status: 'rejected', review_note: 'No valid URL' }).eq('id', sub.id);
          continue;
        }

        // Try to enrich by fetching the URL
        let enrichedDescription = sub.description || '';
        if (hasUrl && enrichedDescription.length < 50) {
          try {
            const pageRes = await fetch(sub.source_url, {
              headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SteppeUp-Bot/1.0)' },
              redirect: 'follow'
            });
            if (pageRes.ok) {
              const pageHtml = await pageRes.text();
              const $page = cheerio.load(pageHtml);
              // Extract page description
              const metaDesc = $page('meta[name="description"]').attr('content') || '';
              const ogDesc = $page('meta[property="og:description"]').attr('content') || '';
              const bodyText = $page('article, .content, .description, main').text().trim().slice(0, 3000);
              enrichedDescription = metaDesc || ogDesc || bodyText || enrichedDescription;
            }
          } catch (e) {
            // URL fetch failed, use what we have
          }
        }

        // Determine source from URL
        let sourceName = 'community';
        if (sub.source_url.includes('instagram')) sourceName = 'instagram';
        else if (sub.source_url.includes('t.me') || sub.source_url.includes('telegram')) sourceName = 'telegram';
        else if (sub.source_url.includes('linkedin')) sourceName = 'linkedin';
        else if (sub.source_url.includes('twitter') || sub.source_url.includes('x.com')) sourceName = 'twitter';
        else if (sub.source_url.includes('threads.net')) sourceName = 'threads';
        else if (sub.source_url.includes('whatsapp')) sourceName = 'whatsapp';

        const salary = extractSalaryFromText(enrichedDescription);

        jobs.push({
          source: sourceName,
          source_id: `community_${sub.id}`,
          source_url: sub.source_url,
          title: sub.title,
          company: sub.company || `${sourceName} Listing`,
          company_logo: null,
          location: sub.location || extractCity(enrichedDescription),
          description: enrichedDescription.slice(0, 5000),
          salary_min: salary.min,
          salary_max: salary.max,
          currency: salary.currency,
          tags: [sourceName, 'community-submitted', ...(sub.tags || [])],
          status: 'active',
          posted_at: sub.created_at || new Date().toISOString()
        });

        // Mark as approved
        await db.from('community_submissions').update({
          status: 'approved',
          review_note: 'Auto-approved by scraper'
        }).eq('id', sub.id);

      } catch (e) {
        log('community', `Error processing submission ${sub.id}: ${e.message}`);
      }
    }
  } catch (e) {
    log('community', `Error: ${e.message}`);
  }

  log('community', `Total community jobs: ${jobs.length}`);
  return jobs;
}

// ══════════════════════════════════════════════════════════════
//  ★ Source 7: JSearch API — LinkedIn + Indeed + Glassdoor
//  Aggregates jobs from the major platforms without scraping them
//  directly. Filtered strictly to internships & entry-level in KZ.
//  Free tier: 200 requests/month → ~6 req/day → zero cost for now.
//  Sign up: https://rapidapi.com/letscrape-6bfbfe/api/jsearch
//  Secret:  JSEARCH_API_KEY in GitHub Actions
// ══════════════════════════════════════════════════════════════
async function scrapeJSearch() {
  const jobs = [];

  if (!JSEARCH_API_KEY) {
    log('jsearch', 'No JSEARCH_API_KEY — skipping (add secret to GitHub Actions to enable)');
    return jobs;
  }

  // Targeted queries for internships & entry-level in Kazakhstan
  // We keep queries focused so we don't blow through the free tier
  const queries = [
    { q: 'intern internship Kazakhstan',        type: 'INTERN'     },
    { q: 'intern internship Almaty',            type: 'INTERN'     },
    { q: 'intern internship Astana',            type: 'INTERN'     },
    { q: 'junior entry level developer Kazakhstan', type: 'FULLTIME' },
    { q: 'стажер стажировка Казахстан',         type: 'INTERN'     },
    { q: 'junior entry level Kazakhstan',       type: 'FULLTIME'   },
  ];

  for (const { q, type } of queries) {
    try {
      // Build request — date_posted=week keeps results fresh
      const params = new URLSearchParams({
        query:            q,
        page:             '1',
        num_pages:        '1',
        date_posted:      'week',
        employment_types: type,
      });

      const res = await fetch(
        `https://jsearch.p.rapidapi.com/search?${params}`,
        {
          headers: {
            'X-RapidAPI-Key':  JSEARCH_API_KEY,
            'X-RapidAPI-Host': 'jsearch.p.rapidapi.com',
          },
        }
      );

      if (res.status === 429) {
        log('jsearch', 'Rate limit hit — stopping early to preserve quota');
        break;
      }
      if (!res.ok) {
        log('jsearch', `Query "${q.slice(0, 40)}" failed: ${res.status}`);
        continue;
      }

      const data = await res.json();
      const items = data.data || [];
      log('jsearch', `Query "${q.slice(0, 40)}": ${items.length} results`);

      for (const v of items) {
        // Hard-filter: only Kazakhstan or remote jobs
        const country = (v.job_country || '').toLowerCase();
        const city    = (v.job_city    || '').toLowerCase();
        const isKZ    = country === 'kz' || country === 'kazakhstan' ||
                        city.includes('almaty') || city.includes('astana') ||
                        city.includes('алматы') || city.includes('астана');
        const isRemote = v.job_is_remote === true;
        if (!isKZ && !isRemote) continue;

        // Build description from all available fields
        const highlights = v.job_highlights || {};
        const highlightText = [
          ...(highlights.Qualifications   || []),
          ...(highlights.Responsibilities || []),
          ...(highlights.Benefits         || []),
        ].join(' ');
        const description = (v.job_description || highlightText || '').slice(0, 5000);

        // Build tags
        const tags = [];
        const publisher = (v.job_publisher || '').toLowerCase();
        if (publisher.includes('linkedin'))  tags.push('linkedin');
        if (publisher.includes('indeed'))    tags.push('indeed');
        if (publisher.includes('glassdoor')) tags.push('glassdoor');
        if (v.job_employment_type === 'INTERN')    tags.push('internship');
        if (v.job_employment_type === 'PART_TIME') tags.push('part-time');
        if (v.job_is_remote) tags.push('remote');
        const exp = v.job_required_experience || {};
        if (exp.no_experience_required) tags.push('no experience required');

        // Source label — show original platform in the badge
        let sourceName = 'jsearch';
        if (publisher.includes('linkedin'))  sourceName = 'linkedin';
        else if (publisher.includes('indeed')) sourceName = 'indeed';

        // Skip senior/middle roles that slipped through the query
        if (!isStudentFriendly(v.job_title, description, tags)) continue;

        const location = [v.job_city, v.job_state, v.job_country]
          .filter(Boolean).join(', ') || 'Kazakhstan';

        jobs.push({
          source:       sourceName,
          source_id:    `jsearch_${v.job_id}`,
          source_url:   v.job_apply_link || `https://jsearch.p.rapidapi.com/job-details?job_id=${v.job_id}`,
          title:        v.job_title,
          company:      v.employer_name  || 'Unknown',
          company_logo: v.employer_logo  || null,
          location,
          description,
          salary_min:   v.job_min_salary || null,
          salary_max:   v.job_max_salary || null,
          currency:     v.job_salary_currency || 'KZT',
          tags,
          status:       'active',
          posted_at:    v.job_posted_at_datetime_utc || new Date().toISOString(),
        });
      }

      await sleep(500); // stay well within rate limits
    } catch (e) {
      log('jsearch', `Error on "${q.slice(0, 40)}": ${e.message}`);
    }
  }

  // Deduplicate by job_id (same listing can appear across queries)
  const seen  = new Set();
  const unique = jobs.filter(j => {
    if (seen.has(j.source_id)) return false;
    seen.add(j.source_id);
    return true;
  });

  log('jsearch', `Total unique jobs: ${unique.length} (LinkedIn/Indeed/Glassdoor)`);
  return unique;
}

// ── Stale Job Cleanup ─────────────────────────────────────────
async function cleanupStaleJobs() {
  if (!db) return { checked: 0, removed: 0 };

  log('cleanup', 'Checking for stale job listings...');

  const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
  const { data: activeJobs, error } = await db
    .from('jobs')
    .select('id, source_url, source, source_id, posted_at')
    .eq('status', 'active')
    .lt('posted_at', threeDaysAgo)
    .limit(50);

  if (error || !activeJobs) {
    log('cleanup', `Error fetching jobs: ${error?.message}`);
    return { checked: 0, removed: 0 };
  }

  let removed = 0;

  for (const job of activeJobs) {
    try {
      if (job.source === 'hh_kz' && job.source_id?.startsWith('hh_')) {
        const hhId = job.source_id.replace('hh_', '');
        const res = await fetch(`https://api.hh.ru/vacancies/${hhId}`, {
          headers: { 'User-Agent': 'SteppeUp-Bot/1.0' }
        });

        if (res.status === 404 || res.status === 403) {
          await db.from('jobs').update({ status: 'inactive' }).eq('id', job.id);
          removed++;
        } else if (res.ok) {
          const data = await res.json();
          if (data.archived || data.type?.id === 'closed') {
            await db.from('jobs').update({ status: 'inactive' }).eq('id', job.id);
            removed++;
          }
        }
        await sleep(300);
      }
      // For Telegram jobs, expire after 7 days (posts get buried fast)
      else if (job.source === 'telegram') {
        const age = Date.now() - new Date(job.posted_at).getTime();
        if (age > 7 * 24 * 60 * 60 * 1000) {
          await db.from('jobs').update({ status: 'inactive' }).eq('id', job.id);
          removed++;
          log('cleanup', `Expired Telegram job: ${job.source_id}`);
        }
      }
      // For social media jobs (Instagram, Threads, etc.), expire after 14 days
      else if (['instagram', 'threads', 'twitter', 'facebook', 'community'].includes(job.source)) {
        const age = Date.now() - new Date(job.posted_at).getTime();
        if (age > 14 * 24 * 60 * 60 * 1000) {
          await db.from('jobs').update({ status: 'inactive' }).eq('id', job.id);
          removed++;
        }
      }
      // Generic URL check for others
      else if (job.source_url) {
        try {
          const res = await fetch(job.source_url, {
            method: 'HEAD',
            headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SteppeUp-Bot/1.0)' },
            redirect: 'follow',
            timeout: 5000
          });

          if (res.status === 404 || res.status === 410) {
            await db.from('jobs').update({ status: 'inactive' }).eq('id', job.id);
            removed++;
          }
        } catch (e) { /* temporary error, skip */ }
        await sleep(500);
      }

      // Hard expire at 30 days
      const age = Date.now() - new Date(job.posted_at).getTime();
      if (age > 30 * 24 * 60 * 60 * 1000) {
        await db.from('jobs').update({ status: 'inactive' }).eq('id', job.id);
        removed++;
      }

    } catch (e) { /* skip */ }
  }

  log('cleanup', `Checked ${activeJobs.length} jobs, removed ${removed}`);
  return { checked: activeJobs.length, removed };
}

// ── Upsert to Supabase ───────────────────────────────────────
async function upsertJobs(jobs) {
  if (!db || jobs.length === 0) return;

  const batchSize = 50;
  let inserted = 0, errors = 0;

  for (let i = 0; i < jobs.length; i += batchSize) {
    const batch = jobs.slice(i, i + batchSize);

    const { data, error } = await db
      .from('jobs')
      .upsert(batch, {
        onConflict: 'source_id',
        ignoreDuplicates: false
      });

    if (error) {
      log('db', `Batch upsert error: ${error.message}`);
      errors += batch.length;
    } else {
      inserted += batch.length;
    }
  }

  log('db', `Upserted ${inserted} jobs (${errors} errors)`);
  return { inserted, errors };
}

// ── Main ──────────────────────────────────────────────────────
async function main() {
  console.log('═══════════════════════════════════════════════════');
  console.log('  SteppeUp Job Scraper v2');
  console.log(`  ${new Date().toISOString()}`);
  console.log(`  Mode: ${DRY_RUN ? 'DRY RUN' : 'LIVE'}`);
  console.log(`  Telegram: ENABLED (${TELEGRAM_CHANNELS.length} channels via web preview)`);
  console.log(`  JSearch:  ${JSEARCH_API_KEY ? 'ENABLED (LinkedIn/Indeed/Glassdoor)' : 'DISABLED (add JSEARCH_API_KEY secret to enable)'}`);
  console.log('═══════════════════════════════════════════════════\n');

  // Remove seed/placeholder jobs
  if (db) {
    try {
      const { error } = await db
        .from('jobs')
        .update({ status: 'inactive' })
        .lte('id', 20)
        .eq('status', 'active');
      if (!error) log('cleanup', 'Deactivated seed jobs (IDs 1-20)');
    } catch (e) {
      log('cleanup', `Seed cleanup failed: ${e.message}`);
    }
  }

  // Run all scrapers (original + new)
  // Group 1: API-based (can run in parallel)
  const [hhJobs, enbekJobs, githubJobs, kolesaJobs, youthJobs] = await Promise.all([
    scrapeHH(),
    scrapeEnbek(),
    scrapeGitHubJobs(),
    scrapeKolesa(),
    scrapeYouthPortal()
  ]);

  // Group 2: Web scraping + external APIs (run sequentially to avoid rate limits)
  const telegramJobs  = await scrapeTelegram();
  const jsearchJobs   = await scrapeJSearch();
  const communityJobs = await processCommunitySubmissions();

  const allJobs = [
    ...hhJobs, ...enbekJobs, ...githubJobs, ...kolesaJobs, ...youthJobs,
    ...telegramJobs, ...jsearchJobs, ...communityJobs
  ];

  console.log('\n── Summary ──────────────────────────────────────');
  console.log(`  hh.kz:          ${hhJobs.length} jobs`);
  console.log(`  enbek.kz:       ${enbekJobs.length} jobs`);
  console.log(`  GitHub:         ${githubJobs.length} jobs`);
  console.log(`  Kolesa Group:   ${kolesaJobs.length} jobs`);
  console.log(`  Youth Portal:   ${youthJobs.length} jobs`);
  console.log(`  Telegram:       ${telegramJobs.length} jobs`);
  console.log(`  JSearch (LI/Indeed): ${jsearchJobs.length} jobs`);
  console.log(`  Community:      ${communityJobs.length} jobs`);
  console.log(`  ─────────────────────────────────────────`);
  console.log(`  TOTAL:          ${allJobs.length} jobs`);

  if (DRY_RUN) {
    console.log('\n[DRY RUN] Would upsert these jobs to Supabase:');
    allJobs.slice(0, 10).forEach(j => {
      console.log(`  - [${j.source}] ${j.title} @ ${j.company} (${j.location})`);
    });
    if (allJobs.length > 10) console.log(`  ... and ${allJobs.length - 10} more`);
    return;
  }

  // Upsert to Supabase
  if (allJobs.length > 0) {
    await upsertJobs(allJobs);
  }

  // Clean up stale listings
  const cleanup = await cleanupStaleJobs();

  console.log('\n── Done ─────────────────────────────────────────');
  console.log(`  New/updated: ${allJobs.length}`);
  console.log(`  Stale removed: ${cleanup.removed}`);
  console.log('═══════════════════════════════════════════════════\n');

  // Log scraping run
  try {
    await db.from('scraping_logs').insert({
      source: 'all',
      jobs_found: allJobs.length,
      jobs_removed: cleanup.removed,
      status: 'success',
      details: {
        hh_kz: hhJobs.length,
        enbek_kz: enbekJobs.length,
        github_kz: githubJobs.length,
        kolesa_group: kolesaJobs.length,
        youth_portal: youthJobs.length,
        telegram: telegramJobs.length,
        community: communityJobs.length
      }
    });
  } catch (e) { /* logging table might not exist yet */ }
}

main().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});
