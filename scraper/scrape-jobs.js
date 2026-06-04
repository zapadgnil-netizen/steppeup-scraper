/**
 * SteppeUp Job Scraper
 * Runs daily via GitHub Actions (free). Scrapes KZ job sites for student-friendly
 * positions, upserts to Supabase, and removes stale listings.
 *
 * Sources:
 *   1. hh.kz (HeadHunter) — public API, no auth needed
 *   2. enbek.kz — government employment portal
 *   3. Kolesa Group careers
 *   4. GitHub Jobs (KZ-related tech)
 *   5. Youth employment portal
 */

const fetch = require('node-fetch');
const cheerio = require('cheerio');
const { createClient } = require('@supabase/supabase-js');
// Provide our own WebSocket implementation so @supabase/realtime-js doesn't
// crash at import time on Node versions without a native global WebSocket.
// We never use Realtime here — this is purely defensive.
const WebSocket = require('ws');

// ── Config ────────────────────────────────────────────────────
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY; // use service role for server-side
const DRY_RUN = process.argv.includes('--dry-run');

if (!DRY_RUN && (!SUPABASE_URL || !SUPABASE_KEY)) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY env vars');
  process.exit(1);
}

const db = DRY_RUN ? null : createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
  realtime: { transport: WebSocket }
});

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

// ── Helpers ───────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Strict reject gate, shared (in spirit) with the client-side isStudentSuitable
// in index.html. Returns a reason string when a job is NOT student-suitable, or
// null when it passes. Keep these two in sync when you change the rules.
function studentRejectReason(title, description, tags = []) {
  const titleText = (title || '').toLowerCase();
  const t = `${titleText} ${(description || '').toLowerCase()} ${tags.join(' ').toLowerCase()}`;

  // 1. Explicitly excludes students ("студентов просьба не беспокоить")
  if (/студент\w*[^.]{0,25}(не\s*беспоко|не\s*обраща|не\s*подход|не\s*рассматр)|без\s*студент|не\s*для\s*студент/.test(t))
    return 'excludes-students';

  // 2. Senior / management role by title
  // NB: \b doesn't work before Cyrillic in JS regex, so Cyrillic terms are plain substrings.
  if (/\b(senior|middle|lead|head)\b|сень[оё]р|синьор|мидл|тимлид|руководител|начальник|директор|главн(ый|ого|ая)|заведующ|управляющ|ведущий\s+специалист|эксперт/.test(titleText))
    return 'senior-title';

  // 3. Requires prior experience (unless it also welcomes no-experience)
  const requiresExp = /опыт\s*работы|с\s*опытом|опыт\s*от|обязателен\s*опыт|требуется\s*опыт|опыт\s*не\s*менее|стаж\s*(работы|от)|experience\s*(required|of)|years?\s*of\s*experience|опыт\s*в\s*(сфере|продаж|данной)/.test(t);
  const welcomesNoExp = /без\s*опыта|опыт\s*не\s*требуется|опыта\s*не\s*требуется|можно\s*без\s*опыта|no\s*experience|обучение\s*с\s*нуля|обучаем/.test(t);
  if (requiresExp && !welcomesNoExp) return 'requires-experience';

  // 4. Age / gender restriction (discriminatory; usually not student roles)
  if (/(женщин\w*|мужчин\w*|девушк\w*|парн\w*|парень|жен\.|муж\.)\s*(от|до)?\s*\d{2}/.test(t))
    return 'age-gender-restricted';

  // 5. Multi-job digest (several vacancies mashed into one post)
  const c = (re) => (t.match(re) || []).length;
  if (c(/зарплата/g) >= 2 || c(/обязанности/g) >= 2 || c(/требовани[ея]/g) >= 3)
    return 'multi-job-digest';

  return null;
}

function isStudentFriendly(title, description, tags = []) {
  const fullText = `${title} ${description || ''} ${tags.join(' ')}`.toLowerCase();

  // Hard reject gate (experience, seniority, exclusion, discrimination, digests)
  if (studentRejectReason(title, description, tags)) return false;

  // Legacy negative-keyword list, kept as an extra guard
  if (NON_STUDENT_KEYWORDS.some(kw => fullText.includes(kw))) {
    if (!fullText.includes('без опыта') && !fullText.includes('опыт не требуется')) return false;
  }

  // Must contain at least one student / junior keyword
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

// ── Source 1: HeadHunter (hh.kz) ─────────────────────────────
// Public API: https://api.hh.ru/vacancies — works for .kz too
// Area 40 = Kazakhstan
// NOTE: api.hh.ru is IP-blocked (403) from datacenter/CI ranges. The public
// HTML search page (hh.kz/search/vacancy) is NOT blocked and embeds the full
// result set as JSON in a <template id="HH-Lux-InitialState">. We parse that —
// far more robust than DOM scraping, and it survives the API block.
const HH_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const HH_EXP_LABEL = {
  noExperience: 'Без опыта', between1And3: 'Опыт 1–3 года',
  between3And6: 'Опыт 3–6 лет', moreThan6: 'Опыт более 6 лет',
};

function extractHhState(html) {
  const m = html.match(/<template[^>]*id="HH-Lux-InitialState"[^>]*>([\s\S]*?)<\/template>/);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch (e) { return null; }
}

async function scrapeHH() {
  const jobs = [];
  const queries = [
    'стажер', 'стажировка', 'junior', 'intern', 'студент',
    'без опыта', 'начинающий', 'подработка'
  ];

  for (const query of queries) {
    try {
      const url = `https://hh.kz/search/vacancy?text=${encodeURIComponent(query)}` +
        `&area=40&items_on_page=50&order_by=publication_time`;
      const res = await fetch(url, {
        headers: { 'User-Agent': HH_UA, 'Accept': 'text/html', 'Accept-Language': 'ru-RU,ru;q=0.9' },
      });
      if (!res.ok) { log('hh.kz', `Query "${query}" failed: ${res.status}`); await sleep(800); continue; }

      const state = extractHhState(await res.text());
      const vacs = (state && state.vacancySearchResult && state.vacancySearchResult.vacancies) || [];

      for (const v of vacs) {
        // Structured entry-level gate: keep only no-experience roles or internships.
        const isEntry = v.workExperience === 'noExperience' || v.internship === true;
        if (!isEntry) continue;

        const empType = v.employment && v.employment['@type'];     // FULL | PART
        const sched = v['@workSchedule'];                          // remote | fullDay | ...
        const tags = [
          HH_EXP_LABEL[v.workExperience] || '',
          v.internship ? 'Стажировка' : '',
          empType === 'PART' ? 'Неполный день' : '',
          sched === 'remote' ? 'Удалённо' : '',
        ].filter(Boolean);

        // No description in the search payload — build a compact one from facts so
        // the frontend's skill extraction and student filter have something to read.
        const description = `${v.name}. ${tags.join('. ')}.`;
        const comp = v.compensation || {};
        const url2 = ((v.links && v.links.desktop) || `https://hh.kz/vacancy/${v.vacancyId}`)
          .replace(/\b[a-z-]+\.hh\.kz/, 'hh.kz').replace('hh.ru', 'hh.kz');

        jobs.push({
          source: 'hh_kz',
          source_id: `hh_${v.vacancyId}`,
          source_url: url2,
          title: v.name,
          company: (v.company && (v.company.visibleName || v.company.name)) || 'Компания',
          company_logo: null,
          location: (v.area && (v.area.name || v.area)) || 'Kazakhstan',
          description: description,
          salary_min: comp.from || null,
          salary_max: comp.to || null,
          currency: comp.currencyCode || 'KZT',
          tags: tags,
          status: 'active',
          posted_at: (v.publicationTime && v.publicationTime['$']) || new Date().toISOString(),
        });
      }

      log('hh.kz', `Query "${query}": ${vacs.length} parsed, ${jobs.length} entry-level so far`);
      await sleep(800); // be gentle with the HTML site
    } catch (e) {
      log('hh.kz', `Error on "${query}": ${e.message}`);
    }
  }

  // Deduplicate by source_id
  const seen = new Set();
  const unique = jobs.filter(j => {
    if (seen.has(j.source_id)) return false;
    seen.add(j.source_id);
    return true;
  });

  log('hh.kz', `Total unique jobs: ${unique.length}`);
  return unique;
}

// ── Source 2: Enbek.kz (Government Portal) ────────────────────
async function scrapeEnbek() {
  const jobs = [];

  try {
    // Enbek has a public search page we can parse
    const queries = ['стажер', 'студент', 'junior', 'без опыта'];

    for (const query of queries) {
      try {
        const url = `https://www.enbek.kz/ru/search/vacancy?key=${encodeURIComponent(query)}&sort=date`;
        const res = await fetch(url, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; SteppeUp-Bot/1.0)',
            'Accept': 'text/html,application/xhtml+xml',
            'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.8'
          }
        });

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
              description: description,
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
        log('enbek.kz', `Error on "${query}": ${e.message}`);
      }
    }
  } catch (e) {
    log('enbek.kz', `Scraper error: ${e.message}`);
  }

  // Deduplicate
  const seen = new Set();
  const unique = jobs.filter(j => {
    if (seen.has(j.source_id)) return false;
    seen.add(j.source_id);
    return true;
  });

  log('enbek.kz', `Total unique jobs: ${unique.length}`);
  return unique;
}

// ── Source 3: GitHub Jobs (KZ tech companies) ─────────────────
// GitHub Jobs API is deprecated, so we search GitHub for KZ companies
// and their career pages / job issues
async function scrapeGitHubJobs() {
  const jobs = [];

  try {
    // Search for job issues in KZ tech repos
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
              title: title,
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

// ── Source 4: Kolesa Group Careers ─────────────────────────────
async function scrapeKolesa() {
  const jobs = [];

  try {
    const url = 'https://kolesa.group/career';
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; SteppeUp-Bot/1.0)',
        'Accept': 'text/html'
      }
    });

    if (!res.ok) {
      log('kolesa', `Failed: ${res.status}`);
      return jobs;
    }

    const html = await res.text();
    const $ = cheerio.load(html);

    // Parse job cards from Kolesa Group career page
    $('a[href*="career"], a[href*="vacancy"], .vacancy, .job-card, [class*="vacancy"]').each((_, el) => {
      const $el = $(el);
      const title = $el.find('h3, h4, .title, .vacancy-title').text().trim() || $el.text().trim();
      const link = $el.attr('href') || '';
      const fullLink = link.startsWith('http') ? link : `https://kolesa.group${link}`;
      const dept = $el.find('.department, .team, .category').text().trim();

      if (title && title.length > 3 && title.length < 200) {
        jobs.push({
          source: 'kolesa_group',
          source_id: `kolesa_${Buffer.from(fullLink).toString('base64').slice(0, 32)}`,
          source_url: fullLink,
          title,
          company: 'Kolesa Group',
          company_logo: null,
          location: 'Almaty',
          description: dept ? `Department: ${dept}` : 'Kolesa Group — leading tech company in Central Asia',
          salary_min: null,
          salary_max: null,
          currency: 'KZT',
          tags: ['kolesa', 'tech', dept].filter(Boolean),
          status: 'active',
          posted_at: new Date().toISOString()
        });
      }
    });
  } catch (e) {
    log('kolesa', `Error: ${e.message}`);
  }

  log('kolesa', `Total jobs: ${jobs.length}`);
  return jobs;
}

// ── Source 5: Youth Employment (zhastar / youth portals) ──────
async function scrapeYouthPortal() {
  const jobs = [];

  try {
    // Try the Zhasproject / youth employment portals
    const urls = [
      'https://www.zhastar.zhastar.kz',
      'https://jasproject.kz'
    ];

    // Fallback: search hh.kz specifically for youth/zhasproject programs
    const url = `https://api.hh.ru/vacancies?area=40&text=${encodeURIComponent('Жас маман OR zhasproject OR молодой специалист OR первое рабочее место')}&per_page=30&order_by=publication_time&period=7`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'SteppeUp-Bot/1.0 (student-jobs-kz)' }
    });

    if (res.ok) {
      const data = await res.json();
      for (const v of (data.items || [])) {
        const description = v.snippet?.responsibility || v.snippet?.requirement || '';
        const tags = ['youth', 'zhasproject', 'government-program', v.experience?.name, v.employment?.name].filter(Boolean);

        if (!isStudentFriendly(v.name, description, tags)) {
          continue;
        }

        const salary = extractSalary(v.salary);
        jobs.push({
          source: 'youth_portal',
          source_id: `youth_hh_${v.id}`,
          source_url: (v.alternate_url || `https://hh.kz/vacancy/${v.id}`).replace('hh.ru', 'hh.kz'),
          title: v.name,
          company: v.employer?.name || 'Unknown',
          company_logo: v.employer?.logo_urls?.['90'] || null,
          location: v.area?.name || 'Kazakhstan',
          description: description,
          salary_min: salary.min,
          salary_max: salary.max,
          currency: salary.currency,
          tags: tags,
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

// ── Stale Job Cleanup ─────────────────────────────────────────
// Checks if jobs are still live on their source. If source returns 404
// or the listing is gone, mark as inactive.
async function cleanupStaleJobs() {
  if (!db) return { checked: 0, removed: 0 };

  log('cleanup', 'Checking for stale job listings...');

  // Get active jobs older than 3 days
  const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
  const { data: activeJobs, error } = await db
    .from('jobs')
    .select('id, source_url, source, source_id, posted_at')
    .eq('status', 'active')
    .lt('posted_at', threeDaysAgo)
    .limit(50); // check 50 at a time to stay within limits

  if (error || !activeJobs) {
    log('cleanup', `Error fetching jobs: ${error?.message}`);
    return { checked: 0, removed: 0 };
  }

  let removed = 0;

  for (const job of activeJobs) {
    try {
      // For hh.kz jobs, check via API
      if (job.source === 'hh_kz' && job.source_id?.startsWith('hh_')) {
        const hhId = job.source_id.replace('hh_', '');
        const res = await fetch(`https://api.hh.ru/vacancies/${hhId}`, {
          headers: { 'User-Agent': 'SteppeUp-Bot/1.0' }
        });

        if (res.status === 404 || res.status === 403) {
          await db.from('jobs').update({ status: 'inactive' }).eq('id', job.id);
          removed++;
          log('cleanup', `Removed hh.kz job ${hhId} (${res.status})`);
        } else if (res.ok) {
          const data = await res.json();
          if (data.archived || data.type?.id === 'closed') {
            await db.from('jobs').update({ status: 'inactive' }).eq('id', job.id);
            removed++;
            log('cleanup', `Archived hh.kz job ${hhId}`);
          }
        }

        await sleep(300);
      }
      // For other sources, check if URL still returns 200
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
            log('cleanup', `Removed ${job.source} job (${res.status}): ${job.source_url}`);
          }
        } catch (e) {
          // Network error — don't remove, might be temporary
        }

        await sleep(500);
      }

      // Also remove jobs older than 30 days regardless
      const age = Date.now() - new Date(job.posted_at).getTime();
      if (age > 30 * 24 * 60 * 60 * 1000) {
        await db.from('jobs').update({ status: 'inactive' }).eq('id', job.id);
        removed++;
        log('cleanup', `Expired 30+ day old job: ${job.source_id}`);
      }

    } catch (e) {
      // Skip this job on error
    }
  }

  log('cleanup', `Checked ${activeJobs.length} jobs, removed ${removed}`);
  return { checked: activeJobs.length, removed };
}

// ── Upsert to Supabase ───────────────────────────────────────
async function upsertJobs(jobs) {
  if (!db || jobs.length === 0) return;

  // We need source_id as a unique key — add it to our table
  // Upsert in batches of 50
  const batchSize = 50;
  let inserted = 0, updated = 0, errors = 0;

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
  console.log('═══════════════════════════════════════════');
  console.log('  SteppeUp Job Scraper');
  console.log(`  ${new Date().toISOString()}`);
  console.log(`  Mode: ${DRY_RUN ? 'DRY RUN' : 'LIVE'}`);
  console.log('═══════════════════════════════════════════\n');

  // Remove seed/placeholder jobs (IDs 1-20) that have fake search URLs instead of real vacancy links
  if (db) {
    try {
      const { data, error } = await db
        .from('jobs')
        .update({ status: 'inactive' })
        .lte('id', 20)
        .eq('status', 'active');
      if (error) log('cleanup', `Seed cleanup error: ${error.message}`);
      else log('cleanup', `Deactivated seed jobs (IDs 1-20)`);
    } catch (e) {
      log('cleanup', `Seed cleanup failed: ${e.message}`);
    }
  }

  // Run all scrapers
  const [hhJobs, enbekJobs, githubJobs, kolesaJobs, youthJobs] = await Promise.all([
    scrapeHH(),
    scrapeEnbek(),
    scrapeGitHubJobs(),
    scrapeKolesa(),
    scrapeYouthPortal()
  ]);

  const allJobs = [...hhJobs, ...enbekJobs, ...githubJobs, ...kolesaJobs, ...youthJobs];

  console.log('\n── Summary ──────────────────────────────');
  console.log(`  hh.kz:        ${hhJobs.length} jobs`);
  console.log(`  enbek.kz:     ${enbekJobs.length} jobs`);
  console.log(`  GitHub:       ${githubJobs.length} jobs`);
  console.log(`  Kolesa Group: ${kolesaJobs.length} jobs`);
  console.log(`  Youth Portal: ${youthJobs.length} jobs`);
  console.log(`  ─────────────────────────────`);
  console.log(`  TOTAL:        ${allJobs.length} jobs`);

  if (DRY_RUN) {
    console.log('\n[DRY RUN] Would upsert these jobs to Supabase:');
    allJobs.slice(0, 5).forEach(j => {
      console.log(`  - [${j.source}] ${j.title} @ ${j.company} (${j.location})`);
    });
    if (allJobs.length > 5) console.log(`  ... and ${allJobs.length - 5} more`);
    return;
  }

  // Upsert to Supabase
  if (allJobs.length > 0) {
    await upsertJobs(allJobs);
  }

  // Clean up stale listings
  const cleanup = await cleanupStaleJobs();

  console.log('\n── Done ─────────────────────────────────');
  console.log(`  New/updated: ${allJobs.length}`);
  console.log(`  Stale removed: ${cleanup.removed}`);
  console.log('═══════════════════════════════════════════\n');

  // Log scraping run to Supabase
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
        youth_portal: youthJobs.length
      }
    });
  } catch (e) {
    // Logging table might not exist yet, that's fine
  }
}

main().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});
