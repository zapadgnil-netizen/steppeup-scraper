/**
 * Authenticated job-alert email. Not an open relay.
 *
 * POST requires a signed-in user. The recipient is the account email, never
 * body.email. Job lines come from server-owned listings matched against the
 * stored subscription spec — client-supplied jobs are ignored.
 *
 * Delivery is off unless a store, sender, unsubscribe secret, from-address,
 * CRON_SECRET, and durable tables (probe) are all ready. Tests inject those;
 * production uses Supabase + Resend. Cron requires CRON_SECRET (fail closed).
 * Authenticated opt-out still works when the sender/scheduler is down as long
 * as the subscription store probe succeeds.
 */
'use strict';

const crypto = require('crypto');
const core = require('../js/steppeup-core');

const CLAIM_TTL_MS = 10 * 60 * 1000;
// Resend retains Idempotency-Key values for 24 hours. Same key + same payload
// returns the original response; same key + different payload is 409.
// https://resend.com/docs/dashboard/emails/idempotency-keys
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
const DISPATCH_BATCH = 20;
const SETUP_DOC = 'See docs/ALERT_EMAIL_SETUP.md';
const OPEN_DIGEST_STATUSES = ['claimed', 'accepted', 'failed', 'ambiguous'];

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

function parseBody(req) {
  return new Promise(function (resolve, reject) {
    if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) {
      return resolve(req.body);
    }
    let raw = '';
    req.on('data', function (chunk) { raw += chunk; if (raw.length > 20000) req.destroy(); });
    req.on('end', function () {
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (err) { reject(err); }
    });
    req.on('error', reject);
  });
}

function bearerToken(req) {
  const header = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  const match = String(header).match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

function createUnsubscribeToken(email, alertId, secret) {
  return crypto.createHmac('sha256', String(secret))
    .update(String(email).toLowerCase() + ':' + String(alertId))
    .digest('hex')
    .slice(0, 32);
}

function tokensMatch(expected, provided) {
  const a = Buffer.from(String(expected || ''), 'hex');
  const b = Buffer.from(String(provided || ''), 'hex');
  if (a.length !== 16 || b.length !== 16) return false;
  return crypto.timingSafeEqual(a, b);
}

function deliveryFingerprint(email, alertId, jobId) {
  return [String(email).toLowerCase(), String(alertId), String(jobId)].join('|');
}

function unsubscribeUrl(origin, email, alertId, secret) {
  const token = createUnsubscribeToken(email, alertId, secret);
  return origin.replace(/\/$/, '') + '/api/alerts?unsubscribe=1&email=' +
    encodeURIComponent(email) + '&alert=' + encodeURIComponent(alertId) + '&token=' + token;
}

function jobPublicUrl(origin, job) {
  const direct = job && (job.url || job.apply_url);
  if (direct && /^https?:\/\//i.test(String(direct))) return String(direct);
  const id = job && job.id != null ? encodeURIComponent(String(job.id)) : '';
  return String(origin || '').replace(/\/$/, '') + '/#/job/' + id;
}

function newDigestId() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return crypto.randomBytes(16).toString('hex');
}

function clonePayload(payload) {
  if (!payload || typeof payload !== 'object') return null;
  return {
    from: payload.from,
    to: payload.to,
    subject: payload.subject,
    text: payload.text,
    headers: payload.headers ? Object.assign({}, payload.headers) : undefined
  };
}

function isOpenDigestStatus(status) {
  return OPEN_DIGEST_STATUSES.indexOf(status) !== -1;
}

function claimConflictError() {
  const err = new Error('delivery_claim_conflict');
  err.code = 'delivery_claim_conflict';
  return err;
}

function claimOwnedBy(row, digestId) {
  if (!row) return false;
  const owner = row.digestId != null ? row.digestId : row.digest_id;
  return String(owner) === String(digestId);
}

function digestCreatedAt(digest) {
  if (!digest) return 0;
  if (digest.createdAt) return digest.createdAt;
  if (digest.claimedAt) return digest.claimedAt;
  return 0;
}

function idempotencyExpired(digest) {
  return Date.now() - digestCreatedAt(digest) >= IDEMPOTENCY_TTL_MS;
}

function buildEmail(jobs, unsub, origin) {
  const lines = jobs.map(function (job) {
    return (job.title || 'Вакансия') + ' — ' + (job.company || '') + '\n' + jobPublicUrl(origin, job);
  });
  const text = lines.join('\n\n') + '\n\nОтписаться: ' + unsub;
  return { text: text, unsubscribeUrl: unsub };
}

function matchHelpers() {
  return { flagTests: core.defaultFlagTests(), detectIndustry: core.detectIndustry };
}

function createMemoryStore(seed) {
  const data = seed || {};
  const users = data.users || {};
  const jobs = Array.isArray(data.jobs) ? data.jobs.slice() : [];
  const subscriptions = new Map();
  const unsubscribes = new Set();
  const deliveries = new Map();
  const outbox = new Map();

  function subKey(userId, alertId) {
    return String(userId) + '::' + String(alertId);
  }

  function mapOpen(row) {
    if (!row || !isOpenDigestStatus(row.status)) return null;
    return {
      digestId: row.digestId,
      userId: row.userId,
      email: row.email,
      alertId: row.alertId,
      jobIds: row.jobIds.slice(),
      idempotencyKey: row.idempotencyKey,
      status: row.status,
      claimedAt: row.claimedAt,
      createdAt: row.createdAt,
      payload: clonePayload(row.payload)
    };
  }

  return {
    async probeDurable() {
      return true;
    },
    async getUserByToken(token) {
      const user = users[token] || null;
      if (!user) return null;
      if (user.emailConfirmed === false) return null;
      return user;
    },
    async getSubscription(userId, alertId) {
      return subscriptions.get(subKey(userId, alertId)) || null;
    },
    async listSubscriptions() {
      return Array.from(subscriptions.values()).filter(function (row) { return row.optedIn; });
    },
    async upsertSubscription(row) {
      subscriptions.set(subKey(row.userId, row.alertId), {
        userId: row.userId,
        alertId: row.alertId,
        email: String(row.email).toLowerCase(),
        spec: row.spec,
        optedIn: !!row.optedIn
      });
      return subscriptions.get(subKey(row.userId, row.alertId));
    },
    async deleteSubscription(userId, alertId) {
      subscriptions.delete(subKey(userId, alertId));
    },
    async isUnsubscribed(email, alertId) {
      return unsubscribes.has(String(email).toLowerCase() + '|' + String(alertId));
    },
    async recordUnsubscribe(email, alertId) {
      unsubscribes.add(String(email).toLowerCase() + '|' + String(alertId));
    },
    async listJobs() {
      return core.selectFeedListings(jobs);
    },
    async listSentJobIds(email, alertId) {
      const prefix = String(email).toLowerCase() + '|' + String(alertId) + '|';
      const ids = [];
      deliveries.forEach(function (row, fp) {
        if (row.status === 'sent' && fp.indexOf(prefix) === 0) ids.push(fp.slice(prefix.length));
      });
      return ids;
    },
    async listOccupiedJobIds(email, alertId) {
      const prefix = String(email).toLowerCase() + '|' + String(alertId) + '|';
      const ids = {};
      deliveries.forEach(function (row, fp) {
        if ((row.status === 'sent' || row.status === 'claimed') && fp.indexOf(prefix) === 0) {
          ids[fp.slice(prefix.length)] = true;
        }
      });
      const wantEmail = String(email).toLowerCase();
      const wantAlert = String(alertId);
      outbox.forEach(function (row) {
        if (row.email === wantEmail && row.alertId === wantAlert && isOpenDigestStatus(row.status)) {
          (row.jobIds || []).forEach(function (id) { ids[String(id)] = true; });
        }
      });
      return Object.keys(ids);
    },
    async getOpenDigest(email, alertId) {
      const wantEmail = String(email).toLowerCase();
      const wantAlert = String(alertId);
      let found = null;
      outbox.forEach(function (row) {
        if (row.email === wantEmail && row.alertId === wantAlert && isOpenDigestStatus(row.status)) {
          found = mapOpen(row);
        }
      });
      return found;
    },
    async createDigest(row) {
      const wantEmail = String(row.email).toLowerCase();
      const wantAlert = String(row.alertId);
      var found = null;
      outbox.forEach(function (d) {
        if (d.email === wantEmail && d.alertId === wantAlert && isOpenDigestStatus(d.status)) found = d;
      });
      if (found) return { conflict: true, digest: mapOpen(found) };
      const now = Date.now();
      const digest = {
        digestId: row.digestId,
        userId: row.userId,
        email: wantEmail,
        alertId: wantAlert,
        jobIds: (row.jobIds || []).map(String),
        idempotencyKey: row.idempotencyKey || row.digestId,
        status: 'claimed',
        claimedAt: now,
        createdAt: now,
        payload: clonePayload(row.payload)
      };
      outbox.set(digest.digestId, digest);
      const failAfter = this._failClaimsAfter;
      digest.jobIds.forEach(function (id, idx) {
        if (failAfter != null && idx >= failAfter) return;
        const fp = deliveryFingerprint(digest.email, digest.alertId, id);
        const cur = deliveries.get(fp);
        if (cur && !claimOwnedBy(cur, digest.digestId)) return;
        if (cur && cur.status === 'sent') return;
        deliveries.set(fp, { status: 'claimed', claimedAt: now, digestId: digest.digestId });
      });
      return { conflict: false, digest: mapOpen(digest) };
    },
    async ensureDigestClaims(digestId) {
      const d = outbox.get(digestId);
      if (!d) {
        const err = new Error('digest_missing');
        err.code = 'store_unavailable';
        throw err;
      }
      const now = Date.now();
      for (var i = 0; i < d.jobIds.length; i++) {
        const fp = deliveryFingerprint(d.email, d.alertId, d.jobIds[i]);
        const cur = deliveries.get(fp);
        if (claimOwnedBy(cur, d.digestId)) continue;
        if (cur) throw claimConflictError();
        deliveries.set(fp, { status: 'claimed', claimedAt: now, digestId: d.digestId });
      }
      for (var j = 0; j < d.jobIds.length; j++) {
        const owned = deliveries.get(deliveryFingerprint(d.email, d.alertId, d.jobIds[j]));
        if (!claimOwnedBy(owned, d.digestId)) throw claimConflictError();
      }
    },
    async reclaimDigest(digestId) {
      const d = outbox.get(digestId);
      if (!d || d.status === 'recorded' || d.status === 'accepted' || d.status === 'ambiguous') return false;
      if (d.status === 'claimed' && Date.now() - d.claimedAt < CLAIM_TTL_MS) return false;
      d.status = 'claimed';
      d.claimedAt = Date.now();
      d.jobIds.forEach(function (id) {
        const fp = deliveryFingerprint(d.email, d.alertId, id);
        const cur = deliveries.get(fp);
        if (cur && cur.status === 'sent') return;
        if (cur && !claimOwnedBy(cur, d.digestId)) return;
        deliveries.set(fp, { status: 'claimed', claimedAt: d.claimedAt, digestId: d.digestId });
      });
      return true;
    },
    async markDigestAccepted(digestId) {
      const d = outbox.get(digestId);
      if (!d) {
        const err = new Error('digest_missing');
        err.code = 'store_unavailable';
        throw err;
      }
      d.status = 'accepted';
      d.acceptedAt = Date.now();
    },
    async recordDigest(digestId) {
      const d = outbox.get(digestId);
      if (!d) {
        const err = new Error('digest_missing');
        err.code = 'store_unavailable';
        throw err;
      }
      const now = Date.now();
      if (d.status === 'accepted') {
        d.jobIds.forEach(function (id) {
          const fp = deliveryFingerprint(d.email, d.alertId, id);
          const cur = deliveries.get(fp);
          deliveries.set(fp, {
            status: 'sent',
            claimedAt: (cur && cur.claimedAt) || now,
            sentAt: now,
            digestId: d.digestId
          });
        });
        d.status = 'recorded';
        d.recordedAt = now;
        return;
      }
      for (var i = 0; i < d.jobIds.length; i++) {
        const fp = deliveryFingerprint(d.email, d.alertId, d.jobIds[i]);
        const cur = deliveries.get(fp);
        if (!cur || (cur.status !== 'claimed' && cur.status !== 'sent')) {
          const err = new Error('delivery_record_failed');
          err.code = 'store_unavailable';
          throw err;
        }
      }
      d.jobIds.forEach(function (id) {
        const fp = deliveryFingerprint(d.email, d.alertId, id);
        const cur = deliveries.get(fp);
        deliveries.set(fp, { status: 'sent', claimedAt: cur.claimedAt, sentAt: now, digestId: d.digestId });
      });
      d.status = 'recorded';
      d.recordedAt = now;
    },
    async failDigest(digestId) {
      const d = outbox.get(digestId);
      if (d && d.status === 'claimed') d.status = 'failed';
    },
    async markDigestAmbiguous(digestId) {
      const d = outbox.get(digestId);
      if (d && d.status !== 'recorded' && d.status !== 'accepted') d.status = 'ambiguous';
    },
    _outbox: outbox,
    _deliveries: deliveries
  };
}

function restHeaders(key) {
  return {
    apikey: key,
    Authorization: 'Bearer ' + key,
    'Content-Type': 'application/json'
  };
}

function createSupabaseStore(url, serviceKey, deps) {
  const base = String(url).replace(/\/$/, '');
  const headers = restHeaders(serviceKey);
  const fetchImpl = (deps && deps.fetch) || fetch;

  async function rest(path, options) {
    const res = await fetchImpl(base + path, options);
    const text = await res.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch (_e) { body = text; }
    return { ok: res.ok, status: res.status, body: body };
  }

  function storeError(message, code) {
    const err = new Error(message || 'store_unavailable');
    err.code = code || 'store_unavailable';
    return err;
  }

  function mapOutboxRow(row) {
    if (!row) return null;
    return {
      digestId: row.digest_id,
      userId: row.user_id,
      email: String(row.email).toLowerCase(),
      alertId: row.alert_id,
      jobIds: Array.isArray(row.job_ids) ? row.job_ids.map(String) : [],
      idempotencyKey: row.idempotency_key,
      status: row.status,
      claimedAt: row.claimed_at ? Date.parse(row.claimed_at) : 0,
      createdAt: row.created_at ? Date.parse(row.created_at) : (row.claimed_at ? Date.parse(row.claimed_at) : 0),
      payload: clonePayload(row.payload)
    };
  }

  async function getDeliveryByFingerprint(fp) {
    const res = await rest(
      '/rest/v1/alert_deliveries?fingerprint=eq.' + encodeURIComponent(fp) +
      '&select=fingerprint,digest_id,status,job_id&limit=1',
      { headers: headers }
    );
    if (!res.ok) throw storeError('delivery_lookup_unavailable');
    return Array.isArray(res.body) ? res.body[0] : null;
  }

  async function requireOwnedClaim(fp, digestId) {
    const existing = await getDeliveryByFingerprint(fp);
    if (claimOwnedBy(existing, digestId)) return existing;
    throw storeError('delivery_claim_conflict', 'delivery_claim_conflict');
  }

  return {
    async probeDurable() {
      const probes = [
        ['alert_subscriptions', '*'],
        ['alert_unsubscribes', '*'],
        ['alert_deliveries', '*'],
        ['alert_outbox', 'digest_id,payload,status']
      ];
      for (var i = 0; i < probes.length; i++) {
        const res = await rest(
          '/rest/v1/' + probes[i][0] + '?select=' + probes[i][1] + '&limit=1',
          { headers: headers }
        );
        if (!res.ok) throw storeError('missing_migration');
      }
      return true;
    },
    async getUserByToken(token) {
      const res = await fetchImpl(base + '/auth/v1/user', {
        headers: { apikey: serviceKey, Authorization: 'Bearer ' + token }
      });
      if (!res.ok) return null;
      const user = await res.json();
      if (!user || !user.id || !user.email) return null;
      if (!user.email_confirmed_at) return null;
      return { id: user.id, email: String(user.email).toLowerCase() };
    },
    async getSubscription(userId, alertId) {
      const res = await rest(
        '/rest/v1/alert_subscriptions?user_id=eq.' + encodeURIComponent(userId) +
        '&alert_id=eq.' + encodeURIComponent(alertId) + '&select=*&limit=1',
        { headers: headers }
      );
      const row = res.ok && Array.isArray(res.body) ? res.body[0] : null;
      if (!row) return null;
      return {
        userId: row.user_id,
        alertId: row.alert_id,
        email: String(row.email).toLowerCase(),
        spec: row.spec || {},
        optedIn: !!row.opted_in
      };
    },
    async listSubscriptions() {
      const res = await rest('/rest/v1/alert_subscriptions?opted_in=eq.true&select=*', { headers: headers });
      if (!res.ok || !Array.isArray(res.body)) throw storeError('subscription_store_unavailable');
      return res.body.map(function (row) {
        return {
          userId: row.user_id,
          alertId: row.alert_id,
          email: String(row.email).toLowerCase(),
          spec: row.spec || {},
          optedIn: !!row.opted_in
        };
      });
    },
    async upsertSubscription(row) {
      const res = await rest('/rest/v1/alert_subscriptions', {
        method: 'POST',
        headers: Object.assign({}, headers, { Prefer: 'resolution=merge-duplicates,return=representation' }),
        body: JSON.stringify({
          user_id: row.userId,
          alert_id: row.alertId,
          email: String(row.email).toLowerCase(),
          spec: row.spec,
          opted_in: !!row.optedIn,
          updated_at: new Date().toISOString()
        })
      });
      if (!res.ok) throw storeError('subscription_store_unavailable');
      return row;
    },
    async deleteSubscription(userId, alertId) {
      const res = await rest(
        '/rest/v1/alert_subscriptions?user_id=eq.' + encodeURIComponent(userId) +
        '&alert_id=eq.' + encodeURIComponent(alertId),
        { method: 'DELETE', headers: headers }
      );
      if (!res.ok) throw storeError('subscription_store_unavailable');
    },
    async isUnsubscribed(email, alertId) {
      const res = await rest(
        '/rest/v1/alert_unsubscribes?email=eq.' + encodeURIComponent(String(email).toLowerCase()) +
        '&alert_id=eq.' + encodeURIComponent(alertId) + '&select=email&limit=1',
        { headers: headers }
      );
      if (!res.ok) throw storeError('unsubscribe_lookup_unavailable');
      return Array.isArray(res.body) && res.body.length > 0;
    },
    async recordUnsubscribe(email, alertId) {
      const res = await rest('/rest/v1/alert_unsubscribes', {
        method: 'POST',
        headers: Object.assign({}, headers, { Prefer: 'resolution=merge-duplicates,return=minimal' }),
        body: JSON.stringify({
          email: String(email).toLowerCase(),
          alert_id: String(alertId)
        })
      });
      if (!res.ok) throw storeError('unsubscribe_store_unavailable');
    },
    async listJobs() {
      const res = await rest('/rest/v1/jobs?' + core.jobsFeedQuery(), { headers: headers });
      if (!res.ok || !Array.isArray(res.body)) throw storeError('jobs_store_unavailable');
      return core.selectFeedListings(res.body);
    },
    async listSentJobIds(email, alertId) {
      const res = await rest(
        '/rest/v1/alert_deliveries?email=eq.' + encodeURIComponent(String(email).toLowerCase()) +
        '&alert_id=eq.' + encodeURIComponent(alertId) + '&status=eq.sent&select=job_id',
        { headers: headers }
      );
      if (!res.ok || !Array.isArray(res.body)) throw storeError('delivery_lookup_unavailable');
      return res.body.map(function (row) { return String(row.job_id); });
    },
    async listOccupiedJobIds(email, alertId) {
      const wantEmail = String(email).toLowerCase();
      const wantAlert = String(alertId);
      const ids = {};
      const claimed = await rest(
        '/rest/v1/alert_deliveries?email=eq.' + encodeURIComponent(wantEmail) +
        '&alert_id=eq.' + encodeURIComponent(wantAlert) +
        '&status=in.(claimed,sent)&select=job_id',
        { headers: headers }
      );
      if (!claimed.ok || !Array.isArray(claimed.body)) throw storeError('delivery_lookup_unavailable');
      claimed.body.forEach(function (row) { ids[String(row.job_id)] = true; });
      const open = await rest(
        '/rest/v1/alert_outbox?email=eq.' + encodeURIComponent(wantEmail) +
        '&alert_id=eq.' + encodeURIComponent(wantAlert) +
        '&status=in.(claimed,accepted,failed,ambiguous)&select=job_ids',
        { headers: headers }
      );
      if (!open.ok || !Array.isArray(open.body)) throw storeError('outbox_unavailable');
      open.body.forEach(function (row) {
        (Array.isArray(row.job_ids) ? row.job_ids : []).forEach(function (id) { ids[String(id)] = true; });
      });
      return Object.keys(ids);
    },
    async getOpenDigest(email, alertId) {
      const res = await rest(
        '/rest/v1/alert_outbox?email=eq.' + encodeURIComponent(String(email).toLowerCase()) +
        '&alert_id=eq.' + encodeURIComponent(alertId) +
        '&status=in.(claimed,accepted,failed,ambiguous)&select=*&order=claimed_at.desc&limit=1',
        { headers: headers }
      );
      if (!res.ok) throw storeError('outbox_unavailable');
      const row = Array.isArray(res.body) ? res.body[0] : null;
      return mapOutboxRow(row);
    },
    async createDigest(row) {
      const open = await this.getOpenDigest(row.email, row.alertId);
      if (open) return { conflict: true, digest: open };
      const now = new Date().toISOString();
      const inserted = await rest('/rest/v1/alert_outbox', {
        method: 'POST',
        headers: Object.assign({}, headers, { Prefer: 'return=representation' }),
        body: JSON.stringify({
          digest_id: row.digestId,
          user_id: row.userId || null,
          email: String(row.email).toLowerCase(),
          alert_id: String(row.alertId),
          job_ids: (row.jobIds || []).map(String),
          payload: clonePayload(row.payload),
          idempotency_key: row.idempotencyKey || row.digestId,
          status: 'claimed',
          claimed_at: now,
          created_at: now
        })
      });
      if (inserted.status === 409) {
        const again = await this.getOpenDigest(row.email, row.alertId);
        if (again) return { conflict: true, digest: again };
        throw storeError('digest_conflict');
      }
      if (!inserted.ok) throw storeError('outbox_unavailable');
      for (var i = 0; i < (row.jobIds || []).length; i++) {
        const fp = deliveryFingerprint(row.email, row.alertId, row.jobIds[i]);
        const claimed = await rest('/rest/v1/alert_deliveries', {
          method: 'POST',
          headers: Object.assign({}, headers, { Prefer: 'return=representation' }),
          body: JSON.stringify({
            fingerprint: fp,
            digest_id: row.digestId,
            user_id: row.userId || null,
            email: String(row.email).toLowerCase(),
            alert_id: String(row.alertId),
            job_id: String(row.jobIds[i]),
            status: 'claimed',
            claimed_at: now
          })
        });
        if (claimed.ok) continue;
        if (claimed.status === 409) {
          await requireOwnedClaim(fp, row.digestId);
          continue;
        }
      }
      const boxRow = Array.isArray(inserted.body) ? inserted.body[0] : null;
      return {
        conflict: false,
        digest: mapOutboxRow(boxRow) || {
          digestId: row.digestId,
          userId: row.userId,
          email: String(row.email).toLowerCase(),
          alertId: String(row.alertId),
          jobIds: (row.jobIds || []).map(String),
          idempotencyKey: row.idempotencyKey || row.digestId,
          status: 'claimed',
          claimedAt: Date.parse(now),
          createdAt: Date.parse(now),
          payload: clonePayload(row.payload)
        }
      };
    },
    async ensureDigestClaims(digestId) {
      const existing = await rest(
        '/rest/v1/alert_outbox?digest_id=eq.' + encodeURIComponent(digestId) + '&select=*&limit=1',
        { headers: headers }
      );
      if (!existing.ok || !Array.isArray(existing.body) || !existing.body.length) {
        throw storeError('digest_missing');
      }
      const row = existing.body[0];
      const jobIds = Array.isArray(row.job_ids) ? row.job_ids.map(String) : [];
      const have = await rest(
        '/rest/v1/alert_deliveries?digest_id=eq.' + encodeURIComponent(digestId) + '&select=job_id,status',
        { headers: headers }
      );
      if (!have.ok || !Array.isArray(have.body)) throw storeError('claim_store_unavailable');
      const present = {};
      have.body.forEach(function (item) { present[String(item.job_id)] = true; });
      const now = new Date().toISOString();
      for (var i = 0; i < jobIds.length; i++) {
        if (present[jobIds[i]]) continue;
        const fp = deliveryFingerprint(row.email, row.alert_id, jobIds[i]);
        const claimed = await rest('/rest/v1/alert_deliveries', {
          method: 'POST',
          headers: Object.assign({}, headers, { Prefer: 'return=representation' }),
          body: JSON.stringify({
            fingerprint: fp,
            digest_id: digestId,
            user_id: row.user_id || null,
            email: String(row.email).toLowerCase(),
            alert_id: String(row.alert_id),
            job_id: jobIds[i],
            status: 'claimed',
            claimed_at: now
          })
        });
        if (claimed.ok) continue;
        if (claimed.status === 409) {
          await requireOwnedClaim(fp, digestId);
          continue;
        }
        throw storeError('claim_store_unavailable');
      }
      const ownedRows = await rest(
        '/rest/v1/alert_deliveries?digest_id=eq.' + encodeURIComponent(digestId) + '&select=job_id',
        { headers: headers }
      );
      if (!ownedRows.ok || !Array.isArray(ownedRows.body)) throw storeError('claim_store_unavailable');
      const owned = {};
      ownedRows.body.forEach(function (item) { owned[String(item.job_id)] = true; });
      for (var j = 0; j < jobIds.length; j++) {
        if (!owned[jobIds[j]]) throw storeError('delivery_claim_conflict', 'delivery_claim_conflict');
      }
    },
    async reclaimDigest(digestId) {
      const staleBefore = new Date(Date.now() - CLAIM_TTL_MS).toISOString();
      const existing = await rest(
        '/rest/v1/alert_outbox?digest_id=eq.' + encodeURIComponent(digestId) + '&select=*&limit=1',
        { headers: headers }
      );
      if (!existing.ok) throw storeError('outbox_unavailable');
      const row = Array.isArray(existing.body) ? existing.body[0] : null;
      if (!row || row.status === 'recorded' || row.status === 'accepted' || row.status === 'ambiguous') return false;
      let updated;
      if (row.status === 'failed') {
        updated = await rest(
          '/rest/v1/alert_outbox?digest_id=eq.' + encodeURIComponent(digestId) + '&status=eq.failed',
          {
            method: 'PATCH',
            headers: Object.assign({}, headers, { Prefer: 'return=representation' }),
            body: JSON.stringify({ status: 'claimed', claimed_at: new Date().toISOString() })
          }
        );
      } else {
        updated = await rest(
          '/rest/v1/alert_outbox?digest_id=eq.' + encodeURIComponent(digestId) +
          '&status=eq.claimed&claimed_at=lt.' + staleBefore,
          {
            method: 'PATCH',
            headers: Object.assign({}, headers, { Prefer: 'return=representation' }),
            body: JSON.stringify({ status: 'claimed', claimed_at: new Date().toISOString() })
          }
        );
      }
      return !!(updated.ok && Array.isArray(updated.body) && updated.body.length);
    },
    async markDigestAccepted(digestId) {
      const res = await rest(
        '/rest/v1/alert_outbox?digest_id=eq.' + encodeURIComponent(digestId) + '&status=in.(claimed,accepted)',
        {
          method: 'PATCH',
          headers: Object.assign({}, headers, { Prefer: 'return=representation' }),
          body: JSON.stringify({ status: 'accepted', accepted_at: new Date().toISOString() })
        }
      );
      if (!res.ok || !Array.isArray(res.body) || !res.body.length) throw storeError('digest_accept_failed');
    },
    async recordDigest(digestId) {
      const now = new Date().toISOString();
      const box = await rest(
        '/rest/v1/alert_outbox?digest_id=eq.' + encodeURIComponent(digestId) +
        '&select=job_ids,email,alert_id,user_id,status,payload&limit=1',
        { headers: headers }
      );
      if (!box.ok || !Array.isArray(box.body) || !box.body.length) throw storeError('digest_missing');
      const boxRow = box.body[0];
      const expected = Array.isArray(boxRow.job_ids) ? boxRow.job_ids.map(String) : [];
      const patched = await rest(
        '/rest/v1/alert_deliveries?digest_id=eq.' + encodeURIComponent(digestId) + '&status=eq.claimed',
        {
          method: 'PATCH',
          headers: Object.assign({}, headers, { Prefer: 'return=representation' }),
          body: JSON.stringify({ status: 'sent', sent_at: now })
        }
      );
      if (!patched.ok) throw storeError('delivery_record_failed');
      const check = await rest(
        '/rest/v1/alert_deliveries?digest_id=eq.' + encodeURIComponent(digestId) + '&select=status,job_id',
        { headers: headers }
      );
      if (!check.ok || !Array.isArray(check.body)) throw storeError('delivery_record_failed');
      const sentIds = {};
      check.body.forEach(function (row) {
        if (row.status === 'sent') sentIds[String(row.job_id)] = true;
      });
      if (boxRow.status === 'accepted') {
        for (var m = 0; m < expected.length; m++) {
          if (sentIds[expected[m]]) continue;
          const fp = deliveryFingerprint(boxRow.email, boxRow.alert_id, expected[m]);
          const inserted = await rest('/rest/v1/alert_deliveries', {
            method: 'POST',
            headers: Object.assign({}, headers, { Prefer: 'return=representation' }),
            body: JSON.stringify({
              fingerprint: fp,
              digest_id: digestId,
              user_id: boxRow.user_id || null,
              email: String(boxRow.email).toLowerCase(),
              alert_id: String(boxRow.alert_id),
              job_id: expected[m],
              status: 'sent',
              claimed_at: now,
              sent_at: now
            })
          });
          if (inserted.ok) {
            sentIds[expected[m]] = true;
            continue;
          }
          if (inserted.status === 409) {
            const existing = await getDeliveryByFingerprint(fp);
            if (existing && claimOwnedBy(existing, digestId) && existing.status === 'sent') {
              sentIds[expected[m]] = true;
              continue;
            }
          }
          throw storeError('delivery_record_incomplete');
        }
      }
      for (var i = 0; i < expected.length; i++) {
        if (!sentIds[expected[i]]) throw storeError('delivery_record_incomplete');
      }
      const recorded = await rest(
        '/rest/v1/alert_outbox?digest_id=eq.' + encodeURIComponent(digestId),
        {
          method: 'PATCH',
          headers: Object.assign({}, headers, { Prefer: 'return=representation' }),
          body: JSON.stringify({ status: 'recorded', recorded_at: now })
        }
      );
      if (!recorded.ok || !Array.isArray(recorded.body) || !recorded.body.length) {
        throw storeError('digest_record_failed');
      }
    },
    async failDigest(digestId) {
      const res = await rest(
        '/rest/v1/alert_outbox?digest_id=eq.' + encodeURIComponent(digestId) + '&status=eq.claimed',
        {
          method: 'PATCH',
          headers: Object.assign({}, headers, { Prefer: 'return=representation' }),
          body: JSON.stringify({ status: 'failed' })
        }
      );
      if (!res.ok) throw storeError('digest_fail_update');
    },
    async markDigestAmbiguous(digestId) {
      const res = await rest(
        '/rest/v1/alert_outbox?digest_id=eq.' + encodeURIComponent(digestId) +
        '&status=in.(claimed,failed)',
        {
          method: 'PATCH',
          headers: Object.assign({}, headers, { Prefer: 'return=representation' }),
          body: JSON.stringify({ status: 'ambiguous' })
        }
      );
      if (!res.ok) throw storeError('digest_ambiguous_update');
    }
  };
}

async function sendWithResend(payload, apiKey) {
  if (!apiKey) {
    const err = new Error('Resend is not configured');
    err.code = 'provider_unconfigured';
    throw err;
  }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + apiKey,
      'Content-Type': 'application/json',
      'Idempotency-Key': payload.idempotencyKey || payload.digestId || ''
    },
    body: JSON.stringify({
      from: payload.from,
      to: payload.to,
      subject: payload.subject,
      text: payload.text,
      headers: payload.headers
    })
  });
  if (!res.ok) {
    const err = new Error('Resend rejected the message');
    err.code = res.status === 409 ? 'idempotency_conflict' : 'provider_error';
    err.status = res.status;
    throw err;
  }
  return res.json();
}

function cors(req, res, origin) {
  if (req.headers.origin && req.headers.origin !== origin) return false;
  if (req.headers.origin) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.setHeader('Vary', 'Origin');
  return true;
}

async function deliveryStatus(opts) {
  const options = opts || {};
  const schedulerOk = !!options.cronSecret;
  const providerOk = !!options.send;
  const unsubOk = !!options.unsubscribeSecret;
  const fromOk = !!options.fromEmail;
  const storePresent = !!(options.store && typeof options.store.probeDurable === 'function');

  let storage = storePresent ? 'unknown' : 'missing';
  if (storePresent) {
    try {
      await options.store.probeDurable();
      storage = 'ok';
    } catch (_e) {
      storage = 'missing_migration';
    }
  }

  const deliveryReady = storage === 'ok' && providerOk && unsubOk && fromOk && schedulerOk;
  return {
    configured: deliveryReady,
    delivery: deliveryReady ? 'ready' : 'unavailable',
    storage: storage,
    provider: providerOk ? 'ok' : 'missing',
    scheduler: schedulerOk ? 'ok' : 'missing',
    optOutAvailable: storage === 'ok',
    setup: deliveryReady ? null : SETUP_DOC
  };
}

function createAlertsHandler(options) {
  const opts = options || {};

  async function handler(req, res) {
    const origin = opts.origin || process.env.STEPPEUP_ORIGIN || 'https://steppeup.ai';
    if (!cors(req, res, origin)) return json(res, 403, { error: 'Origin not allowed' });
    if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }

    const store = opts.store;
    const send = opts.send;
    const secret = opts.unsubscribeSecret || '';
    const fromEmail = opts.fromEmail || '';
    const status = await deliveryStatus({
      store: store,
      send: send,
      unsubscribeSecret: secret,
      fromEmail: fromEmail,
      cronSecret: opts.cronSecret
    });

    if (req.method === 'GET') {
      const url = new URL(req.url, origin);
      if (url.searchParams.get('unsubscribe')) {
        return handleUnsubscribe(url, res, store, secret);
      }
      return json(res, 200, status);
    }

    if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });

    let body;
    try { body = await parseBody(req); } catch (_e) { return json(res, 400, { error: 'Invalid JSON' }); }

    const authenticate = opts.authenticate || (store && store.getUserByToken
      ? function (request) { return store.getUserByToken(bearerToken(request)); }
      : null);

    if (!authenticate) {
      return json(res, 503, { delivered: false, reason: 'auth_unconfigured', setup: SETUP_DOC });
    }

    const user = await authenticate(req);
    if (!user || !user.id || !user.email) {
      return json(res, 401, { delivered: false, error: 'authentication_required' });
    }

    const action = String(body.action || '').toLowerCase();
    if (action === 'subscribe') return handleSubscribe(body, user, res, store, status);
    if (action === 'unsubscribe-alert') return handleOwnerUnsubscribe(body, user, res, store, status);
    if (action === 'dispatch') return handleDispatch(body, user, res, {
      store: store, send: send, secret: secret, fromEmail: fromEmail, origin: origin, status: status
    });
    return json(res, 400, { delivered: false, error: 'unknown_action' });
  }

  return handler;
}

async function handleUnsubscribe(url, res, store, secret) {
  const email = String(url.searchParams.get('email') || '').trim().toLowerCase();
  const alertId = String(url.searchParams.get('alert') || '').trim();
  const token = String(url.searchParams.get('token') || '').trim();
  if (!email || !alertId || !token || !secret) {
    return json(res, 400, { unsubscribed: false, error: 'invalid_token' });
  }
  const expected = createUnsubscribeToken(email, alertId, secret);
  if (!tokensMatch(expected, token)) {
    return json(res, 400, { unsubscribed: false, error: 'invalid_token' });
  }
  if (!store || typeof store.recordUnsubscribe !== 'function') {
    return json(res, 503, { unsubscribed: false, error: 'store_unavailable', setup: SETUP_DOC });
  }
  try {
    await store.recordUnsubscribe(email, alertId);
  } catch (_e) {
    return json(res, 503, { unsubscribed: false, error: 'store_unavailable', setup: SETUP_DOC });
  }
  return json(res, 200, { unsubscribed: true, email: email, alertId: alertId });
}

async function handleSubscribe(body, user, res, store, status) {
  if (!store || typeof store.upsertSubscription !== 'function') {
    return json(res, 503, { delivered: false, reason: 'store_unavailable', setup: SETUP_DOC });
  }
  const alertId = String(body.alertId || '').slice(0, 80);
  if (!alertId) return json(res, 400, { delivered: false, error: 'alert_id_required' });

  if (body.optIn === false) {
    if (!status || status.storage !== 'ok') {
      return json(res, 503, { delivered: false, reason: 'store_unavailable', setup: SETUP_DOC });
    }
    try {
      if (typeof store.deleteSubscription === 'function') {
        await store.deleteSubscription(user.id, alertId);
      } else {
        await store.upsertSubscription({
          userId: user.id, alertId: alertId, email: user.email, spec: {}, optedIn: false
        });
      }
    } catch (_e) {
      return json(res, 503, { delivered: false, reason: 'store_unavailable', setup: SETUP_DOC });
    }
    return json(res, 200, { subscribed: false, optedOut: true, email: user.email, alertId: alertId, delivered: false });
  }

  if (!body.optIn) {
    return json(res, 400, { delivered: false, error: 'explicit_opt_in_required' });
  }
  if (!status || !status.configured) {
    return json(res, 503, { delivered: false, reason: 'provider_unconfigured', setup: SETUP_DOC });
  }
  const spec = core.normalizeAlertSpec(body.spec || {});
  if (!core.alertIsActive(spec)) {
    return json(res, 400, { delivered: false, error: 'inactive_spec' });
  }
  try {
    await store.upsertSubscription({
      userId: user.id,
      alertId: alertId,
      email: user.email,
      spec: spec,
      optedIn: true
    });
  } catch (_e) {
    return json(res, 503, { delivered: false, reason: 'store_unavailable', setup: SETUP_DOC });
  }
  return json(res, 200, { subscribed: true, email: user.email, alertId: alertId, delivered: false });
}

async function handleOwnerUnsubscribe(body, user, res, store, status) {
  if (!status || status.storage !== 'ok') {
    return json(res, 503, { delivered: false, reason: 'store_unavailable', setup: SETUP_DOC });
  }
  const alertId = String(body.alertId || '').slice(0, 80);
  if (!alertId) return json(res, 400, { delivered: false, error: 'alert_id_required' });
  if (!store || typeof store.deleteSubscription !== 'function') {
    return json(res, 503, { delivered: false, reason: 'store_unavailable', setup: SETUP_DOC });
  }
  try {
    await store.deleteSubscription(user.id, alertId);
  } catch (_e) {
    return json(res, 503, { delivered: false, reason: 'store_unavailable', setup: SETUP_DOC });
  }
  return json(res, 200, { subscribed: false, optedOut: true, alertId: alertId, delivered: false });
}

function jobsForDigest(digest, matches) {
  const order = {};
  (digest.jobIds || []).forEach(function (id, idx) { order[String(id)] = idx; });
  return (matches || []).filter(function (job) {
    return Object.prototype.hasOwnProperty.call(order, String(job.id));
  }).sort(function (a, b) {
    return order[String(a.id)] - order[String(b.id)];
  });
}

function buildDigestPayload(jobs, sub, alertId, ctx) {
  const unsub = unsubscribeUrl(ctx.origin, sub.email, alertId, ctx.secret);
  const mail = buildEmail(jobs, unsub, ctx.origin);
  return {
    from: ctx.fromEmail,
    to: sub.email,
    subject: 'Новые вакансии SteppeUp',
    text: mail.text,
    headers: { 'List-Unsubscribe': '<' + unsub + '>' },
    unsubscribe: unsub
  };
}

async function completeAcceptedDigest(digest, res, ctx) {
  try {
    await ctx.store.recordDigest(digest.digestId);
    return json(res, 200, {
      delivered: true,
      persisted: true,
      retried: true,
      count: (digest.jobIds || []).length,
      digestId: digest.digestId,
      idempotencyKey: digest.idempotencyKey
    });
  } catch (err) {
    return json(res, 502, {
      delivered: false,
      persisted: false,
      reason: (err && err.code) || 'delivery_record_failed',
      digestId: digest.digestId,
      idempotencyKey: digest.idempotencyKey
    });
  }
}

async function sendExistingDigest(digest, sub, alertId, res, ctx) {
  if (digest.status === 'ambiguous' || (digest.status !== 'accepted' && idempotencyExpired(digest))) {
    try { await ctx.store.markDigestAmbiguous(digest.digestId); } catch (_e) {}
    return json(res, 409, {
      delivered: false,
      reason: 'idempotency_expired',
      digestId: digest.digestId,
      idempotencyKey: digest.idempotencyKey
    });
  }

  if (digest.status === 'accepted') {
    return completeAcceptedDigest(digest, res, ctx);
  }

  const payload = clonePayload(digest.payload);
  if (!payload || !payload.text) {
    return json(res, 502, {
      delivered: false,
      reason: 'digest_payload_missing',
      digestId: digest.digestId,
      idempotencyKey: digest.idempotencyKey
    });
  }

  try {
    await ctx.store.ensureDigestClaims(digest.digestId);
  } catch (err) {
    if (err && err.code === 'delivery_claim_conflict') {
      try { await ctx.store.failDigest(digest.digestId); } catch (_e) {}
      return json(res, 409, {
        delivered: false,
        reason: 'delivery_claim_conflict',
        digestId: digest.digestId,
        idempotencyKey: digest.idempotencyKey
      });
    }
    return json(res, 502, {
      delivered: false,
      reason: (err && err.code) || 'claim_store_unavailable',
      digestId: digest.digestId,
      idempotencyKey: digest.idempotencyKey
    });
  }

  try {
    await ctx.send({
      from: payload.from,
      to: payload.to,
      subject: payload.subject,
      text: payload.text,
      headers: payload.headers,
      idempotencyKey: digest.idempotencyKey,
      digestId: digest.digestId
    });
  } catch (err) {
    if (err && err.code === 'idempotency_conflict') {
      try { await ctx.store.markDigestAmbiguous(digest.digestId); } catch (_e) {}
      return json(res, 409, {
        delivered: false,
        reason: 'idempotency_conflict',
        digestId: digest.digestId,
        idempotencyKey: digest.idempotencyKey
      });
    }
    try { await ctx.store.failDigest(digest.digestId); } catch (_e) {}
    return json(res, err && err.code === 'provider_unconfigured' ? 503 : 502, {
      delivered: false,
      reason: (err && err.code) || 'provider_error',
      digestId: digest.digestId,
      idempotencyKey: digest.idempotencyKey
    });
  }

  try {
    await ctx.store.markDigestAccepted(digest.digestId);
    await ctx.store.recordDigest(digest.digestId);
  } catch (err) {
    return json(res, 502, {
      delivered: false,
      persisted: false,
      reason: (err && err.code) || 'delivery_record_failed',
      digestId: digest.digestId,
      idempotencyKey: digest.idempotencyKey
    });
  }
  return json(res, 200, {
    delivered: true,
    count: (digest.jobIds || []).length,
    digestId: digest.digestId,
    idempotencyKey: digest.idempotencyKey,
    unsubscribe: payload.headers && payload.headers['List-Unsubscribe']
      ? String(payload.headers['List-Unsubscribe']).replace(/^<|>$/g, '')
      : undefined
  });
}

async function handleDispatch(body, user, res, ctx) {
  if (!ctx.status.configured) {
    return json(res, 503, {
      delivered: false,
      reason: 'provider_unconfigured',
      setup: SETUP_DOC
    });
  }
  const alertId = String(body.alertId || '').slice(0, 80);
  if (!alertId) return json(res, 400, { delivered: false, error: 'alert_id_required' });

  const sub = await ctx.store.getSubscription(user.id, alertId);
  if (!sub || !sub.optedIn) {
    return json(res, 404, { delivered: false, error: 'subscription_not_found' });
  }
  if (sub.email !== String(user.email).toLowerCase()) {
    return json(res, 403, { delivered: false, error: 'recipient_mismatch' });
  }
  try {
    if (await ctx.store.isUnsubscribed(sub.email, alertId)) {
      return json(res, 409, { delivered: false, reason: 'unsubscribed' });
    }
  } catch (err) {
    return json(res, 503, { delivered: false, reason: (err && err.code) || 'store_unavailable', setup: SETUP_DOC });
  }

  let jobs;
  try {
    jobs = await ctx.store.listJobs();
  } catch (err) {
    return json(res, 503, { delivered: false, reason: (err && err.code) || 'store_unavailable', setup: SETUP_DOC });
  }
  const matches = core.matchingJobs(jobs, sub.spec, matchHelpers());

  let digest;
  try {
    digest = await ctx.store.getOpenDigest(sub.email, alertId);
  } catch (err) {
    return json(res, 503, { delivered: false, reason: (err && err.code) || 'store_unavailable', setup: SETUP_DOC });
  }

  if (digest && digest.status === 'accepted') {
    return completeAcceptedDigest(digest, res, ctx);
  }

  if (digest && (digest.status === 'ambiguous' ||
      ((digest.status === 'claimed' || digest.status === 'failed') && idempotencyExpired(digest)))) {
    try { await ctx.store.markDigestAmbiguous(digest.digestId); } catch (_e) {}
    return json(res, 409, {
      delivered: false,
      reason: 'idempotency_expired',
      digestId: digest.digestId,
      idempotencyKey: digest.idempotencyKey
    });
  }

  if (digest && digest.status === 'claimed') {
    if (Date.now() - (digest.claimedAt || 0) < CLAIM_TTL_MS) {
      return json(res, 200, {
        delivered: false,
        reason: 'in_flight',
        digestId: digest.digestId,
        idempotencyKey: digest.idempotencyKey
      });
    }
    const reclaimed = await ctx.store.reclaimDigest(digest.digestId);
    if (!reclaimed) {
      return json(res, 200, {
        delivered: false,
        reason: 'in_flight',
        digestId: digest.digestId,
        idempotencyKey: digest.idempotencyKey
      });
    }
    return sendExistingDigest(digest, sub, alertId, res, ctx);
  }

  if (digest && digest.status === 'failed') {
    const reclaimed = await ctx.store.reclaimDigest(digest.digestId);
    if (!reclaimed) {
      return json(res, 200, {
        delivered: false,
        reason: 'in_flight',
        digestId: digest.digestId,
        idempotencyKey: digest.idempotencyKey
      });
    }
    return sendExistingDigest(digest, sub, alertId, res, ctx);
  }

  let occupiedIds;
  try {
    occupiedIds = typeof ctx.store.listOccupiedJobIds === 'function'
      ? await ctx.store.listOccupiedJobIds(sub.email, alertId)
      : await ctx.store.listSentJobIds(sub.email, alertId);
  } catch (err) {
    return json(res, 503, { delivered: false, reason: (err && err.code) || 'store_unavailable', setup: SETUP_DOC });
  }
  const already = {};
  (occupiedIds || []).forEach(function (id) { already[String(id)] = true; });
  const fresh = [];
  for (var i = 0; i < matches.length && fresh.length < DISPATCH_BATCH; i++) {
    if (!already[String(matches[i].id)]) fresh.push(matches[i]);
  }
  if (!fresh.length) {
    let sentCount = occupiedIds.length;
    try {
      const sentOnly = await ctx.store.listSentJobIds(sub.email, alertId);
      sentCount = sentOnly.length;
    } catch (_e) {}
    return json(res, 200, {
      delivered: false,
      count: 0,
      deduped: sentCount
    });
  }

  const digestId = newDigestId();
  const payload = buildDigestPayload(fresh, sub, alertId, ctx);
  let created;
  try {
    created = await ctx.store.createDigest({
      digestId: digestId,
      userId: user.id,
      email: sub.email,
      alertId: alertId,
      jobIds: fresh.map(function (job) { return String(job.id); }),
      idempotencyKey: digestId,
      payload: {
        from: payload.from,
        to: payload.to,
        subject: payload.subject,
        text: payload.text,
        headers: payload.headers
      }
    });
  } catch (err) {
    if (err && err.code === 'delivery_claim_conflict') {
      return json(res, 409, { delivered: false, reason: 'delivery_claim_conflict', setup: SETUP_DOC });
    }
    return json(res, 503, { delivered: false, reason: (err && err.code) || 'store_unavailable', setup: SETUP_DOC });
  }
  if (created.conflict && created.digest) {
    return json(res, 200, {
      delivered: false,
      reason: 'in_flight',
      digestId: created.digest.digestId,
      idempotencyKey: created.digest.idempotencyKey
    });
  }
  return sendExistingDigest(created.digest, sub, alertId, res, ctx);
}

function cronAuthorized(req, secret) {
  if (!secret) {
    return { ok: false, status: 503, error: 'cron_unconfigured' };
  }
  if (bearerToken(req) !== secret) {
    return { ok: false, status: 401, error: 'cron_unauthorized' };
  }
  return { ok: true };
}

function createCronHandler(options) {
  const opts = options || {};
  return async function handler(req, res) {
    if (req.method !== 'GET' && req.method !== 'POST') {
      return json(res, 405, { error: 'Method not allowed' });
    }
    const auth = cronAuthorized(req, opts.cronSecret);
    if (!auth.ok) {
      return json(res, auth.status, { ran: false, error: auth.error, setup: SETUP_DOC });
    }
    const store = opts.store;
    const send = opts.send;
    const secret = opts.unsubscribeSecret || '';
    const fromEmail = opts.fromEmail || '';
    const origin = opts.origin || process.env.STEPPEUP_ORIGIN || 'https://steppeup.ai';
    const status = await deliveryStatus({
      store: store, send: send, unsubscribeSecret: secret, fromEmail: fromEmail, cronSecret: opts.cronSecret
    });
    if (!status.configured) {
      return json(res, 503, { ran: false, delivered: false, reason: 'provider_unconfigured', setup: SETUP_DOC });
    }
    let subs;
    try {
      subs = await store.listSubscriptions();
    } catch (err) {
      return json(res, 503, { ran: false, reason: (err && err.code) || 'store_unavailable', setup: SETUP_DOC });
    }
    const results = [];
    for (var i = 0; i < subs.length; i++) {
      const sub = subs[i];
      const inner = {
        statusCode: 0,
        headers: {},
        body: '',
        setHeader: function (k, v) { this.headers[k] = v; },
        end: function (s) { this.body = s || ''; }
      };
      await handleDispatch({ alertId: sub.alertId }, { id: sub.userId, email: sub.email }, inner, {
        store: store, send: send, secret: secret, fromEmail: fromEmail, origin: origin, status: status
      });
      results.push({ alertId: sub.alertId, status: inner.statusCode, body: inner.body ? JSON.parse(inner.body) : null });
    }
    return json(res, 200, {
      ran: true,
      subscriptions: results.length,
      delivered: results.filter(function (row) { return row.body && row.body.delivered; }).length
    });
  };
}

function createProductionHandler() {
  const secret = process.env.ALERT_UNSUBSCRIBE_SECRET || '';
  const fromEmail = process.env.ALERT_FROM_EMAIL || '';
  const resendKey = process.env.RESEND_API_KEY || '';
  const sbUrl = process.env.SUPABASE_URL || '';
  const sbKey = process.env.SUPABASE_SERVICE_KEY || '';
  const ready = !!(secret && fromEmail && resendKey && sbUrl && sbKey);
  const store = (sbUrl && sbKey) ? createSupabaseStore(sbUrl, sbKey) : null;
  return createAlertsHandler({
    origin: process.env.STEPPEUP_ORIGIN || 'https://steppeup.ai',
    unsubscribeSecret: secret,
    fromEmail: fromEmail,
    cronSecret: process.env.CRON_SECRET || '',
    store: store,
    send: ready ? function (payload) { return sendWithResend(payload, resendKey); } : null
  });
}

function createProductionCronHandler() {
  const secret = process.env.ALERT_UNSUBSCRIBE_SECRET || '';
  const fromEmail = process.env.ALERT_FROM_EMAIL || '';
  const resendKey = process.env.RESEND_API_KEY || '';
  const sbUrl = process.env.SUPABASE_URL || '';
  const sbKey = process.env.SUPABASE_SERVICE_KEY || '';
  const ready = !!(secret && fromEmail && resendKey && sbUrl && sbKey);
  const store = (sbUrl && sbKey) ? createSupabaseStore(sbUrl, sbKey) : null;
  return createCronHandler({
    origin: process.env.STEPPEUP_ORIGIN || 'https://steppeup.ai',
    unsubscribeSecret: secret,
    fromEmail: fromEmail,
    cronSecret: process.env.CRON_SECRET || '',
    store: store,
    send: ready ? function (payload) { return sendWithResend(payload, resendKey); } : null
  });
}

const handler = createProductionHandler();
handler.createAlertsHandler = createAlertsHandler;
handler.createMemoryStore = createMemoryStore;
handler.createUnsubscribeToken = createUnsubscribeToken;
handler.createSupabaseStore = createSupabaseStore;
module.exports = handler;
module.exports.createAlertsHandler = createAlertsHandler;
module.exports.createMemoryStore = createMemoryStore;
module.exports.createUnsubscribeToken = createUnsubscribeToken;
module.exports.createSupabaseStore = createSupabaseStore;
module.exports.createProductionHandler = createProductionHandler;
module.exports.createCronHandler = createCronHandler;
module.exports.createProductionCronHandler = createProductionCronHandler;
module.exports.cronAuthorized = cronAuthorized;
module.exports.CLAIM_TTL_MS = CLAIM_TTL_MS;
module.exports.IDEMPOTENCY_TTL_MS = IDEMPOTENCY_TTL_MS;
