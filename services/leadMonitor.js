'use strict';
const axios = require('axios');
const db    = require('../db');
const alert = require('./alert');

/**
 * leadMonitor.js
 *
 * Every N hours (default: 6), per-client:
 *  1. Ping the WP plugin /health endpoint → get last_successful_lead_at
 *  2. Compare to now. If older than lead_dry_spell_days → fire active test
 *  3. Active test result:
 *       - fail  → "broken" alert  (🚨 Critical — form is dead)
 *       - pass  → "dry_spell" alert (📉 Marketing — no leads, but form works)
 *  4. Update DB lead_status + last_lead_check_at
 */

async function checkClient(client, settings) {
  if (!client.monitor_key || !client.url) return;

  const drySpellDays = client.lead_dry_spell_days
    ?? Number(settings.lead_dry_spell_days_default ?? 3);

  if (drySpellDays === 0 || drySpellDays == null) {
    // 0 = disabled for this client
    return;
  }

  const apiBase   = `${client.url.replace(/\/$/, '')}/wp-json/wm-monitor/v1`;
  const headers   = { 'X-WM-Monitor-Key': client.monitor_key };

  // ── Step 1: Get health / last lead timestamp ───────────────────────────
  let healthData;
  try {
    const { data } = await axios.get(`${apiBase}/health`, { headers, timeout: 15000 });
    healthData = data;
  } catch (err) {
    console.warn(`[leadMonitor] ${client.name}: health ping failed — ${err.message}`);
    await db.updateLeadStatus(client.id, { lead_status: 'unknown' });
    return;
  }

  const lastLeadAt = healthData?.last_successful_lead_at
    ? new Date(healthData.last_successful_lead_at)
    : null;

  // Always cache what the plugin told us
  await db.updateLeadStatus(client.id, {
    last_organic_lead_at: lastLeadAt ? lastLeadAt.toISOString() : client.last_organic_lead_at,
    last_lead_check_at:   new Date().toISOString(),
  });

  // ── Step 2: Is the site within its dry-spell threshold? ───────────────
  const now              = new Date();
  const thresholdMs      = drySpellDays * 24 * 60 * 60 * 1000;
  const hoursSinceCheck  = lastLeadAt ? (now - lastLeadAt) : Infinity;
  const isPastThreshold  = hoursSinceCheck >= thresholdMs;

  if (!isPastThreshold) {
    await db.updateLeadStatus(client.id, { lead_status: 'ok' });
    console.log(`[leadMonitor] ${client.name}: ✅ lead within threshold (${Math.round(hoursSinceCheck / 3600000)}h ago)`);
    return;
  }

  console.log(`[leadMonitor] ${client.name}: ⚠️ dry spell detected — running active form test`);

  // ── Step 3: Fire the silent active test ──────────────────────────────
  let testResult;
  try {
    const { data } = await axios.post(
      `${apiBase}/test-form`,
      {
        form_id:      client.form_id || 1,
        test_email:   client.test_email || 'test@webmarketers.ca',
        silent_mode:  true, // tells plugin to suppress email + delete entry
      },
      { headers, timeout: 30000 }
    );
    testResult = data;
  } catch (err) {
    // Network failure / 500 on the test itself
    await db.updateLeadStatus(client.id, { lead_status: 'broken' });
    await alert.sendAlert(
      client,
      '🚨 Form Test Failed — Active Test Error',
      `*Lead dry spell detected* (${drySpellDays} day threshold exceeded).\n\n` +
      `An active form test was triggered but *failed to connect* to the site.\n\n` +
      `Error: \`${err.message}\`\n\n` +
      `*Action needed:* Check that the site is online and the WM Monitor plugin is active.`
    );
    return;
  }

  const formOk = testResult?.form_submitted === true;

  if (!formOk) {
    // Form exists but is broken
    await db.updateLeadStatus(client.id, { lead_status: 'broken' });
    const errors = JSON.stringify(testResult?.errors ?? testResult);
    await alert.sendAlert(
      client,
      '🚨 Contact Form Broken',
      `*Lead dry spell detected* (${drySpellDays} day threshold exceeded).\n\n` +
      `An active form test was triggered and *the form submission failed*.\n\n` +
      `Errors: \`${errors}\`\n\n` +
      `*Immediate action needed:* The contact form on this site is not working. ` +
      `Real leads may be lost.`
    );
  } else {
    // Form works fine — it's a marketing/traffic problem
    const daysSince = lastLeadAt
      ? Math.round((now - lastLeadAt) / (1000 * 60 * 60 * 24))
      : 'unknown';

    await db.updateLeadStatus(client.id, { lead_status: 'dry_spell' });
    await alert.sendAlert(
      client,
      '📉 No Leads Received',
      `*No real form submissions* have been detected in the past *${daysSince} day(s)* ` +
      `(threshold: ${drySpellDays} days).\n\n` +
      `✅ *Good news:* An active form test was run and the form is working correctly.\n\n` +
      `📉 *Possible causes:*\n` +
      `• Google Ads campaign paused or budget depleted\n` +
      `• Organic traffic drop (check Search Console)\n` +
      `• Seasonal slowdown\n\n` +
      `*Recommended:* Review analytics and ad campaigns for this site.`
    );
  }
}

/**
 * Run the lead check for all clients that have a monitor_key.
 * Called by the cron in scheduler.js every N hours.
 */
async function runLeadCheck() {
  const settings = await db.getSettings();

  if (!settings.lead_monitoring_enabled) {
    console.log('[leadMonitor] Lead monitoring disabled — skipping.');
    return;
  }

  const clients = await db.getAllClients();
  const eligible = clients.filter(c => c.monitor_key);

  console.log(`[leadMonitor] Running lead check for ${eligible.length} client(s)…`);

  for (const client of eligible) {
    try {
      await checkClient(client, settings);
    } catch (err) {
      console.error(`[leadMonitor] Unhandled error for ${client.name}:`, err.message);
    }
  }

  console.log('[leadMonitor] Lead check complete.');
}

module.exports = { runLeadCheck, checkClient };
