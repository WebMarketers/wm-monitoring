'use strict';
const express   = require('express');
const router    = express.Router();
const db        = require('../db');
const backstop  = require('../services/backstop');
const formTest  = require('../services/formTest');
const scheduler = require('../services/scheduler');

// GET /api/runs/:runId
router.get('/runs/:runId', async (req, res) => {
  try {
    const run = await db.getRunById(Number(req.params.runId));
    if (!run) return res.status(404).json({ success: false, error: 'Run not found' });
    res.json({
      success: true,
      data: { ...run, details: run.details ? JSON.parse(run.details) : null },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/clients/:id/visual/reference
router.post('/clients/:id/visual/reference', async (req, res) => {
  try {
    const client = await db.getClientById(Number(req.params.id));
    if (!client) return res.status(404).json({ success: false, error: 'Client not found' });

    const last = await db.getLastRun(client.id, 'visual');
    if (last && last.status === 'running') {
      return res.status(409).json({ success: false, error: 'A visual test is already running' });
    }

    const run = await db.insertRun(client.id, 'visual');
    res.status(202).json({ success: true, data: { run_id: run.id, status: 'running', action: 'reference' } });

    backstop.runReference(run.id, client).catch(err => {
      console.error(`[backstop] reference error for ${client.slug}:`, err.message);
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/clients/:id/visual/test
router.post('/clients/:id/visual/test', async (req, res) => {
  try {
    const client = await db.getClientById(Number(req.params.id));
    if (!client) return res.status(404).json({ success: false, error: 'Client not found' });

    const last = await db.getLastRun(client.id, 'visual');
    if (last && last.status === 'running') {
      return res.status(409).json({ success: false, error: 'A visual test is already running' });
    }

    const run = await db.insertRun(client.id, 'visual');
    res.status(202).json({ success: true, data: { run_id: run.id, status: 'running', action: 'test' } });

    backstop.runTest(run.id, client).catch(err => {
      console.error(`[backstop] test error for ${client.slug}:`, err.message);
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/clients/:id/form/test
router.post('/clients/:id/form/test', async (req, res) => {
  try {
    const client = await db.getClientById(Number(req.params.id));
    if (!client) return res.status(404).json({ success: false, error: 'Client not found' });

    if (!client.monitor_key) {
      return res.status(400).json({
        success: false,
        error: 'Monitor key not configured. Install the WM Monitor WordPress plugin first.',
      });
    }

    const run = await db.insertRun(client.id, 'form');
    res.status(202).json({ success: true, data: { run_id: run.id, status: 'running', type: 'form' } });

    formTest.runFormTest(run.id, client).catch(err => {
      console.error(`[formTest] error for ${client.slug}:`, err.message);
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/tests/run-all
router.post('/tests/run-all', async (req, res) => {
  try {
    const started = await scheduler.runAllClients();
    res.status(202).json({ success: true, data: { queued: started.length, runs: started } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/activity — recent runs across all clients
router.get('/activity', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 20, 50);
    const activity = await db.getRecentActivity(limit);
    const parsed = activity.map(r => ({
      ...r,
      details: r.details ? JSON.parse(r.details) : null,
    }));
    res.json({ success: true, data: parsed });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
