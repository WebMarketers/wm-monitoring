'use strict';
const cron = require('node-cron');
const db = require('../db');
const backstop = require('./backstop');

// Map of clientId → cron.Task
const tasks = new Map();
let isSchedulerReady = false;

/**
 * Validate a cron expression.
 */
function isValidCron(expr) {
  return cron.validate(expr);
}

/**
 * Run a single client visual test (auto-scheduled).
 * Skips if a test is already running for this client.
 */
async function runAutoCheck(clientId) {
  try {
    const client = await db.getClientById(clientId);
    if (!client) return;

    const last = await db.getLastRun(client.id, 'visual');
    if (last && last.status === 'running') {
      console.log(`[scheduler] Skipping ${client.name} — already running`);
      return;
    }

    console.log(`[scheduler] Auto-checking: ${client.name} (${client.url})`);
    const run = await db.insertRun(client.id, 'visual');
    await backstop.runTest(run.id, client);
    console.log(`[scheduler] Completed: ${client.name}`);
  } catch (err) {
    console.error(`[scheduler] Error for client ${clientId}:`, err.message);
  }
}

/**
 * Run visual tests for ALL clients sequentially.
 * Returns the list of run IDs that were started.
 */
async function runAllClients() {
  const clients = await db.getAllClients();
  const started = [];

  for (const client of clients) {
    try {
      const last = await db.getLastRun(client.id, 'visual');
      if (last && last.status === 'running') {
        console.log(`[run-all] Skipping ${client.name} — already running`);
        continue;
      }
      const run = await db.insertRun(client.id, 'visual');
      started.push({ clientId: client.id, runId: run.id, name: client.name });
      console.log(`[run-all] Queued: ${client.name} (run #${run.id})`);
    } catch (err) {
      console.error(`[run-all] Error queuing ${client.name}:`, err.message);
    }
  }

  // Run them sequentially in background (don't await here — caller gets IDs immediately)
  (async () => {
    for (const item of started) {
      try {
        const client = await db.getClientById(item.clientId);
        await backstop.runTest(item.runId, client);
      } catch (err) {
        console.error(`[run-all] Test failed for ${item.name}:`, err.message);
      }
    }
    console.log(`[run-all] All ${started.length} tests completed.`);
  })();

  return started;
}

/**
 * Stop all active scheduled tasks.
 */
function clearAllTasks() {
  for (const [id, task] of tasks.entries()) {
    try { task.stop(); } catch (_) {}
  }
  tasks.clear();
  console.log('[scheduler] All tasks cleared.');
}

/**
 * Re-read settings & clients and rebuild all cron tasks.
 * Call this on startup and whenever settings change.
 */
async function reschedule() {
  clearAllTasks();

  const settings = await db.getSettings();

  if (!settings.auto_check_enabled) {
    console.log('[scheduler] Auto-check disabled. No tasks scheduled.');
    return;
  }

  const globalSchedule = settings.global_schedule || '0 6 * * *';
  const clients        = await db.getAllClients();

  for (const client of clients) {
    const schedule = client.custom_schedule || globalSchedule;

    if (!isValidCron(schedule)) {
      console.warn(`[scheduler] Invalid cron for ${client.name}: "${schedule}" — skipping`);
      continue;
    }

    const task = cron.schedule(schedule, () => runAutoCheck(client.id), { timezone: 'America/New_York' });
    tasks.set(client.id, task);
    console.log(`[scheduler] Scheduled ${client.name} → "${schedule}"`);
  }

  console.log(`[scheduler] ${tasks.size} client(s) scheduled.`);
}

/**
 * Called when a client is added/removed/updated — reschedule just that client.
 */
async function rescheduleClient(clientId) {
  // Stop existing task for this client
  if (tasks.has(clientId)) {
    tasks.get(clientId).stop();
    tasks.delete(clientId);
  }

  const settings = await db.getSettings();
  if (!settings.auto_check_enabled) return;

  const client       = await db.getClientById(clientId);
  if (!client) return;

  const globalSchedule = settings.global_schedule || '0 6 * * *';
  const schedule       = client.custom_schedule || globalSchedule;

  if (!isValidCron(schedule)) return;

  const task = cron.schedule(schedule, () => runAutoCheck(client.id), { timezone: 'America/New_York' });
  tasks.set(clientId, task);
  console.log(`[scheduler] Re-scheduled ${client.name} → "${schedule}"`);
}

module.exports = { reschedule, rescheduleClient, runAllClients, isValidCron };
