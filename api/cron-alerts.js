/**
 * Daily job-alert dispatch. Disabled until the email stack is configured
 * and CRON_SECRET is set. Vercel Cron hits this path with
 * Authorization: Bearer $CRON_SECRET. Hobby plans allow at most one run
 * per day (see vercel.json `0 6 * * *` UTC). The handler never sends if
 * Resend/Supabase/secrets/migration are missing.
 */
'use strict';

const { createProductionCronHandler } = require('./alerts');

module.exports = createProductionCronHandler();
