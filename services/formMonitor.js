'use strict';
const axios  = require('axios');
const db     = require('../db');
const alert  = require('./alert');

const SUPPORT_EMAIL = 'support@teamwebmarketers.ca';

// ── Passive webhook: called when WP plugin fires a real form submission ────────
async function recordRealSubmission(clientId, payload) {
  const { form_id, form_name, form_type, submitted_at } = payload;

  await db.insertFormSubmissionLog({
    client_id:    clientId,
    form_id:      form_id || null,
    form_name:    form_name || null,
    form_type:    form_type || 'unknown',
    submitted_at: submitted_at || new Date().toISOString(),
    is_test:      false,
    status:       'received',
  });

  // Reset the dry-spell counter by updating last_real_form_at on the client
  await db.updateFormStatus(clientId, {
    last_real_form_at:    submitted_at || new Date().toISOString(),
    form_test_triggered:  false,
    form_status:          'ok',
  });

  console.log(`[formMonitor] Real submission recorded for client ${clientId} — ${form_name || form_type}`);
}

// ── Breakpoint cron: run hourly, check all clients ────────────────────────────
async function runFormBreakpointCheck() {
  const settings = await db.getSettings();

  if (!settings.form_monitoring_enabled) {
    console.log('[formMonitor] Form monitoring disabled — skipping.');
    return;
  }

  const clients = await db.getAllClients();
  const eligible = clients.filter(c => c.monitor_key && c.url);

  console.log(`[formMonitor] Checking ${eligible.length} client(s) for form breakpoints…`);

  for (const client of eligible) {
    try {
      await checkClientBreakpoint(client, settings);
    } catch (err) {
      console.error(`[formMonitor] Error checking ${client.name}:`, err.message);
    }
  }

  console.log('[formMonitor] Breakpoint check complete.');
}

// ── Per-client breakpoint logic ───────────────────────────────────────────────
async function checkClientBreakpoint(client, settings) {
  // Determine breakpoint (site override or global default, in days)
  const breakpointDays = client.form_breakpoint_days
    ?? Number(settings.form_breakpoint_days_default ?? 3);

  if (!breakpointDays || breakpointDays === 0) return; // disabled

  const now             = new Date();
  const lastRealAt      = client.last_real_form_at ? new Date(client.last_real_form_at) : null;
  const daysSinceLast   = lastRealAt
    ? (now - lastRealAt) / (1000 * 60 * 60 * 24)
    : Infinity;

  const daysRemaining   = Math.max(0, breakpointDays - daysSinceLast);
  const isPastBreakpoint = daysSinceLast >= breakpointDays;

  // Update days_since on client record for dashboard display
  await db.updateFormStatus(client.id, {
    form_days_since_last: Math.round(daysSinceLast * 10) / 10,
    form_breakpoint_days: breakpointDays,
  });

  if (!isPastBreakpoint) {
    console.log(`[formMonitor] ${client.name}: ✅ within breakpoint (${daysSinceLast.toFixed(1)}d / ${breakpointDays}d)`);
    return;
  }

  // Already triggered a test? Don't spam — wait for a real submission to reset
  if (client.form_test_triggered) {
    console.log(`[formMonitor] ${client.name}: breakpoint hit but test already fired — waiting for real submission`);
    return;
  }

  console.log(`[formMonitor] ${client.name}: ⚠️ breakpoint exceeded (${daysSinceLast.toFixed(1)}d) — triggering silent test`);

  await triggerSilentFormTest(client, settings, daysSinceLast, breakpointDays);
}

// ── Trigger a silent active test via WP plugin ────────────────────────────────
async function triggerSilentFormTest(client, settings, daysSinceLast, breakpointDays) {
  const baseUrl  = client.url.replace(/\/$/, '');
  const endpoint = `${baseUrl}/wp-json/wm-monitor/v1/test-form`;
  const headers  = {
    'X-WM-Monitor-Key': client.monitor_key,
    'Content-Type': 'application/json',
  };

  // Mark that we've triggered a test (prevents duplicate fires until next real submission)
  await db.updateFormStatus(client.id, {
    form_test_triggered:  true,
    form_last_test_at:    new Date().toISOString(),
    form_status:          'testing',
  });

  let testResult = null;
  let testPassed = false;
  let errorMsg   = null;

  try {
    const { data } = await axios.post(
      endpoint,
      {
        form_id:     client.form_id || 1,
        silent_mode: true, // suppresses owner email notification
      },
      { headers, timeout: 30000 }
    );

    testResult = data;
    testPassed = data?.form_submitted === true;

    if (!testPassed) {
      errorMsg = JSON.stringify(data?.errors || data);
    }

  } catch (err) {
    errorMsg = err.response
      ? `HTTP ${err.response.status}: ${JSON.stringify(err.response.data)}`
      : err.message;
  }

  // Log the test run in form_submission_log
  await db.insertFormSubmissionLog({
    client_id:    client.id,
    form_id:      client.form_id || null,
    form_name:    testResult?.form_name || null,
    form_type:    testResult?.form_type || 'unknown',
    submitted_at: new Date().toISOString(),
    is_test:      true,
    status:       testPassed ? 'test_passed' : 'test_failed',
    error:        errorMsg || null,
    details:      testResult ? JSON.stringify(testResult) : null,
  });

  // Update client status
  await db.updateFormStatus(client.id, {
    form_status:          testPassed ? 'ok_tested' : 'broken',
    form_last_test_at:    new Date().toISOString(),
    form_last_test_ok:    testPassed,
  });

  if (!testPassed) {
    // ── Immediate alert to support ──────────────────────────────────────────
    const daysSinceStr = daysSinceLast === Infinity
      ? 'No submissions ever recorded'
      : `${Math.round(daysSinceLast)} days`;

    await sendFormErrorAlert(client, settings, {
      daysSinceLast: daysSinceStr,
      breakpointDays,
      errorMsg,
      testResult,
    });
  } else {
    console.log(`[formMonitor] ${client.name}: ✅ silent test PASSED — form is working`);
  }
}

// ── Send immediate error alert to support ─────────────────────────────────────
async function sendFormErrorAlert(client, settings, { daysSinceLast, breakpointDays, errorMsg, testResult }) {
  const subject = `⚠️ Form Submission Error — ${client.name}`;

  const body = [
    `*Form submission issue detected on ${client.name}.*`,
    ``,
    `• *Last real submission:* ${daysSinceLast}`,
    `• *Breakpoint threshold:* ${breakpointDays} days`,
    `• *Test triggered:* ${new Date().toLocaleString('en-CA', { timeZone: 'America/Toronto' })}`,
    `• *Test result:* ❌ FAILED`,
    ``,
    errorMsg ? `*Error:* \`${errorMsg}\`` : '',
    ``,
    `*Action Required:* Please check the contact form at ${client.url}`,
    ``,
    `Possible causes: reCAPTCHA misconfiguration, plugin conflict, or server error.`,
  ].filter(l => l !== undefined).join('\n');

  // Always send to support@teamwebmarketers.ca via SES/SMTP
  await sendSupportAlert(settings, subject, body, client);
}

// ── Direct support alert (bypasses per-client alert settings) ─────────────────
async function sendSupportAlert(settings, subject, body, client) {
  try {
    const nodemailer = require('nodemailer');
    const provider   = settings.email_provider || 'ses';
    const fromName   = settings.smtp_from_name || 'WM Plus Monitoring';
    const fromEmail  = settings.smtp_from || settings.aws_ses_from || '';

    let transporter;
    if (provider === 'ses') {
      const region = settings.aws_region || 'us-east-1';
      transporter  = nodemailer.createTransport({
        host:   `email-smtp.${region}.amazonaws.com`,
        port:   587,
        secure: false,
        auth: {
          user: settings.aws_access_key_id,
          pass: settings.aws_secret_access_key,
        },
      });
    } else {
      transporter = nodemailer.createTransport({
        host:   settings.smtp_host,
        port:   parseInt(settings.smtp_port) || 587,
        secure: Boolean(settings.smtp_secure),
        auth: { user: settings.smtp_user, pass: settings.smtp_pass },
      });
    }

    const htmlBody = buildFormAlertEmail(subject, body, client);
    await transporter.sendMail({
      from:    `"${fromName}" <${fromEmail}>`,
      to:      SUPPORT_EMAIL,
      subject: `[WM Monitor] ${subject}`,
      html:    htmlBody,
    });

    console.log(`[formMonitor] ✅ support alert sent to ${SUPPORT_EMAIL} for ${client.name}`);
  } catch (err) {
    console.error(`[formMonitor] ❌ Failed to send support alert:`, err.message);
  }
}

// ── HTML email template for form errors ───────────────────────────────────────
function buildFormAlertEmail(subject, body, client) {
  const DASHBOARD = process.env.DASHBOARD_URL || 'https://backstop.webmarketersdev.ca';
  const htmlBody  = body.replace(/\n/g, '<br>').replace(/\*(.*?)\*/g, '<strong>$1</strong>');

  return `<!DOCTYPE html>
<html><body style="font-family:Arial,sans-serif;background:#f4f4f4;padding:24px;margin:0">
  <div style="max-width:600px;margin:0 auto;background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.1)">
    <div style="background:#d97706;padding:24px 32px">
      <h1 style="color:#fff;margin:0;font-size:20px">⚠️ Form Monitoring Alert</h1>
      <p style="color:#fef3c7;margin:6px 0 0;font-size:14px">${subject}</p>
    </div>
    <div style="padding:28px 32px">
      <table style="width:100%;border-collapse:collapse;margin-bottom:20px">
        <tr><td style="padding:8px 0;font-weight:bold;color:#555;width:140px">Client</td><td style="color:#111">${client.name}</td></tr>
        <tr><td style="padding:8px 0;font-weight:bold;color:#555">Site URL</td><td><a href="${client.url}" style="color:#d97706">${client.url}</a></td></tr>
        <tr><td style="padding:8px 0;font-weight:bold;color:#555">Alert Time</td><td>${new Date().toLocaleString('en-CA', { timeZone: 'America/Toronto' })}</td></tr>
      </table>
      <div style="background:#fffbeb;border-left:4px solid #d97706;padding:14px 18px;border-radius:4px;color:#333;line-height:1.7;margin-bottom:24px">
        ${htmlBody}
      </div>
      <a href="${DASHBOARD}/#/client/${client.id}"
        style="display:inline-block;background:#931834;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:bold;font-size:14px">
        View Dashboard →
      </a>
    </div>
    <div style="background:#f9f9f9;padding:16px 32px;border-top:1px solid #eee">
      <p style="color:#999;font-size:12px;margin:0">Automated alert from <strong>WM Plus Monitoring</strong> — sent to support@teamwebmarketers.ca</p>
    </div>
  </div>
</body></html>`;
}

// ── Generate 6-hour dashboard report ─────────────────────────────────────────
async function generateFormReport() {
  const clients = await db.getAllClients();
  const report  = [];

  for (const client of clients) {
    const recentLogs = await db.getFormSubmissionLogs(client.id, 50);
    const realLogs   = recentLogs.filter(l => !l.is_test);
    const testLogs   = recentLogs.filter(l => l.is_test);

    report.push({
      client_id:         client.id,
      client_name:       client.name,
      client_url:        client.url,
      last_real_form_at: client.last_real_form_at || null,
      form_status:       client.form_status || 'unknown',
      form_breakpoint_days: client.form_breakpoint_days || null,
      form_days_since_last: client.form_days_since_last || null,
      form_test_triggered:  client.form_test_triggered || false,
      form_last_test_at:    client.form_last_test_at || null,
      form_last_test_ok:    client.form_last_test_ok,
      recent_real_count: realLogs.length,
      recent_test_count: testLogs.length,
      recent_logs:       recentLogs.slice(0, 10),
    });
  }

  console.log(`[formMonitor] 6hr report generated for ${report.length} client(s)`);
  return report;
}

module.exports = {
  recordRealSubmission,
  runFormBreakpointCheck,
  triggerSilentFormTest,
  generateFormReport,
};
