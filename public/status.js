/* Pulse — public status page. Dependency-free. */
'use strict';

const STATE_LABEL = {
  up: 'All systems operational',
  degraded: 'Degraded performance',
  down: 'Major outage',
  nodata: 'Awaiting first checks'
};

const el = (id) => document.getElementById(id);

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function pct(v) {
  return v === null || v === undefined ? '—' : v.toFixed(2) + '%';
}

function fmtLatency(ms) {
  if (ms === null || ms === undefined) return '—';
  return ms >= 1000 ? (ms / 1000).toFixed(2) + 's' : ms + 'ms';
}

function timeAgo(iso) {
  if (!iso) return 'never';
  const diff = Date.now() - Date.parse(iso);
  if (Number.isNaN(diff)) return '—';
  const s = Math.round(diff / 1000);
  if (s < 60) return s + 's ago';
  const m = Math.round(s / 60);
  if (m < 60) return m + 'm ago';
  const h = Math.round(m / 60);
  if (h < 24) return h + 'h ago';
  return Math.round(h / 24) + 'd ago';
}

function fmtDate(iso) {
  const d = new Date(iso);
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

// Only the newest refresh may paint: the 15s poll can overlap a slow request.
let renderSeq = 0;

async function load() {
  const seq = ++renderSeq;
  try {
    const [summary, monitors] = await Promise.all([
      fetch('/api/summary').then((r) => r.json()),
      fetch('/api/monitors').then((r) => r.json())
    ]);
    if (seq !== renderSeq) return;

    el('bannerDot').className = 'dot ' + summary.state;
    el('bannerText').textContent = STATE_LABEL[summary.state] || summary.state;
    el('bannerMeta').innerHTML =
      summary.monitors + ' monitor' + (summary.monitors === 1 ? '' : 's') + '<br>' +
      summary.up + ' up · ' + summary.degraded + ' degraded · ' + summary.down + ' down';

    el('sMonitors').textContent = summary.monitors;
    el('sUptime').textContent = pct(summary.uptime90d);
    el('sIncidents').textContent = summary.openIncidents;
    el('sRefresh').textContent = new Date().toLocaleTimeString();

    // ---- monitor cards ----
    const host = el('monitors');
    if (!monitors.length) {
      host.innerHTML = '<div class="empty">No monitors configured yet. Add one from the <a href="/" style="color:var(--accent)">dashboard</a>.</div>';
    } else {
      const histories = await Promise.all(
        monitors.map((m) => fetch('/api/monitors/' + m.monitor.id + '/history?days=90').then((r) => r.json()))
      );
      if (seq !== renderSeq) return;

      host.innerHTML = monitors.map((m, i) => {
        const h = histories[i];
        const bars = h.buckets.map((b) =>
          '<div class="bar ' + b.state + '" title="' + b.date + ' — ' +
          (b.pct === null ? 'no data' : b.pct.toFixed(2) + '% of ' + b.total + ' checks') + '"></div>'
        ).join('');

        const tag = m.monitor.active
          ? '<span class="tag ' + m.state + '">' + m.state + '</span>'
          : '<span class="tag off">paused</span>';

        return '' +
          '<div class="card">' +
            '<div class="card-head">' +
              '<span class="dot ' + m.state + '" style="width:9px;height:9px;border-radius:50%;box-shadow:none"></span>' +
              '<span class="name">' + esc(m.monitor.name) + '</span>' +
              tag +
              '<a class="url" href="' + esc(m.monitor.url) + '" target="_blank" rel="noopener noreferrer">' + esc(m.monitor.url) + '</a>' +
              '<div class="right">' +
                '<span>90d <b>' + pct(m.uptime90d) + '</b></span>' +
                '<span>latency <b>' + fmtLatency(m.avgLatencyMs24h) + '</b></span>' +
                '<span>' + timeAgo(m.lastCheck && m.lastCheck.checkedAt) + '</span>' +
              '</div>' +
            '</div>' +
            '<div class="bars">' + bars + '</div>' +
            '<div class="bars-legend"><span>90 days ago</span><span>today</span></div>' +
            (m.openIncident
              ? '<div class="err" style="margin-top:9px">● open incident since ' + fmtDate(m.openIncident.startedAt) + ' — ' + esc(m.openIncident.reason) + '</div>'
              : '') +
          '</div>';
      }).join('');
    }

    // ---- incidents ----
    const inc = el('incidents');
    if (!summary.incidents.length) {
      inc.innerHTML = '<div class="empty">No incidents recorded. Nice.</div>';
    } else {
      inc.innerHTML = summary.incidents.map((i) => {
        const open = !i.resolvedAt;
        return '<div class="incident">' +
          '<span class="pin ' + (open ? 'open' : 'resolved') + '"></span>' +
          '<div class="body">' +
            '<div class="t">' + esc(i.monitorName) + ' — ' + (open ? 'ongoing' : 'resolved') + '</div>' +
            '<div class="m">' + fmtDate(i.startedAt) +
              (i.resolvedAt ? ' → ' + fmtDate(i.resolvedAt) : ' → now') +
              ' · ' + esc(i.reason) + '</div>' +
          '</div>' +
        '</div>';
      }).join('');
    }
  } catch (err) {
    if (seq !== renderSeq) return;
    el('bannerText').textContent = 'Cannot reach the Pulse API';
    el('bannerDot').className = 'dot down';
    console.error(err);
  }
}

load();
setInterval(load, 15000);
