'use strict';
const { spawn } = require('child_process');
const path    = require('path');
const fs      = require('fs');
const axios   = require('axios');
const db      = require('../db');
const cleanup = require('./cleanup');
const alert   = require('./alert');

const CLIENTS_DIR      = path.join(__dirname, '..', 'clients');
const ENGINE_SCRIPTS_DIR = path.join(__dirname, '..', 'backstop-engine-scripts');
const CUSTOM_INDEX     = path.join(__dirname, '..', 'Backstop-Monitoring', 'backstop', 'custom-index.html');

function getClientDir(slug) {
  return path.join(CLIENTS_DIR, slug);
}

// ── Generate backstop.json per client ─────────────────────────────────────────
function generateConfig(client, threshold = 2) {
  // threshold is the misMatchThreshold for full-page test
  // Above-the-fold test is stricter: 10% of threshold, min 0.05
  const strictThreshold = Math.max(parseFloat((threshold * 0.1).toFixed(2)), 0.05);
  const engineOptions = {
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  };
  if (process.env.CHROMIUM_PATH) {
    engineOptions.executablePath = process.env.CHROMIUM_PATH;
  }

  return {
    id: client.slug,
    viewports: [
      { label: 'desktop', width: 1920, height: 1080 },
      { label: 'tablet',  width: 1024, height: 768  },
      { label: 'mobile',  width: 375,  height: 812  },
    ],
    onBeforeScript: 'puppet/onBefore.js',
    onReadyScript:  'puppet/onReady.js',
    scenarios: [
      {
        label: 'Homepage',
        url: client.url,
        referenceUrl: '',
        selectors: ['document'],
        hideSelectors: [
          '.cookie', '.cookie-banner', '.popup', '.modal',
          '.newsletter', '#popup', '.elementor-popup-modal',
        ],
        removeSelectors: [],
        readyEvent: null,
        delay: 1000,
        misMatchThreshold: threshold,
        requireSameDimensions: false,
      },
      {
        label: 'Homepage Above The Fold',
        url: client.url,
        selectors: ['body'],
        delay: 5000,
        misMatchThreshold: strictThreshold,
      },
    ],
    paths: {
      bitmaps_reference: 'backstop_data/bitmaps_reference',
      bitmaps_test:      'backstop_data/bitmaps_test',
      engine_scripts:    'backstop_data/engine_scripts',
      html_report:       'backstop_data/html_report',
      ci_report:         'backstop_data/ci_report',
    },
    report: ['browser', 'CI'],
    engine: 'puppeteer',
    engineOptions,
    asyncCaptureLimit: 1,
    asyncCompareLimit: 1,
    debug: false,
    debugWindow: false,
  };
}

// ── Init client directory ─────────────────────────────────────────────────────
async function initClient(client) {
  const clientDir = getClientDir(client.slug);
  fs.mkdirSync(path.join(clientDir, 'backstop_data', 'engine_scripts'), { recursive: true });

  if (fs.existsSync(ENGINE_SCRIPTS_DIR)) {
    fs.cpSync(ENGINE_SCRIPTS_DIR, path.join(clientDir, 'backstop_data', 'engine_scripts'), { recursive: true });
  }

  const config = generateConfig(client, 2); // default threshold on init
  fs.writeFileSync(path.join(clientDir, 'backstop.json'), JSON.stringify(config, null, 2));
  console.log(`[backstop] Initialized client dir: ${clientDir}`);
}

// ── Get effective threshold (site override > global setting > default 2%) ──────
async function getEffectiveThreshold(client) {
  if (client.custom_mismatch_threshold != null) return parseFloat(client.custom_mismatch_threshold);
  const settings = await db.getSettings();
  return parseFloat(settings.global_mismatch_threshold ?? 2);
}

// ── Regenerate backstop.json with current threshold before running ────────────
async function applyThresholdConfig(client) {
  const threshold = await getEffectiveThreshold(client);
  const clientDir = getClientDir(client.slug);
  const config    = generateConfig(client, threshold);
  fs.writeFileSync(path.join(clientDir, 'backstop.json'), JSON.stringify(config, null, 2));
  return threshold;
}

// ── Remove client directory ───────────────────────────────────────────────────
function removeClientDir(slug) {
  const clientDir = getClientDir(slug);
  if (fs.existsSync(clientDir)) {
    fs.rmSync(clientDir, { recursive: true, force: true });
    console.log(`[backstop] Removed client dir: ${clientDir}`);
  }
}

// ── Inject custom branded report ──────────────────────────────────────────────
function injectCustomIndex(clientDir) {
  const reportIndex = path.join(clientDir, 'backstop_data', 'html_report', 'index.html');
  if (fs.existsSync(CUSTOM_INDEX) && fs.existsSync(path.dirname(reportIndex))) {
    fs.copyFileSync(CUSTOM_INDEX, reportIndex);
  }
}

// ── Parse mismatch % from latest report.json ──────────────────────────────────
function readMismatchData(clientDir) {
  try {
    const testDir = path.join(clientDir, 'backstop_data', 'bitmaps_test');
    if (!fs.existsSync(testDir)) return null;

    const folders = fs.readdirSync(testDir)
      .filter(f => { try { return fs.statSync(path.join(testDir, f)).isDirectory(); } catch { return false; } })
      .sort(); // YYYYMMDD-HHMMSS → chronological

    if (!folders.length) return null;
    const latest   = folders[folders.length - 1];
    const jsonPath = path.join(testDir, latest, 'report.json');
    if (!fs.existsSync(jsonPath)) return null;

    const raw = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    return (raw.tests || []).map(t => ({
      label:     t.pair?.label     || 'Unknown',
      viewport:  t.pair?.viewportLabel || 'unknown',
      mismatch:  parseFloat(t.pair?.diff?.misMatchPercentage || '0'),
      threshold: t.pair?.misMatchThreshold ?? 0,
      status:    t.status || 'fail',
    }));
  } catch (e) {
    console.warn('[mismatch] Could not read report.json:', e.message);
    return null;
  }
}

// ── Pre-run site availability ping ────────────────────────────────────────────
async function prePing(url) {
  try {
    const res = await axios.get(url, {
      timeout: 10000,
      maxRedirects: 5,
      validateStatus: s => s < 500, // Accept 2xx, 3xx, 4xx — reject 5xx only
    });
    return { ok: true, status: res.status };
  } catch (err) {
    const status = err.response?.status;
    if (status) return { ok: status < 500, status };
    return { ok: false, error: err.message };
  }
}

// ── Core: run a backstop command ──────────────────────────────────────────────
function runBackstopCommand(runId, client, command) {
  return new Promise((resolve, reject) => {
    const clientDir = getClientDir(client.slug);
    const startTime = Date.now();

    if (!fs.existsSync(path.join(clientDir, 'backstop.json'))) {
      const err = new Error('backstop.json not found. Re-add the client to reinitialize.');
      db.updateRun(runId, 'error', err.message, null);
      return reject(err);
    }

    const cmd  = process.platform === 'win32' ? 'backstop.cmd' : 'backstop';
    const proc = spawn(cmd, [command], { cwd: clientDir, shell: true });

    let log = '';

    proc.stdout.on('data', data => {
      log += data.toString();
      db.updateRunLog(runId, log);
    });

    proc.stderr.on('data', data => {
      log += data.toString();
      db.updateRunLog(runId, log);
    });

    proc.on('error', err => {
      const message = `Failed to start backstop: ${err.message}`;
      db.updateRun(runId, 'error', message, null);
      reject(new Error(message));
    });

    proc.on('close', code => {
      injectCustomIndex(clientDir);

      const durationMs = Date.now() - startTime;
      const status     = code === 0 ? 'passed' : 'failed';
      const reportPath = `/data/${client.slug}/backstop_data/html_report/`;

      // Parse mismatch % from report.json (only for 'test' command)
      const mismatch = command === 'test' ? readMismatchData(clientDir) : null;

      db.updateRun(runId, status, log, {
        report_path: reportPath,
        exit_code:   code,
        duration_ms: durationMs,
        mismatch,
      });

      // Auto-cleanup old test snapshots (keep last 5)
      cleanup.cleanupAfterTest(client.slug, 5);

      // Send alerts (Slack + Email) on failure
      if (command === 'test' && status === 'failed') {
        const maxMismatch = mismatch?.length
          ? Math.max(...mismatch.map(m => m.mismatch)).toFixed(2)
          : null;
        const body = [
          `Visual changes detected on *${client.name}*.`,
          maxMismatch ? `Highest mismatch: *${maxMismatch}%*` : '',
          `Duration: ${Math.round(durationMs / 1000)}s`,
          `Report: ${process.env.DASHBOARD_URL || 'https://backstop.webmarketersdev.ca'}${reportPath}`,
        ].filter(Boolean).join('\n');
        alert.sendAlert(client, 'Visual Changes Detected', body).catch(() => {});
      }

      if (code === 0) resolve({ status, log, durationMs });
      else reject(Object.assign(
        new Error(`backstop ${command} failed (exit ${code})`),
        { status, log, durationMs }
      ));
    });
  });
}

// ── Public: capture reference screenshots ────────────────────────────────────
async function runReference(runId, client) {
  let log = `[${new Date().toISOString()}] 🔍 Checking site availability: ${client.url}\n`;
  db.updateRunLog(runId, log);

  const ping = await prePing(client.url);
  if (!ping.ok) {
    const msg = `❌ Site unreachable before capturing reference.\nURL: ${client.url}\nError: ${ping.error || `HTTP ${ping.status}`}\n\nPlease verify the site is live and try again.`;
    await db.updateRun(runId, 'error', msg, { ping_failed: true, ping_error: ping.error });
    throw new Error(msg);
  }

  const threshold = await applyThresholdConfig(client);
  log += `[${new Date().toISOString()}] ✅ Site reachable (HTTP ${ping.status}). Threshold: ${threshold}%. Starting reference capture…\n\n`;
  db.updateRunLog(runId, log);

  return runBackstopCommand(runId, client, 'reference');
}

// ── Public: run visual test ───────────────────────────────────────────────────
async function runTest(runId, client) {
  let log = `[${new Date().toISOString()}] 🔍 Checking site availability: ${client.url}\n`;
  db.updateRunLog(runId, log);

  const ping = await prePing(client.url);
  if (!ping.ok) {
    const msg = `❌ Site unreachable — test aborted.\nURL: ${client.url}\nError: ${ping.error || `HTTP ${ping.status}`}\n\nThe site appears to be down. Check the site and try again.`;
    await db.updateRun(runId, 'error', msg, { ping_failed: true, ping_error: ping.error });
    throw new Error(msg);
  }

  const threshold = await applyThresholdConfig(client);
  log += `[${new Date().toISOString()}] ✅ Site reachable (HTTP ${ping.status}). Threshold: ${threshold}%. Starting visual test…\n\n`;
  db.updateRunLog(runId, log);

  return runBackstopCommand(runId, client, 'test');
}

// ── Slack notification ────────────────────────────────────────────────────────
async function sendSlackAlert(client, reportPath, durationMs) {
  const dashboardUrl = process.env.DASHBOARD_URL || 'https://backstop.webmarketersdev.ca';
  const duration = durationMs ? ` (${Math.round(durationMs / 1000)}s)` : '';

  await axios.post(client.slack_webhook, {
    text: [
      `🚨 *Visual Changes Detected*${duration}`,
      `Client: *${client.name}*`,
      `Site: ${client.url}`,
      `View Report: ${dashboardUrl}${reportPath}`,
    ].join('\n'),
  });
}

module.exports = { initClient, removeClientDir, runReference, runTest, getClientDir };
