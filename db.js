'use strict';
const path = require('path');
const knex = require('knex')({
  client: 'sqlite3',
  connection: { filename: path.join(__dirname, 'wm-monitoring.db') },
  useNullAsDefault: true,
});

// ── Schema bootstrap ──────────────────────────────────────────────────────────
async function bootstrap() {
  const hasClients = await knex.schema.hasTable('clients');
  if (!hasClients) {
    await knex.schema.createTable('clients', t => {
      t.increments('id').primary();
      t.string('name').notNullable();
      t.string('url').notNullable().unique();
      t.string('slug').notNullable().unique();
      t.string('monitor_key');
      t.integer('form_id').defaultTo(1);
      t.string('test_email').defaultTo('test@webmarketers.ca');
      t.string('slack_webhook');
      t.text('notes');
      t.string('custom_schedule'); // null = use global schedule
      t.timestamp('created_at').defaultTo(knex.fn.now());
    });
  } else {
    // Migrate: add custom_schedule if not present
    const hasSched = await knex.schema.hasColumn('clients', 'custom_schedule');
    if (!hasSched) await knex.schema.table('clients', t => t.string('custom_schedule'));
    // Migrate: add custom_mismatch_threshold if not present
    const hasMismatch = await knex.schema.hasColumn('clients', 'custom_mismatch_threshold');
    if (!hasMismatch) await knex.schema.table('clients', t => t.float('custom_mismatch_threshold'));
    // Migrate: add alert columns if not present
    const hasAlertSlack = await knex.schema.hasColumn('clients', 'alert_slack_enabled');
    if (!hasAlertSlack) await knex.schema.table('clients', t => {
      t.boolean('alert_slack_enabled').defaultTo(true);
      t.boolean('alert_email_enabled').defaultTo(false);
      t.string('alert_email');
    });
  }

  const hasRuns = await knex.schema.hasTable('test_runs');
  if (!hasRuns) {
    await knex.schema.createTable('test_runs', t => {
      t.increments('id').primary();
      t.integer('client_id').notNullable().references('id').inTable('clients').onDelete('CASCADE');
      t.enum('type', ['visual', 'form']).notNullable();
      t.enum('status', ['running', 'passed', 'failed', 'error']).notNullable().defaultTo('running');
      t.text('log');
      t.text('details'); // JSON
      t.timestamp('started_at').defaultTo(knex.fn.now());
      t.timestamp('completed_at');
    });
  }

  // Settings table (key-value store)
  const hasSettings = await knex.schema.hasTable('settings');
  if (!hasSettings) {
    await knex.schema.createTable('settings', t => {
      t.string('key').primary();
      t.text('value');
    });
    // Insert defaults
    await knex('settings').insert([
      { key: 'auto_check_enabled',         value: 'false' },
      { key: 'global_schedule',            value: '0 6 * * *' },
      { key: 'auto_form_enabled',          value: 'false' },
      { key: 'default_slack',              value: '' },
      { key: 'global_mismatch_threshold',  value: '2' },
    ]);
  } else {
    // Migrate: seed global_mismatch_threshold if missing
    const hasMT = await knex('settings').where({ key: 'global_mismatch_threshold' }).first();
    if (!hasMT) await knex('settings').insert({ key: 'global_mismatch_threshold', value: '2' });
    // Migrate: seed SMTP settings if missing
    const allowed = [
      'auto_check_enabled', 'global_schedule', 'auto_form_enabled',
      'default_slack', 'global_mismatch_threshold',
      'smtp_host', 'smtp_port', 'smtp_user', 'smtp_pass',
      'smtp_from', 'smtp_from_name', 'smtp_secure', 'smtp_default_email',
      'email_provider',
      'aws_access_key_id', 'aws_secret_access_key', 'aws_region', 'aws_ses_from',
    ];
    for (const key of allowed) {
      const exists = await knex('settings').where({ key }).first();
      if (!exists) await knex('settings').insert({ key, value: key === 'email_provider' ? 'ses' : '' });
    }
  }
}

// Run bootstrap (awaited in server.js before listen)
const ready = bootstrap();

// ── Clients ───────────────────────────────────────────────────────────────────
async function getAllClients() {
  const clients = await knex('clients').orderBy('name');
  return Promise.all(clients.map(enrichClient));
}

async function enrichClient(c) {
  const [vRun] = await knex('test_runs').where({ client_id: c.id, type: 'visual' }).orderBy('id', 'desc').limit(1);
  const [fRun] = await knex('test_runs').where({ client_id: c.id, type: 'form'  }).orderBy('id', 'desc').limit(1);

  // Pass rate from last 10 visual runs
  const recentVisual = await knex('test_runs')
    .where({ client_id: c.id, type: 'visual' })
    .whereIn('status', ['passed', 'failed'])
    .orderBy('id', 'desc')
    .limit(10);
  const passRate = recentVisual.length > 0
    ? Math.round((recentVisual.filter(r => r.status === 'passed').length / recentVisual.length) * 100)
    : null;

  const [{ total_runs }] = await knex('test_runs')
    .where({ client_id: c.id, type: 'visual' })
    .count('id as total_runs');

  return {
    ...c,
    last_visual_status: vRun?.status ?? null,
    last_visual_at:     vRun?.started_at ?? null,
    last_form_status:   fRun?.status ?? null,
    last_form_at:       fRun?.started_at ?? null,
    visual_pass_rate:   passRate,
    total_visual_runs:  Number(total_runs) || 0,
  };
}

async function getClientById(id) {
  const c = await knex('clients').where({ id }).first();
  if (!c) return null;
  return enrichClient(c);
}

async function getClientBySlug(slug) {
  return knex('clients').where({ slug }).first();
}

async function insertClient(data) {
  const [id] = await knex('clients').insert(data);
  return getClientById(id);
}

async function updateClient(data) {
  const { id, ...rest } = data;
  await knex('clients').where({ id }).update(rest);
  return getClientById(id);
}

async function deleteClient(id) {
  return knex('clients').where({ id }).delete();
}

// ── Settings ──────────────────────────────────────────────────────────────────
async function getSettings() {
  const rows = await knex('settings').select('key', 'value');
  const out = {};
  rows.forEach(r => {
    if (r.value === 'true')       out[r.key] = true;
    else if (r.value === 'false') out[r.key] = false;
    else if (!isNaN(r.value) && r.value !== '') out[r.key] = Number(r.value);
    else out[r.key] = r.value;
  });
  return out;
}

async function setSetting(key, value) {
  const exists = await knex('settings').where({ key }).first();
  const strVal = String(value);
  if (exists) {
    await knex('settings').where({ key }).update({ value: strVal });
  } else {
    await knex('settings').insert({ key, value: strVal });
  }
}

async function setSettings(obj) {
  await Promise.all(Object.entries(obj).map(([k, v]) => setSetting(k, v)));
}

// ── Test Runs ─────────────────────────────────────────────────────────────────
async function insertRun(clientId, type) {
  const [id] = await knex('test_runs').insert({ client_id: clientId, type, status: 'running' });
  return knex('test_runs').where({ id }).first();
}

async function getRunById(id) {
  return knex('test_runs').where({ id }).first();
}

async function updateRun(id, status, log, details) {
  return knex('test_runs').where({ id }).update({
    status,
    log: log || null,
    details: details ? JSON.stringify(details) : null,
    completed_at: new Date().toISOString(),
  });
}

async function updateRunLog(id, log) {
  return knex('test_runs').where({ id }).update({ log });
}

async function getRunsForClient(clientId) {
  return knex('test_runs').where({ client_id: clientId }).orderBy('id', 'desc').limit(20);
}

async function getLastRun(clientId, type) {
  return knex('test_runs').where({ client_id: clientId, type }).orderBy('id', 'desc').first();
}

// ── Activity Feed ──────────────────────────────────────────────────────────────────
async function getRecentActivity(limit = 20) {
  return knex('test_runs as r')
    .join('clients as c', 'r.client_id', 'c.id')
    .select(
      'r.id', 'r.type', 'r.status',
      'r.started_at', 'r.completed_at', 'r.details',
      'c.id as client_id', 'c.name as client_name', 'c.slug'
    )
    .orderBy('r.id', 'desc')
    .limit(limit);
}

module.exports = {
  ready,
  getAllClients, getClientById, getClientBySlug,
  insertClient, updateClient, deleteClient,
  insertRun, getRunById, updateRun, updateRunLog,
  getRunsForClient, getLastRun, getRecentActivity,
  getSettings, setSetting, setSettings,
};
