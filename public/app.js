/* Pulse — dashboard. Dependency-free. */
'use strict';

const el = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pct = (v) => (v === null || v === undefined ? '—' : v.toFixed(2) + '%');
const fmtLatency = (ms) => (ms === null || ms === undefined ? '—' : ms >= 1000 ? (ms / 1000).toFixed(2) + 's' : ms + 'ms');

function timeAgo(iso) {
  if (!iso) return 'never';
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (Number.isNaN(s)) return '—';
  if (s < 60) return s + 's ago';
  if (s < 3600) return Math.round(s / 60) + 'm ago';
  if (s < 86400) return Math.round(s / 3600) + 'h ago';
  return Math.round(s / 86400) + 'd ago';
}

function adminHeaders(hasBody) {
  const token = localStorage.getItem('pulse.adminToken');
  const headers = {};
  if (token) headers['x-admin-token'] = token;
  // only declare a JSON body when there is one — Fastify rejects an empty
  // body that claims to be JSON
  if (hasBody) headers['content-type'] = 'application/json';
  return headers;
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { ...adminHeaders(options.body !== undefined), ...(options.headers || {}) }
  });
  if (res.status === 401) {
    const t = prompt('This Pulse instance requires an admin token:');
    if (t) {
      localStorage.setItem('pulse.adminToken', t);
      return api(path, options);
    }
    throw new Error('admin token required');
  }
  if (res.status === 204) return null;
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || ('HTTP ' + res.status));
  return body;
}

function msg(text, ok) {
  el('formMsg').innerHTML = '<span class="' + (ok ? 'ok-msg' : 'err') + '">' + esc(text) + '</span>';
  setTimeout(() => { el('formMsg').textContent = ''; }, 5000);
}

// Refreshes can overlap (the 10s poll plus a button-triggered reload); only the
// newest render may touch the DOM, otherwise a slow response can paint stale
// data over fresh data.
let renderSeq = 0;

async function load() {
  const seq = ++renderSeq;
  try {
    const [summary, monitors] = await Promise.all([api('/api/summary'), api('/api/monitors')]);

    if (seq !== renderSeq) return;
    el('bannerDot').className = 'dot ' + summary.state;
    el('bannerText').textContent = {
      up: 'All systems operational',
      degraded: 'Degraded performance',
      down: 'Major outage',
      nodata: 'Awaiting first checks'
    }[summary.state] || summary.state;
    el('bannerMeta').innerHTML = summary.up + ' up · ' + summary.degraded + ' degraded · ' + summary.down + ' down';

    el('sMonitors').textContent = summary.monitors;
    el('sUptime').textContent = pct(summary.uptime90d);
    el('sIncidents').textContent = summary.openIncidents;

    try {
      const sched = await api('/api/scheduler');
      el('sChecks').textContent = sched.checksRun + ' this session';
    } catch { el('sChecks').textContent = '—'; }

    const host = el('monitors');
    if (!monitors.length) {
      host.innerHTML = '<div class="empty">No monitors yet — add your first below.</div>';
      return;
    }

    const histories = await Promise.all(
      monitors.map((m) => api('/api/monitors/' + m.monitor.id + '/history?days=90'))
    );

    if (seq !== renderSeq) return; // a newer refresh already started
    host.innerHTML = monitors.map((m, i) => {
      const h = histories[i];
      const bars = h.buckets.map((b) =>
        '<div class="bar ' + b.state + '" title="' + b.date + ' — ' +
        (b.pct === null ? 'no data' : b.pct.toFixed(2) + '% of ' + b.total + ' checks') + '"></div>'
      ).join('');

      return '' +
        '<div class="card" data-id="' + m.monitor.id + '">' +
          '<div class="card-head">' +
            '<span class="dot ' + m.state + '" style="width:9px;height:9px;border-radius:50%;box-shadow:none"></span>' +
            '<span class="name">' + esc(m.monitor.name) + '</span>' +
            (m.monitor.active ? '<span class="tag ' + m.state + '">' + m.state + '</span>' : '<span class="tag off">paused</span>') +
            '<a class="url" href="' + esc(m.monitor.url) + '" target="_blank" rel="noopener noreferrer">' + esc(m.monitor.url) + '</a>' +
            '<div class="right">' +
              '<span>90d <b>' + pct(m.uptime90d) + '</b></span>' +
              '<span>24h <b>' + pct(m.uptime24h) + '</b></span>' +
              '<span><b>' + fmtLatency(m.avgLatencyMs24h) + '</b></span>' +
              '<span>' + timeAgo(m.lastCheck && m.lastCheck.checkedAt) + '</span>' +
            '</div>' +
          '</div>' +
          '<div class="bars">' + bars + '</div>' +
          '<div class="card-head" style="margin-top:9px">' +
            '<span class="bars-legend" style="flex:1">every ' + m.monitor.intervalS + 's · expect ' + m.monitor.expectStatus + '</span>' +
            '<div class="actions">' +
              '<button class="ghost" data-act="check" data-id="' + m.monitor.id + '">Check now</button>' +
              '<button class="ghost" data-act="toggle" data-id="' + m.monitor.id + '">' + (m.monitor.active ? 'Pause' : 'Resume') + '</button>' +
              '<button class="danger" data-act="delete" data-id="' + m.monitor.id + '">Delete</button>' +
            '</div>' +
          '</div>' +
          (m.openIncident ? '<div class="err" style="margin-top:6px">● open since ' + timeAgo(m.openIncident.startedAt) + ' — ' + esc(m.openIncident.reason) + '</div>' : '') +
        '</div>';
    }).join('');
  } catch (err) {
    if (seq !== renderSeq) return;
    el('bannerText').textContent = 'API unreachable';
    el('bannerDot').className = 'dot down';
    console.error(err);
  }
}

// ---- actions ----
el('monitors').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const id = Number(btn.dataset.id);
  const act = btn.dataset.act;
  btn.disabled = true;

  try {
    if (act === 'check') {
      await api('/api/monitors/' + id + '/check', { method: 'POST' });
      msg('check complete', true);
    } else if (act === 'delete') {
      if (!confirm('Delete this monitor and all of its history?')) { btn.disabled = false; return; }
      await api('/api/monitors/' + id, { method: 'DELETE' });
      msg('monitor deleted', true);
    } else if (act === 'toggle') {
      const card = btn.closest('.card');
      const paused = !!card.querySelector('.tag.off');
      await api('/api/monitors/' + id, { method: 'PATCH', body: JSON.stringify({ active: paused }) });
      msg(paused ? 'resumed' : 'paused', true);
    }
    await load();
  } catch (err) {
    msg(String(err.message || err), false);
    btn.disabled = false;
  }
});

el('addForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = el('addBtn');
  btn.disabled = true;
  try {
    await api('/api/monitors', {
      method: 'POST',
      body: JSON.stringify({
        name: el('f-name').value,
        url: el('f-url').value,
        expectStatus: Number(el('f-expect').value),
        intervalS: Number(el('f-interval').value)
      })
    });
    el('f-name').value = '';
    el('f-url').value = '';
    msg('monitor added — first check runs within seconds', true);
    await load();
  } catch (err) {
    msg(String(err.message || err), false);
  } finally {
    btn.disabled = false;
  }
});

el('testBtn').addEventListener('click', async () => {
  const url = el('f-url').value.trim();
  if (!url) return msg('enter a URL first', false);
  el('testBtn').disabled = true;
  try {
    const r = await api('/api/preview', { method: 'POST', body: JSON.stringify({ url }) });
    msg(r.reachable ? 'reachable — HTTP ' + r.status + ' in ' + r.latencyMs + 'ms' : 'unreachable: ' + r.error, r.reachable);
  } catch (err) {
    msg(String(err.message || err), false);
  } finally {
    el('testBtn').disabled = false;
  }
});

load();
setInterval(load, 10000);
