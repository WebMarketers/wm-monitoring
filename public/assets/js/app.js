'use strict';

// ── State ─────────────────────────────────────────────────────────────────────
const state = {
  clients: [],
  currentClient: null,
  pollingIntervals: {},
  filter: { search: '', status: 'all' },
};

// ── API ───────────────────────────────────────────────────────────────────────
const api = {
  async get(path) {
    const res = await fetch(`/api${path}`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const errPayload = data.error;
      const msg = errPayload && typeof errPayload === 'object' ? errPayload.message || JSON.stringify(errPayload) : errPayload;
      throw new Error(msg || 'Request failed');
    }
    return data.data || {};
  },
  async post(path, body) {
    const res = await fetch(`/api${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const errPayload = data.error;
      const msg = errPayload && typeof errPayload === 'object' ? errPayload.message || JSON.stringify(errPayload) : errPayload;
      throw new Error(msg || 'Request failed');
    }
    return data.data || {};
  },
  async put(path, body) {
    const res = await fetch(`/api${path}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const errPayload = data.error;
      const msg = errPayload && typeof errPayload === 'object' ? errPayload.message || JSON.stringify(errPayload) : errPayload;
      throw new Error(msg || 'Request failed');
    }
    return data.data || {};
  },
  async del(path) {
    const res = await fetch(`/api${path}`, { method: 'DELETE' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const errPayload = data.error;
      const msg = errPayload && typeof errPayload === 'object' ? errPayload.message || JSON.stringify(errPayload) : errPayload;
      throw new Error(msg || 'Request failed');
    }
    return data || {};
  },
};

// ── Router ────────────────────────────────────────────────────────────────────
function navigate(hash) { window.location.hash = hash; }
function getRoute() { return window.location.hash.replace('#', '') || '/'; }

function router() {
  const route = getRoute();
  const clientMatch = route.match(/^\/client\/(\d+)$/);

  clearPolling();

  // Nav highlighting
  document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
  if (route === '/settings') {
    document.getElementById('nav-settings')?.classList.add('active');
    renderSettings();
  } else if (clientMatch) {
    document.getElementById('nav-dashboard')?.classList.add('active');
    renderClientPage(Number(clientMatch[1]));
  } else {
    document.getElementById('nav-dashboard')?.classList.add('active');
    renderDashboard();
  }
}

// ── Toast ─────────────────────────────────────────────────────────────────────
function toast(msg, type = 'default', duration = 4000) {
  const container = document.getElementById('toast-container');
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  const icon = type === 'success' ? '✅' : type === 'error' ? '❌' : 'ℹ️';
  el.innerHTML = `<span>${icon}</span><span>${msg}</span>`;
  container.appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity 0.3s'; setTimeout(() => el.remove(), 300); }, duration);
}

// ── Modals ────────────────────────────────────────────────────────────────────
function openModal(id) { document.getElementById(id).style.display = 'flex'; }
function closeModal(id) { document.getElementById(id).style.display = 'none'; }

// Click backdrop to close
document.querySelectorAll('.modal-backdrop').forEach(backdrop => {
  backdrop.addEventListener('click', e => { if (e.target === backdrop) backdrop.style.display = 'none'; });
});

// ── Helpers ───────────────────────────────────────────────────────────────────
function timeAgo(dateStr) {
  if (!dateStr) return 'never';
  const diff = Date.now() - new Date(dateStr + (dateStr.endsWith('Z') ? '' : 'Z')).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function statusBadge(status) {
  const map = { passed: 'Passed', failed: 'Failed', running: 'Running', error: 'Error', null: 'Never', undefined: 'Never' };
  const cls = { passed: 'badge-passed', failed: 'badge-failed', running: 'badge-running', error: 'badge-error' };
  const badge = status ?? 'none';
  const label = map[status] ?? 'Never run';
  const cssClass = cls[status] ?? 'badge-none';
  return `<span class="badge ${cssClass}">${label}</span>`;
}

function cardStatusClass(client) {
  const statuses = [client.last_visual_status, client.last_form_status];
  if (statuses.includes('running')) return 'status-running';
  if (statuses.includes('failed') || statuses.includes('error')) return 'status-fail';
  if (statuses.every(s => s === 'passed')) return 'status-pass';
  if (statuses.some(s => s === 'passed')) return 'status-warning';
  return '';
}

function favicon(url) {
  try {
    const domain = new URL(url).hostname;
    return `https://www.google.com/s2/favicons?domain=${domain}&sz=32`;
  } catch { return null; }
}

// ── Filter helper ─────────────────────────────────────────────────────────────
function filterClients() {
  const { search, status } = state.filter;
  return state.clients.filter(c => {
    if (search) {
      const q = search.toLowerCase();
      if (!c.name.toLowerCase().includes(q) && !c.url.toLowerCase().includes(q)) return false;
    }
    if (status === 'passing') return c.last_visual_status === 'passed';
    if (status === 'failing') return c.last_visual_status === 'failed' || c.last_visual_status === 'error'
      || c.last_form_status === 'failed' || c.last_form_status === 'error';
    if (status === 'running') return c.last_visual_status === 'running' || c.last_form_status === 'running';
    if (status === 'never')   return !c.last_visual_status && !c.last_form_status;
    return true;
  });
}

function setFilter(patch) {
  Object.assign(state.filter, patch);
  const filtered = filterClients();
  const total    = state.clients.length;
  const grid     = document.getElementById('sites-grid');
  if (grid) {
    grid.innerHTML = filtered.length === 0
      ? `<div class="empty-state"><div class="empty-icon"><svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg></div><div class="empty-title">No sites match</div><div class="empty-desc">Try a different search or filter.</div></div>`
      : filtered.map(renderClientCard).join('');
  }
  const countEl = document.getElementById('filter-count');
  if (countEl) countEl.textContent = `${filtered.length} of ${total}`;
  // Update active pill
  document.querySelectorAll('.filter-pill').forEach(b => b.classList.remove('active'));
  const activePill = document.querySelector(`.filter-pill[data-status="${state.filter.status}"]`);
  if (activePill) activePill.classList.add('active');
}

// ── Duration helper ───────────────────────────────────────────────────────────
function fmtDuration(ms) {
  if (!ms) return '';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

// ── Dashboard View ────────────────────────────────────────────────────────────
async function renderDashboard() {
  document.getElementById('nav-dashboard').classList.add('active');
  const main = document.getElementById('main-content');
  main.innerHTML = `<div class="loading-overlay"><div class="spinner"></div> Loading sites…</div>`;

  try {
    state.clients = await api.get('/clients');
    const total   = state.clients.length;
    const passing = state.clients.filter(c => c.last_visual_status === 'passed' && (c.last_form_status === 'passed' || !c.last_form_status)).length;
    const failing = state.clients.filter(c => c.last_visual_status === 'failed' || c.last_form_status === 'failed' || c.last_visual_status === 'error' || c.last_form_status === 'error').length;
    const running = state.clients.filter(c => c.last_visual_status === 'running' || c.last_form_status === 'running').length;

    main.innerHTML = `
      <div class="page-header">
        <div class="page-title-block">
          <h1 class="page-title">Webmarketers Monitoring</h1>
          <p class="page-subtitle">Visual regression & contact form tests across all sites</p>
        </div>
        <div style="display:flex;gap:8px">
          <button class="btn btn-secondary" id="btn-run-all" onclick="runAllSites()">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polygon points="5 3 19 12 5 21 5 3"/></svg>
            Run All Checks
          </button>
          <button class="btn btn-primary" onclick="openAddModal()">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
            Add Site
          </button>
        </div>
      </div>

      <div class="stats-bar">
        <div class="stat-card total">
          <div class="stat-value">${total}</div>
          <div class="stat-label">Total Sites</div>
        </div>
        <div class="stat-card passing">
          <div class="stat-value">${passing}</div>
          <div class="stat-label">All Passing</div>
        </div>
        <div class="stat-card failing">
          <div class="stat-value">${failing}</div>
          <div class="stat-label">Issues Found</div>
        </div>
        <div class="stat-card running">
          <div class="stat-value">${running}</div>
          <div class="stat-label">Running Now</div>
        </div>
      </div>

      <!-- Search & Filter Bar -->
      ${total > 0 ? `
      <div class="filter-bar">
        <div class="search-wrap">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="position:absolute;left:10px;top:50%;transform:translateY(-50%);color:var(--text-3);pointer-events:none"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
          <input class="filter-search" type="text" placeholder="Search sites…"
            oninput="setFilter({search:this.value})"
            value="${state.filter.search}" />
        </div>
        <div class="filter-pills">
          ${['all','passing','failing','never','running'].map(s => `
            <button class="filter-pill ${state.filter.status === s ? 'active' : ''}" data-status="${s}" onclick="setFilter({status:'${s}'})">
              ${{all:'All',passing:'Passing',failing:'Issues',never:'Never Run',running:'Running'}[s]}
            </button>
          `).join('')}
        </div>
        <span class="filter-count" id="filter-count">${total} of ${total}</span>
      </div>` : ''}

      <div class="sites-grid" id="sites-grid">
        ${total === 0 ? renderEmptyState() : filterClients().map(renderClientCard).join('')}
      </div>

      <!-- Activity Feed -->
      <div id="activity-feed-section" style="margin-top:32px">
        <div style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.07em;color:var(--text-3);margin-bottom:12px">Recent Activity</div>
        <div id="activity-feed"><div class="loading-overlay" style="padding:20px"><div class="spinner"></div></div></div>
      </div>
    `;

    if (running > 0) startDashboardPolling();

    // Load activity feed async after main render
    loadActivityFeed();
  } catch (err) {
    main.innerHTML = `<div class="loading-overlay">❌ Failed to load: ${err.message}</div>`;
  }
}

function renderEmptyState() {
  return `
    <div class="empty-state">
      <div class="empty-icon">
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
      </div>
      <div class="empty-title">No sites added yet</div>
      <div class="empty-desc">Add your first client site to start visual regression and contact form monitoring.</div>
      <button class="btn btn-primary" onclick="openAddModal()">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        Add First Site
      </button>
    </div>
  `;
}

function renderClientCard(client) {
  const fav = favicon(client.url);
  const domain = (() => { try { return new URL(client.url).hostname; } catch { return client.url; } })();
  const statusClass = cardStatusClass(client);
  const vStatus = client.last_visual_status;
  const fStatus = client.last_form_status;

  return `
    <div class="site-card ${statusClass}" id="card-${client.id}" onclick="navigate('/client/${client.id}')">
      <div class="site-card-header">
        <div style="display:flex;gap:12px;align-items:flex-start;min-width:0;">
          <div class="site-favicon">
            ${fav ? `<img src="${fav}" onerror="this.remove()" alt="" />` : ''}
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="position:absolute"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>
          </div>
          <div style="min-width:0;">
            <div class="site-name">${client.name}</div>
            <div class="site-url" title="${client.url}">${domain}</div>
          </div>
        </div>
        <div class="card-actions" onclick="event.stopPropagation()">
          <button class="icon-btn" title="Edit" onclick="openEditModal(${client.id})">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.1 2.1 0 0 1 3 3L12 15l-4 1 1-4Z"/></svg>
          </button>
          <button class="icon-btn delete" title="Delete" onclick="deleteClient(${client.id}, '${client.name.replace(/'/g, "\\'")}')">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/></svg>
          </button>
        </div>
      </div>

      <div class="status-rows">
        <div class="status-row">
          <div class="status-row-label">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
            Visual
          </div>
          <div class="status-row-right">
            ${statusBadge(vStatus)}
            <span class="status-time">${timeAgo(client.last_visual_at)}</span>
          </div>
        </div>
        <div class="status-row">
          <div class="status-row-label">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>
            Form Test
          </div>
          <div class="status-row-right">
            ${statusBadge(fStatus)}
            <span class="status-time">${timeAgo(client.last_form_at)}</span>
          </div>
        </div>
      </div>

      <div class="site-card-footer">
        <button class="btn btn-secondary btn-sm" onclick="event.stopPropagation(); navigate('/client/${client.id}')">
          View Dashboard →
        </button>
      </div>
    </div>
  `;
}

// ── Client Detail Page ────────────────────────────────────────────────────────
async function renderClientPage(id) {
  const main = document.getElementById('main-content');
  main.innerHTML = `<div class="loading-overlay"><div class="spinner"></div> Loading client…</div>`;

  try {
    const client = await api.get(`/clients/${id}`);
    state.currentClient = client;
    renderClientDetail(client);
    startClientPolling(client);
  } catch (err) {
    main.innerHTML = `<div class="loading-overlay">❌ ${err.message}</div>`;
  }
}

function renderClientDetail(client) {
  const main = document.getElementById('main-content');
  const domain = (() => { try { return new URL(client.url).hostname; } catch { return client.url; } })();

  const visualRuns = client.runs.filter(r => r.type === 'visual').slice(0, 8);
  const formRuns   = client.runs.filter(r => r.type === 'form').slice(0, 8);
  const lastFormRun = formRuns[0];
  const lastFormDetails = lastFormRun?.details;

  // A "passed" or "failed" visual run means reference already exists.
  // If the ONLY run is an error/running, or there are no runs at all, warn the user.
  const hasReference = visualRuns.some(r => r.status === 'passed' || r.status === 'failed');

  main.innerHTML = `
    <div class="detail-header">
      <a href="#/" class="back-btn" onclick="navigate('/')">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="15 18 9 12 15 6"/></svg>
        All Sites
      </a>
      <div class="detail-title-block">
        <div class="detail-title">${client.name}</div>
        <a class="detail-url" href="${client.url}" target="_blank" rel="noopener">${domain} ↗</a>
      </div>
      <div class="detail-actions">
        <button class="btn btn-ghost btn-sm" onclick="openEditModal(${client.id})">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.1 2.1 0 0 1 3 3L12 15l-4 1 1-4Z"/></svg>
          Edit
        </button>
        <button class="btn btn-danger btn-sm" onclick="deleteClient(${client.id}, '${client.name.replace(/'/g, "\\'")}')">
          Delete
        </button>
      </div>
    </div>

    <div class="detail-grid">
      <!-- Visual Testing Card -->
      <div class="detail-card" id="visual-card-${client.id}">
        <div class="detail-card-header">
          <div class="detail-card-title">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
            Visual Regression
          </div>
          <div id="visual-status-badge-${client.id}">
            ${statusBadge(client.last_visual_status)}
          </div>
        </div>
        <div class="detail-card-body">
          <div class="status-display">
            <span class="status-text" id="visual-status-text-${client.id}">
              ${client.last_visual_status ? `Last run: ${timeAgo(client.last_visual_at)}` : 'No tests run yet. Start by capturing reference screenshots.'}
            </span>
          </div>
          <div class="action-buttons">
            <button class="btn btn-secondary btn-sm" id="btn-reference-${client.id}"
              onclick="runVisualReference(${client.id})">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
              ${hasReference ? 'Update Reference' : 'Capture Reference'}
            </button>
            <button class="btn btn-primary btn-sm" id="btn-visual-test-${client.id}"
              onclick="runVisualTest(${client.id})" ${!hasReference ? 'disabled title="Capture reference screenshots first"' : ''}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"/></svg>
              Run Test
            </button>
            ${visualRuns.length > 0 ? `
            <a class="report-link" href="/data/${client.slug}/backstop_data/html_report/" target="_blank" rel="noopener">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
              Open Report
            </a>` : ''}
          </div>

          ${!hasReference ? `
          <div style="display:flex;align-items:flex-start;gap:10px;padding:12px 14px;background:rgba(245,158,11,0.08);border:1px solid rgba(245,158,11,0.2);border-radius:8px;font-size:13px;color:var(--warning);margin-top:4px">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="flex-shrink:0;margin-top:1px"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
            <div>
              <strong>No reference screenshots yet.</strong><br/>
              Click <strong>Capture Reference</strong> first to take baseline screenshots of the site. Once done, you can run comparison tests.
            </div>
          </div>` : ''}

          ${visualRuns.length > 0 ? `
          <div class="run-history">
            <div class="run-history-title">Recent Runs</div>
            ${visualRuns.map(run => `
              <div class="run-item" onclick="openLog(${run.id})">
                <div class="run-item-left">
                  ${statusBadge(run.status)}
                  <span>${formatDate(run.started_at)}</span>
                </div>
                <div class="run-item-right">
                  ${run.details?.mismatch ? `<span class="mismatch-peak" title="Highest mismatch">${Math.max(...run.details.mismatch.map(m=>m.mismatch)).toFixed(2)}%</span>` : ''}
                  ${run.details?.duration_ms ? `<span class="status-time">${fmtDuration(run.details.duration_ms)}</span>` : ''}
                  ${run.log ? `<span class="run-log-link">Log</span>` : ''}
                </div>
              </div>
            `).join('')}
          </div>` : ''}
        </div>
      </div>

      <!-- Mismatch Breakdown Card (full width) -->
      ${renderMismatchCard(visualRuns)}

      <!-- Form Monitoring Card (Passive + Active) -->
      <div class="detail-card" id="form-card-${client.id}">
        <div class="detail-card-header">
          <div class="detail-card-title">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>
            Form Monitoring
          </div>
          <div>${renderFormStatusBadge(client)}</div>
        </div>
        <div class="detail-card-body">

          ${!client.monitor_key ? `
            <div style="padding:14px;background:rgba(245,158,11,0.08);border:1px solid rgba(245,158,11,0.2);border-radius:8px;font-size:13px;color:var(--warning);">
              ⚠️ WM Monitor key not configured. Install the WordPress plugin and paste the key in site settings.
            </div>
          ` : renderFormMonitoringBody(client)}

          <div class="action-buttons" style="margin-top:12px">
            <button class="btn btn-primary btn-sm" id="btn-form-test-${client.id}"
              onclick="runFormTest(${client.id})" ${!client.monitor_key ? 'disabled' : ''}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"/></svg>
              Run Manual Test
            </button>
            ${client.monitor_key ? `
            <button class="btn btn-secondary btn-sm" onclick="triggerSilentTest(${client.id})">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="4.22" y1="4.22" x2="19.78" y2="19.78"/></svg>
              Trigger Silent Test
            </button>` : ''}
          </div>

          <div id="form-submit-log-${client.id}" style="margin-top:16px"></div>

          ${formRuns.length > 0 ? `
          <div class="run-history" style="margin-top:8px">
            <div class="run-history-title">Manual Test Runs</div>
            ${formRuns.map(run => `
              <div class="run-item" onclick="openLog(${run.id})">
                <div class="run-item-left">
                  ${statusBadge(run.status)}
                  <span>${formatDate(run.started_at)}</span>
                </div>
                <div class="run-item-right">
                  ${run.log ? `<span class="run-log-link">Log</span>` : ''}
                </div>
              </div>
            `).join('')}
          </div>` : ''}

          <div style="margin-top:12px;font-size:11px;color:var(--text-3)">
            Plugin: <code>${client.url.replace(/\/$/, '')}/wp-json/wm-monitor/v1</code>
          </div>
        </div>
      </div>
    </div>
  `;

  // Load passive submission log async
  if (client.monitor_key) loadFormSubmissionLog(client.id);
}

function renderFormDetails(details, client) {
  if (!details) {
    return `
      <div class="test-detail-item" style="grid-column:1/-1">
        <div class="test-detail-label">Status</div>
        <div class="test-detail-value check-na">No tests run yet</div>
      </div>
      <div class="test-detail-item">
        <div class="test-detail-label">Form ID</div>
        <div class="test-detail-value">${client.form_id || 1}</div>
      </div>
      <div class="test-detail-item">
        <div class="test-detail-label">Test Email</div>
        <div class="test-detail-value" style="font-size:12px">${client.test_email || '—'}</div>
      </div>
    `;
  }
  const check = v => v === true ? '<span class="check-yes">✅ Yes</span>' : v === false ? '<span class="check-no">❌ No</span>' : '<span class="check-na">—</span>';
  return `
    <div class="test-detail-item">
      <div class="test-detail-label">Form Submitted</div>
      <div class="test-detail-value">${check(details.form_submitted)}</div>
    </div>
    <div class="test-detail-item">
      <div class="test-detail-label">Email Sent</div>
      <div class="test-detail-value">${check(details.email_sent)}</div>
    </div>
    <div class="test-detail-item">
      <div class="test-detail-label">Gravity Forms</div>
      <div class="test-detail-value">${check(details.gravity_forms)}</div>
    </div>
    <div class="test-detail-item">
      <div class="test-detail-label">Post SMTP</div>
      <div class="test-detail-value">${check(details.post_smtp)}</div>
    </div>
    ${details.entry_id ? `
    <div class="test-detail-item">
      <div class="test-detail-label">Entry ID</div>
      <div class="test-detail-value">#${details.entry_id}</div>
    </div>` : ''}
    ${details.error ? `
    <div class="test-detail-item" style="grid-column:1/-1">
      <div class="test-detail-label">Error</div>
      <div class="test-detail-value check-no" style="font-size:12px">${details.error}</div>
    </div>` : ''}
  `;
}

function formatDate(str) {
  if (!str) return '—';
  const d = new Date(str.endsWith('Z') ? str : str + 'Z');
  return d.toLocaleDateString('en-CA') + ' ' + d.toLocaleTimeString('en-CA', { hour: '2-digit', minute: '2-digit' });
}

// ── Form Monitoring Helpers ───────────────────────────────────────────────────

function renderFormStatusBadge(client) {
  const s = client.form_status || 'unknown';
  const map = {
    ok:         { label: 'Receiving',   cls: 'badge-passed' },
    ok_tested:  { label: 'Test Passed', cls: 'badge-passed' },
    broken:     { label: 'Form Broken', cls: 'badge-failed' },
    testing:    { label: 'Testing…',    cls: 'badge-running' },
    dry_spell:  { label: 'Dry Spell',   cls: 'badge-error' },
    unknown:    { label: 'Unknown',     cls: 'badge-none' },
  };
  const { label, cls } = map[s] || map.unknown;
  return `<span class="badge ${cls}">${label}</span>`;
}

function renderFormMonitoringBody(client) {
  const breakpointDays  = client.form_breakpoint_days || '(global)';
  const daysSince       = client.form_days_since_last != null ? parseFloat(client.form_days_since_last) : null;
  const bpNum           = typeof client.form_breakpoint_days === 'number' ? client.form_breakpoint_days : null;
  const pct             = (daysSince != null && bpNum) ? Math.min((daysSince / bpNum) * 100, 100).toFixed(0) : null;
  const daysRemaining   = (daysSince != null && bpNum) ? Math.max(0, bpNum - daysSince).toFixed(1) : null;
  const isOver          = pct !== null && pct >= 100;

  const progressBar = pct !== null ? `
    <div style="margin:10px 0 6px">
      <div style="display:flex;justify-content:space-between;font-size:11px;color:var(--text-3);margin-bottom:4px">
        <span>${daysSince?.toFixed(1)} days since last submission</span>
        <span>${daysRemaining} days until auto-test</span>
      </div>
      <div style="height:6px;background:var(--surface-3);border-radius:4px;overflow:hidden">
        <div style="height:100%;width:${pct}%;background:${isOver ? 'var(--danger)' : pct > 70 ? 'var(--warning)' : 'var(--success)'};border-radius:4px;transition:width 0.5s"></div>
      </div>
    </div>` : '';

  return `
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:4px">
      <div style="background:var(--surface-2);border-radius:8px;padding:12px">
        <div style="font-size:11px;color:var(--text-3);margin-bottom:4px;text-transform:uppercase;letter-spacing:0.05em">Last Real Submission</div>
        <div style="font-size:14px;font-weight:600">${client.last_real_form_at ? timeAgo(client.last_real_form_at) : '—'}</div>
        <div style="font-size:11px;color:var(--text-3);margin-top:2px">${client.last_real_form_at ? formatDate(client.last_real_form_at) : 'No submissions recorded'}</div>
      </div>
      <div style="background:var(--surface-2);border-radius:8px;padding:12px">
        <div style="font-size:11px;color:var(--text-3);margin-bottom:4px;text-transform:uppercase;letter-spacing:0.05em">Breakpoint</div>
        <div style="font-size:14px;font-weight:600">${client.form_breakpoint_days ? client.form_breakpoint_days + ' days' : 'Global default'}</div>
        <div style="font-size:11px;color:var(--text-3);margin-top:2px">${client.form_test_triggered ? '🟡 Test already triggered' : '✅ Watching for submissions'}</div>
      </div>
    </div>
    ${progressBar}
    ${client.form_last_test_at ? `
    <div style="padding:10px 12px;background:${client.form_last_test_ok ? 'rgba(16,185,129,0.07)' : 'rgba(239,68,68,0.07)'};border:1px solid ${client.form_last_test_ok ? 'rgba(16,185,129,0.2)' : 'rgba(239,68,68,0.2)'};border-radius:8px;font-size:12px;margin-top:6px">
      <strong>Last Auto-Test:</strong> ${formatDate(client.form_last_test_at)} — ${client.form_last_test_ok ? '✅ Passed (form working)' : '❌ Failed (alert sent to support)'}
    </div>` : ''}
  `;
}

// Load passive form submission log for a client
async function loadFormSubmissionLog(clientId) {
  const container = document.getElementById(`form-submit-log-${clientId}`);
  if (!container) return;

  try {
    const res  = await fetch(`/api/form-webhook/logs/${clientId}?limit=20`);
    const data = await res.json();
    const logs = data.data || [];

    if (!logs.length) {
      container.innerHTML = `
        <div style="font-size:12px;color:var(--text-3);padding:10px 0;border-top:1px solid var(--border);margin-top:4px">
          📭 No form submissions recorded yet. Install the WP plugin and set the Webhook URL to start tracking.
        </div>`;
      return;
    }

    container.innerHTML = `
      <div style="border-top:1px solid var(--border);padding-top:12px;margin-top:4px">
        <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;color:var(--text-3);margin-bottom:8px">
          📬 Recent Submission Log
        </div>
        <div style="display:flex;flex-direction:column;gap:5px">
          ${logs.map(l => {
            const isTest  = l.is_test;
            const icon    = isTest ? '🟡' : '✅';
            const label   = isTest
              ? (l.status === 'test_passed' ? 'Auto-test: Passed' : 'Auto-test: Failed')
              : 'Real submission';
            const typeTag = l.form_type === 'gravity_forms' ? 'GF' : l.form_type === 'contact_form_7' ? 'CF7' : '?';
            return `
              <div style="display:flex;align-items:center;gap:10px;padding:7px 10px;background:var(--surface-2);border-radius:6px;font-size:12px">
                <span>${icon}</span>
                <span style="flex:1;font-weight:500">${label}</span>
                <span style="color:var(--text-3);background:var(--surface-3);padding:1px 6px;border-radius:4px;font-size:11px">${typeTag}</span>
                ${l.form_name ? `<span style="color:var(--text-3)">${l.form_name}</span>` : ''}
                <span style="color:var(--text-3);font-size:11px;white-space:nowrap">${timeAgo(l.submitted_at)}</span>
              </div>`;
          }).join('')}
        </div>
      </div>`;
  } catch (err) {
    if (container) container.innerHTML = '';
  }
}

// Trigger a silent auto-test (without resetting the breakpoint counter)
async function triggerSilentTest(clientId) {
  try {
    toast('🔇 Triggering silent form test…', 'default', 3000);
    const res  = await fetch(`/api/form-webhook/trigger-test/${clientId}`, { method: 'POST' });
    const data = await res.json();
    if (data.success) {
      toast('✅ Silent test triggered — check logs in a moment', 'success');
      setTimeout(() => loadFormSubmissionLog(clientId), 5000);
    } else {
      toast(data.error || 'Failed to trigger test', 'error');
    }
  } catch (err) {
    toast(err.message, 'error');
  }
}

// Save form monitor global settings
async function saveFormMonitorSettings() {
  const breakpoint = parseInt(document.getElementById('s-form-breakpoint')?.value) || 3;
  const interval   = parseInt(document.getElementById('s-form-report-interval')?.value) || 6;
  try {
    await api.post('/settings', {
      form_breakpoint_days_default: breakpoint,
      form_report_interval_hours:   interval,
    });
    toast('✅ Form monitoring settings saved', 'success');
  } catch (err) {
    toast(err.message, 'error');
  }
}


function renderMismatchCard(visualRuns) {
  // Need at least 1 run with mismatch data
  const latest   = visualRuns.find(r => r.details?.mismatch?.length);
  const previous = visualRuns.slice(1).find(r => r.details?.mismatch?.length);

  if (!latest) return ''; // no mismatch data yet

  const rows = latest.details.mismatch.map(item => {
    // Find matching entry from previous run for delta
    const prev = previous?.details?.mismatch?.find(
      p => p.label === item.label && p.viewport === item.viewport
    );
    const delta     = prev != null ? item.mismatch - prev.mismatch : null;
    const overLimit = item.mismatch > item.threshold;
    const barMax    = Math.max(item.threshold * 3, item.mismatch, 0.5);
    const barPct    = Math.min((item.mismatch / barMax) * 100, 100).toFixed(1);
    const thPct     = Math.min((item.threshold / barMax) * 100, 100).toFixed(1);

    const deltaHtml = delta !== null
      ? `<span class="mismatch-delta ${delta > 0 ? 'delta-up' : delta < 0 ? 'delta-down' : 'delta-zero'}">
           ${delta > 0 ? '▲' : delta < 0 ? '▼' : '='} ${Math.abs(delta).toFixed(2)}%
         </span>`
      : '';

    const viewportIcon = { desktop: '🖥', tablet: '📱', mobile: '📲' }[item.viewport] || '🌐';

    return `
      <div class="mismatch-row">
        <div class="mismatch-label">
          <span class="mismatch-viewport">${viewportIcon} ${item.label}</span>
          <span class="mismatch-vp-tag">${item.viewport}</span>
        </div>
        <div class="mismatch-bar-wrap">
          <div class="mismatch-bar-track">
            <div class="mismatch-bar-fill ${overLimit ? 'over-limit' : 'under-limit'}"
              style="width:${barPct}%"></div>
            <div class="mismatch-threshold-line" style="left:${thPct}%"
              title="Threshold: ${item.threshold}%"></div>
          </div>
        </div>
        <div class="mismatch-value-group">
          <span class="mismatch-value ${overLimit ? 'mismatch-over' : 'mismatch-ok'}">${item.mismatch.toFixed(2)}%</span>
          ${deltaHtml}
          <span class="mismatch-threshold">/ ${item.threshold}%</span>
        </div>
      </div>
    `;
  }).join('');

  const runDate   = formatDate(latest.started_at);
  const prevNote  = previous
    ? `<span style="font-size:11px;color:var(--text-3)">Δ vs ${formatDate(previous.started_at)}</span>`
    : `<span style="font-size:11px;color:var(--text-3)">No previous run to compare</span>`;

  return `
    <div class="detail-card mismatch-card">
      <div class="detail-card-header">
        <div class="detail-card-title">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M2 12h20M12 2v20"/><circle cx="12" cy="12" r="10" stroke-dasharray="4 2"/></svg>
          Visual Mismatch Breakdown
        </div>
        <div style="display:flex;align-items:center;gap:10px">
          ${prevNote}
          <span style="font-size:11px;color:var(--text-3)">Last run: ${runDate}</span>
        </div>
      </div>
      <div class="detail-card-body" style="gap:10px">
        <div class="mismatch-legend">
          <span class="legend-item"><span class="legend-dot under-limit"></span>Within threshold</span>
          <span class="legend-item"><span class="legend-dot over-limit"></span>Exceeds threshold</span>
          <span class="legend-item"><span class="legend-line"></span>Threshold limit</span>
        </div>
        ${rows}
      </div>
    </div>
  `;
}

// ── Run All Sites ─────────────────────────────────────────────────────────────
async function runAllSites() {
  const btn = document.getElementById('btn-run-all');
  if (btn) { btn.disabled = true; btn.innerHTML = `<div class="spinner"></div> Starting…`; }
  try {
    const result = await api.post('/tests/run-all', {});
    toast(`▶ Running visual checks for ${result.queued} site(s)…`, 'default', 6000);
    // Start dashboard polling to update statuses
    setTimeout(renderDashboard, 2000);
  } catch (err) {
    toast(err.message, 'error');
    if (btn) { btn.disabled = false; btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polygon points="5 3 19 12 5 21 5 3"/></svg> Run All Checks`; }
  }
}

// ── Activity Feed ───────────────────────────────────────────────────────────────
async function loadActivityFeed() {
  const container = document.getElementById('activity-feed');
  if (!container) return;
  try {
    const activity = await api.get('/activity?limit=15');
    if (!activity.length) {
      container.innerHTML = `<div style="color:var(--text-3);font-size:13px;padding:8px 0">No test runs yet.</div>`;
      return;
    }
    container.innerHTML = `
      <div class="activity-list">
        ${activity.map(r => {
          const icon = r.type === 'visual'
            ? `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2"/></svg>`
            : `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/></svg>`;
          const dur = r.details?.duration_ms ? ` · ${fmtDuration(r.details.duration_ms)}` : '';
          return `
            <div class="activity-item" onclick="navigate('/client/${r.client_id}')">
              <div class="activity-icon activity-${r.status}">${icon}</div>
              <div class="activity-body">
                <span class="activity-site">${r.client_name}</span>
                <span class="activity-type">${r.type === 'visual' ? 'Visual check' : 'Form test'}${dur}</span>
              </div>
              <div class="activity-meta">
                ${statusBadge(r.status)}
                <span class="status-time">${timeAgo(r.started_at)}</span>
              </div>
            </div>
          `;
        }).join('')}
      </div>
    `;
  } catch (err) {
    if (container) container.innerHTML = '';
  }
}

// ── Settings Page ─────────────────────────────────────────────────────────────
const SCHEDULE_LABELS = {
  '0 * * * *':   'Every hour',
  '0 */6 * * *': 'Every 6 hours',
  '0 */12 * * *':'Every 12 hours',
  '0 6 * * *':   'Daily at 6am',
  '0 0 * * *':   'Daily at midnight',
  '0 9 * * 1':   'Weekly (Mon 9am)',
  '0 9 * * *':   'Daily at 9am',
};

async function renderSettings() {
  const main = document.getElementById('main-content');
  main.innerHTML = `<div class="loading-overlay"><div class="spinner"></div> Loading settings…</div>`;

  try {
    const settings = await api.get('/settings');

    main.innerHTML = `
      <div class="page-header">
        <div class="page-title-block">
          <h1 class="page-title">Settings</h1>
          <p class="page-subtitle">Global monitoring configuration for all sites</p>
        </div>
      </div>

      <div style="display:flex;flex-direction:column;gap:20px;max-width:680px">

        <!-- Auto Check Card -->
        <div class="detail-card">
          <div class="detail-card-header">
            <div class="detail-card-title">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
              Scheduled Auto-Check
            </div>
          </div>
          <div class="detail-card-body">
            <div style="display:flex;align-items:center;justify-content:space-between;padding:14px 0;border-bottom:1px solid var(--border)">
              <div>
                <div style="font-size:14px;font-weight:600">Enable Auto Visual Checks</div>
                <div style="font-size:12px;color:var(--text-3);margin-top:3px">Automatically run visual regression tests on a schedule</div>
              </div>
              <label class="toggle" style="position:relative;display:inline-block;width:44px;height:24px;cursor:pointer">
                <input type="checkbox" id="s-auto-enabled" ${settings.auto_check_enabled ? 'checked' : ''}
                  style="opacity:0;width:0;height:0;position:absolute"
                  onchange="saveSettingToggle('auto_check_enabled', this.checked)" />
                <span style="
                  position:absolute;inset:0;border-radius:24px;
                  background:${settings.auto_check_enabled ? 'var(--success)' : 'var(--surface-3)'};
                  transition:0.25s;display:flex;align-items:center;
                  padding:0 3px;
                " id="toggle-knob-auto">
                  <span style="
                    width:18px;height:18px;border-radius:50%;background:#fff;
                    transition:0.25s;transform:${settings.auto_check_enabled ? 'translateX(20px)' : 'translateX(0)'};
                  "></span>
                </span>
              </label>
            </div>

            <div class="form-group" style="margin-top:16px">
              <label class="form-label" for="s-schedule">Global Check Schedule</label>
              <select class="form-input" id="s-schedule" onchange="saveSchedule(this.value)">
                <option value="0 * * * *"   ${settings.global_schedule==='0 * * * *'   ?'selected':''}>Every hour</option>
                <option value="0 */6 * * *" ${settings.global_schedule==='0 */6 * * *' ?'selected':''}>Every 6 hours</option>
                <option value="0 */12 * * *"${settings.global_schedule==='0 */12 * * *'?'selected':''}>Every 12 hours</option>
                <option value="0 6 * * *"   ${settings.global_schedule==='0 6 * * *'   ?'selected':''}>Daily at 6am (recommended)</option>
                <option value="0 9 * * *"   ${settings.global_schedule==='0 9 * * *'   ?'selected':''}>Daily at 9am</option>
                <option value="0 0 * * *"   ${settings.global_schedule==='0 0 * * *'   ?'selected':''}>Daily at midnight</option>
                <option value="0 9 * * 1"   ${settings.global_schedule==='0 9 * * 1'   ?'selected':''}>Weekly (Mon 9am)</option>
              </select>
              <span class="form-hint">Applies to all sites unless they have their own schedule override (set per site in Edit Site)</span>
            </div>

            <div class="form-group">
              <label class="form-label" for="s-threshold">Global Mismatch Threshold (%)</label>
              <input type="number" step="0.1" min="0" max="100" class="form-input" id="s-threshold" value="${settings.global_mismatch_threshold || 2}" onchange="saveMismatchThreshold(this.value)">
              <span class="form-hint">Maximum allowed pixel change before a test is marked as failed. Above-the-fold is always 10&times; stricter. Applies globally unless a site has its own override.</span>
            </div>

            <div style="display:flex;align-items:center;justify-content:space-between;padding:16px 0 0;border-top:1px solid var(--border);margin-top:8px">
              <div>
                <div style="font-size:14px;font-weight:600">Enable Auto Form Tests</div>
                <div style="font-size:12px;color:var(--text-3);margin-top:3px">Also run contact form tests automatically (requires WM Monitor plugin on each site)</div>
              </div>
              <label class="toggle" style="position:relative;display:inline-block;width:44px;height:24px;cursor:pointer">
                <input type="checkbox" id="s-form-enabled" ${settings.auto_form_enabled ? 'checked' : ''}
                  style="opacity:0;width:0;height:0;position:absolute"
                  onchange="saveSettingToggle('auto_form_enabled', this.checked)" />
                <span style="
                  position:absolute;inset:0;border-radius:24px;
                  background:${settings.auto_form_enabled ? 'var(--success)' : 'var(--surface-3)'};
                  transition:0.25s;display:flex;align-items:center;padding:0 3px;
                " id="toggle-knob-form">
                  <span style="
                    width:18px;height:18px;border-radius:50%;background:#fff;
                    transition:0.25s;transform:${settings.auto_form_enabled ? 'translateX(20px)' : 'translateX(0)'};
                  "></span>
                </span>
              </label>
            </div>
          </div>
        </div>

        <!-- Form Monitoring Settings Card -->
        <div class="detail-card">
          <div class="detail-card-header">
            <div class="detail-card-title">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>
              Passive Form Monitoring
            </div>
          </div>
          <div class="detail-card-body" style="gap:16px">
            <div style="display:flex;align-items:center;justify-content:space-between;padding-bottom:14px;border-bottom:1px solid var(--border)">
              <div>
                <div style="font-size:14px;font-weight:600">Enable Passive Form Monitoring</div>
                <div style="font-size:12px;color:var(--text-3);margin-top:3px">Track real user form submissions from Gravity Forms &amp; CF7 via webhook. Checks breakpoints hourly.</div>
              </div>
              <label class="toggle" style="position:relative;display:inline-block;width:44px;height:24px;cursor:pointer">
                <input type="checkbox" id="s-form-monitor-enabled" ${settings.form_monitoring_enabled ? 'checked' : ''}
                  style="opacity:0;width:0;height:0;position:absolute"
                  onchange="saveSettingToggle('form_monitoring_enabled', this.checked)" />
                <span style="position:absolute;inset:0;border-radius:24px;background:${settings.form_monitoring_enabled ? 'var(--success)' : 'var(--surface-3)'};transition:0.25s;display:flex;align-items:center;padding:0 3px;" id="toggle-knob-form-monitor">
                  <span style="width:18px;height:18px;border-radius:50%;background:#fff;transition:0.25s;transform:${settings.form_monitoring_enabled ? 'translateX(20px)' : 'translateX(0)'};"></span>
                </span>
              </label>
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px">
              <div class="form-group" style="margin-bottom:0">
                <label class="form-label" for="s-form-breakpoint">Global Breakpoint (Days)</label>
                <input class="form-input" type="number" id="s-form-breakpoint" min="1" max="90"
                  placeholder="3"
                  value="${settings.form_breakpoint_days_default || 3}" />
                <span class="form-hint">If a site has no real submission for this many days, an automated silent test fires. Sites can override this per-site in Edit Site.</span>
              </div>
              <div class="form-group" style="margin-bottom:0">
                <label class="form-label" for="s-form-report-interval">Dashboard Report Interval</label>
                <select class="form-input" id="s-form-report-interval">
                  <option value="6" ${(settings.form_report_interval_hours||6)==6?'selected':''}>Every 6 hours (recommended)</option>
                  <option value="3" ${settings.form_report_interval_hours==3?'selected':''}>Every 3 hours</option>
                  <option value="12" ${settings.form_report_interval_hours==12?'selected':''}>Every 12 hours</option>
                  <option value="24" ${settings.form_report_interval_hours==24?'selected':''}>Daily</option>
                </select>
                <span class="form-hint">How often the dashboard form report refreshes</span>
              </div>
            </div>
            <div style="padding:10px 14px;background:rgba(147,24,52,0.06);border:1px solid rgba(147,24,52,0.15);border-radius:8px;font-size:12px;color:var(--text-2);line-height:1.7">
              📋 <strong>How it works:</strong> The WM Monitor WordPress plugin reports real form submissions automatically. If a site goes silent past the breakpoint, a <em>silent test</em> fires using Jayson Yavuz test data — the site owner never sees this email. Any failure alerts <strong>support@teamwebmarketers.ca</strong> immediately.
            </div>
            <div class="action-buttons">
              <button class="btn btn-primary btn-sm" onclick="saveFormMonitorSettings()">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/></svg>
                Save Form Settings
              </button>
            </div>
          </div>
        </div>

        <!-- Notifications Card -->
        <div class="detail-card">
          <div class="detail-card-header">
            <div class="detail-card-title">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>
              Notifications
            </div>
          </div>
          <div class="detail-card-body">
            <div class="form-group">
              <label class="form-label" for="s-slack">Default Slack Webhook</label>
              <input class="form-input" type="url" id="s-slack"
                placeholder="https://hooks.slack.com/services/…"
                value="${settings.default_slack || ''}" />
              <span class="form-hint">Fallback Slack webhook for sites that don't have their own webhook configured</span>
            </div>
            <div class="action-buttons" style="margin-top:4px">
              <button class="btn btn-primary btn-sm" onclick="saveSlack()">
                Save Webhook
              </button>
            </div>
          </div>
        </div>

        <!-- Email Provider Card -->
        <div class="detail-card">
          <div class="detail-card-header">
            <div class="detail-card-title">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>
              Email Notifications
            </div>
            <span style="font-size:11px;color:var(--text-3)">Used for email alerts on test failures</span>
          </div>
          <div class="detail-card-body" style="gap:14px">

            <!-- Provider tabs -->
            <div class="email-provider-tabs">
              <button class="provider-tab ${settings.email_provider !== 'smtp' ? 'active' : ''}"
                id="tab-ses" onclick="switchEmailProvider('ses')">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/></svg>
                AWS SES
              </button>
              <button class="provider-tab ${settings.email_provider === 'smtp' ? 'active' : ''}"
                id="tab-smtp" onclick="switchEmailProvider('smtp')">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/></svg>
                Generic SMTP
              </button>
            </div>

            <!-- AWS SES fields -->
            <div id="ses-fields" style="display:${settings.email_provider !== 'smtp' ? 'flex' : 'none'};flex-direction:column;gap:12px">
              <div style="padding:10px 14px;background:rgba(255,153,0,0.08);border:1px solid rgba(255,153,0,0.2);border-radius:8px;font-size:12px;color:var(--warning)">
                💡 Use your <strong>SES SMTP credentials</strong> from AWS Console → SES → SMTP Settings → Create SMTP credentials. The host is auto-derived from the region (e.g. <code>email-smtp.us-east-1.amazonaws.com</code> port 587).
              </div>
              <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
                <div class="form-group" style="margin-bottom:0">
                  <label class="form-label" for="s-aws-key">SMTP Username</label>
                  <input class="form-input" type="text" id="s-aws-key"
                    placeholder="AKIAIOSFODNN7EXAMPLE"
                    value="${settings.aws_access_key_id || ''}" />
                </div>
                <div class="form-group" style="margin-bottom:0">
                  <label class="form-label" for="s-aws-secret">SMTP Password</label>
                  <input class="form-input" type="password" id="s-aws-secret"
                    placeholder="••••••••"
                    value="${settings.aws_secret_access_key ? '••••••••' : ''}" />
                </div>
              </div>
              <div style="display:grid;grid-template-columns:160px 1fr 1fr;gap:12px">
                <div class="form-group" style="margin-bottom:0">
                  <label class="form-label" for="s-aws-region">AWS Region</label>
                  <select class="form-input" id="s-aws-region">
                    ${['us-east-1','us-east-2','us-west-1','us-west-2','ca-central-1',
                       'eu-west-1','eu-west-2','eu-central-1','ap-southeast-1','ap-southeast-2','ap-northeast-1']
                      .map(r => `<option value="${r}" ${(settings.aws_region||'us-east-1')===r?'selected':''}>${r}</option>`).join('')}
                  </select>
                </div>
                <div class="form-group" style="margin-bottom:0">
                  <label class="form-label" for="s-ses-from">Verified From Email</label>
                  <input class="form-input" type="email" id="s-ses-from"
                    placeholder="alerts@webmarketers.ca"
                    value="${settings.smtp_from || settings.aws_ses_from || ''}" />
                </div>
                <div class="form-group" style="margin-bottom:0">
                  <label class="form-label" for="s-ses-from-name">From Name</label>
                  <input class="form-input" type="text" id="s-ses-from-name"
                    placeholder="WM Monitoring"
                    value="${settings.smtp_from_name || ''}" />
                </div>
              </div>
              <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:4px">
                <div class="form-group" style="margin-bottom:0">
                  <label class="form-label" for="s-ses-default-email">Default Alert Email</label>
                  <input class="form-input" type="email" id="s-ses-default-email"
                    placeholder="alerts@webmarketers.ca"
                    value="${settings.smtp_default_email || ''}" />
                  <span class="form-hint">Fallback recipient when a site has no specific alert email</span>
                </div>
                <div class="form-group" style="margin-bottom:0">
                  <label class="form-label" for="s-ses-test-to">Send Test Email To</label>
                  <input class="form-input" type="email" id="s-ses-test-to"
                    placeholder="you@example.com" />
                  <span class="form-hint">Receives a real test email when you click Test Connection</span>
                </div>
              </div>
              <div style="display:flex;gap:10px;margin-top:4px">
                <button class="btn btn-primary btn-sm" onclick="saveSes()">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/></svg>
                  Save AWS SES
                </button>
                <button class="btn btn-secondary btn-sm" id="btn-test-ses" onclick="testSesConnection()">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="22 2 11 13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
                  Test Connection
                </button>
                <span id="smtp-test-result" style="font-size:13px;align-self:center"></span>
              </div>
            </div>

            <!-- SMTP fields -->
            <div id="smtp-fields" style="display:${settings.email_provider === 'smtp' ? 'flex' : 'none'};flex-direction:column;gap:12px">
              <div style="display:grid;grid-template-columns:1fr 120px;gap:12px">
                <div class="form-group" style="margin-bottom:0">
                  <label class="form-label" for="s-smtp-host">SMTP Host</label>
                  <input class="form-input" type="text" id="s-smtp-host"
                    placeholder="smtp.gmail.com"
                    value="${settings.smtp_host || ''}" />
                </div>
                <div class="form-group" style="margin-bottom:0">
                  <label class="form-label" for="s-smtp-port">Port</label>
                  <input class="form-input" type="number" id="s-smtp-port"
                    placeholder="587"
                    value="${settings.smtp_port || '587'}" />
                </div>
              </div>
              <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
                <div class="form-group" style="margin-bottom:0">
                  <label class="form-label" for="s-smtp-user">Username / Email</label>
                  <input class="form-input" type="text" id="s-smtp-user"
                    placeholder="you@gmail.com"
                    value="${settings.smtp_user || ''}" />
                </div>
                <div class="form-group" style="margin-bottom:0">
                  <label class="form-label" for="s-smtp-pass">Password / App Password</label>
                  <input class="form-input" type="password" id="s-smtp-pass"
                    placeholder="••••••••"
                    value="${settings.smtp_pass || ''}" />
                </div>
              </div>
              <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
                <div class="form-group" style="margin-bottom:0">
                  <label class="form-label" for="s-smtp-from">From Email</label>
                  <input class="form-input" type="email" id="s-smtp-from"
                    placeholder="alerts@agency.com"
                    value="${settings.smtp_from || ''}" />
                </div>
                <div class="form-group" style="margin-bottom:0">
                  <label class="form-label" for="s-smtp-from-name">From Name</label>
                  <input class="form-input" type="text" id="s-smtp-from-name"
                    placeholder="WM Monitoring"
                    value="${settings.smtp_from_name || ''}" />
                </div>
              </div>
              <label class="toggle-label" style="margin-top:4px">
                <input type="checkbox" id="s-smtp-secure" class="toggle-input" ${settings.smtp_secure ? 'checked' : ''} />
                <span class="toggle-track"><span class="toggle-thumb"></span></span>
                <span class="toggle-text" style="font-size:13px">Use SSL/TLS (enable for port 465)</span>
              </label>
              <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:4px">
                <div class="form-group" style="margin-bottom:0">
                  <label class="form-label" for="s-smtp-default-email">Default Alert Email</label>
                  <input class="form-input" type="email" id="s-smtp-default-email"
                    placeholder="alerts@webmarketers.ca"
                    value="${settings.smtp_default_email || ''}" />
                  <span class="form-hint">Fallback recipient when a site has no specific alert email</span>
                </div>
                <div class="form-group" style="margin-bottom:0">
                  <label class="form-label" for="s-smtp-test-to">Send Test Email To</label>
                  <input class="form-input" type="email" id="s-smtp-test-to"
                    placeholder="you@example.com" />
                  <span class="form-hint">Receives a real test email when you click Test Connection</span>
                </div>
              </div>
              <div style="display:flex;gap:10px;margin-top:4px">
                <button class="btn btn-primary btn-sm" onclick="saveSmtp()">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/></svg>
                  Save SMTP
                </button>
                <button class="btn btn-secondary btn-sm" id="btn-test-smtp" onclick="testSmtp()">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="22 2 11 13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
                  Test Connection
                </button>
                <span id="smtp-test-result-smtp" style="font-size:13px;align-self:center"></span>
              </div>
            </div>

          </div>
        </div>

        <!-- WP Plugin Card -->
        <div class="detail-card">
          <div class="detail-card-header">
            <div class="detail-card-title">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" class="stroke-current" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
              WordPress Plugin
            </div>
          </div>
          <div class="detail-card-body">
            <p style="font-size:13px;color:var(--text-2);margin-bottom:16px">
              Download the WM Plus Monitoring WordPress plugin. Install this plugin on client sites to enable Form Submission Tracking and Automated Testing.
            </p>
            <a href="/plugin/wm-monitor.zip" class="btn btn-primary btn-sm" style="display:inline-flex;text-decoration:none" download>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
              Download Latest Plugin (v2.0)
            </a>
          </div>
        </div>

        <!-- Info Card -->
        <div class="detail-card">
          <div class="detail-card-header">
            <div class="detail-card-title">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
              How Scheduling Works
            </div>
          </div>
          <div class="detail-card-body" style="font-size:13px;color:var(--text-2);line-height:1.8">
            <ol style="padding-left:18px;display:flex;flex-direction:column;gap:6px">
              <li>Enable auto-check above and choose a <strong>Global Schedule</strong></li>
              <li>All sites will be visually tested on that schedule automatically</li>
              <li>Individual sites can override the schedule via <strong>Edit Site → Schedule Override</strong></li>
              <li>If visual changes are detected and a Slack webhook is configured, you'll receive an alert</li>
              <li>You can still manually click <strong>Run All Checks</strong> or run tests per-site at any time</li>
            </ol>
          </div>
        </div>

        <!-- Disk Cleanup Card -->
        <div class="detail-card">
          <div class="detail-card-header">
            <div class="detail-card-title">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>
              Disk Cleanup
            </div>
          </div>
          <div class="detail-card-body">
            <p style="font-size:13px;color:var(--text-2);margin-bottom:16px">
              Old test snapshots accumulate on disk over time. Cleanup removes old <code>bitmaps_test</code> runs, keeping only the most recent ones per site. New tests auto-cleanup (keep 5), but you can run a manual sweep here.
            </p>
            <div style="display:flex;align-items:center;gap:12px">
              <div class="form-group" style="margin-bottom:0;flex:1">
                <label class="form-label" for="cleanup-keep">Keep last N snapshots per site</label>
                <select class="form-input" id="cleanup-keep">
                  <option value="1">1 (minimum)</option>
                  <option value="2">2</option>
                  <option value="3" selected>3</option>
                  <option value="5">5</option>
                </select>
              </div>
              <button class="btn btn-danger btn-sm" id="btn-cleanup" onclick="runCleanup()" style="margin-top:20px">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>
                Run Cleanup
              </button>
            </div>
            <div id="cleanup-result" style="margin-top:12px;font-size:13px"></div>
          </div>
        </div>

      </div>
    `;
  } catch (err) {
    main.innerHTML = `<div class="loading-overlay">❌ ${err.message}</div>`;
  }
}

async function saveSettingToggle(key, value) {
  try {
    await api.put('/settings', { [key]: value });
    toast(`Setting saved`, 'success', 2000);
    // Re-render to update toggle visual state
    renderSettings();
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function saveSchedule(value) {
  try {
    await api.put('/settings', { global_schedule: value });
    toast(`Schedule updated to: ${SCHEDULE_LABELS[value] || value}`, 'success', 3000);
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function saveMismatchThreshold(value) {
  try {
    await api.put('/settings', { global_mismatch_threshold: parseFloat(value) });
    toast(`Global threshold set to ${value}%`, 'success', 3000);
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function saveSmtp() {
  try {
    await api.put('/settings', {
      email_provider: 'smtp',
      smtp_host:      document.getElementById('s-smtp-host').value.trim(),
      smtp_port:      document.getElementById('s-smtp-port').value.trim() || '587',
      smtp_user:      document.getElementById('s-smtp-user').value.trim(),
      smtp_pass:      document.getElementById('s-smtp-pass').value,
      smtp_from:      document.getElementById('s-smtp-from').value.trim(),
      smtp_from_name: document.getElementById('s-smtp-from-name').value.trim(),
      smtp_secure:    document.getElementById('s-smtp-secure').checked,
    });
    toast('SMTP settings saved!', 'success');
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function saveSes() {
  try {
    await api.put('/settings', {
      email_provider:        'ses',
      aws_access_key_id:     document.getElementById('s-aws-key').value.trim(),
      aws_secret_access_key: document.getElementById('s-aws-secret').value,
      aws_region:            document.getElementById('s-aws-region').value,
      smtp_from:             document.getElementById('s-ses-from').value.trim(),
      smtp_from_name:        document.getElementById('s-ses-from-name').value.trim(),
      smtp_default_email:    document.getElementById('s-ses-default-email').value.trim(),
    });
    toast('AWS SES settings saved!', 'success');
  } catch (err) {
    toast(err.message, 'error');
  }
}

function switchEmailProvider(provider) {
  const sesFields  = document.getElementById('ses-fields');
  const smtpFields = document.getElementById('smtp-fields');
  const tabSes     = document.getElementById('tab-ses');
  const tabSmtp    = document.getElementById('tab-smtp');
  if (!sesFields) return;
  sesFields.style.display  = provider === 'ses'  ? 'flex' : 'none';
  smtpFields.style.display = provider === 'smtp' ? 'flex' : 'none';
  tabSes.classList.toggle('active',  provider === 'ses');
  tabSmtp.classList.toggle('active', provider === 'smtp');
}

async function testSesConnection() {
  const btn    = document.getElementById('btn-test-ses');
  const result = document.getElementById('smtp-test-result');
  if (btn) { btn.disabled = true; btn.innerHTML = `<div class="spinner"></div> Testing…`; }
  if (result) result.innerHTML = '';
  try {
    const data = await api.post('/settings/test-ses', {
      aws_access_key_id:     document.getElementById('s-aws-key').value.trim(),
      aws_secret_access_key: document.getElementById('s-aws-secret').value,
      aws_region:            document.getElementById('s-aws-region').value,
      smtp_from:             document.getElementById('s-ses-from').value.trim(),
      smtp_from_name:        document.getElementById('s-ses-from-name').value.trim(),
      test_to:               document.getElementById('s-ses-test-to').value.trim(),
    });
    if (result) result.innerHTML = `<span style="color:var(--success)">✅ ${data?.message || 'Success'}</span>`;
    toast('AWS SES connected!', 'success');
  } catch (err) {
    const errorMsg = err?.message || err || 'An unknown error occurred';
    if (result) result.innerHTML = `<span style="color:var(--error)">❌ ${errorMsg}</span>`;
    toast(errorMsg, 'error');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="22 2 11 13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg> Test Connection`;
    }
  }
}

async function testSmtp() {
  const btn    = document.getElementById('btn-test-smtp');
  const result = document.getElementById('smtp-test-result');
  if (btn) { btn.disabled = true; btn.innerHTML = `<div class="spinner"></div> Testing…`; }
  if (result) result.innerHTML = '';
  try {
    const data = await api.post('/settings/test-email', {
      smtp_host:   document.getElementById('s-smtp-host').value.trim(),
      smtp_port:   document.getElementById('s-smtp-port').value.trim(),
      smtp_user:   document.getElementById('s-smtp-user').value.trim(),
      smtp_pass:   document.getElementById('s-smtp-pass').value,
      smtp_secure: document.getElementById('s-smtp-secure').checked,
    });
    if (result) result.innerHTML = `<span style="color:var(--success)">✅ ${data?.message || 'Success'}</span>`;
    toast('SMTP connection successful!', 'success');
  } catch (err) {
    const errorMsg = err?.message || err || 'An unknown error occurred';
    if (result) result.innerHTML = `<span style="color:var(--error)">❌ ${errorMsg}</span>`;
    toast(errorMsg, 'error');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="22 2 11 13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg> Test Connection`;
    }
  }
}

async function saveSlack() {
  try {
    const val = document.getElementById('s-slack').value.trim();
    await api.put('/settings', { default_slack: val });
    toast('Slack webhook saved!', 'success');
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function runCleanup() {
  const btn    = document.getElementById('btn-cleanup');
  const result = document.getElementById('cleanup-result');
  const keep   = parseInt(document.getElementById('cleanup-keep')?.value) || 3;
  if (btn) { btn.disabled = true; btn.innerHTML = `<div class="spinner"></div> Cleaning…`; }
  try {
    const data = await api.post('/settings/cleanup', { keep_last: keep });
    const freed = data.totalFreedKb > 1024
      ? `${(data.totalFreedKb / 1024).toFixed(1)} MB`
      : `${data.totalFreedKb} KB`;
    const totalRemoved = data.results.reduce((s, r) => s + r.removed, 0);
    if (result) result.innerHTML = `<span style="color:var(--success)">✅ Removed ${totalRemoved} snapshot folder(s), freed ${freed}</span>`;
    toast(`Cleanup done — freed ${freed}`, 'success');
  } catch (err) {
    if (result) result.innerHTML = `<span style="color:var(--danger)">❌ ${err.message}</span>`;
    toast(err.message, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg> Run Cleanup`; }
  }
}

// ── Actions ────────────────────────────────────────────────────────────────────
async function runVisualReference(clientId) {
  const btn = document.getElementById(`btn-reference-${clientId}`);
  if (!btn) return;
  btn.disabled = true;
  btn.innerHTML = `<div class="spinner"></div> Capturing…`;
  try {
    const run = await api.post(`/clients/${clientId}/visual/reference`, {});
    toast('Capturing reference screenshots…', 'default');
    pollRun(run.run_id, 'visual', clientId);
  } catch (err) {
    toast(err.message, 'error');
    btn.disabled = false;
    btn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/></svg> Capture Reference`;
  }
}

async function runVisualTest(clientId) {
  const btn = document.getElementById(`btn-visual-test-${clientId}`);
  if (!btn) return;
  btn.disabled = true;
  btn.innerHTML = `<div class="spinner"></div> Running…`;
  try {
    const run = await api.post(`/clients/${clientId}/visual/test`, {});
    toast('Visual test started…', 'default');
    pollRun(run.run_id, 'visual', clientId);
  } catch (err) {
    toast(err.message, 'error');
    btn.disabled = false;
    btn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"/></svg> Run Test`;
  }
}

async function runFormTest(clientId) {
  const btn = document.getElementById(`btn-form-test-${clientId}`);
  if (!btn) return;
  btn.disabled = true;
  btn.innerHTML = `<div class="spinner"></div> Testing…`;
  try {
    const run = await api.post(`/clients/${clientId}/form/test`, {});
    toast('Form test started…', 'default');
    pollRun(run.run_id, 'form', clientId);
  } catch (err) {
    toast(err.message, 'error');
    btn.disabled = false;
    btn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"/></svg> Run Form Test`;
  }
}

// ── Polling ───────────────────────────────────────────────────────────────────
function pollRun(runId, type, clientId) {
  const key = `run-${runId}`;
  if (state.pollingIntervals[key]) return;

  state.pollingIntervals[key] = setInterval(async () => {
    try {
      const run = await api.get(`/runs/${runId}`);
      if (run.status !== 'running') {
        clearInterval(state.pollingIntervals[key]);
        delete state.pollingIntervals[key];

        const successMsg = type === 'visual'
          ? (run.status === 'passed' ? '✅ Visual test passed!' : '⚠️ Visual differences detected.')
          : (run.status === 'passed' ? '✅ Form test passed!' : '❌ Form test failed.');
        toast(successMsg, run.status === 'passed' ? 'success' : 'error');

        // Refresh the current view
        const route = getRoute();
        const clientMatch = route.match(/^\/client\/(\d+)$/);
        if (clientMatch && Number(clientMatch[1]) === clientId) {
          renderClientPage(clientId);
        } else {
          renderDashboard();
        }
      }
    } catch (err) { /* ignore poll errors */ }
  }, 3000);
}

function startClientPolling(client) {
  const lastVisual = client.runs.find(r => r.type === 'visual' && r.status === 'running');
  const lastForm   = client.runs.find(r => r.type === 'form'   && r.status === 'running');
  if (lastVisual) pollRun(lastVisual.id, 'visual', client.id);
  if (lastForm)   pollRun(lastForm.id,   'form',   client.id);
}

function startDashboardPolling() {
  if (state.pollingIntervals['dashboard']) return;
  state.pollingIntervals['dashboard'] = setInterval(async () => {
    try {
      const clients = await api.get('/clients');
      const stillRunning = clients.some(c => c.last_visual_status === 'running' || c.last_form_status === 'running');
      if (!stillRunning) {
        clearInterval(state.pollingIntervals['dashboard']);
        delete state.pollingIntervals['dashboard'];
        renderDashboard();
      } else {
        // Update status badges in-place
        clients.forEach(c => {
          const card = document.getElementById(`card-${c.id}`);
          if (card) {
            card.className = `site-card ${cardStatusClass(c)}`;
          }
        });
      }
    } catch (err) {}
  }, 5000);
}

function clearPolling() {
  Object.keys(state.pollingIntervals).forEach(key => {
    clearInterval(state.pollingIntervals[key]);
    delete state.pollingIntervals[key];
  });
}

// ── Add/Edit Client Modal ─────────────────────────────────────────────────────
function openAddModal() {
  document.getElementById('modal-title').textContent = 'Add New Site';
  document.getElementById('modal-submit-btn').textContent = 'Add Site';
  document.getElementById('client-form').reset();
  document.getElementById('client-id').value = '';
  document.getElementById('f-email').value = 'dev@teamwebmarketers.ca';
  document.getElementById('f-form-id').value = '1';
  document.getElementById('f-breakpoint').value = '';
  document.getElementById('f-schedule').value = '';
  document.getElementById('f-threshold').value = '';
  document.getElementById('f-alert-slack').checked = true;
  document.getElementById('f-alert-email').checked = false;
  document.getElementById('f-alert-email-to').value = '';
  openModal('client-modal');
}

async function openEditModal(clientId) {
  const client = state.clients.find(c => c.id === clientId) || await api.get(`/clients/${clientId}`);
  document.getElementById('modal-title').textContent = 'Edit Site';
  document.getElementById('modal-submit-btn').textContent = 'Save Changes';
  document.getElementById('client-id').value = client.id;
  document.getElementById('f-name').value = client.name;
  document.getElementById('f-url').value = client.url;
  document.getElementById('f-key').value = client.monitor_key || '';
  document.getElementById('f-form-id').value = client.form_id || 1;
  document.getElementById('f-email').value = client.test_email || 'dev@teamwebmarketers.ca';
  document.getElementById('f-breakpoint').value = client.form_breakpoint_days != null ? client.form_breakpoint_days : '';
  document.getElementById('f-notes').value = client.notes || '';
  document.getElementById('f-schedule').value = client.custom_schedule || '';
  document.getElementById('f-threshold').value = client.custom_mismatch_threshold != null ? String(client.custom_mismatch_threshold) : '';
  document.getElementById('f-alert-slack').checked = client.alert_slack_enabled !== false;
  document.getElementById('f-alert-email').checked = Boolean(client.alert_email_enabled);
  document.getElementById('f-alert-email-to').value = client.alert_email || '';
  openModal('client-modal');
}

async function submitClientForm(e) {
  e.preventDefault();
  const btn = document.getElementById('modal-submit-btn');
  const clientId = document.getElementById('client-id').value;
  const payload = {
    name: document.getElementById('f-name').value.trim(),
    url: document.getElementById('f-url').value.trim(),
    monitor_key: document.getElementById('f-key').value.trim(),
    form_id: parseInt(document.getElementById('f-form-id').value) || 1,
    test_email: document.getElementById('f-email').value.trim(),
    form_breakpoint_days: document.getElementById('f-breakpoint').value
      ? parseInt(document.getElementById('f-breakpoint').value) : null,
    slack_webhook: document.getElementById('f-slack')?.value.trim(),
    notes:                     document.getElementById('f-notes').value.trim(),
    custom_schedule:           document.getElementById('f-schedule').value || null,
    custom_mismatch_threshold: document.getElementById('f-threshold').value || null,
    alert_slack_enabled:       document.getElementById('f-alert-slack').checked,
    alert_email_enabled:       document.getElementById('f-alert-email').checked,
    alert_email:               document.getElementById('f-alert-email-to').value.trim() || null,
  };

  btn.disabled = true;
  btn.innerHTML = `<div class="spinner"></div> Saving…`;

  try {
    if (clientId) {
      await api.put(`/clients/${clientId}`, payload);
      toast('Site updated!', 'success');
    } else {
      await api.post('/clients', payload);
      toast('Site added successfully!', 'success');
    }
    closeModal('client-modal');
    const route = getRoute();
    const clientMatch = route.match(/^\/client\/(\d+)$/);
    if (clientMatch) renderClientPage(Number(clientMatch[1]));
    else renderDashboard();
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = clientId ? 'Save Changes' : 'Add Site';
  }
}

async function deleteClient(clientId, clientName) {
  if (!confirm(`Delete "${clientName}"? This will remove all test history. This cannot be undone.`)) return;
  try {
    await api.del(`/clients/${clientId}`);
    toast(`"${clientName}" deleted`, 'default');
    navigate('/');
    renderDashboard();
  } catch (err) {
    toast(err.message, 'error');
  }
}

// ── Log Viewer ────────────────────────────────────────────────────────────────
async function openLog(runId) {
  document.getElementById('log-content').textContent = 'Loading...';
  openModal('log-modal');
  try {
    const run = await api.get(`/runs/${runId}`);
    document.getElementById('log-modal-title').textContent = `${run.type === 'visual' ? 'Visual' : 'Form'} Test Log`;
    document.getElementById('log-content').textContent = run.log || '(No log output)';
  } catch (err) {
    document.getElementById('log-content').textContent = `Error: ${err.message}`;
  }
}

// ── Init ──────────────────────────────────────────────────────────────────────
window.addEventListener('hashchange', router);
window.addEventListener('DOMContentLoaded', router);

// Expose functions needed by HTML onclick attributes
Object.assign(window, {
  navigate, openAddModal, openEditModal, closeModal, openModal,
  submitClientForm, deleteClient, runVisualReference, runVisualTest,
  runFormTest, openLog, runAllSites, saveSettingToggle, saveSchedule, saveSlack,
  saveMismatchThreshold, saveSmtp, saveSes, switchEmailProvider, testSmtp, testSesConnection,
  setFilter, runCleanup,
});
