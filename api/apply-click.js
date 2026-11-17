/**
 * POST /api/apply-click   body: { "job_id": <positive int>, "kind": "<short>" }
 *
 * Anonymous, best-effort counter of clicks on "Apply".  Never requires sign-in.
 * Accepts application/json and text/plain (navigator.sendBeacon sends the
 * latter).  Writes one row to public.apply_clicks with the service key, which
 * stays server-side.  Answers 204; 400 for bad input; 503 when storage is not
 * configured or not reachable (no details leaked).
 */
const MAX_BODY_BYTES = 1024;
const KIND_RE = /^[A-Za-z0-9_-]{1,32}$/;

function validateClick(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const keys = Object.keys(body);
  if (keys.length !== 2 || keys.indexOf('job_id') === -1 || keys.indexOf('kind') === -1) return null;
  if (!Number.isSafeInteger(body.job_id) || body.job_id <= 0) return null;
  if (typeof body.kind !== 'string' || !KIND_RE.test(body.kind)) return null;
  return { job_id: body.job_id, kind: body.kind };
}

// Returns a parsed value, or undefined when the body is missing, too large or not JSON.
function readBody(req) {
  return new Promise(function (resolve) {
    function parse(raw) {
      if (raw == null) return resolve(undefined);
      if (typeof raw === 'object' && !Buffer.isBuffer(raw)) return resolve(raw);
      const str = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw);
      if (Buffer.byteLength(str) > MAX_BODY_BYTES) return resolve(undefined);
      try { resolve(JSON.parse(str)); } catch (e) { resolve(undefined); }
    }
    // Vercel's req.body is a lazy getter that THROWS on malformed JSON.
    let platformBody;
    try { platformBody = req.body; } catch (e) { return resolve(undefined); }
    if (platformBody !== undefined) return parse(platformBody);   // already parsed by the platform
    if (typeof req.on !== 'function') return resolve(undefined);
    const chunks = [];
    let size = 0;
    let done = false;
    req.on('data', function (chunk) {
      if (done) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) { done = true; resolve(undefined); return; }   // stop buffering; caller answers 400
      chunks.push(chunk);
    });
    req.on('end', function () { if (!done) { done = true; parse(chunks.length ? Buffer.concat(chunks) : undefined); } });
    req.on('error', function () { if (!done) { done = true; resolve(undefined); } });
  });
}

function reply(res, status, body) {
  res.statusCode = status;
  if (status === 400) res.setHeader('Connection', 'close');
  res.setHeader('Cache-Control', 'no-store');
  if (body === undefined) { res.end(); return; }
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

function createApplyClickHandler(deps) {
  const env = (deps && deps.env) || process.env;
  const doFetch = (deps && deps.fetch) || function () { return fetch.apply(null, arguments); };

  return async function applyClick(req, res) {
    // Same origin rule as api/apply.js.
    const allowedOrigin = env.STEPPEUP_ORIGIN || 'https://steppeup.ai';
    const requestOrigin = req.headers && req.headers.origin;
    if (requestOrigin && requestOrigin !== allowedOrigin) return reply(res, 403, { error: 'Origin not allowed' });
    if (requestOrigin) res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return reply(res, 204);
    if (req.method !== 'POST') { res.setHeader('Allow', 'POST, OPTIONS'); return reply(res, 405, { error: 'Method not allowed' }); }

    const click = validateClick(await readBody(req));
    if (!click) return reply(res, 400, { error: 'Invalid request' });

    const sbUrl = env.SUPABASE_URL;
    const sbKey = env.SUPABASE_SERVICE_KEY;
    if (!sbUrl || !sbKey) {
      console.error('[APPLY-CLICK] Supabase server credentials are not configured');
      return reply(res, 503, { error: 'Service unavailable' });
    }

    try {
      const insert = await doFetch(sbUrl.replace(/\/$/, '') + '/rest/v1/apply_clicks', {
        method: 'POST',
        headers: {
          apikey: sbKey,
          Authorization: 'Bearer ' + sbKey,
          'Content-Type': 'application/json',
          Prefer: 'return=minimal'
        },
        body: JSON.stringify({ job_id: click.job_id, kind: click.kind }),
        signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(5000) : undefined
      });
      if (!insert.ok) {
        // 404 / PGRST205 means the migration has not been applied yet.
        console.error('[APPLY-CLICK] insert failed: HTTP ' + insert.status);
        return reply(res, 503, { error: 'Service unavailable' });
      }
    } catch (err) {
      console.error('[APPLY-CLICK] insert error:', err.message);
      return reply(res, 503, { error: 'Service unavailable' });
    }
    return reply(res, 204);
  };
}

module.exports = createApplyClickHandler();
module.exports.createApplyClickHandler = createApplyClickHandler;
module.exports.validateClick = validateClick;
