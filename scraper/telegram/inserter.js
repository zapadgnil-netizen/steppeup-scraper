/**
 * Inserter — dedups parsed jobs and upserts them into the existing `jobs` table.
 *
 * Dedup strategy (cheap + deterministic):
 *   1. source_id (`tg_<channel>_<msgId>`) is UNIQUE → upsert handles re-scrapes.
 *   2. Before insert, skip a job whose apply_url already exists in the DB, or
 *      whose (title + company) pair already exists — so the same vacancy posted
 *      to several channels, or reposted, isn't duplicated.
 */

function normalize(s) {
  return (s || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

// Returns the subset of `jobs` that are NOT already in the DB.
async function dedupe(db, jobs) {
  if (!db || !jobs.length) return jobs;

  // Pull existing apply_url + title/company for comparison (active jobs only).
  const applyUrls = jobs.map((j) => j.apply_url).filter(Boolean);
  const existingApply = new Set();
  const existingTitleCo = new Set();

  try {
    if (applyUrls.length) {
      const { data } = await db.from('jobs').select('apply_url').in('apply_url', applyUrls);
      (data || []).forEach((r) => r.apply_url && existingApply.add(r.apply_url));
    }
    // Title+company check across recent jobs (bounded for cost).
    const { data: recent } = await db
      .from('jobs')
      .select('title, company')
      .order('posted_at', { ascending: false })
      .limit(1000);
    (recent || []).forEach((r) => existingTitleCo.add(normalize(r.title) + '|' + normalize(r.company)));
  } catch (e) {
    console.log(`[inserter] dedup lookup failed (continuing): ${e.message}`);
  }

  const seenInBatch = new Set();
  return jobs.filter((j) => {
    if (j.apply_url && j.source_type === 'external_link' && existingApply.has(j.apply_url)) return false;
    const key = normalize(j.title) + '|' + normalize(j.company);
    if (existingTitleCo.has(key) || seenInBatch.has(key)) return false;
    seenInBatch.add(key);
    return true;
  });
}

async function upsertJobs(db, jobs) {
  if (!db || !jobs.length) return { inserted: 0, errors: 0 };
  let inserted = 0, errors = 0;
  const batchSize = 50;
  for (let i = 0; i < jobs.length; i += batchSize) {
    const batch = jobs.slice(i, i + batchSize);
    const { error } = await db.from('jobs').upsert(batch, { onConflict: 'source_id', ignoreDuplicates: false });
    if (error) { console.log(`[inserter] batch error: ${error.message}`); errors += batch.length; }
    else inserted += batch.length;
  }
  return { inserted, errors };
}

module.exports = { dedupe, upsertJobs, normalize };
