/**
 * Moderated listing reports. Heuristics never become a public accusation.
 * Reports land in job_reports (service role) when configured; otherwise they
 * are accepted locally and logged for manual review.
 */
function json(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

function parseBody(req) {
  return new Promise(function (resolve, reject) {
    let raw = '';
    req.on('data', function (chunk) { raw += chunk; if (raw.length > 20000) req.destroy(); });
    req.on('end', function () {
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (err) { reject(err); }
    });
    req.on('error', reject);
  });
}

const ALLOWED_REASONS = ['not-a-job', 'salary', 'expired', 'duplicate', 'other'];

async function handler(req, res) {
  const origin = process.env.STEPPEUP_ORIGIN || 'https://steppeup.ai';
  if (req.headers.origin && req.headers.origin !== origin) {
    return json(res, 403, { error: 'Origin not allowed' });
  }
  if (req.headers.origin) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }
  if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });

  let body;
  try { body = await parseBody(req); } catch (_e) { return json(res, 400, { error: 'Invalid JSON' }); }

  const jobId = String(body.jobId || '').slice(0, 80);
  const reason = ALLOWED_REASONS.indexOf(body.reason) !== -1 ? body.reason : 'other';
  const details = String(body.details || '').slice(0, 2000);
  if (!jobId) return json(res, 400, { error: 'jobId required' });

  const payload = {
    job_id: jobId,
    reason: reason,
    details: details,
    status: 'pending_review',
    public_accusation: false,
    created_at: new Date().toISOString()
  };

  const sbUrl = process.env.SUPABASE_URL;
  const sbKey = process.env.SUPABASE_SERVICE_KEY;
  if (sbUrl && sbKey) {
    try {
      const result = await fetch(sbUrl.replace(/\/$/, '') + '/rest/v1/job_reports', {
        method: 'POST',
        headers: {
          apikey: sbKey,
          Authorization: 'Bearer ' + sbKey,
          'Content-Type': 'application/json',
          Prefer: 'return=minimal'
        },
        body: JSON.stringify(payload)
      });
      if (!result.ok) {
        console.warn('[report-listing] insert failed', result.status);
      }
    } catch (err) {
      console.warn('[report-listing] insert error', err.message);
    }
  } else {
    console.warn('[report-listing] queued for review (no service key)', payload);
  }

  return json(res, 200, {
    accepted: true,
    status: 'pending_review',
    message: 'Спасибо. Мы проверим объявление вручную. Это не публичная жалоба на работодателя.'
  });
}

module.exports = handler;
