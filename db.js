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
    // Migrate: add lead monitoring columns
    const hasLeadDrySpell = await knex.schema.hasColumn('clients', 'lead_dry_spell_days');
    if (!hasLeadDrySpell) await knex.schema.table('clients', t => {
      t.integer('lead_dry_spell_days').defaultTo(3); // null = disabled
      t.string('last_organic_lead_at');               // ISO timestamp from WP plugin
      t.string('last_lead_check_at');                 // last time we polled the plugin
      t.string('lead_status').defaultTo('unknown');   // ok | dry_spell | broken | unknown
    });
    // Migrate: add form monitoring columns
    const hasFormStatus = await knex.schema.hasColumn('clients', 'form_status');
    if (!hasFormStatus) await knex.schema.table('clients', t => {
      t.string('form_status').defaultTo('unknown');   // ok | ok_tested | broken | testing | unknown
      t.string('last_real_form_at');                  // last real (non-test) submission timestamp
      t.string('form_last_test_at');                  // last time we ran a silent test
      t.boolean('form_last_test_ok').defaultTo(null); // did the last test pass?
      t.boolean('form_test_triggered').defaultTo(false); // has a test been fired since last real sub?
      t.integer('form_breakpoint_days').defaultTo(null); // site-specific override (null = use global)
      t.float('form_days_since_last').defaultTo(null);   // cached for dashboard
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

  // Form submission log table
  const hasFormLog = await knex.schema.hasTable('form_submission_log');
  if (!hasFormLog) {
    await knex.schema.createTable('form_submission_log', t => {
      t.increments('id').primary();
      t.integer('client_id').notNullable().references('id').inTable('clients').onDelete('CASCADE');
      t.integer('form_id');
      t.string('form_name');
      t.string('form_type');                          // gravity_forms | contact_form_7 | unknown
      t.string('submitted_at').notNullable();         // ISO timestamp
      t.boolean('is_test').notNullable().defaultTo(false);
      t.string('status').notNullable().defaultTo('received'); // received | test_passed | test_failed
      t.text('error');                                // error message if test failed
      t.text('details');                              // JSON from plugin response
      t.timestamp('created_at').defaultTo(knex.fn.now());
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
      'lead_monitoring_enabled', 'lead_check_interval_hours', 'lead_dry_spell_days_default',
      'form_monitoring_enabled', 'form_check_interval_hours', 'form_breakpoint_days_default', 'form_report_interval_hours',
    ];
    for (const key of allowed) {
      const exists = await knex('settings').where({ key }).first();
      let defaultVal = '';
      if (key === 'email_provider')                 defaultVal = 'ses';
      if (key === 'lead_monitoring_enabled')         defaultVal = 'false';
      if (key === 'lead_check_interval_hours')       defaultVal = '6';
      if (key === 'lead_dry_spell_days_default')     defaultVal = '3';
      if (key === 'form_monitoring_enabled')         defaultVal = 'false';
      if (key === 'form_check_interval_hours')       defaultVal = '1';
      if (key === 'form_breakpoint_days_default')    defaultVal = '3';
      if (key === 'form_report_interval_hours')      defaultVal = '6';
      if (!exists) await knex('settings').insert({ key, value: defaultVal });
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

async function updateLeadStatus(clientId, { last_organic_lead_at, last_lead_check_at, lead_status }) {
  const update = { last_lead_check_at: new Date().toISOString() };
  if (lead_status !== undefined)           update.lead_status = lead_status;
  if (last_organic_lead_at !== undefined)  update.last_organic_lead_at = last_organic_lead_at;
  if (last_lead_check_at !== undefined)    update.last_lead_check_at = last_lead_check_at;
  await knex('clients').where({ id: clientId }).update(update);
}

async function updateFormStatus(clientId, fields) {
  // Only update provided fields
  const allowed = [
    'form_status', 'last_real_form_at', 'form_last_test_at',
    'form_last_test_ok', 'form_test_triggered', 'form_breakpoint_days',
    'form_days_since_last',
  ];
  const update = {};
  for (const key of allowed) {
    if (fields[key] !== undefined) update[key] = fields[key];
  }
  if (Object.keys(update).length === 0) return;
  await knex('clients').where({ id: clientId }).update(update);
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

// ── Form Submission Log ───────────────────────────────────────────────────────
async function insertFormSubmissionLog(data) {
  const [id] = await knex('form_submission_log').insert(data);
  return knex('form_submission_log').where({ id }).first();
}

async function getFormSubmissionLogs(clientId, limit = 50) {
  return knex('form_submission_log')
    .where({ client_id: clientId })
    .orderBy('id', 'desc')
    .limit(limit);
}

async function getFormSubmissionLogsByDate(clientId, fromDate, toDate) {
  return knex('form_submission_log')
    .where({ client_id: clientId })
    .where('submitted_at', '>=', fromDate)
    .where('submitted_at', '<=', toDate)
    .orderBy('submitted_at', 'desc');
}

async function getRecentFormActivity(limit = 50) {
  return knex('form_submission_log as l')
    .join('clients as c', 'l.client_id', 'c.id')
    .select(
      'l.id', 'l.form_id', 'l.form_name', 'l.form_type',
      'l.submitted_at', 'l.is_test', 'l.status', 'l.error',
      'c.id as client_id', 'c.name as client_name', 'c.slug'
    )
    .orderBy('l.id', 'desc')
    .limit(limit);
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
  insertClient, updateClient, updateLeadStatus, updateFormStatus, deleteClient,
  insertRun, getRunById, updateRun, updateRunLog,
  getRunsForClient, getLastRun, getRecentActivity,
  getSettings, setSetting, setSettings,
  insertFormSubmissionLog, getFormSubmissionLogs,
  getFormSubmissionLogsByDate, getRecentFormActivity,
};
