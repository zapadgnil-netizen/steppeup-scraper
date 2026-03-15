process.stdout.write('=== SteppeUp Scraper starting ===\n');

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

console.log('SUPABASE_URL set:', !!SUPABASE_URL);
console.log('SUPABASE_KEY set:', !!SUPABASE_KEY);

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('ERROR: Missing env vars!');
  process.exit(1);
}

const db = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false }
});

const SEED_JOBS = [
  { source:'seed', source_id:'seed_kaspi_ios_intern', source_url:'https://hh.kz/search/vacancy?text=ios+kaspi', title:'iOS Developer Intern', company:'Kaspi Bank', company_logo:null, location:'Almaty', description:'Join Kaspi Bank mobile team as iOS intern. Work on KZ #1 super-app used by 13M+ people. Swift, UIKit, SwiftUI.', salary_min:150000, salary_max:250000, currency:'KZT', tags:['стажировка','iOS','Swift','mobile'], status:'active', posted_at:new Date().toISOString() },
  { source:'seed', source_id:'seed_kaspi_backend_intern', source_url:'https://hh.kz/search/vacancy?text=backend+kaspi', title:'Backend Java Intern', company:'Kaspi Bank', company_logo:null, location:'Almaty', description:'Backend internship in Kaspi Bank engineering. Java Spring Boot microservices. Flexible schedule for students.', salary_min:180000, salary_max:280000, currency:'KZT', tags:['стажировка','Java','Spring Boot','backend'], status:'active', posted_at:new Date().toISOString() },
  { source:'seed', source_id:'seed_kolesa_frontend', source_url:'https://hh.kz/search/vacancy?text=frontend+kolesa', title:'Junior Frontend Developer', company:'Kolesa Group', company_logo:null, location:'Almaty', description:'Kolesa.kz looking for junior React developer. Remote-friendly, great mentorship, 4-day work week option.', salary_min:250000, salary_max:400000, currency:'KZT', tags:['junior','React','frontend','частичная занятость'], status:'active', posted_at:new Date().toISOString() },
  { source:'seed', source_id:'seed_kolesa_android', source_url:'https://hh.kz/search/vacancy?text=android+kolesa', title:'Android Developer Intern', company:'Kolesa Group', company_logo:null, location:'Almaty', description:'Android internship at Kolesa Group. Kotlin, Jetpack Compose. Best engineering culture in Central Asia.', salary_min:200000, salary_max:320000, currency:'KZT', tags:['стажировка','Android','Kotlin','mobile'], status:'active', posted_at:new Date().toISOString() },
  { source:'seed', source_id:'seed_halyk_data_intern', source_url:'https://hh.kz/search/vacancy?text=data+analyst+halyk', title:'Data Analyst Intern', company:'Halyk Bank', company_logo:null, location:'Almaty', description:'Work with real banking data. Python, SQL, Power BI. Part-time internship compatible with university schedule.', salary_min:140000, salary_max:220000, currency:'KZT', tags:['стажировка','Data','Python','SQL','частичная занятость'], status:'active', posted_at:new Date().toISOString() },
  { source:'seed', source_id:'seed_choco_smm', source_url:'https://hh.kz/search/vacancy?text=smm+choco', title:'SMM Manager (Part-time)', company:'Chocofamily', company_logo:null, location:'Almaty', description:'Create content for Chocotravel, Chocofood and Chocolife. Instagram, TikTok, Telegram. Flexible hours for students.', salary_min:100000, salary_max:180000, currency:'KZT', tags:['частичная занятость','SMM','маркетинг','гибкий график'], status:'active', posted_at:new Date().toISOString() },
  { source:'seed', source_id:'seed_kcell_it_intern', source_url:'https://hh.kz/search/vacancy?text=it+intern+kcell', title:'IT Support Intern', company:'Kcell', company_logo:null, location:'Almaty', description:'IT support internship at leading telecom. Networking, Linux systems, enterprise infrastructure.', salary_min:120000, salary_max:180000, currency:'KZT', tags:['стажировка','IT','Linux','networking'], status:'active', posted_at:new Date().toISOString() },
  { source:'seed', source_id:'seed_beeline_marketing_intern', source_url:'https://hh.kz/search/vacancy?text=marketing+intern+beeline', title:'Marketing Intern', company:'Beeline Kazakhstan', company_logo:null, location:'Almaty', description:'Digital marketing internship. Assist with campaigns, analytics and social media. Great for business students.', salary_min:110000, salary_max:170000, currency:'KZT', tags:['стажировка','маркетинг','digital','студент'], status:'active', posted_at:new Date().toISOString() },
  { source:'seed', source_id:'seed_tengri_graphic', source_url:'https://hh.kz/search/vacancy?text=graphic+design+almaty', title:'Graphic Designer (Part-time)', company:'Tengri Media', company_logo:null, location:'Almaty', description:'Create visuals for Kazakhstan top news portal. Figma, Photoshop, Illustrator. 20 hrs/week, remote possible.', salary_min:130000, salary_max:200000, currency:'KZT', tags:['частичная занятость','дизайн','Figma','удалённо'], status:'active', posted_at:new Date().toISOString() },
  { source:'seed', source_id:'seed_alem_ml_intern', source_url:'https://hh.kz/search/vacancy?text=machine+learning+intern+almaty', title:'ML Engineer Intern', company:'Alem Research', company_logo:null, location:'Almaty', description:'Research internship in AI/ML. NLP and computer vision for Central Asian languages. Python, PyTorch.', salary_min:200000, salary_max:350000, currency:'KZT', tags:['стажировка','ML','Python','AI','research'], status:'active', posted_at:new Date().toISOString() },
  { source:'seed', source_id:'seed_forte_finance_intern', source_url:'https://hh.kz/search/vacancy?text=finance+intern+forte+bank', title:'Finance Analyst Intern', company:'ForteBank', company_logo:null, location:'Astana', description:'Financial analysis internship. Excel, 1C, SAP basics. Ideal for Finance, Economics, or Accounting students.', salary_min:130000, salary_max:200000, currency:'KZT', tags:['стажировка','финансы','Excel','аналитика'], status:'active', posted_at:new Date().toISOString() },
  { source:'seed', source_id:'seed_airba_qa_intern', source_url:'https://hh.kz/search/vacancy?text=qa+intern+airba', title:'QA Engineer Intern', company:'Airba Fresh', company_logo:null, location:'Almaty', description:'Manual and automated testing internship at Kazakhstan fastest growing grocery delivery startup.', salary_min:160000, salary_max:240000, currency:'KZT', tags:['стажировка','QA','testing','startup'], status:'active', posted_at:new Date().toISOString() },
  { source:'seed', source_id:'seed_samruk_hr_intern', source_url:'https://hh.kz/search/vacancy?text=hr+intern+astana', title:'HR Intern', company:'Samruk-Kazyna', company_logo:null, location:'Astana', description:'HR department internship at the national welfare fund. Great for Psychology, Management, or HR students.', salary_min:120000, salary_max:180000, currency:'KZT', tags:['стажировка','HR','Астана','студент'], status:'active', posted_at:new Date().toISOString() },
  { source:'seed', source_id:'seed_dar_fullstack', source_url:'https://hh.kz/search/vacancy?text=fullstack+junior+almaty', title:'Junior Full-Stack Developer', company:'DAR', company_logo:null, location:'Almaty', description:'Join DAR IT outsourcing team. Node.js + React stack. Junior-friendly with strong code review culture.', salary_min:300000, salary_max:500000, currency:'KZT', tags:['junior','Node.js','React','fullstack'], status:'active', posted_at:new Date().toISOString() },
  { source:'seed', source_id:'seed_epam_remote_intern', source_url:'https://hh.kz/search/vacancy?text=intern+epam+kazakhstan', title:'Software Engineering Intern (Remote)', company:'EPAM Systems', company_logo:null, location:'Almaty', description:'EPAM internship program for KZ students. Full remote, international project experience. Java or Python.', salary_min:250000, salary_max:400000, currency:'KZT', tags:['стажировка','remote','удалённо','Java','Python'], status:'active', posted_at:new Date().toISOString() },
  { source:'seed', source_id:'seed_choco_content_writer', source_url:'https://hh.kz/search/vacancy?text=content+writer+almaty', title:'Content Writer (Part-time)', company:'Chocofamily', company_logo:null, location:'Almaty', description:'Write blog posts and product descriptions in Russian/Kazakh. 10-20 hrs/week. Perfect for Journalism students.', salary_min:80000, salary_max:150000, currency:'KZT', tags:['частичная занятость','копирайтинг','контент','удалённо'], status:'active', posted_at:new Date().toISOString() },
  { source:'seed', source_id:'seed_techorda_devops', source_url:'https://hh.kz/search/vacancy?text=devops+intern+almaty', title:'DevOps Intern', company:'Tech Orda', company_logo:null, location:'Almaty', description:'DevOps internship: Docker, Kubernetes basics, CI/CD pipelines. Open-source focused tech hub.', salary_min:180000, salary_max:280000, currency:'KZT', tags:['стажировка','DevOps','Docker','Linux'], status:'active', posted_at:new Date().toISOString() },
  { source:'seed', source_id:'seed_jusan_react_native', source_url:'https://hh.kz/search/vacancy?text=mobile+developer+jusan', title:'React Native Developer Intern', company:'Jusan Bank', company_logo:null, location:'Almaty', description:'Work on Jusan mobile banking app using React Native. 3-month internship with possible extension.', salary_min:200000, salary_max:320000, currency:'KZT', tags:['стажировка','React Native','mobile','JavaScript'], status:'active', posted_at:new Date().toISOString() },
  { source:'seed', source_id:'seed_wb_logistics', source_url:'https://hh.kz/search/vacancy?text=logistics+intern+almaty', title:'Logistics Coordinator Intern', company:'Wildberries KZ', company_logo:null, location:'Almaty', description:'Logistics internship at largest online retailer in KZ. Supply chain, inventory management, 1C system.', salary_min:110000, salary_max:160000, currency:'KZT', tags:['стажировка','логистика','склад','студент'], status:'active', posted_at:new Date().toISOString() },
  { source:'seed', source_id:'seed_kbtu_translator', source_url:'https://hh.kz/search/vacancy?text=translator+student', title:'Translator / Interpreter (Part-time)', company:'KBTU', company_logo:null, location:'Almaty', description:'KZ/RU/EN translation of academic and technical materials. Remote work, flexible deadlines. Great for Linguistics students.', salary_min:70000, salary_max:130000, currency:'KZT', tags:['частичная занятость','перевод','удалённо','казахский','гибкий график'], status:'active', posted_at:new Date().toISOString() }
];

async function main() {
  console.log('Connected to:', SUPABASE_URL);
  console.log('Upserting', SEED_JOBS.length, 'seed jobs...');

  const { error: seedErr } = await db
    .from('jobs')
    .upsert(SEED_JOBS, { onConflict: 'source_id', ignoreDuplicates: false });

  if (seedErr) {
    console.error('Seed error:', JSON.stringify(seedErr));
  } else {
    console.log('Seed jobs upserted OK');
  }

  // Also try hh.kz live jobs
  let hhCount = 0;
  try {
    const fetch = require('node-fetch');
    const liveJobs = [];
    const queries = ['стажировка', 'intern'];
    for (const q of queries) {
      try {
        const r = await fetch(`https://api.hh.ru/vacancies?area=40&text=${encodeURIComponent(q)}&per_page=20&period=7`, { headers:{'User-Agent':'SteppeUp/1.0'}, timeout:8000 });
        if (!r.ok) { console.log('hh.kz', q, r.status); continue; }
        const d = await r.json();
        console.log('hh.kz', q, '->', d.items?.length, 'jobs');
        for (const v of (d.items||[])) {
          const s = v.salary||{};
          liveJobs.push({ source:'hh_kz', source_id:'hh_'+v.id, source_url:v.alternate_url, title:v.name, company:v.employer?.name||'Unknown', company_logo:null, location:v.area?.name||'Kazakhstan', description:(v.snippet?.responsibility||v.snippet?.requirement||'').replace(/<[^>]+>/g,'').trim().slice(0,1000), salary_min:s.from||null, salary_max:s.to||null, currency:s.currency||'KZT', tags:[v.schedule?.name,v.experience?.name].filter(Boolean), status:'active', posted_at:v.published_at||new Date().toISOString() });
        }
        await new Promise(r=>setTimeout(r,500));
      } catch(e) { console.log('hh.kz error', q, e.message); }
    }
    const seen=new Set(); const unique=liveJobs.filter(j=>!seen.has(j.source_id)&&seen.add(j.source_id));
    if (unique.length > 0) {
      const { error } = await db.from('jobs').upsert(unique, { onConflict:'source_id' });
      if (error) console.error('hh upsert error:', JSON.stringify(error));
      else { hhCount = unique.length; console.log('hh.kz upserted:', hhCount); }
    }
  } catch(e) { console.log('hh.kz fetch skipped:', e.message); }

  const { count } = await db.from('jobs').select('*', { count:'exact', head:true }).eq('status','active');
  console.log('FINAL active jobs in DB:', count);
  console.log('=== SCRAPER DONE ===');
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
