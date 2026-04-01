'use strict';
const express      = require('express');
const router       = express.Router();
const db           = require('../db');
const formMonitor  = require('../services/formMonitor');

/**
 * POST /api/form-webhook
 *
 * Receives passive form submission events from the WM Monitor WP plugin.
 * The plugin fires this on every real (non-test) GF or CF7 submission.
 * Authenticated via X-WM-Monitor-Key header matched against the client's monitor_key.
 */
router.post('/', async (req, res) => {
  try {
    const providedKey = req.headers['x-wm-monitor-key'];
    const { event, form_type, form_id, form_name, submitted_at, site, is_test } = req.body;

    if (!providedKey) {
      return res.status(401).json({ success: false, error: 'Missing X-WM-Monitor-Key header' });
    }

    if (event !== 'form_submission') {
      return res.status(400).json({ success: false, error: `Unknown event type: ${event}` });
    }

    // Find client by monitor_key
    const clients = await db.getAllClients();
    const client  = clients.find(c => c.monitor_key && c.monitor_key === providedKey);

    if (!client) {
      return res.status(401).json({ success: false, error: 'Invalid monitor key — no matching client found' });
    }

    // Skip if it's our own test (plugin sets is_test: false for real, but just in case)
    if (is_test) {
      return res.json({ success: true, message: 'Test submission acknowledged but not recorded' });
    }

    // Record the real submission
    await formMonitor.recordRealSubmission(client.id, {
      form_id,
      form_name,
      form_type,
      submitted_at: submitted_at || new Date().toISOString(),
    });

    console.log(`[formWebhook] ✅ Real submission from ${client.name} — ${form_type}/${form_name}`);
    res.json({ success: true, message: 'Submission recorded', client: client.name });

  } catch (err) {
    console.error('[formWebhook] Error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/form-webhook/logs/:clientId
 * Returns the form submission log for a specific client.
 */
router.get('/logs/:clientId', async (req, res) => {
  try {
    const clientId = Number(req.params.clientId);
    const limit    = Math.min(Number(req.query.limit) || 50, 200);
    const logs     = await db.getFormSubmissionLogs(clientId, limit);
    res.json({ success: true, data: logs });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/form-webhook/logs
 * Returns recent form activity across all clients.
 */
router.get('/logs', async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const logs  = await db.getRecentFormActivity(limit);
    res.json({ success: true, data: logs });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/form-webhook/report
 * Returns the current 6hr form monitoring report for all clients.
 */
router.get('/report', async (req, res) => {
  try {
    const report = await formMonitor.generateFormReport();
    res.json({ success: true, data: report });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/form-webhook/trigger-test/:clientId
 * Manually trigger a silent form test for a specific client.
 */
router.post('/trigger-test/:clientId', async (req, res) => {
  try {
    const clientId = Number(req.params.clientId);
    const client   = await db.getClientById(clientId);
    if (!client) return res.status(404).json({ success: false, error: 'Client not found' });
    if (!client.monitor_key) return res.status(400).json({ success: false, error: 'Client has no monitor key configured' });

    const settings = await db.getSettings();

    // Run in background, return immediately
    res.json({ success: true, message: `Silent form test triggered for ${client.name}` });

    formMonitor.triggerSilentFormTest(client, settings, null, client.form_breakpoint_days || settings.form_breakpoint_days_default || 3)
      .catch(err => console.error(`[formWebhook] Manual test error for ${client.name}:`, err.message));

  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
