'use strict';
const express = require('express');
const router  = express.Router({ mergeParams: true });
const axios   = require('axios');
const db      = require('../db');

// ── GET /api/clients/:id/maintenance-logs ────────────────────────────────────
router.get('/:id/maintenance-logs', async (req, res) => {
  try {
    const client = await db.getClientById(Number(req.params.id));
    if (!client) return res.status(404).json({ success: false, error: 'Client not found' });
    const logs = await db.getMaintenanceLogs(client.id);
    res.json({ success: true, data: logs });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── POST /api/clients/:id/maintenance-logs ───────────────────────────────────
router.post('/:id/maintenance-logs', async (req, res) => {
  try {
    const client = await db.getClientById(Number(req.params.id));
    if (!client) return res.status(404).json({ success: false, error: 'Client not found' });
    const { note } = req.body;
    if (!note?.trim()) return res.status(400).json({ success: false, error: 'Note is required' });
    const log = await db.insertMaintenanceLog(client.id, note.trim());
    res.status(201).json({ success: true, data: log });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── DELETE /api/clients/:id/maintenance-logs/:logId ──────────────────────────
router.delete('/:id/maintenance-logs/:logId', async (req, res) => {
  try {
    await db.deleteMaintenanceLog(Number(req.params.logId));
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── GET /api/clients/:id/checklist?month=2026-04 ─────────────────────────────
router.get('/:id/checklist', async (req, res) => {
  try {
    const client = await db.getClientById(Number(req.params.id));
    if (!client) return res.status(404).json({ success: false, error: 'Client not found' });
    const month    = req.query.month || new Date().toISOString().slice(0, 7);
    const existing = await db.getChecklist(client.id, month);
    res.json({
      success: true,
      data: existing || {
        month,
        plugin_updates_applied: false,
        activity_log_reviewed:  false,
        debug_log_clear:        false,
        frontend_verified:      false,
        contact_form_tested:    false,
        notes: '',
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── PUT /api/clients/:id/checklist ───────────────────────────────────────────
router.put('/:id/checklist', async (req, res) => {
  try {
    const client = await db.getClientById(Number(req.params.id));
    if (!client) return res.status(404).json({ success: false, error: 'Client not found' });
    const month = req.body.month || new Date().toISOString().slice(0, 7);
    const data  = {
      plugin_updates_applied: Boolean(req.body.plugin_updates_applied),
      activity_log_reviewed:  Boolean(req.body.activity_log_reviewed),
      debug_log_clear:        Boolean(req.body.debug_log_clear),
      frontend_verified:      Boolean(req.body.frontend_verified),
      contact_form_tested:    Boolean(req.body.contact_form_tested),
      notes:                  req.body.notes || null,
    };
    const checklist = await db.upsertChecklist(client.id, month, data);
    res.json({ success: true, data: checklist });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── GET /api/clients/:id/site-info ───────────────────────────────────────────
// Fetches from WP plugin and caches for 1h
router.get('/:id/site-info', async (req, res) => {
  const clientId    = Number(req.params.id);
  const forceRefresh = req.query.refresh === '1';

  try {
    const client = await db.getClientById(clientId);
    if (!client) return res.status(404).json({ success: false, error: 'Client not found' });

    // Return cached data if fresh (< 1h) and not forcing refresh
    if (!forceRefresh) {
      const cached = await db.getSiteInfoCache(clientId);
      if (cached) {
        const ageMs = Date.now() - new Date(cached.cached_at + (cached.cached_at.endsWith('Z') ? '' : 'Z')).getTime();
        if (ageMs < 3_600_000) return res.json({ success: true, data: cached, source: 'cache' });
      }
    }

    if (!client.monitor_key) {
      return res.json({ success: true, data: null, reason: 'no_key' });
    }

    const baseUrl = client.url.replace(/\/$/, '');
    const response = await axios.get(`${baseUrl}/wp-json/wm-monitor/v1/site-info`, {
      headers: { 'X-WM-Monitor-Key': client.monitor_key },
      timeout: 15000,
    });

    await db.upsertSiteInfoCache(clientId, response.data);
    const fresh = await db.getSiteInfoCache(clientId);
    res.json({ success: true, data: fresh, source: 'live' });

  } catch (err) {
    // Try returning stale cache on failure
    try {
      const cached = await db.getSiteInfoCache(clientId);
      if (cached) return res.json({ success: true, data: cached, source: 'stale', error: err.message });
    } catch {}
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
