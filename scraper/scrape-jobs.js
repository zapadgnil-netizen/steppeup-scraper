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

// ── Config ────────────────────────────────────────────────────
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY; // use service role for server-side
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

// ── Helpers ───────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function isStudentFriendly(title, description, tags = []) {
  const titleText = (title || '').toLowerCase();
  const fullText = `${title} ${description || ''} ${tags.join(' ')}`.toLowerCase();

  // 1. Explicitly reject senior/middle/lead roles by title
  if (['senior', 'middle', 'lead', 'сеньор', 'мидл', 'ведущий', 'руководитель', 'директор', 'главный', 'head', 'эксперт'].some(kw => titleText.includes(kw))) {
    return false;
  }

  // 2. Reject if the full text contains strong experience requirements
  if (NON_STUDENT_KEYWORDS.some(kw => fullText.includes(kw))) {
    // Exception: Explicitly allow if it also says "без опыта" 
    if (!fullText.includes('без опыта') && !fullText.includes('опыт не требуется')) {
      return false;
    }
  }

  // 3. Must contain at least one student or junior keyword
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
        // Fetch full vacancy for description
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

        if (!isStudentFriendly(v.name, description, tags)) {
          continue; // Skip if it's actually a senior/middle role disguised in search results
        }

        jobs.push({
          source: 'hh_kz',
          source_id: `hh_${v.id}`,
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
          posted_at: v.published_at || new Date().toISOString()
        });

        await sleep(200); // be nice to the API
      }

      log('hh.kz', `Query "${query}": found ${data.items?.length || 0} vacancies`);
      await sleep(500);
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
