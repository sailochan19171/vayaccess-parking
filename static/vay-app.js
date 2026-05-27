/* VAY ParkOps Control — API-driven (Flask backend).
 * Replaces the original in-memory demo data layer. Every view's content
 * comes from the Flask APIs; submits go to the DB. parkvision.js handles
 * the ANPR live feed / SRK-F206 reader / Admin enrollment separately.
 */

const state = {
  capacity:     120,
  vehicles:     [],   // active parking transactions
  transactions: [],   // closed transactions (for reports)
  audit:        [],
  devices:      [],
  tariffs:      [],
};
// Expose to parkvision.js (Reports / Exit-preview read from this).
// `function refreshAll()` declared below is automatically on `window` in this
// non-module script, so the Reports Refresh button can call it as
// window.refreshAll() — no manual wrapper needed (an earlier wrapper caused
// infinite recursion because the lambda overwrote the natural binding).
window.state = state;

const els = {};

document.addEventListener("DOMContentLoaded", async () => {
  cacheElements();
  bindEvents();
  els["report-date"].valueAsDate = new Date();
  await refreshAll();
  setInterval(refreshAll, 5000);   // keep all tabs live
});

function cacheElements() {
  document.querySelectorAll("[id]").forEach((el) => { els[el.id] = el; });
}

function bindEvents() {
  document.querySelectorAll(".nav-item").forEach((button) => {
    button.addEventListener("click", () => switchView(button.dataset.view));
  });
  els["seed-data"]?.addEventListener("click", refreshAll);
  els["vehicle-search"]?.addEventListener("input", renderVehicles);
  els["report-date"]?.addEventListener("change", renderReports);
  els["export-excel"]?.addEventListener("click", exportReportsExcel);
  els["export-pdf"]?.addEventListener("click", exportReportsPdf);
  els["entry-form"]?.addEventListener("submit", handleEntry);
  els["exit-form"]?.addEventListener("submit", handleExit);
  els["print-receipt"]?.addEventListener("click", () => toast("Receipt sent to printer queue."));
  els["add-tariff"]?.addEventListener("click", openTariffPrompt);
  els["save-settings"]?.addEventListener("click", saveSettings);
}

function switchView(view) {
  document.querySelectorAll(".nav-item").forEach((b) =>
    b.classList.toggle("active", b.dataset.view === view));
  document.querySelectorAll(".view").forEach((s) =>
    s.classList.toggle("active", s.id === view));
  if (els["view-title"]) els["view-title"].textContent = view[0].toUpperCase() + view.slice(1);
}

// ── Centralized refresh ───────────────────────────────────────────────────────
async function refreshAll() {
  try {
    const [settings, metrics, active, transactions, audit, devices, tariffs] =
      await Promise.all([
        fetchJSON('/api/settings'),
        fetchJSON('/api/dashboard_metrics'),
        fetchJSON('/api/active_vehicles'),
        fetchJSON('/api/transactions?limit=500'),
        fetchJSON('/api/audit?limit=80'),
        fetchJSON('/api/devices'),
        fetchJSON('/api/tariffs'),
      ]);
    state.capacity     = settings.capacity || metrics.capacity || 120;
    if (els["capacity-input"]) els["capacity-input"].value = state.capacity;
    state.vehicles     = active        || [];
    state.transactions = transactions  || [];
    state.audit        = audit         || [];
    state.devices      = devices       || [];
    state.tariffs      = tariffs       || [];
    render(metrics);
  } catch (err) {
    console.error('refreshAll failed', err);
  }
}

async function fetchJSON(url, opts = {}) {
  const r = await fetch(url, { headers: { 'Content-Type': 'application/json' },
                               cache: 'no-store', ...opts });
  if (!r.ok) {
    let msg = `HTTP ${r.status}`;
    try { const j = await r.json(); msg = j.message || j.error || msg; } catch {}
    throw new Error(msg);
  }
  return r.json();
}

// ── Renderers ────────────────────────────────────────────────────────────────
function render(metrics) {
  updateClock();
  renderMetrics(metrics);
  renderVehicles();
  renderActivity();
  renderTariffs();
  renderDevices();
  renderReports();
}

function renderMetrics(m) {
  if (!els["metric-occupancy"]) return;
  const occupied = m ? m.occupied  : state.vehicles.length;
  const cap      = m ? m.capacity  : state.capacity;
  const avail    = m ? m.available : Math.max(0, cap - occupied);
  const revenue  = m ? m.today_revenue
                     : state.transactions.reduce((s, x) => s + (x.total || 0), 0);
  const devs     = m ? m.active_devices
                     : state.devices.filter((d) => ["Online","Ready","Connected"].includes(d.status)).length;
  els["metric-occupancy"].textContent = `${occupied} / ${cap}`;
  els["metric-available"].textContent = avail;
  els["metric-revenue"].textContent   = formatCurrency(revenue);
  els["metric-devices"].textContent   = devs;
  if (els["occupancy-bar"])
    els["occupancy-bar"].style.width = `${Math.min(100, Math.round((occupied / cap) * 100))}%`;
}

function renderVehicles() {
  if (!els["active-vehicles"]) return;
  const term = (els["vehicle-search"]?.value || '').trim().toUpperCase();
  const vehicles = state.vehicles.filter((v) =>
    `${v.vehicle} ${v.identity} ${v.type} ${v.zone}`.toUpperCase().includes(term));
  els["active-vehicles"].innerHTML = vehicles.map((v) => `
    <tr>
      <td><strong>${v.vehicle}</strong><br><small>${v.zone}</small></td>
      <td>${v.type}</td>
      <td>${timeAgo(v.entryAt)}</td>
      <td>${v.mode}<br><small>${v.identity || ''}</small></td>
      <td><span class="status ${v.vip || v.staff ? "vip" : ""}">${v.staff ? "Staff Free" : v.vip ? "VIP" : "Parked"}</span></td>
    </tr>`).join("") || `<tr><td colspan="5" style="text-align:center; opacity:0.6; padding:14px;">No active vehicles.</td></tr>`;
}

function renderActivity() {
  if (!els["activity-feed"]) return;
  els["activity-count"].textContent = `${state.audit.length} events`;
  els["activity-feed"].innerHTML = state.audit.slice(0, 12).map((item) => `
    <div class="activity">
      <strong>${item.message}</strong>
      <span>${item.area} • ${timeAgo(item.at)}</span>
    </div>`).join("") || `<div class="activity"><span style="opacity:0.6;">No events yet.</span></div>`;
}

function renderTariffs() {
  if (!els["tariff-list"]) return;
  els["tariff-list"].innerHTML = state.tariffs.map((t) => `
    <div class="tariff">
      <strong>${t.type}</strong>
      <span>${t.model} • ${formatCurrency(t.rate)}/hour • Daily cap ${formatCurrency(t.dailyCap)} • Lost ticket ${formatCurrency(t.lost)}</span>
      <button class="ghost-button" data-tariff-del="${t.id}" style="padding: 4px 10px; font-size: 0.78em; margin-left: 10px;">Remove</button>
    </div>`).join("") || `<div class="tariff"><span style="opacity:0.6;">No tariffs defined.</span></div>`;
  // Bind remove buttons
  els["tariff-list"].querySelectorAll('[data-tariff-del]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!confirm(`Remove tariff?`)) return;
      try {
        await fetchJSON(`/api/tariffs/${btn.dataset.tariffDel}`, { method: 'DELETE' });
        toast('Tariff removed.');
        refreshAll();
      } catch (e) { toast(`✗ ${e.message}`); }
    });
  });
}

function renderDevices() {
  if (!els["device-list"]) return;
  els["device-list"].innerHTML = state.devices.map((d) => `
    <div class="device">
      <strong>${d.name}</strong>
      <span>${d.type} • ${d.status} • ${d.lastSeen}</span>
    </div>`).join("") || `<div class="device"><span style="opacity:0.6;">No devices reported.</span></div>`;
}

function renderReports() {
  if (!els["hourly-chart"]) return;
  const report = buildReportData();
  renderBarChart(els["hourly-chart"],  report.hourly.filter((it) => it.value > 0), "vehicles");
  renderBarChart(els["shift-chart"],   report.shifts,  "currency");
  renderBarChart(els["daily-chart"],   report.daily,   "currency");
  renderBarChart(els["monthly-chart"], report.monthly, "currency");
  renderBarChart(els["payment-chart"], report.payments,"currency");
  els["audit-list"].innerHTML = state.audit.slice(0, 30).map((item) => `
    <div class="audit">
      <strong>${item.message}</strong>
      <span>${item.area} • ${new Date(item.at).toLocaleString()}</span>
    </div>`).join("") || `<div class="audit"><span style="opacity:0.6;">No audit events.</span></div>`;
}

// ── Form handlers (POST to backend) ──────────────────────────────────────────
async function handleEntry(event) {
  event.preventDefault();
  const data = new FormData(event.currentTarget);
  const body = {
    vehicle:  String(data.get("vehicle") || '').toUpperCase(),
    type:     data.get("type") || 'Car',
    mode:     data.get("mode") || 'RFID/UHF',
    identity: String(data.get("identity") || '').toUpperCase(),
    zone:     data.get("zone") || 'Basement A',
    emp_name: data.get("emp_name") || '',
    vip:      data.get("vip")   === "on",
    staff:    data.get("staff") === "on",
  };
  try {
    const res = await fetchJSON('/api/entries', { method: 'POST', body: JSON.stringify(body) });
    if (els["gate-state"]) {
      els["gate-state"].textContent = "Opened";
      setTimeout(() => { els["gate-state"].textContent = "Ready"; }, 1400);
    }
    event.currentTarget.reset();
    const banner = document.getElementById('entry-prefill-banner');
    if (banner) banner.style.display = 'none';
    toast(`✓ ${res.transaction.vehicle} entered via ${res.transaction.mode}`);
    refreshAll();
  } catch (err) {
    toast(`✗ ${err.message}`);
  }
}

async function handleExit(event) {
  event.preventDefault();
  const data = new FormData(event.currentTarget);
  const body = {
    query: String(data.get("query") || '').trim().toUpperCase(),
    zone:  String(data.get("zone")  || '').trim(),
  };
  try {
    const res = await fetchJSON('/api/exits', { method: 'POST', body: JSON.stringify(body) });
    renderReceipt(res.transaction, res.duration);
    event.currentTarget.reset();
    // Re-disable submit until next valid match
    const btn = document.getElementById('exit-submit-btn');
    if (btn) btn.disabled = true;
    document.getElementById('exit-match-box').style.display = 'none';
    document.getElementById('exit-nomatch-box').style.display = 'none';
    toast(`✓ Exit closed for ${res.transaction.vehicle} (parked ${res.duration.hours}h)`);
    refreshAll();
  } catch (err) {
    toast(`✗ ${err.message}`);
  }
}

function renderReceipt(tx, duration) {
  if (!els["receipt-vehicle"]) return;
  els["receipt-vehicle"].textContent  = tx.vehicle;
  if (els["receipt-owner"])    els["receipt-owner"].textContent    = tx.owner || '—';
  if (els["receipt-zone"])     els["receipt-zone"].textContent     = tx.zone  || '—';
  if (els["receipt-duration"]) {
    const m = duration.elapsed_seconds ? Math.round(duration.elapsed_seconds / 60) : duration.hours * 60;
    els["receipt-duration"].textContent = m < 60 ? `${m}m` : `${Math.floor(m/60)}h ${m%60}m`;
  }
  if (els["receipt-exittime"]) {
    els["receipt-exittime"].textContent = tx.exitAt ? new Date(tx.exitAt).toLocaleString() : new Date().toLocaleString();
  }
}

// ── Add Tariff (prompt-based; real backend write) ────────────────────────────
async function openTariffPrompt() {
  const type = prompt("Vehicle type (e.g. Car, Bike, Van):");
  if (!type) return;
  const rate = parseInt(prompt("Rate (₹/hour):", "50"), 10);
  const cap  = parseInt(prompt("Daily cap (₹):", "300"), 10);
  const lost = parseInt(prompt("Lost-ticket charge (₹):", "300"), 10);
  if ([rate, cap, lost].some(Number.isNaN)) {
    toast('Cancelled — non-numeric values.');
    return;
  }
  try {
    await fetchJSON('/api/tariffs', { method: 'POST',
      body: JSON.stringify({ vehicle_type: type, model: 'Hourly',
                              rate, daily_cap: cap, lost }) });
    toast(`Tariff saved for ${type}.`);
    refreshAll();
  } catch (e) { toast(`✗ ${e.message}`); }
}

// ── Facility settings save ───────────────────────────────────────────────────
async function saveSettings() {
  const capacity = parseInt(els["capacity-input"]?.value || '120', 10) || 120;
  try {
    await fetchJSON('/api/settings', { method: 'POST',
      body: JSON.stringify({ capacity }) });
    toast('Settings saved.');
    refreshAll();
  } catch (e) { toast(`✗ ${e.message}`); }
}

// ── Reports (computed locally from real /api/transactions) ───────────────────
function buildReportData() {
  const selectedDate = els["report-date"]?.value
    ? new Date(`${els["report-date"].value}T00:00:00`)
    : new Date();
  const dayStart = startOfDay(selectedDate).getTime();
  const dayEnd   = dayStart + 86_400_000;
  const inDay = (t) => t >= dayStart && t < dayEnd;
  const todayTxs = state.transactions.filter((t) => inDay(t.exitAt || t.entryAt));
  const todayVs  = state.vehicles    .filter((v) => inDay(v.entryAt));

  const hourly = Array.from({ length: 24 }, (_, h) =>
    ({ label: `${String(h).padStart(2,'0')}:00`, value: 0 }));
  [...todayVs, ...todayTxs].forEach((it) => {
    const ts = it.entryAt || it.exitAt;
    if (ts) hourly[new Date(ts).getHours()].value += 1;
  });

  const shifts = [
    { label: 'Morning', value: 0, range: [6, 14] },
    { label: 'Evening', value: 0, range: [14, 22] },
    { label: 'Night',   value: 0, range: [22, 30] },
  ];
  todayTxs.forEach((t) => {
    const h = new Date(t.exitAt || t.entryAt).getHours();
    const n = h < 6 ? h + 24 : h;
    const s = shifts.find((x) => n >= x.range[0] && n < x.range[1]);
    if (s) s.value += t.total || 0;
  });

  const daily = lastNDays(7).map((d) => ({
    label: d.toLocaleDateString([], { weekday: 'short', day: '2-digit' }),
    value: sumTxs(startOfDay(d).getTime(), startOfDay(d).getTime() + 86_400_000),
  }));
  const monthly = lastNMonths(6).map((d) => {
    const s = new Date(d.getFullYear(), d.getMonth(),     1).getTime();
    const e = new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime();
    return { label: d.toLocaleDateString([], { month: 'short', year: '2-digit' }),
             value: sumTxs(s, e) };
  });
  const payments = Object.entries(
    todayTxs.reduce((a, t) => { a[t.payment || 'Other'] = (a[t.payment || 'Other'] || 0) + (t.total || 0); return a; }, {})
  ).map(([label, value]) => ({ label, value }));
  return {
    dateLabel: selectedDate.toLocaleDateString(),
    hourly, shifts: shifts.map(({label,value}) => ({label,value})),
    daily, monthly, payments,
  };
}
function sumTxs(s, e) {
  return state.transactions
    .filter((t) => (t.exitAt || t.entryAt) >= s && (t.exitAt || t.entryAt) < e)
    .reduce((sum, t) => sum + (t.total || 0), 0);
}

function renderBarChart(target, rows, format) {
  const visible = rows.length ? rows : [{ label: 'No data', value: 0 }];
  const max = Math.max(1, ...visible.map((it) => it.value));
  target.innerHTML = visible.map((it) => `
    <div class="bar-row">
      <strong>${it.label}</strong>
      <span class="bar-track"><i style="width:${it.value ? (it.value / max) * 100 : 0}%"></i></span>
      <span>${format === 'currency' ? formatCurrency(it.value) : it.value}</span>
    </div>`).join('');
}

// ── Real exports of the live Reports view (metrics, breakdowns, transactions)
function _buildReportExport() {
  const month = document.getElementById('rpt-month')?.value || '';
  const typeF = document.getElementById('rpt-type-filter')?.value || '';
  const zoneF = document.getElementById('rpt-zone-filter')?.value || '';
  const inMonth = (ms) => {
    if (!month || !ms) return !month;
    const d = new Date(ms);
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}` === month;
  };
  const matchFilter = (t) => (!typeF || t.type === typeF) && (!zoneF || t.zone === zoneF);
  const closed = state.transactions.filter(t => inMonth(t.exitAt || t.entryAt) && matchFilter(t));
  const active = state.vehicles.filter(matchFilter);
  const all    = [...active, ...closed];
  const totalVehicles = new Set(all.map(t => t.vehicle)).size;
  const stayMs = all.filter(t => t.entryAt).map(t => (t.exitAt || Date.now()) - t.entryAt);
  const avgMin = stayMs.length ? Math.round(stayMs.reduce((a,b)=>a+b,0) / stayMs.length / 60000) : 0;
  const byType = {}, byVeh = {}, byZone = {};
  all.forEach(t => {
    byType[t.type || 'Other'] = (byType[t.type || 'Other'] || 0) + 1;
    byVeh [t.vehicle]         = (byVeh [t.vehicle]         || 0) + 1;
    byZone[t.zone || 'Unknown'] = (byZone[t.zone || 'Unknown'] || 0) + 1;
  });
  const topVehicles = Object.entries(byVeh).sort(([,a],[,b]) => b - a).slice(0, 20);
  return { month: month || '(all months)', typeF: typeF || '(all types)', zoneF: zoneF || '(all zones)',
           totalVehicles, active, closed, all, avgMin, byType, topVehicles, byZone };
}

function _renderExportHtml(r) {
  const fmtDT  = (ms) => ms ? new Date(ms).toLocaleString() : '';
  const fmtDur = (a, b) => {
    if (!a) return '';
    const m = Math.max(0, Math.round(((b || Date.now()) - a) / 60000));
    return m < 60 ? `${m}m` : `${Math.floor(m/60)}h ${m%60}m`;
  };
  const avgLabel = r.avgMin < 60 ? `${r.avgMin}m` : `${Math.floor(r.avgMin/60)}h ${r.avgMin%60}m`;

  // Helper that emits a clean tabular section. Each table is its own block —
  // when opened in Excel, each ends up on its own logical row range with a
  // bold header row. No HTML decoration that Excel would render weirdly.
  const tbl = (title, headers, rows) => `
    <h2>${escapeHtml(title)}</h2>
    <table>
      <thead><tr>${headers.map(h => `<th>${escapeHtml(h)}</th>`).join('')}</tr></thead>
      <tbody>${rows.length
        ? rows.map(row => `<tr>${row.map(c => `<td>${c}</td>`).join('')}</tr>`).join('')
        : `<tr><td colspan="${headers.length}" style="text-align:center;">No data.</td></tr>`}</tbody>
    </table>`;

  return `
    <h1>VayAccess Systems &mdash; Parking Activity Report</h1>
    <table>
      <tr><th>Generated</th><td>${escapeHtml(new Date().toLocaleString())}</td></tr>
      <tr><th>Month filter</th><td>${escapeHtml(r.month)}</td></tr>
      <tr><th>Vehicle type filter</th><td>${escapeHtml(r.typeF)}</td></tr>
      <tr><th>Zone filter</th><td>${escapeHtml(r.zoneF)}</td></tr>
    </table>

    ${tbl('Summary Metrics',
       ['Metric', 'Value'],
       [
         ['Total Vehicles',    r.totalVehicles],
         ['Currently Parked',  r.active.length],
         ['Exited',            r.closed.length],
         ['Avg Stay Duration', avgLabel],
       ])}

    ${tbl('Vehicle Type Distribution',
       ['Vehicle Type', 'Total Visits'],
       Object.entries(r.byType).map(([t,c]) => [escapeHtml(t), c]))}

    ${tbl('Top Vehicles by Visits',
       ['Vehicle Plate', 'Visit Count'],
       r.topVehicles.map(([v,c]) => [escapeHtml(v), c]))}

    ${tbl('Zone-wise Performance',
       ['Zone', 'Total Visits'],
       Object.entries(r.byZone).map(([z,c]) => [escapeHtml(z), c]))}

    ${tbl('Currently Parked Vehicles',
       ['Vehicle Plate', 'Vehicle Type', 'Employee', 'Zone', 'Entry Time', 'Duration'],
       r.active.map(v => [
         escapeHtml(v.vehicle),
         escapeHtml(v.type || ''),
         escapeHtml(v.owner || ''),
         escapeHtml(v.zone || ''),
         fmtDT(v.entryAt),
         fmtDur(v.entryAt, null),
       ]))}

    ${tbl('Closed Parking Sessions',
       ['Vehicle Plate', 'Vehicle Type', 'Employee', 'Zone', 'Mode', 'Identity (Tag/Ticket)',
        'Entry Time', 'Exit Time', 'Duration'],
       r.closed.slice(0, 500).map(t => [
         escapeHtml(t.vehicle),
         escapeHtml(t.type || ''),
         escapeHtml(t.owner || ''),
         escapeHtml(t.zone || ''),
         escapeHtml(t.mode || ''),
         escapeHtml(t.identity || ''),
         fmtDT(t.entryAt),
         fmtDT(t.exitAt),
         fmtDur(t.entryAt, t.exitAt),
       ]))}`;
}

function exportReportsExcel() {
  const r = _buildReportExport();
  // xmlns:o + ProgId hint Excel that this is a workbook, so each <table>
  // becomes its own contiguous cell range (rows/columns are preserved cleanly).
  const html = `<?xml version="1.0"?>
<html xmlns:o="urn:schemas-microsoft-com:office:office"
      xmlns:x="urn:schemas-microsoft-com:office:excel"
      xmlns="http://www.w3.org/TR/REC-html40">
  <head>
    <meta charset="utf-8">
    <meta name="ProgId" content="Excel.Sheet">
    <meta name="Generator" content="VayAccess Systems">
    <style>
      body { font-family: Calibri, sans-serif; }
      h1   { font-size: 16pt; color: #127c72; margin: 0 0 12px; }
      h2   { font-size: 12pt; color: #127c72; margin: 18px 0 4px; }
      table { border-collapse: collapse; margin-bottom: 8px; font-size: 11pt; }
      th    { background: #127c72; color: #fff; padding: 6px 10px;
              border: 1px solid #0a5e58; text-align: left; font-weight: bold; }
      td    { padding: 5px 10px; border: 1px solid #c0d0c0; vertical-align: top; }
    </style>
  </head>
  <body>${_renderExportHtml(r)}</body>
</html>`;
  downloadFile(`vayaccess-${fileDate()}.xls`, 'application/vnd.ms-excel', html);
  toast(`✓ Excel exported · ${r.totalVehicles} vehicles · ${r.closed.length} closed`);
}

function exportReportsPdf() {
  const r = _buildReportExport();
  const w = window.open('', '_blank');
  if (!w) { toast('Please allow popups to export PDF.'); return; }
  w.document.write(`
    <!doctype html><html><head>
      <title>VayAccess Systems Reports · ${fileDate()}</title>
      <style>
        body{font-family:Inter,Segoe UI,sans-serif; padding:24px;}
        h1,h2{color:#127c72;}
        table{border-collapse:collapse; width:100%; margin-bottom:18px; font-size:12px;}
        th,td{border:1px solid #c0d0c0; padding:6px 8px; text-align:left;}
        thead tr{background:#127c72; color:#fff;}
        @media print { @page { size: landscape; margin: 12mm; } }
      </style>
    </head><body>
      ${_renderExportHtml(r)}
      <script>setTimeout(() => window.print(), 400);<\/script>
    </body></html>`);
  w.document.close();
  toast('✓ PDF print dialog opened');
}

// ── Utils ────────────────────────────────────────────────────────────────────
function updateClock() {
  if (els["clock"]) els["clock"].textContent = new Date().toLocaleString();
}
function toast(msg) {
  const t = els["toast"]; if (!t) return;
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toast._h);
  toast._h = setTimeout(() => t.classList.remove('show'), 3200);
}
function formatCurrency(v) { return `₹${Number(v||0).toLocaleString('en-IN')}`; }
function timeAgo(ts) {
  if (!ts) return '—';
  const d = Date.now() - ts;
  if (d < 60_000)    return `${Math.round(d/1000)}s ago`;
  if (d < 3_600_000) return `${Math.round(d/60_000)}m ago`;
  if (d < 86_400_000)return `${Math.round(d/3_600_000)}h ago`;
  return `${Math.round(d/86_400_000)}d ago`;
}
function startOfDay(d) { const x = new Date(d); x.setHours(0,0,0,0); return x; }
function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate()+n); return x; }
function lastNDays(n)  { return Array.from({length:n}, (_,i)=>addDays(startOfDay(new Date()), -(n-1-i))); }
function lastNMonths(n){ return Array.from({length:n}, (_,i)=>{const d=new Date(); d.setMonth(d.getMonth()-(n-1-i)); d.setDate(1); return d; }); }
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function fileDate()    { return new Date().toISOString().slice(0,10); }
function downloadFile(name, type, content) {
  const blob = new Blob([content], { type }); const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
