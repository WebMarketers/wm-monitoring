'use strict';
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const clientsRouter  = require('./routes/clients');
const testsRouter    = require('./routes/tests');
const settingsRouter = require('./routes/settings');
const db             = require('./db');
const scheduler      = require('./services/scheduler');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Middleware ─────────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());

// ── Static: frontend SPA ───────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// ── Static: per-client backstop data (html reports + screenshots) ────────────
// BackstopJS HTML report uses relative paths like ../../bitmaps_reference/
// so we serve from the client root (parent of backstop_data)
const CLIENTS_DIR = path.join(__dirname, 'clients');
fs.mkdirSync(CLIENTS_DIR, { recursive: true });
app.use('/data', express.static(CLIENTS_DIR));

// ── API Routes ─────────────────────────────────────────────────────────────────
app.use('/api/clients',  clientsRouter);
app.use('/api/settings', settingsRouter);
app.use('/api',          testsRouter);

// ── Health check ───────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', version: '1.0.0', timestamp: new Date().toISOString() });
});

// ── SPA Fallback ───────────────────────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Start after DB is ready ────────────────────────────────────────────────────
db.ready.then(() => {
  app.listen(PORT, () => {
    console.log(`\n✅ Webmarketers Monitoring running on http://localhost:${PORT}`);
    console.log(`   Clients dir: ${CLIENTS_DIR}\n`);
  });
  // Init scheduler after DB is ready
  scheduler.reschedule().catch(err => console.error('[scheduler init error]', err));
}).catch(err => {
  console.error('❌ Database init failed:', err);
  process.exit(1);
});
