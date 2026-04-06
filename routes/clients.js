'use strict';
const express   = require('express');
const router    = express.Router();
const db        = require('../db');
const backstop  = require('../services/backstop');
const scheduler = require('../services/scheduler');

function slugify(url) {
  return url
    .replace(/^https?:\/\//, '')
    .replace(/[^a-z0-9]/gi, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase()
    .substring(0, 60);
}

// GET /api/clients
router.get('/', async (req, res) => {
  try {
    const clients = await db.getAllClients();
    res.json({ success: true, data: clients });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/clients/:id
router.get('/:id', async (req, res) => {
  try {
    const client = await db.getClientById(Number(req.params.id));
    if (!client) return res.status(404).json({ success: false, error: 'Client not found' });
    const runs = await db.getRunsForClient(client.id);
    const runsFormatted = runs.map(r => ({
      ...r,
      details: r.details ? JSON.parse(r.details) : null,
    }));
    res.json({ success: true, data: { ...client, runs: runsFormatted } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/clients
router.post('/', async (req, res) => {
  try {
    const { name, url, monitor_key, form_id, test_email, slack_webhook, notes } = req.body;
    if (!name || !url) return res.status(400).json({ success: false, error: 'name and url are required' });

    const normalizedUrl = url.trim().replace(/\/$/, '');
    const slug = slugify(normalizedUrl);

    const existing = await db.getClientBySlug(slug);
    if (existing) return res.status(409).json({ success: false, error: 'A client with this URL already exists' });

    const client = await db.insertClient({
      name: name.trim(),
      url: normalizedUrl,
      slug,
      monitor_key: monitor_key || null,
      form_id: form_id ? Number(form_id) : 1,
      test_email: test_email || 'test@webmarketers.ca',
      slack_webhook: slack_webhook || null,
      notes: notes || null,
      custom_schedule: req.body.custom_schedule || null,
      custom_mismatch_threshold: req.body.custom_mismatch_threshold != null ? parseFloat(req.body.custom_mismatch_threshold) : null,
      alert_slack_enabled: req.body.alert_slack_enabled !== undefined ? Boolean(req.body.alert_slack_enabled) : true,
      alert_email_enabled: req.body.alert_email_enabled !== undefined ? Boolean(req.body.alert_email_enabled) : false,
      alert_email: req.body.alert_email || null,
      lead_dry_spell_days: req.body.lead_dry_spell_days !== undefined
        ? (req.body.lead_dry_spell_days !== '' ? parseInt(req.body.lead_dry_spell_days, 10) : null)
        : 3,
      form_breakpoint_days: req.body.form_breakpoint_days !== undefined
        ? (req.body.form_breakpoint_days !== '' ? parseInt(req.body.form_breakpoint_days, 10) : null)
        : null,
      tags:           req.body.tags ? JSON.stringify(req.body.tags) : null,
      hosting_server: req.body.hosting_server || null,
    });

    backstop.initClient(client).catch(err => console.warn(`[backstop] initClient: ${err.message}`));
    scheduler.rescheduleClient(client.id).catch(() => {});

    res.status(201).json({ success: true, data: client });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// PUT /api/clients/:id
router.put('/:id', async (req, res) => {
  try {
    const client = await db.getClientById(Number(req.params.id));
    if (!client) return res.status(404).json({ success: false, error: 'Client not found' });

    const { name, url, monitor_key, form_id, test_email, slack_webhook, notes } = req.body;
    const updated = await db.updateClient({
      id: client.id,
      name: name?.trim() || client.name,
      url: url?.trim().replace(/\/$/, '') || client.url,
      monitor_key: monitor_key !== undefined ? monitor_key : client.monitor_key,
      form_id: form_id !== undefined ? Number(form_id) : client.form_id,
      test_email: test_email || client.test_email,
      slack_webhook: slack_webhook !== undefined ? slack_webhook : client.slack_webhook,
      notes: notes !== undefined ? notes : client.notes,
      custom_schedule: req.body.custom_schedule !== undefined ? (req.body.custom_schedule || null) : client.custom_schedule,
      custom_mismatch_threshold: req.body.custom_mismatch_threshold !== undefined
        ? (req.body.custom_mismatch_threshold !== '' ? parseFloat(req.body.custom_mismatch_threshold) : null)
        : client.custom_mismatch_threshold,
      alert_slack_enabled: req.body.alert_slack_enabled !== undefined ? Boolean(req.body.alert_slack_enabled) : client.alert_slack_enabled,
      alert_email_enabled: req.body.alert_email_enabled !== undefined ? Boolean(req.body.alert_email_enabled) : client.alert_email_enabled,
      alert_email: req.body.alert_email !== undefined ? (req.body.alert_email || null) : client.alert_email,
      lead_dry_spell_days: req.body.lead_dry_spell_days !== undefined
        ? (req.body.lead_dry_spell_days !== '' && req.body.lead_dry_spell_days !== null
            ? parseInt(req.body.lead_dry_spell_days, 10) : null)
        : client.lead_dry_spell_days,
      form_breakpoint_days: req.body.form_breakpoint_days !== undefined
        ? (req.body.form_breakpoint_days !== '' && req.body.form_breakpoint_days !== null
            ? parseInt(req.body.form_breakpoint_days, 10) : null)
        : client.form_breakpoint_days,
      tags: req.body.tags !== undefined
        ? (req.body.tags ? JSON.stringify(req.body.tags) : null)
        : client.tags,
      hosting_server: req.body.hosting_server !== undefined
        ? (req.body.hosting_server || null)
        : client.hosting_server,
    });

    scheduler.rescheduleClient(client.id).catch(() => {});
    res.json({ success: true, data: updated });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// DELETE /api/clients/:id
router.delete('/:id', async (req, res) => {
  try {
    const client = await db.getClientById(Number(req.params.id));
    if (!client) return res.status(404).json({ success: false, error: 'Client not found' });

    backstop.removeClientDir(client.slug);
    await db.deleteClient(client.id);
    scheduler.reschedule().catch(() => {});

    res.json({ success: true, message: `Client "${client.name}" deleted` });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
