/**
 * SteppeUp Job Scraper
 * Runs daily via GitHub Actions (free). Scrapes KZ job sites for student-friendly
 * positions, upserts to Supabase, and removes stale listings.
 */

const fetch = require('node-fetch');
const cheerio = require('cheerio');
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const DRY_RUN = process.argv.includes('--dry-run');

if (!DRY_RUN && (!SUPABASE_URL || !SUPABASE_KEY)) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY env vars');
  process.exit(1);
}

const db = DRY_RUN ? null : createClient(SUPABASE_URL, SUPABASE_KEY);

const ALL_KEYWORDS = ['intern','internship','junior','entry level','entry-level','graduate','trainee','assistant','part-time','student','no experience','beginner',
  '\u0441\u0442\u0430\u0436\u0435\u0440','\u0441\u0442\u0430\u0436\u0451\u0440','\u0441\u0442\u0430\u0436\u0438\u0440\u043e\u0432\u043a\u0430','\u0434\u0436\u0443\u043d\u0438\u043e\u0440','\u043d\u0430\u0447\u0438\u043d\u0430\u044e\u0449\u0438\u0439','\u0431\u0435\u0437 \u043e\u043f\u044b\u0442\u0430','\u0441\u0442\u0443\u0434\u0435\u043d\u0442','\u043f\u0440\u0430\u043a\u0442\u0438\u043a\u0430','\u043f\u043e\u043c\u043e\u0449\u043d\u0438\u043a','\u0430\u0441\u0441\u0438\u0441\u0442\u0435\u043d\u0442','\u043f\u043e\u0434\u0440\u0430\u0431\u043e\u0442\u043a\u0430'];

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function isStudentFriendly(t, d) { const x = (t+' '+(d||'')).toLowerCase(); return ALL_KEYWORDS.some(k => x.includes(k)); }
function extractSalary(s) { if (!s) return {min:null,max:null,currency:'KZT'}; return {min:s.from||null,max:s.to||null,currency:s.currency||'KZT'}; }
function cleanHtml(h) { if (!h) return ''; return h.replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim().slice(0,5000); }
const log = (src, msg) => console.log('['+src+'] '+msg);
async function scrapeHH() {
  const jobs = [];
  const queries = ['\u0441\u0442\u0430\u0436\u0435\u0440','\u0441\u0442\u0430\u0436\u0438\u0440\u043e\u0432\u043a\u0430','junior','intern','\u0441\u0442\u0443\u0434\u0435\u043d\u0442','\u0431\u0435\u0437 \u043e\u043f\u044b\u0442\u0430','\u043d\u0430\u0447\u0438\u043d\u0430\u044e\u0449\u0438\u0439','\u043f\u043e\u0434\u0440\u0430\u0431\u043e\u0442\u043a\u0430'];
  for (const query of queries) {
    try {
      const url = `https://api.hh.ru/vacancies?area=40&text=${encodeURIComponent(query)}&per_page=50&order_by=publication_time&period=3`;
      const res = await fetch(url, { headers: { 'User-Agent': 'SteppeUp-Bot/1.0 (student-jobs-kz)' } });
      if (!res.ok) { log('hh.kz', `Query "${query}" failed: ${res.status}`); continue; }
      const data = await res.json();
      for (const v of (data.items || [])) {
        let description = v.snippet?.responsibility || v.snippet?.requirement || '';
        try {
          const dr = await fetch(`https://api.hh.ru/vacancies/${v.id}`, { headers: { 'User-Agent': 'SteppeUp-Bot/1.0' } });
          if (dr.ok) { const d = await dr.json(); description = cleanHtml(d.description) || description; }
        } catch(e) {}
        const salary = extractSalary(v.salary);
        const tags = [v.schedule?.name, v.experience?.name, v.employment?.name, ...(v.professional_roles||[]).map(r=>r.name)].filter(Boolean);
        jobs.push({ source:'hh_kz', source_id:`hh_${v.id}`, source_url:v.alternate_url||`https://hh.kz/vacancy/${v.id}`, title:v.name, company:v.employer?.name||'Unknown', company_logo:v.employer?.logo_urls?.['90']||null, location:v.area?.name||'Kazakhstan', description, salary_min:salary.min, salary_max:salary.max, currency:salary.currency, tags, status:'active', posted_at:v.published_at||new Date().toISOString() });
        await sleep(200);
      }
      log('hh.kz', `Query "${query}": found ${data.items?.length||0} vacancies`);
      await sleep(500);
    } catch(e) { log('hh.kz', `Error on "${query}": ${e.message}`); }
  }
  const seen = new Set();
  const unique = jobs.filter(j => { if (seen.has(j.source_id)) return false; seen.add(j.source_id); return true; });
  log('hh.kz', `Total unique jobs: ${unique.length}`);
  return unique;
}
async function scrapeEnbek() {
  const jobs = [];
  try {
    const queries = ['\u0441\u0442\u0430\u0436\u0435\u0440','\u0441\u0442\u0443\u0434\u0435\u043d\u0442','junior','\u0431\u0435\u0437 \u043e\u043f\u044b\u0442\u0430'];
    for (const query of queries) {
      try {
        const url = `https://www.enbek.kz/ru/search/vacancy?key=${encodeURIComponent(query)}&sort=date`;
        const res = await fetch(url, { headers: { 'User-Agent':'Mozilla/5.0 (compatible; SteppeUp-Bot/1.0)', 'Accept':'text/html,application/xhtml+xml', 'Accept-Language':'ru-RU,ru;q=0.9,en;q=0.8' } });
        if (!res.ok) { log('enbek.kz', `Query "${query}" failed: ${res.status}`); continue; }
        const html = await res.text();
        const $ = cheerio.load(html);
        $('a.vacancy-card, .vacancy-item, [class*="vacancy"]').each((_, el) => {
          const $el = $(el);
          const title = $el.find('h3, .vacancy-title, .title').text().trim() || $el.find('a').first().text().trim();
          const company = $el.find('.company-name, .employer, [class*="company"]').text().trim();
          const location = $el.find('.location, .city, [class*="location"]').text().trim() || 'Kazakhstan';
          const link = $el.attr('href') || $el.find('a').attr('href') || '';
          const fullLink = link.startsWith('http') ? link : `https://www.enbek.kz${link}`;
          if (title && title.length > 3) {
            jobs.push({ source:'enbek_kz', source_id:`enbek_${Buffer.from(fullLink).toString('base64').slice(0,32)}`, source_url:fullLink, title, company:company||'Enbek.kz Listing', company_logo:null, location, description:$el.find('.description, .snippet, p').text().trim().slice(0,5000), salary_min:null, salary_max:null, currency:'KZT', tags:['enbek.kz','verified'], status:'active', posted_at:new Date().toISOString() });
          }
        });
        log('enbek.kz', `Query "${query}": parsed page`);
        await sleep(1000);
      } catch(e) { log('enbek.kz', `Error on "${query}": ${e.message}`); }
    }
  } catch(e) { log('enbek.kz', `Scraper error: ${e.message}`); }
  const seen = new Set();
  return jobs.filter(j => { if (seen.has(j.source_id)) return false; seen.add(j.source_id); return true; });
}
async function scrapeGitHubJobs() {
  const jobs = [];
  try {
    const queries = ['label:job location:kazakhstan','hiring intern kazakhstan'];
    for (const query of queries) {
      try {
        const url = `https://api.github.com/search/issues?q=${encodeURIComponent(query+' is:open')}&sort=created&order=desc&per_page=20`;
        const res = await fetch(url, { headers: { 'User-Agent':'SteppeUp-Bot/1.0', 'Accept':'application/vnd.github.v3+json' } });
        if (!res.ok) continue;
        const data = await res.json();
        for (const issue of (data.items||[])) {
          if (isStudentFriendly(issue.title, issue.body)) {
            jobs.push({ source:'github_kz', source_id:`gh_${issue.id}`, source_url:issue.html_url, title:issue.title, company:issue.repository_url?.split('/').slice(-2).join('/')||'GitHub', company_logo:issue.user?.avatar_url||null, location:'Remote / Kazakhstan', description:cleanHtml((issue.body||'').slice(0,5000)), salary_min:null, salary_max:null, currency:'KZT', tags:['github','tech',...(issue.labels||[]).map(l=>l.name)], status:'active', posted_at:issue.created_at });
          }
        }
        await sleep(1000);
      } catch(e) { log('github', `Error: ${e.message}`); }
    }
  } catch(e) { log('github', `Scraper error: ${e.message}`); }
  log('github', `Total jobs: ${jobs.length}`);
  return jobs;
}

async function scrapeKolesa() {
  const jobs = [];
  try {
    const res = await fetch('https://kolesa.group/career', { headers: { 'User-Agent':'Mozilla/5.0 (compatible; SteppeUp-Bot/1.0)', 'Accept':'text/html' } });
    if (!res.ok) return jobs;
    const html = await res.text();
    const $ = cheerio.load(html);
    $('a[href*="career"], a[href*="vacancy"], .vacancy, .job-card').each((_, el) => {
      const $el = $(el);
      const title = $el.find('h3, h4, .title').text().trim() || $el.text().trim();
      const link = $el.attr('href') || '';
      const fullLink = link.startsWith('http') ? link : `https://kolesa.group${link}`;
      if (title && title.length > 3 && title.length < 200) {
        jobs.push({ source:'kolesa_group', source_id:`kolesa_${Buffer.from(fullLink).toString('base64').slice(0,32)}`, source_url:fullLink, title, company:'Kolesa Group', company_logo:null, location:'Almaty', description:'Kolesa Group - leading tech company in Central Asia', salary_min:null, salary_max:null, currency:'KZT', tags:['kolesa','tech'], status:'active', posted_at:new Date().toISOString() });
      }
    });
  } catch(e) { log('kolesa', `Error: ${e.message}`); }
  log('kolesa', `Total jobs: ${jobs.length}`);
  return jobs;
}
async function scrapeYouthPortal() {
  const jobs = [];
  try {
    const url = `https://api.hh.ru/vacancies?area=40&text=${encodeURIComponent('\u0416\u0430\u0441 \u043c\u0430\u043c\u0430\u043d OR zhasproject OR \u043c\u043e\u043b\u043e\u0434\u043e\u0439 \u0441\u043f\u0435\u0446\u0438\u0430\u043b\u0438\u0441\u0442 OR \u043f\u0435\u0440\u0432\u043e\u0435 \u0440\u0430\u0431\u043e\u0447\u0435\u0435 \u043c\u0435\u0441\u0442\u043e')}&per_page=30&order_by=publication_time&period=7`;
    const res = await fetch(url, { headers: { 'User-Agent':'SteppeUp-Bot/1.0' } });
    if (res.ok) {
      const data = await res.json();
      for (const v of (data.items||[])) {
        const salary = extractSalary(v.salary);
        jobs.push({ source:'youth_portal', source_id:`youth_hh_${v.id}`, source_url:v.alternate_url, title:v.name, company:v.employer?.name||'Unknown', company_logo:v.employer?.logo_urls?.['90']||null, location:v.area?.name||'Kazakhstan', description:v.snippet?.responsibility||v.snippet?.requirement||'', salary_min:salary.min, salary_max:salary.max, currency:salary.currency, tags:['youth','zhasproject','government-program'], status:'active', posted_at:v.published_at });
      }
    }
  } catch(e) { log('youth', `Error: ${e.message}`); }
  log('youth', `Total jobs: ${jobs.length}`);
  return jobs;
}

async function cleanupStaleJobs() {
  if (!db) return { checked:0, removed:0 };
  log('cleanup', 'Checking for stale job listings...');
  const threeDaysAgo = new Date(Date.now() - 3*24*60*60*1000).toISOString();
  const { data: activeJobs, error } = await db.from('jobs').select('id, source_url, source, source_id, posted_at').eq('status','active').lt('posted_at', threeDaysAgo).limit(50);
  if (error || !activeJobs) return { checked:0, removed:0 };
  let removed = 0;
  for (const job of activeJobs) {
    try {
      if (job.source === 'hh_kz' && job.source_id?.startsWith('hh_')) {
        const hhId = job.source_id.replace('hh_','');
        const res = await fetch(`https://api.hh.ru/vacancies/${hhId}`, { headers: { 'User-Agent':'SteppeUp-Bot/1.0' } });
        if (res.status === 404 || res.status === 403) { await db.from('jobs').update({status:'inactive'}).eq('id',job.id); removed++; }
        else if (res.ok) { const d = await res.json(); if (d.archived || d.type?.id === 'closed') { await db.from('jobs').update({status:'inactive'}).eq('id',job.id); removed++; } }
        await sleep(300);
      } else if (job.source_url) {
        try { const res = await fetch(job.source_url, { method:'HEAD', headers:{'User-Agent':'Mozilla/5.0'}, redirect:'follow' }); if (res.status===404||res.status===410) { await db.from('jobs').update({status:'inactive'}).eq('id',job.id); removed++; } } catch(e) {}
        await sleep(500);
      }
      const age = Date.now() - new Date(job.posted_at).getTime();
      if (age > 30*24*60*60*1000) { await db.from('jobs').update({status:'inactive'}).eq('id',job.id); removed++; }
    } catch(e) {}
  }
  log('cleanup', `Checked ${activeJobs.length} jobs, removed ${removed}`);
  return { checked: activeJobs.length, removed };

// ── Upsert to Supabase ───────────────────────────────────────
async function upsertJobs(jobs) {
  if (!db || jobs.length === 0) return;

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

  if (allJobs.length > 0) {
    await upsertJobs(allJobs);
  }

  const cleanup = await cleanupStaleJobs();

  console.log('\n── Done ─────────────────────────────────');
  console.log(`  New/updated: ${allJobs.length}`);
  console.log(`  Stale removed: ${cleanup.removed}`);
  console.log('═══════════════════════════════════════════\n');

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
  } catch(e) {
    // Logging table might not exist yet
  }
}

main().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});
}
