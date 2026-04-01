'use strict';
const axios = require('axios');
const db    = require('../db');

const DASHBOARD = process.env.DASHBOARD_URL || 'https://backstop.webmarketersdev.ca';

// ── Main entry ────────────────────────────────────────────────────────────────
async function sendAlert(client, subject, bodyText) {
  const settings = await db.getSettings();
  const results  = await Promise.allSettled([
    maybeSlack(client, settings, subject, bodyText),
    maybeEmail(client, settings, subject, bodyText),
  ]);
  results.forEach(r => {
    if (r.status === 'rejected') console.warn('[alert] error:', r.reason?.message || r.reason);
  });
}

// ── Slack ─────────────────────────────────────────────────────────────────────
async function maybeSlack(client, settings, subject, body) {
  if (!client.alert_slack_enabled) return;
  const webhook = settings.default_slack;
  if (!webhook) return;

  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: `🚨 ${subject}`, emoji: true } },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Client:*\n${client.name}` },
        { type: 'mrkdwn', text: `*URL:*\n<${client.url}|${client.url}>` },
      ],
    },
    { type: 'section', text: { type: 'mrkdwn', text: body } },
    {
      type: 'actions',
      elements: [{
        type: 'button',
        text: { type: 'plain_text', text: '🔍 View Dashboard' },
        url: `${DASHBOARD}/#/client/${client.id}`,
        style: 'danger',
      }],
    },
  ];

  await axios.post(webhook, { blocks, text: `🚨 ${subject} — ${client.name}` });
  console.log(`[alert] Slack sent for ${client.name}`);
}

// ── Email: route to SES or SMTP ───────────────────────────────────────────────
async function maybeEmail(client, settings, subject, body) {
  if (!client.alert_email_enabled) return;

  // Build recipient list: site-specific (comma-sep) OR global default
  const siteEmails    = client.alert_email
    ? client.alert_email.split(',').map(e => e.trim()).filter(Boolean)
    : [];
  const defaultEmail  = settings.smtp_default_email || settings.smtp_from || '';
  const recipients    = siteEmails.length ? siteEmails : [defaultEmail].filter(Boolean);

  if (!recipients.length) {
    console.warn('[alert] Email skipped — no recipient configured');
    return;
  }

  const provider = settings.email_provider || 'smtp';
  const to = recipients.join(', ');

  if (provider === 'ses') {
    await sendViaSes(settings, to, subject, body, client);
  } else {
    await sendViaSmtp(settings, to, subject, body, client);
  }
}

// ── AWS SES (via SMTP credentials) ─────────────────────────────────────────
async function sendViaSes(settings, to, subject, body, client) {
  const transporter = buildSesTransport(settings);
  const fromName    = settings.smtp_from_name || 'WM Monitoring';
  const fromEmail   = settings.smtp_from || settings.aws_ses_from;

  await transporter.sendMail({
    from:    `"${fromName}" <${fromEmail}>`,
    to,
    subject: `[WM Monitor] ${subject} — ${client.name}`,
    html:    buildHtmlEmail(subject, body, client),
  });
  console.log(`[alert] SES email sent to ${to} for ${client.name}`);
}

// ── Generic SMTP ──────────────────────────────────────────────────────────────
async function sendViaSmtp(settings, to, subject, body, client) {
  const transporter = buildSmtpTransport(settings);
  const fromName    = settings.smtp_from_name || 'WM Monitoring';
  const fromEmail   = settings.smtp_from      || settings.smtp_user;

  await transporter.sendMail({
    from:    `"${fromName}" <${fromEmail}>`,
    to,
    subject: `[WM Monitor] ${subject} — ${client.name}`,
    html:    buildHtmlEmail(subject, body, client),
  });
  console.log(`[alert] SMTP email sent to ${to} for ${client.name}`);
}

// ── Transporter builders ──────────────────────────────────────────────────────
function buildSesTransport(settings) {
  const nodemailer = require('nodemailer');
  const region     = settings.aws_region || 'us-east-1';
  return nodemailer.createTransport({
    host:   `email-smtp.${region}.amazonaws.com`,
    port:   587,
    secure: false,
    auth: {
      user: settings.aws_access_key_id,
      pass: settings.aws_secret_access_key,
    },
  });
}

function buildSmtpTransport(settings) {
  const nodemailer = require('nodemailer');
  const port       = parseInt(settings.smtp_port) || 587;
  const secure     = Boolean(settings.smtp_secure) || port === 465;
  return nodemailer.createTransport({
    host: settings.smtp_host,
    port,
    secure,
    auth: { user: settings.smtp_user, pass: settings.smtp_pass },
  });
}

// ── Shared HTML template ──────────────────────────────────────────────────────
function buildHtmlEmail(subject, body, client) {
  return `<!DOCTYPE html>
<html><body style="font-family:Arial,sans-serif;background:#f4f4f4;padding:24px;margin:0">
  <div style="max-width:600px;margin:0 auto;background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.1)">
    <div style="background:#931834;padding:24px 32px">
      <h1 style="color:#fff;margin:0;font-size:20px">🚨 ${subject}</h1>
    </div>
    <div style="padding:28px 32px">
      <table style="width:100%;border-collapse:collapse;margin-bottom:20px">
        <tr>
          <td style="padding:8px 0;font-weight:bold;color:#555;width:120px">Client</td>
          <td style="padding:8px 0;color:#111">${client.name}</td>
        </tr>
        <tr>
          <td style="padding:8px 0;font-weight:bold;color:#555">Site URL</td>
          <td style="padding:8px 0"><a href="${client.url}" style="color:#931834">${client.url}</a></td>
        </tr>
      </table>
      <div style="background:#fff5f5;border-left:4px solid #931834;padding:14px 18px;border-radius:4px;color:#333;line-height:1.6;margin-bottom:24px">
        ${body.replace(/\n/g, '<br>').replace(/\*(.*?)\*/g, '<strong>$1</strong>')}
      </div>
      <a href="${DASHBOARD}/#/client/${client.id}"
        style="display:inline-block;background:#931834;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:bold;font-size:14px">
        View Dashboard →
      </a>
    </div>
    <div style="background:#f9f9f9;padding:16px 32px;border-top:1px solid #eee">
      <p style="color:#999;font-size:12px;margin:0">Automated alert from <strong>Webmarketers Monitoring</strong></p>
    </div>
  </div>
</body></html>`;
}

// ── Test connections ──────────────────────────────────────────────────────────
async function testSmtp(settings, testTo) {
  const transporter = buildSmtpTransport(settings);
  await transporter.verify();
  if (testTo) {
    const fromName  = settings.smtp_from_name || 'WM Monitoring';
    const fromEmail = settings.smtp_from || settings.smtp_user;
    await transporter.sendMail({
      from:    `"${fromName}" <${fromEmail}>`,
      to:      testTo,
      subject: '✅ WM Monitoring — SMTP Test',
      html:    buildTestEmail('Generic SMTP', settings.smtp_host),
    });
  }
  return true;
}

async function testSes(settings, testTo) {
  const transporter = buildSesTransport(settings);
  const region      = settings.aws_region || 'us-east-1';
  const sesHost     = `email-smtp.${region}.amazonaws.com`;
  await transporter.verify();
  if (testTo) {
    const fromName  = settings.smtp_from_name || 'WM Monitoring';
    const fromEmail = settings.smtp_from || settings.aws_ses_from;
    await transporter.sendMail({
      from:    `"${fromName}" <${fromEmail}>`,
      to:      testTo,
      subject: '✅ WM Monitoring — AWS SES Test',
      html:    buildTestEmail('AWS SES', sesHost),
    });
  }
  return { host: sesHost, region };
}

function buildTestEmail(provider, host) {
  return `<!DOCTYPE html>
<html><body style="font-family:Arial,sans-serif;background:#f4f4f4;padding:24px;margin:0">
  <div style="max-width:500px;margin:0 auto;background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.1)">
    <div style="background:#10b981;padding:20px 28px">
      <h1 style="color:#fff;margin:0;font-size:18px">✅ Email Connection Verified</h1>
    </div>
    <div style="padding:24px 28px">
      <p style="color:#333;margin:0 0 12px">Your <strong>${provider}</strong> email configuration is working correctly.</p>
      <table style="width:100%;border-collapse:collapse">
        <tr><td style="padding:6px 0;color:#555;width:80px">Provider</td><td style="color:#111">${provider}</td></tr>
        <tr><td style="padding:6px 0;color:#555">Host</td><td style="color:#111">${host}</td></tr>
      </table>
    </div>
    <div style="background:#f9f9f9;padding:12px 28px;border-top:1px solid #eee">
      <p style="color:#999;font-size:12px;margin:0">Webmarketers Monitoring — configuration test</p>
    </div>
  </div>
</body></html>`;
}

module.exports = { sendAlert, testSmtp, testSes };
