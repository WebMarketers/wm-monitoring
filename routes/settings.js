'use strict';
const express   = require('express');
const router    = express.Router();
const db        = require('../db');
const scheduler = require('../services/scheduler');
const cleanup   = require('../services/cleanup');
const alert     = require('../services/alert');

// GET /api/settings
router.get('/', async (req, res) => {
  try {
    const settings = await db.getSettings();
    // Never expose SMTP password to frontend
    const safe = { ...settings, smtp_pass: settings.smtp_pass ? '••••••••' : '' };
    res.json({ success: true, data: safe });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// PUT /api/settings
router.put('/', async (req, res) => {
  try {
    const allowed = [
      'auto_check_enabled', 'global_schedule', 'auto_form_enabled',
      'default_slack', 'global_mismatch_threshold',
      'smtp_host', 'smtp_port', 'smtp_user', 'smtp_pass',
      'smtp_from', 'smtp_from_name', 'smtp_secure',
      'email_provider',
      'aws_access_key_id', 'aws_secret_access_key', 'aws_region', 'aws_ses_from',
      // Form monitoring
      'form_monitoring_enabled', 'form_check_interval_hours',
      'form_breakpoint_days_default', 'form_report_interval_hours',
    ];
    const updates = {};

    for (const key of allowed) {
      if (req.body[key] !== undefined) {
        // Don't overwrite real password with masked value from frontend
        if (key === 'smtp_pass' && req.body[key] === '••••••••') continue;
        updates[key] = req.body[key];
      }
    }

    // Validate cron if provided
    if (updates.global_schedule && !scheduler.isValidCron(updates.global_schedule)) {
      return res.status(400).json({ success: false, error: `Invalid cron expression: "${updates.global_schedule}"` });
    }

    await db.setSettings(updates);
    const settings = await db.getSettings();
    const safe     = { ...settings, smtp_pass: settings.smtp_pass ? '••••••••' : '' };

    scheduler.reschedule().catch(err => console.error('[reschedule error]', err));
    res.json({ success: true, data: safe });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/settings/cleanup
router.post('/cleanup', async (req, res) => {
  try {
    const keepLast = Math.max(1, parseInt(req.body.keep_last) || 3);
    const result   = await cleanup.cleanupAllClients(keepLast);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/settings/test-email — verify SMTP + optionally send test email
router.post('/test-email', async (req, res) => {
  try {
    const settings = await db.getSettings();
    const cfg = {
      smtp_host:        req.body.smtp_host   || settings.smtp_host,
      smtp_port:        req.body.smtp_port   || settings.smtp_port,
      smtp_user:        req.body.smtp_user   || settings.smtp_user,
      smtp_pass:        (req.body.smtp_pass && req.body.smtp_pass !== '••••••••')
                          ? req.body.smtp_pass : settings.smtp_pass,
      smtp_secure:      req.body.smtp_secure ?? settings.smtp_secure,
      smtp_from:        req.body.smtp_from   || settings.smtp_from,
      smtp_from_name:   req.body.smtp_from_name || settings.smtp_from_name,
    };
    if (!cfg.smtp_host || !cfg.smtp_user) {
      return res.status(400).json({ success: false, error: 'SMTP host and username are required' });
    }
    const testTo = req.body.test_to || '';
    await alert.testSmtp(cfg, testTo);
    const msg = testTo
      ? `SMTP verified ✓ Test email sent to ${testTo}`
      : 'SMTP connection verified successfully!';
    res.json({ success: true, data: { message: msg } });
  } catch (err) {
    const errorMsg = err?.message || err || 'Unknown error';
    res.status(400).json({ success: false, error: `SMTP error: ${errorMsg}` });
  }
});

// POST /api/settings/test-ses — verify AWS SES SMTP credentials + optionally send test email
router.post('/test-ses', async (req, res) => {
  try {
    const settings = await db.getSettings();
    const cfg = {
      aws_access_key_id:     req.body.aws_access_key_id || settings.aws_access_key_id,
      aws_secret_access_key: (req.body.aws_secret_access_key && req.body.aws_secret_access_key !== '••••••••')
                               ? req.body.aws_secret_access_key : settings.aws_secret_access_key,
      aws_region:            req.body.aws_region || settings.aws_region || 'us-east-1',
      smtp_from:             req.body.smtp_from  || settings.smtp_from,
      smtp_from_name:        req.body.smtp_from_name || settings.smtp_from_name,
    };
    if (!cfg.aws_access_key_id || !cfg.aws_secret_access_key) {
      return res.status(400).json({ success: false, error: 'SMTP Username and Password are required' });
    }
    const testTo = req.body.test_to || '';
    const result = await alert.testSes(cfg, testTo);
    const msg = testTo
      ? `Connected to ${result.host} ✓ Test email sent to ${testTo}`
      : `Connected to ${result.host} ✓ SES SMTP is working.`;
    res.json({ success: true, data: { message: msg } });
  } catch (err) {
    const errorMsg = err?.message || err || 'Unknown error';
    res.status(400).json({ success: false, error: `SES error: ${errorMsg}` });
  }
});

module.exports = router;
