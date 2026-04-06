'use strict';
const axios = require('axios');
const db = require('../db');

/**
 * Calls the WM Monitor WordPress plugin REST endpoint to:
 * 1. Ping the site (verify plugin is installed + keys match)
 * 2. Submit a Gravity Forms test entry
 * 3. Check Post SMTP email delivery
 */
async function runFormTest(runId, client) {
  const baseUrl = client.url.replace(/\/$/, '');
  const endpoint = `${baseUrl}/wp-json/wm-monitor/v1/test-form`;

  const headers = {
    'X-WM-Monitor-Key': client.monitor_key,
    'Content-Type': 'application/json',
  };

  let log = `[${new Date().toISOString()}] Starting form test for ${client.url}\n`;
  log += `[${new Date().toISOString()}] Endpoint: ${endpoint}\n`;
  log += `[${new Date().toISOString()}] Form ID: ${client.form_id}\n`;
  log += `[${new Date().toISOString()}] Test email: ${client.test_email}\n\n`;
  db.updateRunLog(runId, log);

  try {
    // Step 1: Ping the plugin
    log += `[${new Date().toISOString()}] Step 1: Pinging plugin...\n`;
    db.updateRunLog(runId, log);

    let pingResult;
    try {
      const pingRes = await axios.get(`${baseUrl}/wp-json/wm-monitor/v1/ping`, {
        headers,
        timeout: 15000,
      });
      pingResult = pingRes.data;
      log += `[${new Date().toISOString()}] ✅ Plugin reachable. Site: "${pingResult.site}"\n`;
      log += `[${new Date().toISOString()}]    Gravity Forms: ${pingResult.gravity_forms ? '✅ installed' : '❌ not found'}\n`;
      log += `[${new Date().toISOString()}]    Post SMTP: ${pingResult.post_smtp ? '✅ installed' : '❌ not found'}\n\n`;
    } catch (pingErr) {
      const msg = pingErr.response
        ? `HTTP ${pingErr.response.status}: ${JSON.stringify(pingErr.response.data)}`
        : pingErr.message;
      log += `[${new Date().toISOString()}] ❌ Plugin ping failed: ${msg}\n`;
      log += `[${new Date().toISOString()}] Make sure the WM Monitor plugin is installed and active on the site.\n`;
      db.updateRun(runId, 'error', log, {
        error: 'Plugin not reachable',
        plugin_ping: false,
        form_submitted: false,
        email_sent: false,
      });
      return;
    }

    // Check Gravity Forms
    if (!pingResult.gravity_forms) {
      log += `[${new Date().toISOString()}] ❌ Gravity Forms not installed. Cannot run form test.\n`;
      db.updateRun(runId, 'error', log, {
        error: 'Gravity Forms not installed',
        plugin_ping: true,
        form_submitted: false,
        email_sent: false,
      });
      return;
    }

    // Step 2: Submit the form
    log += `[${new Date().toISOString()}] Step 2: Submitting Gravity Form ID ${client.form_id}...\n`;
    db.updateRunLog(runId, log);

    const formRes = await axios.post(
      endpoint,
      {
        form_id:     client.form_id,
        test_email:  client.test_email,
        silent_mode: true,   // ← suppress client notification emails
      },
      { headers, timeout: 30000 }
    );

    let result = formRes.data;
    
    // Some WP plugins inject HTML/JS into REST API responses, causing Axios to return a string.
    if (typeof result === 'string') {
      try {
        const jsonStart = result.indexOf('{');
        const jsonEnd = result.lastIndexOf('}') + 1;
        if (jsonStart !== -1 && jsonEnd > jsonStart) {
          result = JSON.parse(result.substring(jsonStart, jsonEnd));
        }
      } catch (e) {
        log += `[${new Date().toISOString()}] ⚠️ Server returned malformed JSON: ${e.message}\n`;
      }
    }

    log += `[${new Date().toISOString()}] Form submitted: ${result.form_submitted ? '✅ Yes' : '❌ No'}\n`;
    if (result.entry_id) log += `[${new Date().toISOString()}]    Entry ID: ${result.entry_id}\n`;
    if (result.errors) log += `[${new Date().toISOString()}]    Errors: ${typeof result.errors === 'string' ? result.errors : JSON.stringify(result.errors)}\n`;
    log += `\n`;

    // Step 3: Email delivery check
    log += `[${new Date().toISOString()}] Step 3: Checking Post SMTP email log...\n`;
    log += `[${new Date().toISOString()}] Email sent: ${result.email_sent ? '✅ Yes' : '❌ No'}\n`;
    if (result.email_log) {
      log += `[${new Date().toISOString()}]    To: ${result.email_log.to_email || result.email_log.receiver}\n`;
      log += `[${new Date().toISOString()}]    Subject: ${result.email_log.subject}\n`;
      log += `[${new Date().toISOString()}]    Status: ${result.email_log.status || 'sent'}\n`;
    } else if (!pingResult.post_smtp) {
      log += `[${new Date().toISOString()}]    ⚠️ Post SMTP not installed — cannot verify email delivery\n`;
    } else if (result.wp_mail_fired === false) {
      log += `[${new Date().toISOString()}]    ❌ wp_mail() was NEVER called by the form plugin.\n`;
      log += `[${new Date().toISOString()}]    ⚠️ Make sure the form has an active notification configured!\n`;
    } else {
      log += `[${new Date().toISOString()}]    ❌ No recent email log entry found since form submission\n`;
      log += `[${new Date().toISOString()}]    ⚠️ wp_mail() WAS called, but Post SMTP did not record it in time.\n`;
    }

    // Determine overall status
    const passed = result.form_submitted && (result.email_sent || !pingResult.post_smtp);
    const status = passed ? 'passed' : 'failed';

    log += `\n[${new Date().toISOString()}] ──────────────────────────────\n`;
    log += `[${new Date().toISOString()}] Result: ${status === 'passed' ? '✅ PASSED' : '❌ FAILED'}\n`;

    db.updateRun(runId, status, log, {
      plugin_ping: true,
      gravity_forms: pingResult.gravity_forms,
      post_smtp: pingResult.post_smtp,
      form_submitted: result.form_submitted,
      entry_id: result.entry_id,
      email_sent: result.email_sent,
      email_log: result.email_log,
      errors: result.errors,
    });

    // Also record this test in the form_submission_log
    await db.insertFormSubmissionLog({
      client_id:    client.id,
      form_id:      client.form_id || null,
      form_name:    null,
      form_type:    'manual_test',
      submitted_at: new Date().toISOString(),
      is_test:      true,
      status:       passed ? 'test_passed' : 'test_failed',
      error:        !passed ? JSON.stringify(result.errors || result) : null,
      details:      JSON.stringify(result),
    });

  } catch (err) {
    const errMsg = err.response
      ? `HTTP ${err.response.status}: ${JSON.stringify(err.response.data)}`
      : err.message;

    log += `[${new Date().toISOString()}] ❌ Error: ${errMsg}\n`;
    db.updateRun(runId, 'error', log, { error: errMsg });
  }
}

module.exports = { runFormTest };
