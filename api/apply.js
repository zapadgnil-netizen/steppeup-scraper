const { put } = require('@vercel/blob');
const formidable = require('formidable');
const fs = require('fs');

async function handler(req, res) {
  const allowedOrigin = process.env.STEPPEUP_ORIGIN || 'https://steppeup.ai';
  const requestOrigin = req.headers.origin;
  if (requestOrigin && requestOrigin !== allowedOrigin) {
    res.status(403).json({ error: 'Origin not allowed' });
    return;
  }
  if (requestOrigin) res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');

  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  const sbUrl = process.env.SUPABASE_URL;
  const sbKey = process.env.SUPABASE_SERVICE_KEY;
  const token = req.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!sbUrl || !sbKey) {
    console.error('[APPLY] Supabase server credentials are not configured');
    res.status(503).json({ error: 'Application service is unavailable' });
    return;
  }
  if (!token) {
    res.status(401).json({ error: 'Authentication is required' });
    return;
  }

  let authUser;
  try {
    const authRes = await fetch(`${sbUrl.replace(/\/$/, '')}/auth/v1/user`, {
      headers: { apikey: sbKey, Authorization: `Bearer ${token}` },
    });
    if (!authRes.ok) {
      res.status(401).json({ error: 'Invalid or expired session' });
      return;
    }
    authUser = await authRes.json();
  } catch (err) {
    console.error('[APPLY] Session verification failed:', err.message);
    res.status(503).json({ error: 'Authentication service is unavailable' });
    return;
  }

  try {
    const form = formidable({ maxFileSize: 10 * 1024 * 1024, maxFieldsSize: 100 * 1024 });
    const [fields, files] = await form.parse(req);

    const jobId      = fields.job_id?.[0];
    const name       = fields.name?.[0] || null;
    const email      = fields.email?.[0] || null;
    const phone      = fields.phone?.[0] || null;
    const coverLetter = fields.cover_letter?.[0] || null;
    const resumeFile = files.resume?.[0];

    if (!jobId || !/^[a-zA-Z0-9_-]{1,100}$/.test(jobId)) {
      res.status(400).json({ error: 'A valid job_id is required' });
      return;
    }
    if (email && (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) {
      res.status(400).json({ error: 'A valid email is required' });
      return;
    }

    // Upload resume to Vercel Blob
    let resumeUrl = null;
    if (resumeFile) {
      const allowedTypes = new Set([
        'application/pdf',
        'application/msword',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      ]);
      if (!allowedTypes.has(resumeFile.mimetype)) {
        res.status(400).json({ error: 'Resume must be a PDF, DOC, or DOCX file' });
        return;
      }
      const safeName = (resumeFile.originalFilename || 'resume.pdf').replace(/[^a-zA-Z0-9._-]/g, '_');
      const pathname = `resumes/${Date.now()}-${safeName}`;
      const stream = fs.createReadStream(resumeFile.filepath);
      const blob = await put(pathname, stream, {
        // Resumes contain personal data. They must never be retrievable by URL alone.
        access: 'private',
        contentType: resumeFile.mimetype || 'application/pdf',
      });
      resumeUrl = blob.url;
    }

    // Insert via server credentials only after the caller's Supabase session
    // has been verified above.  Do not trust a browser-supplied email.
    const insertRes = await fetch(`${sbUrl}/rest/v1/partner_applications`, {
      method: 'POST',
      headers: {
        'apikey': sbKey,
        'Authorization': `Bearer ${sbKey}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal',
      },
      body: JSON.stringify({
        job_id: jobId,
        applicant_name: name,
        applicant_email: authUser.email || email,
        applicant_phone: phone,
        cover_letter: coverLetter,
        resume_url: resumeUrl,
      }),
    });

    if (!insertRes.ok) {
      const errText = await insertRes.text();
      console.error('[APPLY] Supabase insert error:', errText);
      res.status(500).json({ error: 'Failed to save application' });
      return;
    }

    console.log(`[APPLY] Submitted: job=${jobId} resume=${Boolean(resumeUrl)}`);
    res.status(200).json({ success: true });

  } catch (err) {
    console.error('[APPLY] Error:', err.message);
    res.status(500).json({ error: 'Unable to submit application' });
  }
};

module.exports = handler;
