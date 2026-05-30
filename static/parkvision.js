/* ParkVision Pro · VAY ParkOps integration
 * Drives view switching + live data binding for Dashboard, Devices, Admin.
 * Entry/Exit/Tariffs/Reports are scaffolded placeholders for now.
 */

const $ = (id) => document.getElementById(id);

// ── View switching (sidebar nav) ─────────────────────────────────────────────
function switchView(name) {
  document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.id === name));
  document.querySelectorAll('.nav-item').forEach(b => b.classList.toggle('active',
                                                                        b.dataset.view === name));
  // Labels match the WeParking sidebar from VAY Parking Management.pdf.
  const titleMap = {
    dashboard: 'Home Page',          reports: 'Statistical Management',
    video: 'Video Monitoring',       'parking-records': 'Parking Records',
    'scanning-record': 'Scanning Record', devices: 'Lane Monitoring',
    exit: 'Manual Exit Record',      orders: 'Order Management',
    admin: 'Whitelist',              registered: 'Registered Vehicle',
    blacklist: 'Black List',         yard: 'Yard Management',
    region: 'Region Management',     entry: 'Entry', tariffs: 'Tariffs',
    membership: 'Monthly Membership', 'type-mgmt': 'Type Management',
    visitors: 'Visitor Management',  equipment: 'Equipment Management',
    'settings-basic': 'Basic Settings', 'settings-entry-exit': 'Entry / Exit Settings',
    account: 'Account Management',   lcd: 'LCD Display',
    'menu-mgmt': 'Menu Management',  role: 'Role Management',
    'role-perm': 'Role Permission',  dictionary: 'Dictionary Managed',
  };
  $('view-title').textContent = titleMap[name] || 'Home Page';
}

// ── Sidebar expandable groups (Parking Inquiry, etc.) ────────────────────────
// A .nav-group toggles the .nav-sub block that follows it. Clicking a group
// header expands/collapses; it does NOT switch a view (groups have no data-view).
document.querySelectorAll('.nav-group').forEach(group => {
  group.addEventListener('click', () => {
    const key  = group.dataset.group;
    const body = document.querySelector(`[data-group-body="${key}"]`);
    const open = group.getAttribute('aria-expanded') === 'true';
    group.setAttribute('aria-expanded', String(!open));
    if (body) body.classList.toggle('open', !open);
  });
});
// Scroll to top of the page whenever the user lands on a new view —
// applies to sidebar nav clicks AND in-content "jump" buttons.
function scrollMainToTop() {
  const main = document.querySelector('main');
  // Scroll both the main element and the window — covers both layouts where
  // main is the scroll container, and where the body scrolls instead.
  if (main && typeof main.scrollTo === 'function') main.scrollTo({ top: 0, behavior: 'auto' });
  if (typeof window.scrollTo === 'function')        window.scrollTo({ top: 0, behavior: 'auto' });
}
// Some browsers (Firefox, Chrome) preserve scroll position across page
// reloads — force the page to start at the top on every load / refresh.
if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
window.addEventListener('load', () => scrollMainToTop());
window.addEventListener('beforeunload', () => scrollMainToTop());
document.querySelectorAll('.nav-item').forEach(btn => {
  btn.addEventListener('click', () => {
    // Group headers (Parking Inquiry) only expand/collapse — they have no
    // data-view, so don't try to switch to an undefined view (that would
    // blank the page).
    if (!btn.dataset.view) return;
    switchView(btn.dataset.view);
    scrollMainToTop();
  });
});
// In-content "jump" buttons (e.g. "+ Activate New Tag →")
document.querySelectorAll('[data-jump]').forEach(el => {
  el.addEventListener('click', (e) => {
    e.preventDefault();
    switchView(el.dataset.jump);
    scrollMainToTop();
  });
});

// ── Clock ────────────────────────────────────────────────────────────────────
function tickClock() {
  const d = new Date();
  $('clock').textContent = d.toLocaleString();
}
setInterval(tickClock, 1000); tickClock();

// ── Toast ────────────────────────────────────────────────────────────────────
function toast(msg, kind = 'ok', ms = 3000) {
  const el = $('toast');
  el.textContent = msg;
  el.dataset.kind = kind;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), ms);
}

// ─────────────────────────────────────────────────────────────────────────────
// DASHBOARD — live ANPR feed + current scan + access log + vehicles table
// ─────────────────────────────────────────────────────────────────────────────

// Reload the JPEG frame as fast as the previous one decodes (no MJPEG, smoother)
const streamImg = $('anpr-stream');
function loadNextFrame() {
  const next = new Image();
  next.onload  = () => { streamImg.src = next.src; setTimeout(loadNextFrame, 60); };
  next.onerror = () => setTimeout(loadNextFrame, 500);
  next.src = `/api/latest_frame.jpg?t=${Date.now()}`;
}
loadNextFrame();

// Track which plate we last pre-filled into the Entry form, so the same
// vehicle sitting at the gate doesn't keep overwriting the operator's edits.
let lastGrantedPlate = '';

// Auto-exit alert: fires once per (plate|tag) when ANPR/UHF re-detects a
// vehicle that's been parked long enough and the backend auto-closes its
// session. Green banner confirms the exit happened.
let lastAutoExitAlertKey = '';
function showAutoExitAlertIfNeeded(s, status) {
  const banner = document.getElementById('dash-autoexit-alert');
  if (!banner) return;
  const isAutoExit = status.includes('AUTO-EXITED');
  const key = `${s.latest_plate}|${s.latest_tag}`;
  if (isAutoExit && key !== lastAutoExitAlertKey) {
    lastAutoExitAlertKey = key;
    document.getElementById('dash-autoexit-name').textContent =
      (s.owner && s.owner !== 'N/A') ? s.owner : 'Vehicle';
    document.getElementById('dash-autoexit-id').textContent =
      (s.latest_plate && s.latest_plate !== 'Waiting...') ? s.latest_plate :
      (s.latest_tag && s.latest_tag !== 'Waiting...') ? s.latest_tag : '—';
    banner.style.display = 'flex';
    // Auto-hide after 8s — it's positive info, not blocking
    setTimeout(() => { banner.style.display = 'none'; }, 8000);
  } else if (!isAutoExit && !status.includes('DENIED') && !status.includes('GRANTED')) {
    lastAutoExitAlertKey = '';
  }
}
document.getElementById('dash-autoexit-dismiss')?.addEventListener('click', () => {
  const banner = document.getElementById('dash-autoexit-alert');
  if (banner) banner.style.display = 'none';
});

// "Already inside" alert was removed — every re-scan now auto-exits via
// check_access(), so there's no in-between state to surface.

// Track expired-alert state — fires once per (plate|tag) so the operator
// isn't spammed while the same expired vehicle sits at the gate.
let lastExpiredAlertKey = '';
function showExpiredAlertIfNeeded(s, status) {
  const banner = document.getElementById('dash-expired-alert');
  if (!banner) return;
  const isExpired = status.includes('EXPIRED');
  const key = `${s.latest_plate}|${s.latest_tag}`;
  if (isExpired && key !== lastExpiredAlertKey) {
    lastExpiredAlertKey = key;
    document.getElementById('dash-expired-name').textContent =
      (s.owner && s.owner !== 'N/A') ? s.owner : 'Unknown';
    document.getElementById('dash-expired-tag').textContent =
      (s.latest_tag && s.latest_tag !== 'Waiting...') ? s.latest_tag :
      (s.latest_plate && s.latest_plate !== 'Waiting...') ? s.latest_plate : '—';
    banner.style.display = 'flex';
  } else if (!isExpired && !status.includes('DENIED') && !status.includes('GRANTED')) {
    // Reset when scene goes back to idle, so next expired scan fires again
    lastExpiredAlertKey = '';
  }
}

document.getElementById('dash-expired-dismiss')?.addEventListener('click', () => {
  const banner = document.getElementById('dash-expired-alert');
  if (banner) banner.style.display = 'none';
});

// Map ANPR vehicle_type / category to the Entry form's <select> options.
// System supports two vehicle types only: Car | Bike (everything else collapses).
function mapEntryVehicleType(vt, vc) {
  if (!vt) return 'Car';
  const v = String(vt).toLowerCase();
  if (v.includes('bike') || v.includes('moto') || v.includes('scoot')) return 'Bike';
  if (vc && String(vc).toLowerCase().includes('two')) return 'Bike';
  // Trucks, buses, EVs, vans — all bucketed as Car for tariff/reporting
  return 'Car';
}

// Auto-fill the Entry form when a vehicle is approved at the gate. Runs
// once per *new* granted plate (guarded by lastGrantedPlate). Does NOT
// switch the active view — operator can finish what they're doing.
function prefillEntryFromGrant(s) {
  const form = document.getElementById('entry-form');
  if (!form) return;
  const plate = (s.latest_plate || '').trim();
  const tag   = (s.latest_tag   || '').trim();
  form.elements.vehicle.value  = plate;
  form.elements.type.value     = mapEntryVehicleType(s.vehicle_type, s.vehicle_category);
  if (form.elements.emp_name) form.elements.emp_name.value = s.owner || '';
  // Prefer RFID/UHF if we have a tag, else fall back to ANPR.
  const hasTag = tag && tag !== 'Waiting...';
  form.elements.mode.value     = hasTag ? 'RFID/UHF' : 'ANPR';
  form.elements.identity.value = hasTag ? tag : `ANPR-${plate}`;
  // Whitelist checkbox — vehicle is in the DB, so flag it
  if (form.elements.vip) form.elements.vip.checked = true;

  const banner = document.getElementById('entry-prefill-banner');
  if (banner) {
    document.getElementById('entry-prefill-name').textContent = s.owner || plate;
    banner.style.display = 'block';
  }
  toast(`✓ Entry pre-filled for ${s.owner || plate}`, 'ok');
}

async function pollState() {
  try {
    const r = await fetch('/api/state', { cache: 'no-store' });
    const s = await r.json();
    $('scan-plate').textContent = s.latest_plate || 'Waiting…';
    $('scan-tag').textContent   = s.latest_tag   || 'Waiting…';
    $('scan-owner').textContent = s.owner        || 'N/A';
    if ($('scan-dept'))    $('scan-dept').textContent    = s.department     || '—';
    if ($('scan-contact')) $('scan-contact').textContent = s.contact_number || '—';
    $('scan-vtype').textContent = (s.vehicle_type || 'N/A') +
                                  (s.vehicle_category ? ' · ' + s.vehicle_category : '');
    $('scan-conf').textContent  = (s.plate_confidence ?? 0) + '%';

    const status = (s.status || 'Scanning').toUpperCase();
    const badge  = $('scan-status');
    badge.textContent = status;
    badge.className   = 'scan-status-badge ' +
      (status.includes('GRANTED') ? 'granted' :
       status.includes('DENIED')  ? 'denied'  : 'scanning');

    const stage = s.detection_stage || 'idle';
    const isScanning = stage === 'reading' || stage === 'vehicle_found';
    $('anpr-dot').classList.toggle('scanning', isScanning);
    $('anpr-dot-label').textContent = isScanning ?
      (stage === 'reading' ? 'READING PLATE' : 'TRACKING') : 'ACTIVE';
    $('anpr-status').textContent = isScanning ? 'Scanning' : 'Idle';

    // ── Auto-fill Entry form on a NEW granted scan ──────────────────────
    const plate = (s.latest_plate || '').trim();
    if (status.includes('GRANTED') && plate && plate !== 'Waiting...' &&
        plate !== lastGrantedPlate) {
      lastGrantedPlate = plate;
      prefillEntryFromGrant(s);
    } else if (!status.includes('GRANTED') && !status.includes('DENIED')) {
      // Status went back to idle/scanning — allow next grant to refill
      lastGrantedPlate = '';
    }

    // ── Expired-tag + auto-exit alerts on Dashboard ─────────────────────
    showExpiredAlertIfNeeded(s, status);
    showAutoExitAlertIfNeeded(s, status);
  } catch (e) {
    $('anpr-status').textContent = 'API offline';
  }
}
setInterval(pollState, 1000); pollState();

async function pollLogs() {
  try {
    const r  = await fetch('/api/logs', { cache: 'no-store' });
    const js = await r.json();
    if (!Array.isArray(js)) return;
    $('log-count').textContent = `${js.length} events`;
    const tb = $('access-log-body');
    if (!js.length) {
      tb.innerHTML = `<tr><td colspan="6" style="text-align:center; opacity:0.6; padding:20px;">No access events yet</td></tr>`;
      return;
    }
    tb.innerHTML = js.slice(0, 20).map(l => `
      <tr>
        <td style="font-size:0.85em; opacity:0.85;">${l.timestamp || '—'}</td>
        <td style="font-family:monospace;">${l.number_plate || '—'}</td>
        <td style="font-family:monospace; font-size:0.85em;">${l.rfid_tag || '—'}</td>
        <td>${l.owner_name || '—'}</td>
        <td>${l.department || '—'}</td>
        <td><span class="scan-status-badge ${
          (l.status || '').includes('GRANTED') ? 'granted' :
          (l.status || '').includes('DENIED')  ? 'denied'  : 'scanning'}">${l.status || '—'}</span></td>
      </tr>`).join('');
  } catch (e) { /* swallow */ }
}
setInterval(pollLogs, 3000); pollLogs();

async function pollVehicles() {
  try {
    const r  = await fetch('/api/whitelist', { cache: 'no-store' });
    const js = await r.json();
    if (!Array.isArray(js)) return;
    const tb = $('vehicles-body');
    if (!js.length) {
      tb.innerHTML = `<tr><td colspan="4" style="text-align:center; opacity:0.6; padding:20px;">No vehicles registered yet.</td></tr>`;
      return;
    }
    tb.innerHTML = js.map(v => `
      <tr>
        <td style="font-family:monospace;">${v.number_plate || '—'}</td>
        <td>${v.owner_name || '—'}</td>
        <td style="font-family:monospace; font-size:0.85em;">${v.rfid_tag || '—'}</td>
        <td>${v.valid_until || '—'}</td>
      </tr>`).join('');
  } catch (e) { /* swallow */ }
}
setInterval(pollVehicles, 5000); pollVehicles();


// ─────────────────────────────────────────────────────────────────────────────
// DEVICES — hardware status
// ─────────────────────────────────────────────────────────────────────────────
async function pollDevices() {
  try {
    const [srk, state, cfg, activity] = await Promise.all([
      fetch('/api/desktop_reader/status').then(r => r.json()),
      fetch('/api/state').then(r => r.json()),
      fetch('/api/config').then(r => r.json()),
      fetch('/api/devices_activity').then(r => r.json()),
    ]);

    const srkOk = (srk.status || '').toLowerCase().startsWith('connected');
    $('dev-srk-state').textContent = srk.status || '—';
    $('dev-srk-state').className   = srkOk ? 'device-state-ok' : 'device-state-err';
    $('dev-srk-port').textContent  = srk.port || 'auto';
    $('dev-srk-baud').textContent  = srk.baudrate || '115200';
    $('dev-srk-proto').textContent = srk.active_protocol || '—';
    $('dev-srk-tag').textContent   = srk.latest_tag || 'none';

    const gateOk = (state.reader_status || '').toLowerCase() === 'connected';
    $('dev-gate-state').textContent = state.reader_status || '—';
    $('dev-gate-state').className   = gateOk ? 'device-state-ok' : 'device-state-err';
    $('dev-gate-tag').textContent   = state.latest_tag && state.latest_tag !== 'Waiting...'
                                        ? state.latest_tag : 'none';

    const camActive = !!cfg.camera_source;
    $('dev-cam-state').textContent = camActive ? 'Configured' : 'No source set';
    $('dev-cam-state').className   = camActive ? 'device-state-ok' : 'device-state-err';
    $('dev-cam-src').textContent   = cfg.camera_source || '—';
    if (cfg.camera_source && !$('camera-source-input').value) {
      $('camera-source-input').value = cfg.camera_source;
    }

    // Per-device traffic (today + 7-day + last seen). Activity is keyed by
    // the `mode` field on ParkingTransaction.
    const fillActivity = (prefix, mode) => {
      const a = activity[mode] || { entries_today: 0, exits_today: 0, active_now: 0,
                                     entries_7days: 0, last_activity: null };
      const e = $(`${prefix}-entries`); if (e) e.textContent = a.entries_today;
      const x = $(`${prefix}-exits`);   if (x) x.textContent = a.exits_today;
      const c = $(`${prefix}-active`);  if (c) c.textContent = a.active_now;
      const w = $(`${prefix}-week`);    if (w) w.textContent = a.entries_7days;
      const l = $(`${prefix}-last`);    if (l) l.textContent = a.last_activity || '—';
    };
    fillActivity('dev-gate', 'RFID/UHF');
    fillActivity('dev-cam',  'ANPR');
    fillActivity('dev-man',  'Manual Ticket');
  } catch (e) { /* swallow */ }
}
setInterval(pollDevices, 4000); pollDevices();
$('poll-devices').addEventListener('click', pollDevices);

// ── Default Entry Zone (Devices tab) — controls zone tagged on auto-entries
async function loadDefaultZone() {
  try {
    const cfg = await (await fetch('/api/settings', { cache: 'no-store' })).json();
    const sel = document.getElementById('default-zone-select');
    const cur = document.getElementById('default-zone-current');
    if (sel && cfg.default_entry_zone) {
      sel.value = cfg.default_entry_zone;
      // Add option if not already present (e.g. custom zone)
      if (sel.value !== cfg.default_entry_zone) {
        const opt = document.createElement('option');
        opt.value = cfg.default_entry_zone; opt.textContent = cfg.default_entry_zone;
        sel.appendChild(opt);
        sel.value = cfg.default_entry_zone;
      }
    }
    if (cur) cur.innerHTML = `Currently: <b>${cfg.default_entry_zone || '—'}</b>`;
  } catch (e) { /* swallow */ }
}
document.getElementById('default-zone-save')?.addEventListener('click', async () => {
  const sel = document.getElementById('default-zone-select');
  if (!sel) return;
  try {
    const r = await fetch('/api/settings', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ default_entry_zone: sel.value }),
    });
    if (r.ok) {
      toast(`✓ Default entry zone set to "${sel.value}". Future auto-entries will use this.`, 'ok');
      loadDefaultZone();
    } else {
      const js = await r.json();
      toast(`✗ ${js.message || 'Failed to save'}`, 'err');
    }
  } catch (err) { toast(`✗ ${err.message}`, 'err'); }
});
loadDefaultZone();
setInterval(loadDefaultZone, 10000);

$('camera-cfg-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const source = $('camera-source-input').value.trim();
  if (!source) return;
  try {
    const r = await fetch('/api/config', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ camera_source: source }),
    });
    const js = await r.json();
    if (r.ok && js.status === 'success') toast('✓ Camera source saved', 'ok');
    else                                  toast('✗ ' + (js.message || 'Failed'), 'err');
    pollDevices();
  } catch (err) { toast('Network error: ' + err.message, 'err'); }
});


// ─────────────────────────────────────────────────────────────────────────────
// ADMIN — Employee enrollment via SRK-F206
// ─────────────────────────────────────────────────────────────────────────────
function fmtDate(d) { return d.toISOString().slice(0, 10); }
function recalcValidity() {
  const months = parseInt($('emp-months').value || '12', 10);
  const now = new Date();
  const valid = new Date(now); valid.setMonth(valid.getMonth() + months);
  $('emp-actdate').value     = fmtDate(now);
  $('emp-validuntil').value  = fmtDate(valid);
}
$('emp-months').addEventListener('change', recalcValidity);
recalcValidity();

// Mirror the server-side regex so we don't enable the button for inputs the
// backend will reject. Same patterns as in templates/activate.html.
const EMP_UPI_RE = /^[a-zA-Z0-9._\-]{2,256}@[a-zA-Z][a-zA-Z0-9.\-]{1,64}$/;
const EMP_TXN_RE = /^[A-Za-z0-9]{8,30}$/;

// Cash skips the UPI fields entirely (no VPA, no provider txn ID to capture).
// Anything else in this set is a UPI provider and requires both.
const UPI_PAYMENT_METHODS = new Set([
  'PhonePe', 'Paytm', 'Google Pay', 'BHIM', 'Amazon Pay', 'Other UPI'
]);

function syncUpiVisibility() {
  const method = $('emp-pay-method') ? $('emp-pay-method').value : '';
  const wrap   = $('upi-fields');
  if (!wrap) return;
  const upiInput = $('emp-pay-upi');
  const txnInput = $('emp-pay-txn');
  if (UPI_PAYMENT_METHODS.has(method)) {
    wrap.style.display = '';
    if (upiInput) { upiInput.required = true;  upiInput.disabled = false; }
    if (txnInput) { txnInput.required = true;  txnInput.disabled = false; }
  } else {
    // Cash (or unselected) — hide the UPI block and disable+blank the inputs so
    // (a) the form's required-validity doesn't gate on hidden fields, and
    // (b) stale values from a previous UPI selection don't get submitted.
    wrap.style.display = 'none';
    if (upiInput) { upiInput.required = false; upiInput.disabled = true;  upiInput.value = ''; }
    if (txnInput) { txnInput.required = false; txnInput.disabled = true;  txnInput.value = ''; }
  }
}

function setSubmitState() {
  const hasTag = !!$('emp-tag').value.trim();
  const method = $('emp-pay-method') ? $('emp-pay-method').value : '';
  const amount = $('emp-pay-amount') ? parseInt($('emp-pay-amount').value, 10) : 0;
  if (!method || !(amount > 0)) {
    $('emp-submit').disabled = !hasTag || true;
    return;
  }
  let payOk;
  if (UPI_PAYMENT_METHODS.has(method)) {
    const upi = $('emp-pay-upi') ? $('emp-pay-upi').value.trim() : '';
    const txn = $('emp-pay-txn') ? $('emp-pay-txn').value.trim() : '';
    payOk = EMP_UPI_RE.test(upi) && EMP_TXN_RE.test(txn);
  } else {
    // Cash — amount alone is sufficient.
    payOk = true;
  }
  $('emp-submit').disabled = !(hasTag && payOk);
}

// Re-check button state + UPI visibility whenever any payment field changes.
['emp-pay-method', 'emp-pay-amount', 'emp-pay-upi', 'emp-pay-txn'].forEach(id => {
  const el = $(id);
  if (!el) return;
  el.addEventListener('input',  () => { syncUpiVisibility(); setSubmitState(); });
  el.addEventListener('change', () => { syncUpiVisibility(); setSubmitState(); });
});
// Run once on load so an unselected method already hides the UPI block.
syncUpiVisibility();

function clearEmpForm() {
  $('emp-name').value    = '';
  $('emp-dept').value    = '';
  $('emp-contact').value = '';
  $('emp-plate').value   = '';
  $('emp-vtype').value   = 'Car';
  $('emp-months').value  = '12';
  recalcValidity();
}

let lastLookedUpTag = '';
async function lookupAndPrefill(tag) {
  try {
    const r = await fetch(`/api/employees/by_tag/${encodeURIComponent(tag)}`,
                          { cache: 'no-store' });
    if (r.status === 404) {
      clearEmpForm();
      $('adm-renew').classList.remove('show');
      return;
    }
    const js = await r.json();
    if (!js.found || !js.employee) {
      clearEmpForm();
      $('adm-renew').classList.remove('show');
      return;
    }
    const e = js.employee;
    $('emp-name').value    = e.owner_name     || '';
    $('emp-dept').value    = e.department     || '';
    $('emp-contact').value = e.contact_number || '';
    $('emp-plate').value   = (e.number_plate || '').replace(/^EMP-/, '');
    if (e.vehicle_type)      $('emp-vtype').value  = e.vehicle_type;
    if (e.activation_months) $('emp-months').value = e.activation_months;
    recalcValidity();
    $('adm-renew-name').textContent = e.owner_name || tag;
    $('adm-renew').classList.add('show');
  } catch (err) {
    $('adm-renew').classList.remove('show');
  }
}

async function pollReader() {
  try {
    const r  = await fetch('/api/desktop_reader/status', { cache: 'no-store' });
    const js = await r.json();
    const ok  = (js.status || '').toLowerCase().startsWith('connected');
    const err = !ok && /(error|failed|not installed|no com)/i.test(js.status || '');
    const dot = $('adm-rdr-dot');
    dot.classList.toggle('ok',  ok);
    dot.classList.toggle('err', err);
    $('adm-rdr-status').textContent = js.status || '—';
    $('adm-rdr-port').textContent   = `port: ${js.port || 'auto'} · ${js.baudrate || 115200} baud · proto: ${js.active_protocol || '—'}`;

    const tag   = (js.latest_tag || '').toUpperCase();
    const epcEl = $('adm-epc');
    const box   = $('adm-tagbox');
    if (tag) {
      if ($('emp-tag').value !== tag) { $('emp-tag').value = tag; setSubmitState(); }
      epcEl.innerHTML = `${tag}<div style="font-size:0.72em; font-weight:600; color:#127c72; margin-top:6px; letter-spacing:1px;">🔒 LOCKED — press Clear for next scan</div>`;
      epcEl.classList.remove('idle');
      box.classList.add('live');
      if (tag !== lastLookedUpTag) { lastLookedUpTag = tag; lookupAndPrefill(tag); }
    } else if (!$('emp-tag').value) {
      epcEl.textContent = '— waiting for tag scan —';
      epcEl.classList.add('idle');
      box.classList.remove('live');
      $('adm-renew').classList.remove('show');
    }
  } catch (e) {
    $('adm-rdr-status').textContent = 'API unreachable';
    $('adm-rdr-dot').classList.add('err');
  }
}
setInterval(pollReader, 800); pollReader();

$('adm-clear-tag').addEventListener('click', async () => {
  await fetch('/api/desktop_reader/clear', { method: 'POST' });
  $('emp-tag').value = '';
  $('adm-epc').textContent = '— waiting for tag scan —';
  $('adm-epc').classList.add('idle');
  $('adm-tagbox').classList.remove('live');
  $('adm-renew').classList.remove('show');
  lastLookedUpTag = '';
  setSubmitState();
});

$('emp-reset').addEventListener('click', () => {
  $('emp-form').reset();
  $('emp-tag').value = '';
  $('adm-renew').classList.remove('show');
  lastLookedUpTag = '';
  recalcValidity();
  setSubmitState();
});

$('emp-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = {
    employee_name:     $('emp-name').value.trim(),
    department:        $('emp-dept').value.trim(),
    contact_number:    $('emp-contact').value.trim(),
    rfid_tag:          $('emp-tag').value.trim(),
    activation_months: parseInt($('emp-months').value, 10),
    number_plate:      $('emp-plate').value.trim(),
    vehicle_type:      $('emp-vtype').value,
    payment_method:    $('emp-pay-method').value,
    payment_amount:    parseInt($('emp-pay-amount').value, 10) || 0,
    upi_id:            $('emp-pay-upi').value.trim(),
    transaction_id:    $('emp-pay-txn').value.trim(),
  };
  $('emp-submit').disabled = true;
  $('emp-submit').textContent = 'Activating…';
  try {
    const r  = await fetch('/api/employees', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const js = await r.json();
    if (r.ok && js.status === 'success') {
      toast(`✓ Tag ${js.action} for ${body.employee_name}`, 'ok');
      $('emp-form').reset();
      $('emp-tag').value = '';
      $('adm-renew').classList.remove('show');
      lastLookedUpTag = '';
      recalcValidity();
      loadEmployees();
      pollVehicles();
    } else {
      toast('✗ ' + (js.message || 'Failed'), 'err');
    }
  } catch (err) {
    toast('✗ Network error: ' + err.message, 'err');
  } finally {
    $('emp-submit').textContent = 'Activate Tag';
    setSubmitState();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// EXIT — live match preview as operator types tag/plate
// Backend accepts either (or partial) via /api/exits; this just shows the
// matched vehicle inline before they hit Submit so they can confirm.
// ─────────────────────────────────────────────────────────────────────────────
function fmtCurrency(v) { return `₹${Number(v || 0).toLocaleString('en-IN')}`; }

function estimateBill(v) {
  // Mirror server's _compute_bill at a high level. Tariffs are fetched by
  // vay-app.js into window.state.tariffs; if not loaded yet, fall back to ₹40/hr.
  const tariffs = (window.state && window.state.tariffs) || [];
  const t = tariffs.find(x => (x.type || '').toLowerCase() === (v.type || '').toLowerCase())
            || tariffs[0]
            || { rate: 40, dailyCap: 240 };
  const elapsedMs = Date.now() - (v.entryAt || Date.now());
  const hours = Math.max(1, Math.ceil(elapsedMs / 3600000));
  const parking = Math.min(hours * t.rate, t.dailyCap);
  const free = v.vip || v.staff;
  return { hours, total: free ? 0 : parking, tariff: t };
}

function durationLabel(entryAtMs) {
  const ms = Date.now() - entryAtMs;
  if (ms < 60_000)    return `${Math.round(ms/1000)}s in`;
  if (ms < 3_600_000) return `${Math.round(ms/60_000)}m in`;
  return `${(ms/3_600_000).toFixed(1)}h in`;
}

function updateExitMatchPreview(query) {
  const matchBox    = document.getElementById('exit-match-box');
  const noMatchBox  = document.getElementById('exit-nomatch-box');
  const submitBtn   = document.getElementById('exit-submit-btn');
  if (!matchBox) return;
  query = (query || '').trim().toUpperCase();
  if (!query) {
    matchBox.style.display = 'none';
    noMatchBox.style.display = 'none';
    if (submitBtn) submitBtn.disabled = true;
    return;
  }
  // EXACT match — partial substring matches were a security hole. Operator
  // must type the full plate or full tag for the exit to succeed.
  const all = (window.state && window.state.vehicles) || [];
  const match = all.find(v =>
    (v.vehicle  && v.vehicle.toUpperCase()  === query) ||
    (v.identity && v.identity.toUpperCase() === query)
  );
  if (!match) {
    // Diagnose what happened so the operator sees WHY exit is blocked:
    // (a) was already exited (recent closed tx), (b) never entered but
    // whitelisted, (c) not even whitelisted.
    const closed = ((window.state && window.state.transactions) || []).find(t =>
      (t.vehicle  && t.vehicle.toUpperCase()  === query) ||
      (t.identity && t.identity.toUpperCase() === query));
    let html;
    if (closed) {
      const exitT = closed.exitAt ? new Date(closed.exitAt).toLocaleTimeString() : '—';
      html = `↩ <b>${query}</b> was <b>already exited</b> at ${exitT}
              (owner: ${closed.owner || '—'}, zone: ${closed.zone}).
              To re-enter, scan the tag at the gate.`;
    } else {
      // Couldn't tell from cached state — fall back to backend diagnosis on submit
      html = `⛔ No active parking session for <b>${query}</b>. ` +
             `Either it was already exited, never entered, or the tag is not whitelisted. ` +
             `(Click Confirm Exit to see the exact reason.)`;
    }
    noMatchBox.innerHTML = html;
    matchBox.style.display = 'none';
    noMatchBox.style.display = 'block';
    if (submitBtn) submitBtn.disabled = !!closed;  // already-exited → keep button disabled; unknown → let backend respond
    return;
  }
  // Reset the no-match box content to the default in case it was customized
  noMatchBox.innerHTML = '⛔ No active vehicle matches that plate / tag. Exit blocked.';
  noMatchBox.style.display = 'none';
  matchBox.style.display = 'block';
  document.getElementById('exit-match-vehicle').textContent  = match.vehicle;
  document.getElementById('exit-match-type').textContent     = match.type || 'Car';
  document.getElementById('exit-match-owner').textContent    = match.owner || '—';
  document.getElementById('exit-match-id').textContent       = match.identity || '—';
  document.getElementById('exit-match-zone').textContent     = match.zone || '—';
  document.getElementById('exit-match-duration').textContent = durationLabel(match.entryAt);
  // Auto-fill the zone selector to the matched entry zone (operator can override)
  const zoneSel = document.querySelector('#exit-form select[name="zone"]');
  if (zoneSel && match.zone) {
    const opts = [...zoneSel.options].map(o => o.value);
    if (opts.includes(match.zone)) zoneSel.value = match.zone;
  }
  if (submitBtn) submitBtn.disabled = false;
}

const exitQueryInput = document.querySelector('#exit-form input[name="query"]');
if (exitQueryInput) {
  exitQueryInput.addEventListener('input', (e) => updateExitMatchPreview(e.target.value));
}

// If the operator scans a tag on the SRK-F206 while the Exit tab is open,
// auto-fill the search field with the EPC.
let lastExitAutoFillTag = '';
async function pollReaderForExit() {
  try {
    const js = await (await fetch('/api/desktop_reader/status', { cache: 'no-store' })).json();
    const tag = (js.latest_tag || '').toUpperCase();
    const exitView = document.getElementById('exit');
    if (!tag || !exitView || !exitView.classList.contains('active')) return;
    if (tag === lastExitAutoFillTag) return;
    lastExitAutoFillTag = tag;
    if (exitQueryInput) {
      exitQueryInput.value = tag;
      updateExitMatchPreview(tag);
      toast('✓ Tag scanned — Exit field auto-filled', 'ok');
    }
  } catch (e) { /* swallow */ }
}
setInterval(pollReaderForExit, 800);

// ─── Pagination shared between Detailed View tables ─────────────────────────
const RPT_PAGE_SIZE = 25;
const _rptPage = { access: 1, detail: 1 };
const _rptRows = { access: [], detail: [] };   // cached full row arrays

function rptUpdatePaginator(name) {
  const total = _rptRows[name].length;
  const pages = Math.max(1, Math.ceil(total / RPT_PAGE_SIZE));
  if (_rptPage[name] > pages) _rptPage[name] = pages;
  if (_rptPage[name] < 1)     _rptPage[name] = 1;
  const cur = _rptPage[name];
  const start = total ? (cur - 1) * RPT_PAGE_SIZE + 1 : 0;
  const end   = Math.min(total, cur * RPT_PAGE_SIZE);
  const root = document.querySelector(`.rpt-paginator[data-paginator="${name}"]`);
  if (!root) return;
  root.querySelector('[data-pg="cur"]').textContent   = cur;
  root.querySelector('[data-pg="total"]').textContent = pages;
  root.querySelector('[data-pg="range"]').textContent = total ? `${start}–${end}` : '0';
  root.querySelector('[data-pg="all"]').textContent   = total;
  root.querySelector('[data-pg="first"]').disabled = cur <= 1;
  root.querySelector('[data-pg="prev"]').disabled  = cur <= 1;
  root.querySelector('[data-pg="next"]').disabled  = cur >= pages;
  root.querySelector('[data-pg="last"]').disabled  = cur >= pages;
}
function rptPageSlice(name) {
  const cur = _rptPage[name];
  return _rptRows[name].slice((cur - 1) * RPT_PAGE_SIZE, cur * RPT_PAGE_SIZE);
}
// Bind once on load
document.querySelectorAll('.rpt-paginator').forEach(root => {
  const name = root.dataset.paginator;
  root.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-pg]');
    if (!btn || btn.disabled) return;
    const total = _rptRows[name].length;
    const pages = Math.max(1, Math.ceil(total / RPT_PAGE_SIZE));
    if      (btn.dataset.pg === 'first') _rptPage[name] = 1;
    else if (btn.dataset.pg === 'prev')  _rptPage[name] = Math.max(1, _rptPage[name] - 1);
    else if (btn.dataset.pg === 'next')  _rptPage[name] = Math.min(pages, _rptPage[name] + 1);
    else if (btn.dataset.pg === 'last')  _rptPage[name] = pages;
    // Trigger the corresponding re-render
    if (name === 'access') refreshAccessEvents();
    if (name === 'detail') renderDetailedView();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// REPORTS — Farmley-style: filters → metrics → status breakdown → charts → detailed table
// vay-app.js handles the legacy bar charts (Hourly/Shift/Daily/Monthly/Payment)
// and renderReports() invocation. We add Reports2 wiring on top via the same
// state.transactions / state.vehicles that vay-app.js syncs every 5s.
// ─────────────────────────────────────────────────────────────────────────────
const RPT_COLORS = {
  Car: '#2f8b57', Bike: '#b74a42', Truck: '#d5952a', EV: '#7c4dff',
  Other: '#5c6c66',
};

// View toggle (Summary / Detailed) — restarts entrance animations each click
document.querySelectorAll('.rpt-view-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const target = btn.dataset.rptView;
    document.querySelectorAll('.rpt-view-btn').forEach(b =>
      b.classList.toggle('active', b === btn));
    document.querySelectorAll('.rpt-view-pane').forEach(p =>
      p.classList.toggle('active', p.id === `rpt-${target}-view`));
    if (target === 'summary') {
      // Restart the panel-level fade-in.
      const grid = document.querySelector('#rpt-summary-view .rpt-summary-grid');
      if (grid) {
        grid.classList.remove('rpt-anim-restart');
        void grid.offsetWidth;
        grid.classList.add('rpt-anim-restart');
      }
      // Clear chart data-key caches so the next refreshReports re-renders
      // (with the rpt-anim-once entrance animation on the inner content).
      ['rpt-donut', 'rpt-trend', 'rpt-top-vehicles', 'rpt-zone-perf'].forEach(id => {
        const e = document.getElementById(id);
        if (e) delete e.dataset.dataKey;
      });
      refreshReports();
    }
    if (target === 'detailed') renderDetailedView();
  });
});

// Filter wiring
const _rptMonth = $('rpt-month');
if (_rptMonth) {
  const today = new Date();
  _rptMonth.value = `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}`;
}
['rpt-month', 'rpt-type-filter', 'rpt-zone-filter'].forEach(id => {
  const el = $(id);
  if (el) el.addEventListener('change', () => {
    // Reset to page 1 when filters change — a stale page index for a
    // smaller filtered result set just looks empty.
    _rptPage.access = 1;
    _rptPage.detail = 1;
    refreshReports();
  });
});
$('rpt-reset-filters')?.addEventListener('click', () => {
  $('rpt-type-filter').value = '';
  $('rpt-zone-filter').value = '';
  if (_rptMonth) {
    const t = new Date();
    _rptMonth.value = `${t.getFullYear()}-${String(t.getMonth()+1).padStart(2,'0')}`;
  }
  refreshReports();
  toast('✓ Filters reset — showing current month, all types, all zones');
});
$('rpt-refresh')?.addEventListener('click', async () => {
  const btn = $('rpt-refresh');
  if (!btn) return;
  const orig = btn.textContent;
  btn.disabled = true;
  btn.textContent = '↻ Refreshing…';
  try {
    // Pull a fresh data snapshot via vay-app.js refreshAll, then re-render
    if (typeof window.refreshAll === 'function') {
      await window.refreshAll();
    }
    // Clear data-key caches so all charts re-render with entrance animation
    ['rpt-donut', 'rpt-trend', 'rpt-top-vehicles', 'rpt-zone-perf'].forEach(id => {
      const e = document.getElementById(id);
      if (e) delete e.dataset.dataKey;
    });
    refreshReports();
    scrollMainToTop();
    toast('✓ Reports refreshed with latest data', 'ok');
  } catch (err) {
    toast(`✗ Refresh failed: ${err.message}`, 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = orig;
  }
});

function rptFilteredTransactions() {
  const txs = (window.state && window.state.transactions) || [];
  const month = _rptMonth?.value || '';
  const typeF = $('rpt-type-filter')?.value || '';
  const zoneF = $('rpt-zone-filter')?.value || '';
  return txs.filter(t => {
    if (month) {
      const ts = t.exitAt || t.entryAt;
      if (!ts) return false;
      const d = new Date(ts);
      const tag = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
      if (tag !== month) return false;
    }
    if (typeF && t.type !== typeF) return false;
    if (zoneF && t.zone !== zoneF) return false;
    return true;
  });
}

function rptFilteredActive() {
  const active = (window.state && window.state.vehicles) || [];
  const typeF = $('rpt-type-filter')?.value || '';
  const zoneF = $('rpt-zone-filter')?.value || '';
  return active.filter(v =>
    (!typeF || v.type === typeF) && (!zoneF || v.zone === zoneF));
}

function refreshReports() {
  const closed = rptFilteredTransactions();
  const active = rptFilteredActive();
  const all    = [...closed, ...active];

  // ── Metric cards
  const totalVehicles  = new Set(all.map(t => t.vehicle)).size;
  // Avg stay = mean of (exit_at OR now) - entry_at, in minutes
  const stayMs = all
    .filter(t => t.entryAt)
    .map(t => (t.exitAt || Date.now()) - t.entryAt);
  const avgMin = stayMs.length ? Math.round(stayMs.reduce((a,b)=>a+b,0) / stayMs.length / 60000) : 0;
  const avgLabel = !stayMs.length ? '—'
                   : avgMin < 60 ? `${avgMin}m`
                   : `${Math.floor(avgMin/60)}h ${avgMin%60}m`;
  $('rpt-total-vehicles').textContent = totalVehicles;
  $('rpt-currently-parked').textContent = active.length;
  $('rpt-exited').textContent  = closed.length;
  if ($('rpt-avg-duration')) $('rpt-avg-duration').textContent = avgLabel;
  const month = _rptMonth?.value || '(all)';
  $('rpt-total-vehicles-sub').textContent = `in ${month}`;
  if ($('rpt-avg-duration-sub')) $('rpt-avg-duration-sub').textContent =
    stayMs.length ? `${stayMs.length} parking session${stayMs.length === 1 ? '' : 's'}` : 'no data';

  // ── Vehicle-type breakdown cards (Car / Bike / VIP-Staff)
  const groupBy = (key) => all.filter(t => (t.type || 'Other') === key);
  const carRows  = groupBy('Car');
  const bikeRows = groupBy('Bike');
  const vipRows  = all.filter(t => t.vip || t.staff);
  const setCount = (countId, rowsId, rows) => {
    if ($(countId)) $(countId).textContent = new Set(rows.map(r => r.vehicle)).size;
    if ($(rowsId))  $(rowsId).textContent  = `${rows.length} total visits`;
  };
  setCount('rpt-car-count',  'rpt-car-rows',  carRows);
  setCount('rpt-bike-count', 'rpt-bike-rows', bikeRows);
  if ($('rpt-vip-count')) $('rpt-vip-count').textContent = new Set(vipRows.map(r => r.vehicle)).size;
  if ($('rpt-vip-rows'))  $('rpt-vip-rows').textContent  = `${vipRows.length} total rows`;

  // ── Donut: vehicle-type distribution (Car + Bike only)
  const counts = ['Car','Bike'].map(t => ({
    label: t, value: groupBy(t).length, color: RPT_COLORS[t],
  })).filter(c => c.value > 0);
  renderDonut($('rpt-donut'), counts);

  // ── Daily trend (line chart with hover tooltip)
  const trendByDay = {};
  closed.forEach(t => {
    const d = new Date(t.exitAt || t.entryAt);
    const key = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
    if (!trendByDay[key]) trendByDay[key] = { entries: 0, exits: 0, revenue: 0 };
    trendByDay[key].exits += 1;
    trendByDay[key].revenue += t.total || 0;
  });
  all.forEach(t => {
    if (!t.entryAt) return;
    const d = new Date(t.entryAt);
    const key = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
    if (!trendByDay[key]) trendByDay[key] = { entries: 0, exits: 0, revenue: 0 };
    trendByDay[key].entries += 1;
  });
  const trendRows = Object.entries(trendByDay)
    .sort(([a], [b]) => a < b ? -1 : 1)
    .map(([date, v]) => ({ date, ...v }));
  renderTrend($('rpt-trend'), trendRows);

  // ── Top vehicles by visits (vertical bar chart — distinct from zone's horizontal)
  const vehicleCounts = {};
  all.forEach(t => { vehicleCounts[t.vehicle] = (vehicleCounts[t.vehicle] || 0) + 1; });
  const topVehicles = Object.entries(vehicleCounts)
    .sort(([,a],[,b]) => b - a).slice(0, 8)
    .map(([label, value]) => ({ label, value }));
  renderVerticalBars($('rpt-top-vehicles'), topVehicles, 'visits');

  // ── Zone-wise performance (horizontal gradient bars — distinct from vertical above)
  const zoneCounts = {};
  all.forEach(t => { zoneCounts[t.zone || 'Unknown'] = (zoneCounts[t.zone || 'Unknown'] || 0) + 1; });
  const zoneRows = Object.entries(zoneCounts)
    .sort(([,a],[,b]) => b - a)
    .map(([label, value]) => ({ label, value }));
  renderGradientHorizontalBars($('rpt-zone-perf'), zoneRows);

  // Gate access events (granted/denied) — fetch directly from /api/logs
  refreshAccessEvents();

  // Detailed table only re-renders when visible (cheap optimization)
  if ($('rpt-detailed-view').classList.contains('active')) renderDetailedView();
}

// Pull access logs and render the "Gate Access Events" panel in Reports.
// Filters by month + vehicle type (and a free-text plate/tag isn't needed —
// month is the main slicer, matching the Farmley pattern).
async function refreshAccessEvents() {
  const tb = $('rpt-access-body');
  const meta = $('rpt-access-meta');
  if (!tb) return;
  try {
    const r  = await fetch('/api/logs', { cache: 'no-store' });
    const all = await r.json();
    if (!Array.isArray(all)) return;
    const month = _rptMonth?.value || '';
    const typeF = $('rpt-type-filter')?.value || '';
    const zoneF = $('rpt-zone-filter')?.value || '';   // (no zone on access logs, but kept for symmetry)
    const filtered = all.filter(l => {
      if (month) {
        const tag = (l.timestamp || '').slice(0, 7);   // 'YYYY-MM'
        if (tag !== month) return false;
      }
      if (typeF && l.vehicle_type !== typeF && l.vehicle_type !== 'N/A') return false;
      return true;
    });
    const granted = filtered.filter(l => (l.status || '').includes('GRANTED')).length;
    const denied  = filtered.filter(l => (l.status || '').includes('DENIED')).length;
    meta.textContent = `${filtered.length} scans · ${granted} granted · ${denied} denied`;
    // Cache the full filtered set for the paginator, then slice
    _rptRows.access = filtered;
    rptUpdatePaginator('access');
    if (!filtered.length) {
      tb.innerHTML = `<tr><td colspan="11" style="text-align:center; opacity:0.6; padding:20px;">No access events match the filters.</td></tr>`;
      return;
    }
    const pageRows = rptPageSlice('access');

    // Build a per-vehicle / per-tag index of parking transactions so each
    // access log can show the matching Entry / Exit / Duration.
    const txAll = [
      ...((window.state && window.state.vehicles) || []),
      ...((window.state && window.state.transactions) || [])
    ];
    const txByTag   = {};
    const txByPlate = {};
    txAll.forEach(t => {
      if (t.identity) {
        (txByTag[t.identity] = txByTag[t.identity] || []).push(t);
      }
      if (t.vehicle) {
        (txByPlate[t.vehicle] = txByPlate[t.vehicle] || []).push(t);
      }
    });
    // Sort each list newest-entry first so we pick the most recent session
    Object.values(txByTag).forEach(arr => arr.sort((a,b) => (b.entryAt||0) - (a.entryAt||0)));
    Object.values(txByPlate).forEach(arr => arr.sort((a,b) => (b.entryAt||0) - (a.entryAt||0)));

    const fmtTime = (ms) => ms ? new Date(ms).toLocaleString() : '—';
    const dur = (entryAt, exitAt) => {
      if (!entryAt) return '—';
      const end = exitAt || Date.now();
      const mins = Math.max(0, Math.round((end - entryAt) / 60000));
      if (mins < 60) return `${mins}m`;
      return `${Math.floor(mins/60)}h ${mins%60}m`;
    };

    tb.innerHTML = pageRows.map(l => {
      // Find the parking transaction whose entry_at is closest to this scan
      // (within a few minutes either side). Falls back to any matching tx.
      const logTs = l.timestamp ? new Date(l.timestamp.replace(' ', 'T')).getTime() : 0;
      const candidates = txByTag[l.rfid_tag] || txByPlate[l.number_plate] || [];
      let tx = null;
      if (candidates.length && logTs) {
        tx = candidates.find(t => Math.abs((t.entryAt || 0) - logTs) < 3 * 60 * 1000)
             || candidates.find(t => (t.entryAt || 0) <= logTs)
             || candidates[0];
      } else if (candidates.length) {
        tx = candidates[0];
      }
      const entryStr = tx ? fmtTime(tx.entryAt) : '—';
      const exitStr  = tx ? (tx.exitAt ? fmtTime(tx.exitAt) : '<i style="color:#d5952a;">still parked</i>') : '—';
      const durAttrs = tx
        ? `data-live-dur="1" data-entry-at="${tx.entryAt || 0}" data-exit-at="${tx.exitAt || 0}"`
        : '';
      const durStr   = tx ? dur(tx.entryAt, tx.exitAt) : '—';
      return `
      <tr>
        <td style="font-size: 0.85em; opacity: 0.85;">${l.timestamp || '—'}</td>
        <td style="font-family: monospace;">${(l.number_plate && l.number_plate !== 'N/A') ? l.number_plate : '—'}</td>
        <td style="font-family: monospace; font-size: 0.82em;">${(l.rfid_tag && l.rfid_tag !== 'N/A') ? l.rfid_tag : '—'}</td>
        <td>${(l.owner_name && l.owner_name !== 'N/A') ? l.owner_name : '—'}</td>
        <td>${l.department || '—'}</td>
        <td>${l.contact_number || '—'}</td>
        <td>${(l.vehicle_type && l.vehicle_type !== 'N/A') ? l.vehicle_type : '—'}</td>
        <td style="font-size: 0.85em;">${entryStr}</td>
        <td style="font-size: 0.85em;">${exitStr}</td>
        <td ${durAttrs}><b>${durStr}</b></td>
        <td><span class="scan-status-badge ${
          (l.status || '').includes('GRANTED') ? 'granted' :
          (l.status || '').includes('DENIED')  ? 'denied'  : 'scanning'}">${l.status || '—'}</span></td>
      </tr>`;
    }).join('');
  } catch (err) {
    tb.innerHTML = `<tr><td colspan="8" style="text-align:center; color: #b74a42; padding:20px;">Failed to load access events: ${err.message}</td></tr>`;
  }
}

function renderDonut(el, slices) {
  if (!el) return;
  // Skip render if data unchanged — prevents the 2s refresh from re-triggering
  // the entrance animation. Animation only fires when slices change.
  const dataKey = slices.length
    ? slices.map(s => `${s.label}:${s.value}`).join('|')
    : 'empty';
  if (el.dataset.dataKey === dataKey) return;
  el.dataset.dataKey = dataKey;
  if (!slices.length) {
    el.innerHTML = '<div class="rpt-donut-empty">No data for selected filters</div>';
    return;
  }
  const total = slices.reduce((s, x) => s + x.value, 0);
  const size = 220, r = 90, cx = size/2, cy = size/2, stroke = 32;
  let acc = -Math.PI / 2;  // start at top
  const arcs = slices.map((s, i) => {
    const frac = s.value / total;
    const a0 = acc, a1 = acc + frac * Math.PI * 2;
    acc = a1;
    const x0 = cx + r * Math.cos(a0), y0 = cy + r * Math.sin(a0);
    const x1 = cx + r * Math.cos(a1), y1 = cy + r * Math.sin(a1);
    const large = (a1 - a0) > Math.PI ? 1 : 0;
    return `<path d="M ${x0} ${y0} A ${r} ${r} 0 ${large} 1 ${x1} ${y1}"
              stroke="${s.color}" stroke-width="${stroke}" fill="none"
              stroke-linecap="butt"
              pathLength="100" class="rpt-arc-draw"
              style="animation-delay: ${i * 250}ms;"></path>`;
  }).join('');
  el.innerHTML = `
    <div class="rpt-anim-once">
      <svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">
        ${arcs}
        <text x="${cx}" y="${cy - 4}" text-anchor="middle"
              font-size="28" font-weight="800" fill="#1f2a27">${total}</text>
        <text x="${cx}" y="${cy + 18}" text-anchor="middle"
              font-size="11" fill="#66706c" letter-spacing="1">VISITS</text>
      </svg>
    </div>
    <div class="rpt-donut-legend rpt-anim-once" style="animation-delay: .15s;">
      ${slices.map(s => `
        <div><i style="background:${s.color}"></i>
          <b>${s.label}</b>:
          ${s.value} (${Math.round(100 * s.value / total)}%)
        </div>`).join('')}
    </div>`;
}

function renderTrend(el, rows) {
  if (!el) return;
  const dataKey = rows.length
    ? rows.map(r => `${r.date}:${r.entries}:${r.exits}`).join('|')
    : 'empty';
  if (el.dataset.dataKey === dataKey) return;
  el.dataset.dataKey = dataKey;
  if (!rows.length) {
    el.innerHTML = '<div class="rpt-donut-empty" style="padding:24px;">No transactions in selected period</div>';
    return;
  }
  const W = el.clientWidth || 500, H = 240;
  const padL = 40, padR = 16, padT = 14, padB = 36;
  const innerW = W - padL - padR, innerH = H - padT - padB;
  const maxEntries = Math.max(1, ...rows.map(r => Math.max(r.entries, r.exits)));
  const xAt = (i) => padL + (rows.length === 1 ? innerW/2 : (i * innerW / (rows.length - 1)));
  const yAt = (v) => padT + innerH - (v / maxEntries * innerH);

  const entriesPath = rows.map((r,i) => `${i===0?'M':'L'} ${xAt(i)} ${yAt(r.entries)}`).join(' ');
  const exitsPath   = rows.map((r,i) => `${i===0?'M':'L'} ${xAt(i)} ${yAt(r.exits)}`).join(' ');
  const yTicks = 4;
  const grid = Array.from({length: yTicks + 1}, (_, i) => {
    const v = Math.round(maxEntries * (yTicks - i) / yTicks);
    const y = padT + (i * innerH / yTicks);
    return `<line x1="${padL}" y1="${y}" x2="${W-padR}" y2="${y}" stroke="#dce2dc" stroke-dasharray="3 3"></line>
            <text x="${padL - 6}" y="${y + 4}" text-anchor="end" font-size="10" fill="#66706c">${v}</text>`;
  }).join('');
  const skip = Math.max(1, Math.ceil(rows.length / 8));
  const xLabels = rows.map((r, i) => i % skip === 0
    ? `<text x="${xAt(i)}" y="${H - 14}" text-anchor="middle" font-size="10" fill="#66706c"
            transform="rotate(-30 ${xAt(i)} ${H - 14})">${r.date.slice(5)}</text>` : '').join('');

  el.innerHTML = `
    <div class="rpt-anim-once">
    <svg viewBox="0 0 ${W} ${H}">
      ${grid}
      <path d="${entriesPath}" stroke="#127c72" stroke-width="2" fill="none"
            pathLength="100" class="rpt-line-draw"></path>
      <path d="${exitsPath}"   stroke="#d5952a" stroke-width="2" fill="none"
            pathLength="100" class="rpt-line-draw" style="animation-delay: .35s;"></path>
      ${rows.map((r,i) => `
        <circle cx="${xAt(i)}" cy="${yAt(r.entries)}" r="4" fill="#127c72"
                data-i="${i}" class="rpt-trend-dot" style="cursor:pointer;"></circle>
        <circle cx="${xAt(i)}" cy="${yAt(r.exits)}"   r="4" fill="#d5952a"
                data-i="${i}" class="rpt-trend-dot" style="cursor:pointer;"></circle>`).join('')}
      ${xLabels}
      <g font-size="11" fill="#1f2a27">
        <circle cx="${padL + 6}" cy="${H - 4}" r="4" fill="#127c72"></circle>
        <text x="${padL + 16}" y="${H - 1}">Entries</text>
        <circle cx="${padL + 80}" cy="${H - 4}" r="4" fill="#d5952a"></circle>
        <text x="${padL + 90}" y="${H - 1}">Exits</text>
      </g>
    </svg>
    </div>
    <div class="rpt-trend-tip"></div>`;
  // Hover tooltip
  const tip = el.querySelector('.rpt-trend-tip');
  el.querySelectorAll('.rpt-trend-dot').forEach(dot => {
    dot.addEventListener('mouseenter', (e) => {
      const i = +dot.dataset.i;
      const r = rows[i];
      tip.innerHTML = `<strong>${r.date}</strong>
        <span>Entries: <b>${r.entries}</b></span>
        <span>Exits: <b>${r.exits}</b></span>`;
      tip.style.display = 'block';
      const rect = el.getBoundingClientRect();
      const dr = dot.getBoundingClientRect();
      tip.style.left = `${dr.left - rect.left + 12}px`;
      tip.style.top  = `${dr.top  - rect.top  - 8}px`;
    });
    dot.addEventListener('mouseleave', () => { tip.style.display = 'none'; });
  });
}

function renderTopBars(el, rows, suffix) {
  if (!el) return;
  if (!rows.length) {
    el.innerHTML = '<div class="rpt-donut-empty" style="padding:20px;">No data</div>';
    return;
  }
  const max = Math.max(1, ...rows.map(r => r.value));
  el.innerHTML = rows.map(r => `
    <div class="bar-row">
      <strong>${r.label}</strong>
      <span class="bar-track"><i style="width:${(r.value/max)*100}%; background: #127c72;"></i></span>
      <span>${r.value} ${suffix || ''}</span>
    </div>`).join('');
}

// Farmley-style horizontal list chart (used for Top Vehicles by Visits).
// Each row: truncated label on the left, full gradient green bar showing the
// value scaled to the max, x-axis tick row at the bottom.
function renderVerticalBars(el, rows, suffix) {
  if (!el) return;
  const dataKey = rows.length ? rows.map(r => `${r.label}:${r.value}`).join('|') : 'empty';
  if (el.dataset.dataKey === dataKey) return;
  el.dataset.dataKey = dataKey;
  if (!rows.length) {
    el.innerHTML = '<div class="rpt-donut-empty" style="padding:20px;">No data</div>';
    return;
  }
  const max  = Math.max(1, ...rows.map(r => r.value));
  // X-axis ticks: 5 evenly-spaced values (0, max/4, max/2, 3max/4, max)
  const ticks = [0, 0.25, 0.5, 0.75, 1].map(f => Math.round(max * f));
  el.innerHTML = `
    <div class="frm-bar-chart">
      ${rows.map((r, i) => {
        const pct = (r.value / max) * 100;
        return `
        <div class="frm-bar-row" style="animation-delay: ${i * 60}ms">
          <div class="frm-bar-label" title="${r.label}">${r.label}</div>
          <div class="frm-bar-track">
            <div class="frm-bar-fill" style="width: ${pct}%;">
              <span class="frm-bar-val">${r.value}</span>
            </div>
          </div>
        </div>`;
      }).join('')}
      <div class="frm-bar-axis">
        ${ticks.map(t => `<span>${t}</span>`).join('')}
      </div>
    </div>`;
}

// Horizontal bar chart with rotating gradient colours per zone — distinct
// from the vertical bars above and clearly per-category coloured.
function renderGradientHorizontalBars(el, rows) {
  if (!el) return;
  const dataKey = rows.length ? rows.map(r => `${r.label}:${r.value}`).join('|') : 'empty';
  if (el.dataset.dataKey === dataKey) return;
  el.dataset.dataKey = dataKey;
  if (!rows.length) {
    el.innerHTML = '<div class="rpt-donut-empty" style="padding:20px;">No data</div>';
    return;
  }
  // Distinct colour per zone (cycled)
  const palette = ['#127c72', '#d5952a', '#7c4dff', '#b74a42', '#2f8b57', '#3b82f6'];
  const max = Math.max(1, ...rows.map(r => r.value));
  el.innerHTML = `
    <div style="padding: 8px 6px;">
      ${rows.map((r, i) => {
        const col = palette[i % palette.length];
        const pct = (r.value / max) * 100;
        return `
        <div style="display:flex; align-items:center; gap:14px; margin-bottom:12px;">
          <strong style="flex: 0 0 130px; font-size: 0.88em;">${r.label}</strong>
          <div style="flex:1; height: 22px; background: rgba(31,42,39,0.06); border-radius: 11px; overflow:hidden; position:relative;">
            <div style="width: ${pct}%; height: 100%;
                        background: linear-gradient(90deg, ${col} 0%, ${col}cc 100%);
                        border-radius: 11px;
                        display:flex; align-items:center; padding-left: 10px;">
              ${pct > 28 ? `<span style="color:#fff; font-size:0.78em; font-weight:700;">${r.value} visits</span>` : ''}
            </div>
            ${pct <= 28 ? `<span style="position:absolute; left: calc(${pct}% + 8px); top:50%; transform:translateY(-50%); font-size:0.78em; font-weight:700; color:${col};">${r.value} visits</span>` : ''}
          </div>
        </div>`;
      }).join('')}
    </div>`;
}

// ── DETAILED VIEW (table) ────────────────────────────────────────────────────
function renderDetailedView() {
  const closed = rptFilteredTransactions();
  const active = rptFilteredActive();
  const all = [...active, ...closed]    // active first, then closed
    .sort((a, b) => (b.entryAt || 0) - (a.entryAt || 0));
  const tb = $('rpt-detail-body');
  const meta = $('rpt-detail-meta');
  if (!tb) return;
  meta.textContent = `Showing ${all.length} transaction${all.length === 1 ? '' : 's'}`;
  // Cache full set for paginator, then take the current page slice
  _rptRows.detail = all;
  rptUpdatePaginator('detail');
  if (!all.length) {
    tb.innerHTML = `<tr><td colspan="11" style="text-align:center; opacity:0.6; padding:24px;">No transactions match the filters.</td></tr>`;
    return;
  }
  const pageAll = rptPageSlice('detail');
  const month = _rptMonth?.value;
  if (month) $('rpt-detail-title').textContent = `Monthly Transactions (${month})`;
  else        $('rpt-detail-title').textContent = `All Transactions`;

  const fmtDT = (ms) => ms ? new Date(ms).toLocaleString() : '—';
  const dateOnly = (ms) => ms ? new Date(ms).toLocaleDateString() : '—';
  const durationOf = (t) => {
    const start = t.entryAt, end = t.exitAt || Date.now();
    if (!start) return '—';
    const mins = Math.round((end - start) / 60000);
    if (mins < 60) return `${mins}m`;
    return `${Math.floor(mins/60)}h ${mins%60}m`;
  };
  const tagFor = (t) =>
    t.isActive ? '<span class="scan-status-badge scanning">P</span>'
               : '<span class="scan-status-badge granted">E</span>';

  tb.innerHTML = pageAll.map(t => `
    <tr>
      <td>${dateOnly(t.entryAt)}</td>
      <td><b>${t.vehicle}</b>${t.vip ? ' <span class="scan-status-badge granted">V</span>'
                              : t.staff ? ' <span class="scan-status-badge granted">S</span>' : ''}</td>
      <td>${t.owner || '—'}</td>
      <td>${t.type || '—'}</td>
      <td>${t.zone || '—'}</td>
      <td>${t.mode || '—'}</td>
      <td style="font-family:monospace; font-size:0.85em;">${t.identity || '—'}</td>
      <td>${fmtDT(t.entryAt)}</td>
      <td>${fmtDT(t.exitAt)}</td>
      <td data-live-dur="1" data-entry-at="${t.entryAt || 0}" data-exit-at="${t.exitAt || 0}">${durationOf(t)}</td>
      <td>${tagFor(t)}</td>
    </tr>`).join('');
}

// ── Per-second duration ticker ───────────────────────────────────────────────
// Updates ONLY the duration cells (cells tagged with data-live-dur). Doesn't
// re-render whole tables — just patches the text content. Proves the values
// are live and not cached/hardcoded.
function liveDurStr(entryAt, exitAt) {
  if (!entryAt) return '—';
  const end = exitAt || Date.now();
  const secs = Math.max(0, Math.round((end - entryAt) / 1000));
  if (secs < 60)    return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60)    return `${mins}m ${secs % 60}s`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h ${mins % 60}m`;
}
function tickLiveDurations() {
  document.querySelectorAll('[data-live-dur="1"]').forEach(el => {
    const entry = +el.dataset.entryAt || 0;
    const exit  = +el.dataset.exitAt  || 0;
    // Closed transactions: render once and stop ticking
    if (exit) return;
    if (!entry) return;
    const fresh = liveDurStr(entry, 0);
    // Preserve <b> wrapping if present
    if (el.querySelector('b')) el.querySelector('b').textContent = fresh;
    else                       el.textContent = fresh;
  });
}
setInterval(tickLiveDurations, 1000);

// Live-monitoring cadence: when the Reports tab is open, refresh every 2s
// so auto-entries / exits show up almost immediately. When hidden, 8s is fine.
let _rptTimer = null;
function _scheduleReportsTick() {
  if (_rptTimer) clearTimeout(_rptTimer);
  const active = document.getElementById('reports')?.classList.contains('active');
  const ms = active ? 2000 : 8000;
  _rptTimer = setTimeout(() => { refreshReports(); _scheduleReportsTick(); }, ms);
}
setTimeout(() => { refreshReports(); _scheduleReportsTick(); }, 1500);
// Reschedule (faster) when user switches into Reports
document.querySelectorAll('.nav-item').forEach(b => {
  b.addEventListener('click', () => setTimeout(_scheduleReportsTick, 50));
});

async function loadEmployees() {
  try {
    const r  = await fetch('/api/employees', { cache: 'no-store' });
    const js = await r.json();
    const tb = $('emp-tbody');
    if (!Array.isArray(js) || !js.length) {
      tb.innerHTML = `<tr><td colspan="10" style="text-align:center; opacity:0.6; padding:20px;">No employees activated yet.</td></tr>`;
      $('emp-count').textContent = '';
      return;
    }
    // Live counts: active vs expired, with "expiring in ≤14 days" warning
    const now = Date.now();
    const days = (yyyymmdd) => {
      if (!yyyymmdd) return Infinity;
      return Math.ceil((new Date(yyyymmdd + 'T00:00:00').getTime() - now) / 86_400_000);
    };
    const expired   = js.filter(e => e.status === 'Expired').length;
    const expiringSoon = js.filter(e => e.status === 'Active' && days(e.valid_until) <= 14).length;
    let countLabel = `${js.length} total · ${js.length - expired} active`;
    if (expired)       countLabel += ` · ${expired} expired`;
    if (expiringSoon)  countLabel += ` · ${expiringSoon} expiring ≤14d`;
    $('emp-count').textContent = countLabel;

    tb.innerHTML = js.map(e => {
      const left = days(e.valid_until);
      const isExpired   = e.status === 'Expired';
      const isExpiring  = !isExpired && left <= 14;
      const validLabel  = isExpired
        ? `<span style="color:#b74a42;">${e.valid_until} <small>(${Math.abs(left)}d ago)</small></span>`
        : isExpiring
            ? `<span style="color:#a87217;">${e.valid_until} <small>(${left}d left)</small></span>`
            : (e.valid_until || '—');
      const statusBadge = isExpired
        ? '<span class="scan-status-badge denied">Expired</span>'
        : isExpiring
            ? '<span class="scan-status-badge scanning">Expiring</span>'
            : '<span class="scan-status-badge granted">Active</span>';
      // Only expired/expiring rows get a button. Active rows have nothing —
      // renewal isn't allowed more than 1 day before expiry anyway (backend
      // enforces this), so no point showing a button that can't fire.
      const renewBtn = isExpired
        ? `<button class="ghost-button rpt-renew-btn"
                    data-renew-tag="${e.rfid_tag || ''}"
                    style="padding:4px 10px; font-size:0.78em; background:#127c72; color:#fff;">↻ Renew</button>`
        : isExpiring
            ? `<button class="ghost-button rpt-renew-btn"
                        data-renew-tag="${e.rfid_tag || ''}"
                        style="padding:4px 10px; font-size:0.78em;">↻ Extend</button>`
            : `<span style="opacity:0.45; font-size:0.85em;">—</span>`;
      // Compact payment cell: "PhonePe · ₹2500" with the rest of the
      // payment details exposed via title= tooltip so the row stays narrow.
      // Legacy rows (no payment captured) get a muted "—".
      const payCell = e.payment_method
        ? `<span title="UPI ID: ${e.upi_id || '—'}\nTxn: ${e.transaction_id || '—'}\nPaid: ${e.paid_at || '—'}"
                 style="white-space:nowrap; cursor:help;">
              <b>${e.payment_method}</b><br>
              <small style="opacity:0.75;">₹${e.payment_amount || 0}${e.paid_at ? ' · ' + e.paid_at.slice(0,10) : ''}</small>
           </span>`
        : `<span style="opacity:0.45; font-size:0.85em;">—</span>`;
      return `
      <tr>
        <td>${e.owner_name || '—'}</td>
        <td>${e.department || '—'}</td>
        <td>${e.contact_number || '—'}</td>
        <td style="font-family:monospace; font-size:0.85em;">${e.rfid_tag || '—'}</td>
        <td>${(e.number_plate || '').startsWith('EMP-') ? '<i style="opacity:0.5;">(none)</i>' : (e.number_plate || '—')}</td>
        <td>${payCell}</td>
        <td>${e.activated_at ? e.activated_at.slice(0,10) : '—'}</td>
        <td>${validLabel}</td>
        <td>${statusBadge}</td>
        <td>${renewBtn}</td>
      </tr>`;
    }).join('');

    // Wire each renew button — loads that employee into the activation form
    tb.querySelectorAll('.rpt-renew-btn').forEach(btn => {
      btn.addEventListener('click', () => startRenewalFlow(btn.dataset.renewTag));
    });
  } catch (err) { /* swallow */ }
}

// ── Renewal flow ─────────────────────────────────────────────────────────────
// "↻ Renew" buttons in the Activated Employees table call this, which routes
// to the separate Renewal section (NOT the new-enrollment form).
let _renewLoadedEmployee = null;   // cached employee details after Load

async function startRenewalFlow(tag) {
  if (!tag) {
    toast('No tag on this employee — can\'t renew without a tag.', 'err');
    return;
  }
  if (typeof switchView === 'function') switchView('admin');
  $('renew-tag').value = tag;
  await renewLookup();
  const section = document.getElementById('renew-tag').closest('section');
  if (section) section.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

async function renewLookup() {
  const tag = ($('renew-tag').value || '').trim().toUpperCase();
  if (!tag) {
    toast('Enter or scan a tag first', 'err');
    return;
  }
  try {
    const r = await fetch(`/api/employees/by_tag/${encodeURIComponent(tag)}`,
                          { cache: 'no-store' });
    if (r.status === 404) {
      _renewLoadedEmployee = null;
      $('renew-details').style.display = 'none';
      toast(`No employee found for tag ${tag}`, 'err');
      updateRenewSubmitState();
      return;
    }
    const js = await r.json();
    if (!js.found || !js.employee) {
      _renewLoadedEmployee = null;
      $('renew-details').style.display = 'none';
      updateRenewSubmitState();
      return;
    }
    _renewLoadedEmployee = js.employee;
    const e = js.employee;
    $('renew-d-name').textContent       = e.owner_name      || '—';
    $('renew-d-dept').textContent       = e.department      || '—';
    $('renew-d-contact').textContent    = e.contact_number  || '—';
    $('renew-d-plate').textContent      = e.number_plate    || '—';
    $('renew-d-actdate').textContent    = e.activated_at ? e.activated_at.slice(0,10) : '—';
    $('renew-d-validuntil').textContent = e.valid_until     || '—';
    if (e.activation_months) $('renew-months').value = String(e.activation_months);

    // Eligibility evaluation (mirror backend rule: days_left <= 1)
    const validMs = e.valid_until ? new Date(e.valid_until + 'T00:00:00').getTime() : 0;
    const daysLeft = (validMs - Date.now()) / 86_400_000;
    const elig = $('renew-eligibility');
    if (daysLeft > 1) {
      elig.style.background = 'rgba(183,74,66,0.10)';
      elig.style.color = '#8a2820';
      elig.innerHTML = `⛔ <b>Renewal not yet allowed.</b> ${Math.ceil(daysLeft)} day(s) remain on the current validity. Renewal opens 1 day before expiry.`;
    } else if (daysLeft >= 0) {
      elig.style.background = 'rgba(213,149,42,0.12)';
      elig.style.color = '#a87217';
      elig.innerHTML = `✓ <b>Renewal allowed.</b> Validity ends in less than 1 day (${Math.max(0, Math.round(daysLeft * 24))} hours).`;
    } else {
      elig.style.background = 'rgba(213,149,42,0.18)';
      elig.style.color = '#a87217';
      elig.innerHTML = `⚠ <b>Validity expired ${Math.abs(Math.round(daysLeft))} day(s) ago.</b> Renewal allowed — gate is currently denying this tag.`;
    }
    $('renew-details').style.display = 'block';
    updateRenewSubmitState();
  } catch (err) {
    toast(`Lookup failed: ${err.message}`, 'err');
  }
}

function updateRenewSubmitState() {
  const e = _renewLoadedEmployee;
  const confirmName = ($('renew-confirm-name').value || '').trim();
  if (!e) { $('renew-submit').disabled = true; return; }
  const validMs = e.valid_until ? new Date(e.valid_until + 'T00:00:00').getTime() : 0;
  const daysLeft = (validMs - Date.now()) / 86_400_000;
  const eligible = daysLeft <= 1;
  const nameMatch = confirmName && confirmName.toLowerCase() === (e.owner_name || '').toLowerCase();
  $('renew-submit').disabled = !(eligible && nameMatch);
}

$('renew-lookup-btn')?.addEventListener('click', renewLookup);
$('renew-tag')?.addEventListener('change', () => { _renewLoadedEmployee = null; $('renew-details').style.display = 'none'; updateRenewSubmitState(); });
$('renew-confirm-name')?.addEventListener('input', updateRenewSubmitState);

$('renew-cancel')?.addEventListener('click', () => {
  _renewLoadedEmployee = null;
  $('renew-tag').value = '';
  $('renew-confirm-name').value = '';
  $('renew-details').style.display = 'none';
  updateRenewSubmitState();
});

$('renew-submit')?.addEventListener('click', async () => {
  if (!_renewLoadedEmployee) return;
  const body = {
    rfid_tag:     _renewLoadedEmployee.rfid_tag,
    confirm_name: ($('renew-confirm-name').value || '').trim(),
    months:       parseInt($('renew-months').value, 10) || 12,
  };
  $('renew-submit').disabled = true;
  $('renew-submit').textContent = 'Renewing…';
  try {
    const r = await fetch('/api/employees/renew', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const js = await r.json();
    if (r.ok && js.status === 'success') {
      toast(`✓ Renewed — valid until ${js.employee.valid_until}`, 'ok');
      _renewLoadedEmployee = null;
      $('renew-tag').value = '';
      $('renew-confirm-name').value = '';
      $('renew-details').style.display = 'none';
      loadEmployees();
      pollVehicles();
    } else {
      toast(`✗ ${js.message || 'Renewal failed'}`, 'err');
    }
  } catch (err) {
    toast(`✗ ${err.message}`, 'err');
  } finally {
    $('renew-submit').textContent = '↻ Confirm Renewal';
    updateRenewSubmitState();
  }
});
setInterval(loadEmployees, 5000); loadEmployees();


// ──────────────────────────────────────────────────────────────────────────
// Blacklist admin section
// ──────────────────────────────────────────────────────────────────────────
async function loadBlacklist() {
  try {
    const r    = await fetch('/api/blacklist', { cache: 'no-store' });
    const rows = await r.json();
    const tb   = $('bl-tbody');
    if (!tb) return;
    $('bl-count').textContent = `${rows.length} banned`;
    if (!rows.length) {
      tb.innerHTML = '<tr><td colspan="6" style="text-align:center; opacity:0.6; padding:14px;">No banned entries.</td></tr>';
      return;
    }
    tb.innerHTML = rows.map(b => `
      <tr>
        <td style="font-family:monospace;">${b.number_plate || '—'}</td>
        <td style="font-family:monospace;">${b.rfid_tag || '—'}</td>
        <td>${b.reason || ''}</td>
        <td>${b.added_by || ''}</td>
        <td>${b.created_at || ''}</td>
        <td><button class="ghost-button" data-bl-del="${b.id}"
              style="padding:4px 10px; font-size:0.82em; color:#b74a42;">Remove</button></td>
      </tr>`).join('');
    tb.querySelectorAll('[data-bl-del]').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm('Remove this entry from the blacklist?')) return;
        const id = btn.getAttribute('data-bl-del');
        const rr = await fetch(`/api/blacklist/${id}`, { method: 'DELETE' });
        const jj = await rr.json().catch(() => ({}));
        if (rr.ok) { toast('✓ Removed from blacklist', 'ok'); loadBlacklist(); }
        else       { toast('✗ ' + (jj.message || 'Failed'), 'err'); }
      });
    });
  } catch (err) { /* table not present yet — view not loaded */ }
}

document.getElementById('bl-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = {
    number_plate: $('bl-plate').value.trim(),
    rfid_tag:     $('bl-tag').value.trim(),
    reason:       $('bl-reason').value.trim(),
  };
  if (!body.number_plate && !body.rfid_tag) {
    toast('✗ Provide a plate or a tag', 'err'); return;
  }
  const r  = await fetch('/api/blacklist', {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify(body),
  });
  const js = await r.json().catch(() => ({}));
  if (r.ok && js.status === 'ok') {
    toast('✓ Added to blacklist', 'ok');
    $('bl-plate').value = ''; $('bl-tag').value = ''; $('bl-reason').value = '';
    loadBlacklist();
  } else {
    toast('✗ ' + (js.message || 'Failed'), 'err');
  }
});

// ──────────────────────────────────────────────────────────────────────────
// Visitor management section
// ──────────────────────────────────────────────────────────────────────────
async function loadVisitors() {
  try {
    const r    = await fetch('/api/visitors', { cache: 'no-store' });
    const rows = await r.json();
    const tb   = $('vis-tbody');
    if (!tb) return;
    const activeCount = rows.filter(v => v.status === 'Active').length;
    $('vis-count').textContent = `${rows.length} total · ${activeCount} active`;
    if (!rows.length) {
      tb.innerHTML = '<tr><td colspan="9" style="text-align:center; opacity:0.6; padding:14px;">No visitor passes issued yet.</td></tr>';
      return;
    }
    const badge = (s) => {
      const color = s === 'Active' ? '#2f8b57' : s === 'Future' ? '#a87217' : '#888';
      return `<span style="background:${color}; color:#fff; padding:3px 9px; border-radius:10px; font-size:0.78em; font-weight:600;">${s}</span>`;
    };
    tb.innerHTML = rows.map(v => `
      <tr>
        <td>${v.name}</td>
        <td style="font-family:monospace;">${v.number_plate}</td>
        <td style="font-family:monospace;">${v.rfid_tag || '—'}</td>
        <td>${v.purpose || ''}</td>
        <td>${v.host_employee || ''}</td>
        <td>${v.start_at}</td>
        <td>${v.end_at}</td>
        <td>${badge(v.status)}</td>
        <td><button class="ghost-button" data-vis-del="${v.id}"
              style="padding:4px 10px; font-size:0.82em; color:#b74a42;">Revoke</button></td>
      </tr>`).join('');
    tb.querySelectorAll('[data-vis-del]').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm('Revoke this visitor pass?')) return;
        const id = btn.getAttribute('data-vis-del');
        const rr = await fetch(`/api/visitors/${id}`, { method: 'DELETE' });
        const jj = await rr.json().catch(() => ({}));
        if (rr.ok) { toast('✓ Pass revoked', 'ok'); loadVisitors(); }
        else       { toast('✗ ' + (jj.message || 'Failed'), 'err'); }
      });
    });
  } catch (err) { /* view not loaded */ }
}

// Default the start/end inputs when the admin view is first rendered.
function _seedVisitorTimes() {
  const start = $('vis-start'), end = $('vis-end');
  if (!start || !end) return;
  if (start.value) return;
  const pad = n => String(n).padStart(2, '0');
  const fmt = d => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const now = new Date();
  start.value = fmt(now);
  end.value   = fmt(new Date(now.getTime() + 8 * 3600 * 1000));
}

document.getElementById('vis-reset')?.addEventListener('click', () => {
  ['vis-name','vis-plate','vis-tag','vis-contact','vis-purpose','vis-host']
    .forEach(id => { const el = $(id); if (el) el.value = ''; });
  $('vis-start').value = ''; $('vis-end').value = '';
  _seedVisitorTimes();
});

document.getElementById('vis-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = {
    name:           $('vis-name').value.trim(),
    number_plate:   $('vis-plate').value.trim(),
    rfid_tag:       $('vis-tag').value.trim(),
    contact:        $('vis-contact').value.trim(),
    purpose:        $('vis-purpose').value.trim(),
    host_employee:  $('vis-host').value.trim(),
    start_at:       $('vis-start').value,
    end_at:         $('vis-end').value,
  };
  const r  = await fetch('/api/visitors', {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify(body),
  });
  const js = await r.json().catch(() => ({}));
  if (r.ok && js.status === 'ok') {
    toast(`✓ Pass issued to ${body.name}`, 'ok');
    document.getElementById('vis-reset').click();
    loadVisitors();
  } else {
    toast('✗ ' + (js.message || 'Failed'), 'err');
  }
});

// ──────────────────────────────────────────────────────────────────────────
// Entry-time-rule section
// ──────────────────────────────────────────────────────────────────────────
async function loadEntryWindows() {
  try {
    const r  = await fetch('/api/entry_windows', { cache: 'no-store' });
    const js = await r.json();
    const el = $('ew-windows');
    if (el && !document.activeElement?.isSameNode(el)) el.value = js.windows || '';
  } catch (err) { /* view not loaded */ }
}

document.getElementById('ew-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const r  = await fetch('/api/entry_windows', {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ windows: $('ew-windows').value }),
  });
  const js = await r.json().catch(() => ({}));
  if (r.ok && js.status === 'ok') {
    toast(js.windows ? `✓ Entry windows saved: ${js.windows}` : '✓ Entry-time blocking disabled', 'ok');
    $('ew-windows').value = js.windows || '';
  } else {
    toast('✗ ' + (js.message || 'Failed'), 'err');
  }
});

// ──────────────────────────────────────────────────────────────────────────
// Dashboard: long-parked banner
// ──────────────────────────────────────────────────────────────────────────
let _longParkedDismissedKey = null;  // sessionStorage of last-dismissed set
async function loadLongParked() {
  const banner = $('dash-longparked-alert');
  if (!banner) return;
  try {
    const r  = await fetch('/api/long_parked', { cache: 'no-store' });
    const js = await r.json();
    const list = js.vehicles || [];
    if (!list.length) { banner.style.display = 'none'; return; }
    // Dismissal key: which vehicles+threshold the user already saw
    const key = JSON.stringify({ t: js.threshold_hours, ids: list.map(v => v.id) });
    if (_longParkedDismissedKey === key) return;
    $('dash-longparked-count').textContent     = list.length;
    $('dash-longparked-threshold').textContent = js.threshold_hours;
    $('dash-longparked-list').innerHTML = list.slice(0, 6).map(v =>
      `• <b>${v.vehicle}</b> (${v.owner || 'Unknown'}) — ${v.elapsed_hours}h in ${v.zone || 'lot'}`
    ).join('<br>');
    banner.style.display = 'flex';
  } catch (err) { banner.style.display = 'none'; }
}
document.getElementById('dash-longparked-dismiss')?.addEventListener('click', () => {
  const banner = $('dash-longparked-alert');
  if (banner) banner.style.display = 'none';
  // Re-derive current key so the same set stays dismissed; will resurface if a new vehicle crosses threshold.
  fetch('/api/long_parked', { cache: 'no-store' }).then(r => r.json()).then(js => {
    _longParkedDismissedKey = JSON.stringify({ t: js.threshold_hours, ids: (js.vehicles||[]).map(v => v.id) });
  });
});

// Refresh admin tables when the Admin tab is opened (cheap: only fires on click).
document.querySelectorAll('.nav-item[data-view="admin"]').forEach(btn => {
  btn.addEventListener('click', () => {
    _seedVisitorTimes();
    loadBlacklist();
    loadVisitors();
    loadEntryWindows();
  });
});

// Initial seed + periodic refresh
_seedVisitorTimes();
loadBlacklist();      setInterval(loadBlacklist,     10000);
loadVisitors();       setInterval(loadVisitors,      10000);
loadEntryWindows();   setInterval(loadEntryWindows,  30000);
loadLongParked();     setInterval(loadLongParked,    15000);


// ──────────────────────────────────────────────────────────────────────────
// Reports → UHF Tag Hourly Entry/Exit panel
// ──────────────────────────────────────────────────────────────────────────
function _uhfDateInput() {
  const el = $('uhf-hourly-date');
  if (!el) return null;
  if (!el.value) {
    const d = new Date();
    const pad = n => String(n).padStart(2, '0');
    el.value = `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
  }
  return el;
}

async function loadUhfHourly() {
  const dateEl = _uhfDateInput();
  const tbody  = $('uhf-hourly-body');
  if (!dateEl || !tbody) return;
  try {
    const r  = await fetch(`/api/uhf_hourly?date=${encodeURIComponent(dateEl.value)}`,
                           { cache: 'no-store' });
    const js = await r.json();
    $('uhf-hourly-meta').textContent =
      `${js.entries_total} entries · ${js.exits_total} exits · ${js.date}`;

    const cellList = (rows, color) => {
      if (!rows.length) return '<span style="opacity:0.4;">—</span>';
      return rows.map(it => `
        <div style="padding:3px 0; border-bottom:1px dashed rgba(0,0,0,0.06);">
          <span style="color:${color}; font-weight:600; font-family:monospace;">${it.time}</span>
          &nbsp;<b style="font-family:monospace;">${it.vehicle}</b>
          ${it.owner ? `&middot; <span style="opacity:0.8;">${it.owner}</span>` : ''}
          ${it.identity ? ` &middot; <span style="font-family:monospace; font-size:0.85em; opacity:0.7;">${it.identity}</span>` : ''}
        </div>`).join('');
    };

    const rows = (js.hours || []).filter(h => h.entries.length || h.exits.length);
    if (!rows.length) {
      tbody.innerHTML = `<tr><td colspan="3" style="text-align:center; opacity:0.6; padding:18px;">
                          No UHF tag transactions for ${js.date}.</td></tr>`;
      return;
    }
    tbody.innerHTML = rows.map(h => `
      <tr>
        <td style="vertical-align:top; font-family:monospace; font-weight:700;">${h.label}</td>
        <td style="vertical-align:top;">${cellList(h.entries, '#2f8b57')}</td>
        <td style="vertical-align:top;">${cellList(h.exits,   '#b74a42')}</td>
      </tr>`).join('');
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="3" style="text-align:center; color:#b74a42; padding:18px;">
                        Failed to load UHF hourly data.</td></tr>`;
  }
}

document.getElementById('uhf-hourly-date')?.addEventListener('change', loadUhfHourly);

// Re-pull when the Reports tab is opened, and refresh in the background.
document.querySelectorAll('.nav-item[data-view="reports"]').forEach(btn => {
  btn.addEventListener('click', loadUhfHourly);
});

loadUhfHourly();
setInterval(loadUhfHourly, 20000);


// ──────────────────────────────────────────────────────────────────────────
// Mobile hamburger drawer — toggle .sidebar-open on <body>.
// Hidden on desktop via media query; no behavior change there.
// ──────────────────────────────────────────────────────────────────────────
(function mobileNav() {
  const toggle   = document.getElementById('mobile-menu-toggle');
  const backdrop = document.getElementById('mobile-backdrop');
  if (!toggle || !backdrop) return;

  const setOpen = (open) => {
    document.body.classList.toggle('sidebar-open', open);
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  };
  toggle.addEventListener('click', () => setOpen(!document.body.classList.contains('sidebar-open')));
  backdrop.addEventListener('click', () => setOpen(false));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') setOpen(false); });
  // Closing on nav-item click is essential on mobile so users see the view they picked.
  document.querySelectorAll('.sidebar .nav-item').forEach(b =>
    b.addEventListener('click', () => setOpen(false))
  );
})();

// ── Phase 2: live data sections ───────────────────────────────────────────────
// Parking Records / Scanning Record / Registered Vehicle / Black List each fetch
// an existing API and render an auto-refreshing table. The 4 sections that still
// need new backends (Video, Order, Yard, Region) remain stub panels.
function _fmtTs(ms) {
  if (!ms) return '—';
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
function _dwell(a, b) {
  if (!a) return '—';
  const end = b || Date.now();
  let s = Math.max(0, Math.floor((end - a) / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return `${h}h ${m}m`;
}
function _emptyRow(cols, msg) {
  return `<tr><td colspan="${cols}" style="text-align:center; opacity:0.6; padding:20px;">${msg}</td></tr>`;
}
function _esc(s) {
  return (s == null ? '' : String(s)).replace(/[&<>"]/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// ── Reusable client-side paginator ───────────────────────────────────────────
// Every data table routes its rows through paginate(); the helper slices the
// rows into pages, renders the current page into the tbody, and injects a
// First/Prev/Next/Last control directly after the table's .table-wrap.
// Per-table state (current page) lives in _pager keyed by a unique id.
const _pager = {};
const PAGE_SIZE = 10;

function paginate(key, rows, tbodyId, rowFn, colspan, afterRender) {
  const prevPage = _pager[key] ? _pager[key].page : 1;
  _pager[key] = { rows, page: prevPage, tbodyId, rowFn, colspan, afterRender };
  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  if (_pager[key].page > pages) _pager[key].page = pages;
  if (_pager[key].page < 1) _pager[key].page = 1;
  _renderPage(key);
}

function _renderPage(key) {
  const s = _pager[key]; if (!s) return;
  const tb = document.getElementById(s.tbodyId); if (!tb) return;
  const total = s.rows.length;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  if (s.page > pages) s.page = pages;
  if (s.page < 1) s.page = 1;
  const start = (s.page - 1) * PAGE_SIZE;
  const slice = s.rows.slice(start, start + PAGE_SIZE);
  tb.innerHTML = slice.length
    ? slice.map(s.rowFn).join('')
    : _emptyRow(s.colspan, 'No matching rows.');
  if (s.afterRender) s.afterRender(tb);
  _renderPaginatorEl(key, s.page, pages, total, start, slice.length);
}

function _renderPaginatorEl(key, page, pages, total, start, count) {
  const tb = document.getElementById(_pager[key].tbodyId);
  const wrap = tb && tb.closest('.table-wrap');
  if (!wrap) return;
  let pg = wrap.nextElementSibling;
  if (!pg || !pg.classList.contains('tbl-paginator')) {
    pg = document.createElement('div');
    pg.className = 'tbl-paginator';
    wrap.parentNode.insertBefore(pg, wrap.nextSibling);
  }
  const dF = page <= 1 ? 'disabled' : '';
  const dL = page >= pages ? 'disabled' : '';
  const from = total ? start + 1 : 0;
  pg.innerHTML = `
    <button class="ghost-button" data-pg="first" ${dF} title="First page">⏮</button>
    <button class="ghost-button" data-pg="prev"  ${dF} title="Previous page">◀</button>
    <span class="tbl-page-info">Page <b>${page}</b> of <b>${pages}</b>
      <span class="tbl-page-meta">· ${from}–${start + count} of ${total}</span></span>
    <button class="ghost-button" data-pg="next" ${dL} title="Next page">▶</button>
    <button class="ghost-button" data-pg="last" ${dL} title="Last page">⏭</button>`;
  pg.querySelectorAll('button[data-pg]').forEach(b => b.addEventListener('click', () => {
    const s = _pager[key]; if (!s) return;
    const p = Math.max(1, Math.ceil(s.rows.length / PAGE_SIZE));
    if (b.dataset.pg === 'first') s.page = 1;
    else if (b.dataset.pg === 'prev') s.page = Math.max(1, s.page - 1);
    else if (b.dataset.pg === 'next') s.page = Math.min(p, s.page + 1);
    else if (b.dataset.pg === 'last') s.page = p;
    _renderPage(key);
  }));
}

// Generic case-insensitive substring filter over a set of fields.
function _filterRows(rows, query, fields) {
  const q = (query || '').trim().toUpperCase();
  if (!q) return rows;
  return rows.filter(r => fields.some(f => String(r[f] == null ? '' : r[f]).toUpperCase().includes(q)));
}

async function loadParkingRecords() {
  const tb = $('pr-body'); if (!tb) return;
  try {
    const r = await fetch('/api/transactions?limit=500', { cache: 'no-store' });
    const js = await r.json();
    const q = ($('pr-search')?.value || '').trim().toUpperCase();
    const rows = (Array.isArray(js) ? js : []).filter(t => !q || (t.vehicle || '').toUpperCase().includes(q));
    if ($('pr-meta')) $('pr-meta').textContent = `${rows.length} record(s)`;
    paginate('pr', rows, 'pr-body', t => `<tr>
      <td style="font-family:monospace;">${_esc(t.vehicle) || '—'}</td>
      <td>${_esc(t.type) || '—'}</td>
      <td>${_fmtTs(t.entryAt)}</td>
      <td>${_fmtTs(t.exitAt)}</td>
      <td>${_dwell(t.entryAt, t.exitAt)}</td>
      <td>₹${t.total || 0}</td>
      <td>${_esc(t.payment) || '—'}</td>
      <td>${t.isActive ? '<span class="scan-status-badge scanning">Parked</span>' : '<span class="scan-status-badge granted">Exited</span>'}</td>
    </tr>`, 8);
  } catch (e) { tb.innerHTML = _emptyRow(8, 'Failed to load.'); }
}

async function loadScanningRecord() {
  const tb = $('sr-body'); if (!tb) return;
  try {
    const r = await fetch('/api/logs?limit=500', { cache: 'no-store' });
    const js = await r.json();
    const q = ($('sr-search')?.value || '').trim().toUpperCase();
    const rows = (Array.isArray(js) ? js : []).filter(l =>
      !q || (l.number_plate || '').toUpperCase().includes(q) || (l.rfid_tag || '').toUpperCase().includes(q));
    if ($('sr-meta')) $('sr-meta').textContent = `${rows.length} scan(s)`;
    const badge = (st) => /grant/i.test(st) ? '<span class="scan-status-badge granted">Granted</span>'
      : /den/i.test(st) ? '<span class="scan-status-badge denied">Denied</span>'
      : `<span class="scan-status-badge scanning">${_esc(st) || '—'}</span>`;
    paginate('sr', rows, 'sr-body', l => `<tr>
      <td>${_esc(l.timestamp)}</td>
      <td style="font-family:monospace;">${_esc(l.number_plate) || '—'}</td>
      <td style="font-family:monospace; font-size:0.88em;">${_esc(l.rfid_tag) || '—'}</td>
      <td>${_esc(l.owner_name) || '—'}</td>
      <td>${_esc(l.department) || '—'}</td>
      <td>${_esc(l.vehicle_type) || '—'}</td>
      <td>${badge(l.status)}</td>
    </tr>`, 7);
  } catch (e) { tb.innerHTML = _emptyRow(7, 'Failed to load.'); }
}

async function loadRegisteredVehicles() {
  const tb = $('rv-body'); if (!tb) return;
  try {
    const r = await fetch('/api/employees', { cache: 'no-store' });
    const js = await r.json();
    const q = ($('rv-search')?.value || '').trim().toUpperCase();
    const rows = (Array.isArray(js) ? js : []).filter(e =>
      !q || (e.number_plate || '').toUpperCase().includes(q) || (e.owner_name || '').toUpperCase().includes(q));
    if ($('rv-meta')) $('rv-meta').textContent = `${rows.length} vehicle(s)`;
    paginate('rv', rows, 'rv-body', e => {
      const pay = e.payment_method ? `${_esc(e.payment_method)} ₹${e.payment_amount || 0}` : '—';
      const badge = e.status === 'Active'
        ? '<span class="scan-status-badge granted">Active</span>'
        : '<span class="scan-status-badge denied">Expired</span>';
      const plate = (e.number_plate || '').startsWith('EMP-') ? '<i style="opacity:0.5;">(none)</i>' : (_esc(e.number_plate) || '—');
      return `<tr>
        <td>${_esc(e.owner_name) || '—'}</td>
        <td style="font-family:monospace;">${plate}</td>
        <td style="font-family:monospace; font-size:0.88em;">${_esc(e.rfid_tag) || '—'}</td>
        <td>${_esc(e.vehicle_type) || '—'}</td>
        <td>${_esc(e.department) || '—'}</td>
        <td>${pay}</td>
        <td>${_esc(e.valid_until) || '—'}</td>
        <td>${badge}</td>
      </tr>`;
    }, 8);
  } catch (e) { tb.innerHTML = _emptyRow(8, 'Failed to load.'); }
}

async function loadBlacklistView() {
  const tb = $('bl-body'); if (!tb) return;
  try {
    const r = await fetch('/api/blacklist', { cache: 'no-store' });
    const js = await r.json();
    const q = ($('bl-search')?.value || '').trim().toUpperCase();
    const rows = (Array.isArray(js) ? js : []).filter(b =>
      !q || (b.number_plate || '').toUpperCase().includes(q) || (b.rfid_tag || '').toUpperCase().includes(q));
    if ($('bl-meta')) $('bl-meta').textContent = `${rows.length} banned entr${rows.length === 1 ? 'y' : 'ies'}`;
    paginate('bl', rows, 'bl-body', b => `<tr>
      <td style="font-family:monospace;">${_esc(b.number_plate) || '—'}</td>
      <td style="font-family:monospace; font-size:0.88em;">${_esc(b.rfid_tag) || '—'}</td>
      <td>${_esc(b.reason) || '—'}</td>
      <td>${_esc(b.added_by) || '—'}</td>
      <td>${_esc(b.created_at) || '—'}</td>
    </tr>`, 5);
  } catch (e) { tb.innerHTML = _emptyRow(5, 'Failed to load.'); }
}

// Wire loaders: load when the section is opened, on search input, and on refresh.
const _liveLoaders = {
  'parking-records': loadParkingRecords,
  'scanning-record': loadScanningRecord,
  'registered':      loadRegisteredVehicles,
  'blacklist':       loadBlacklistView,
};
document.querySelectorAll('.nav-item, [data-jump]').forEach(btn => {
  const v = btn.dataset.view || btn.dataset.jump;
  if (v && _liveLoaders[v]) btn.addEventListener('click', () => setTimeout(_liveLoaders[v], 30));
});
$('pr-search')?.addEventListener('input', loadParkingRecords);
$('pr-refresh')?.addEventListener('click', loadParkingRecords);
$('sr-search')?.addEventListener('input', loadScanningRecord);
$('sr-refresh')?.addEventListener('click', loadScanningRecord);
$('rv-search')?.addEventListener('input', loadRegisteredVehicles);
$('bl-search')?.addEventListener('input', loadBlacklistView);

// Real-time: every 5s, refresh whichever live section is currently visible.
setInterval(() => {
  for (const [view, fn] of Object.entries(_liveLoaders)) {
    if (document.getElementById(view)?.classList.contains('active')) fn();
  }
}, 5000);

// ── Phase 3: Order Management / Yard Management / Region Management ───────────
async function loadOrders() {
  const tb = $('od-body'); if (!tb) return;
  try {
    const r = await fetch('/api/orders', { cache: 'no-store' });
    const js = await r.json();
    const q = ($('od-search')?.value || '').trim().toUpperCase();
    const ty = $('od-type')?.value || '';
    const rows = (Array.isArray(js) ? js : []).filter(o =>
      (!ty || o.type === ty) &&
      (!q || (o.order_no || '').toUpperCase().includes(q) || (o.plate || '').toUpperCase().includes(q)));
    if ($('od-meta')) $('od-meta').textContent = `${rows.length} order(s)`;
    paginate('od', rows, 'od-body', o => `<tr>
      <td style="font-family:monospace; font-size:0.88em;">${_esc(o.order_no)}</td>
      <td>${_esc(o.type)}</td>
      <td style="font-family:monospace;">${_esc(o.plate)}</td>
      <td>₹${o.amount || 0}</td>
      <td>${_esc(o.payment)}</td>
      <td>${_esc(o.created_at)}</td>
      <td>${_esc(o.admission)}</td>
      <td><span class="scan-status-badge ${o.status === 'Paid' ? 'granted' : 'scanning'}">${_esc(o.status)}</span></td>
    </tr>`, 8);
  } catch (e) { tb.innerHTML = _emptyRow(8, 'Failed to load.'); }
}

async function loadYards() {
  const tb = $('yard-body'); if (!tb) return;
  try {
    const r = await fetch('/api/yards', { cache: 'no-store' });
    const js = await r.json();
    const rows = _filterRows(Array.isArray(js) ? js : [], $('yard-search')?.value, ['name', 'region', 'location']);
    if ($('yard-meta')) $('yard-meta').textContent = `${rows.length} yard(s)`;
    paginate('yard', rows, 'yard-body', y => `<tr>
      <td><b>${_esc(y.name)}</b></td>
      <td>${y.capacity}</td>
      <td>${y.occupied}</td>
      <td>${y.available}</td>
      <td>${_esc(y.location) || '—'}</td>
      <td>${_esc(y.region) || '—'}</td>
      <td><button class="ghost-button" data-edit="${y.id}" data-edit-sec="yard" style="padding:4px 10px; font-size:0.8em; margin-right:4px;">Edit</button><button class="ghost-button yard-del" data-id="${y.id}"
             style="padding:4px 10px; font-size:0.8em; color:#b74a42;">Delete</button></td>
    </tr>`, 7, (tb) => {
      tb.querySelectorAll('.yard-del').forEach(b => b.addEventListener('click', async () => {
        if (!confirm('Delete this yard?')) return;
        await fetch(`/api/yards/${b.dataset.id}`, { method: 'DELETE' });
        loadYards();
      }));
    });
  } catch (e) { tb.innerHTML = _emptyRow(7, 'Failed to load.'); }
}

async function loadRegions() {
  const tb = $('region-body'); if (!tb) return;
  try {
    const r = await fetch('/api/regions', { cache: 'no-store' });
    const js = await r.json();
    const rows = _filterRows(Array.isArray(js) ? js : [], $('region-search')?.value, ['name', 'description']);
    if ($('region-meta')) $('region-meta').textContent = `${rows.length} region(s)`;
    paginate('region', rows, 'region-body', rg => `<tr>
      <td><b>${_esc(rg.name)}</b></td>
      <td>${rg.yard_count}</td>
      <td>${_esc(rg.description) || '—'}</td>
      <td>${_esc(rg.created_at)}</td>
      <td><button class="ghost-button" data-edit="${rg.id}" data-edit-sec="region" style="padding:4px 10px; font-size:0.8em; margin-right:4px;">Edit</button><button class="ghost-button region-del" data-id="${rg.id}"
             style="padding:4px 10px; font-size:0.8em; color:#b74a42;">Delete</button></td>
    </tr>`, 5, (tb) => {
      tb.querySelectorAll('.region-del').forEach(b => b.addEventListener('click', async () => {
        if (!confirm('Delete this region?')) return;
        await fetch(`/api/regions/${b.dataset.id}`, { method: 'DELETE' });
        loadRegions();
      }));
    });
    // Keep the Yard form's region dropdown in sync with existing regions.
    const sel = $('yard-region');
    if (sel) {
      const cur = sel.value;
      sel.innerHTML = '<option value="">— none —</option>' +
        rows.map(rg => `<option value="${_esc(rg.name)}">${_esc(rg.name)}</option>`).join('');
      sel.value = cur;
    }
  } catch (e) { tb.innerHTML = _emptyRow(5, 'Failed to load.'); }
}

// Add-yard form
$('yard-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = {
    name:     $('yard-name').value.trim(),
    capacity: parseInt($('yard-capacity').value, 10) || 0,
    location: $('yard-location').value.trim(),
    region:   $('yard-region').value,
  };
  const btn = $('yard-submit'); btn.disabled = true;
  try {
    const r = await fetch('/api/yards', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const js = await r.json();
    if (r.ok && js.status === 'ok') { toast(`✓ Yard "${body.name}" added`, 'ok'); $('yard-form').reset(); loadYards(); }
    else { toast('✗ ' + (js.message || 'Failed'), 'err'); }
  } catch (err) { toast('✗ Network error', 'err'); }
  finally { btn.disabled = false; }
});

// Add-region form
$('region-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = { name: $('region-name').value.trim(), description: $('region-desc').value.trim() };
  const btn = $('region-submit'); btn.disabled = true;
  try {
    const r = await fetch('/api/regions', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const js = await r.json();
    if (r.ok && js.status === 'ok') { toast(`✓ Region "${body.name}" added`, 'ok'); $('region-form').reset(); loadRegions(); }
    else { toast('✗ ' + (js.message || 'Failed'), 'err'); }
  } catch (err) { toast('✗ Network error', 'err'); }
  finally { btn.disabled = false; }
});

// Register the 3 new sections with the same open-on-click + live-refresh system.
Object.assign(_liveLoaders, {
  'orders': loadOrders,
  'yard':   () => { loadRegions(); loadYards(); },   // regions first so the dropdown fills
  'region': loadRegions,
});
document.querySelectorAll('.nav-item, [data-jump]').forEach(btn => {
  const v = btn.dataset.view || btn.dataset.jump;
  if (v && ['orders', 'yard', 'region'].includes(v)) {
    btn.addEventListener('click', () => setTimeout(_liveLoaders[v], 30));
  }
});
$('od-search')?.addEventListener('input', loadOrders);
$('od-type')?.addEventListener('change', loadOrders);
$('od-refresh')?.addEventListener('click', loadOrders);

// ── Phase 4: Member sub-menu / Type / Visitors / Equipment / Settings ────────
async function loadMembership() {
  const tb = $('mm-body'); if (!tb) return;
  try {
    const r = await fetch('/api/employees', { cache: 'no-store' });
    const js = await r.json();
    const q = ($('mm-search')?.value || '').trim().toUpperCase();
    const rows = (Array.isArray(js) ? js : []).filter(e =>
      !q || (e.owner_name || '').toUpperCase().includes(q) || (e.number_plate || '').toUpperCase().includes(q));
    if ($('mm-meta')) $('mm-meta').textContent = `${rows.length} member(s)`;
    paginate('mm', rows, 'mm-body', e => {
      const plan = e.activation_months ? `${e.activation_months} month${e.activation_months > 1 ? 's' : ''}` : '—';
      const badge = e.status === 'Active'
        ? '<span class="scan-status-badge granted">Active</span>'
        : '<span class="scan-status-badge denied">Expired</span>';
      return `<tr>
        <td><b>${_esc(e.owner_name) || '—'}</b></td>
        <td style="font-family:monospace;">${_esc(e.number_plate) || '—'}</td>
        <td style="font-family:monospace; font-size:0.88em;">${_esc(e.rfid_tag) || '—'}</td>
        <td>${_esc(e.department) || '—'}</td>
        <td>${plan}</td>
        <td>₹${e.payment_amount || 0}</td>
        <td>${_esc(e.valid_until) || '—'}</td>
        <td>${badge}</td>
      </tr>`;
    }, 8);
  } catch (e) { tb.innerHTML = _emptyRow(8, 'Failed to load.'); }
}

async function loadTypes() {
  const tb = $('tm-body'); if (!tb) return;
  try {
    const r = await fetch('/api/tariffs', { cache: 'no-store' });
    const js = await r.json();
    const rows = _filterRows(Array.isArray(js) ? js : [], $('tm-search')?.value, ['type', 'model']);
    if ($('tm-meta')) $('tm-meta').textContent = `${rows.length} type(s)`;
    paginate('tm', rows, 'tm-body', t => `<tr>
      <td><b>${_esc(t.type)}</b></td>
      <td>${_esc(t.model) || '—'}</td>
      <td>₹${t.rate || 0}/hr</td>
      <td>₹${t.dailyCap || 0}</td>
      <td>₹${t.lost || 0}</td>
    </tr>`, 5);
  } catch (e) { tb.innerHTML = _emptyRow(5, 'Failed to load.'); }
}

async function loadVisitorsView() {
  const tb = $('vis-body'); if (!tb) return;
  try {
    const r = await fetch('/api/visitors', { cache: 'no-store' });
    const js = await r.json();
    const rows = _filterRows(Array.isArray(js) ? js : [], $('vis-search')?.value,
      ['name', 'number_plate', 'contact', 'purpose', 'host_employee']);
    if ($('vis-meta')) $('vis-meta').textContent = `${rows.length} visitor(s)`;
    paginate('vis', rows, 'vis-body', v => {
      const st = (v.status || '').toLowerCase();
      const badge = st.includes('active') ? 'granted' : st.includes('expir') ? 'denied' : 'scanning';
      return `<tr>
        <td><b>${_esc(v.name)}</b></td>
        <td style="font-family:monospace;">${_esc(v.number_plate) || '—'}</td>
        <td>${_esc(v.contact) || '—'}</td>
        <td>${_esc(v.purpose) || '—'}</td>
        <td>${_esc(v.host_employee) || '—'}</td>
        <td>${_esc(v.start_at) || '—'}</td>
        <td>${_esc(v.end_at) || '—'}</td>
        <td><span class="scan-status-badge ${badge}">${_esc(v.status) || '—'}</span></td>
        <td><button class="ghost-button" data-edit="${v.id}" data-edit-sec="vis" style="padding:4px 10px; font-size:0.8em; margin-right:4px;">Edit</button><button class="ghost-button vis-del" data-id="${v.id}"
               style="padding:4px 10px; font-size:0.8em; color:#b74a42;">Delete</button></td>
      </tr>`;
    }, 9, (tb) => {
      tb.querySelectorAll('.vis-del').forEach(b => b.addEventListener('click', async () => {
        if (!confirm('Delete this visitor pass?')) return;
        await fetch(`/api/visitors/${b.dataset.id}`, { method: 'DELETE' });
        loadVisitorsView();
      }));
    });
  } catch (e) { tb.innerHTML = _emptyRow(9, 'Failed to load.'); }
}

$('vis-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = {
    name:          $('vis-name').value.trim(),
    number_plate:  $('vis-plate').value.trim(),
    contact:       $('vis-contact').value.trim(),
    purpose:       $('vis-purpose').value.trim(),
    host_employee: $('vis-host').value.trim(),
  };
  const btn = $('vis-submit'); btn.disabled = true;
  try {
    const r = await fetch('/api/visitors', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const js = await r.json();
    if (r.ok && (js.status === 'ok' || js.id)) { toast(`✓ Visitor "${body.name}" added`, 'ok'); $('vis-form').reset(); loadVisitorsView(); }
    else { toast('✗ ' + (js.message || 'Failed'), 'err'); }
  } catch (err) { toast('✗ Network error', 'err'); }
  finally { btn.disabled = false; }
});

async function loadEquipment() {
  const tb = $('eq-body'); if (!tb) return;
  try {
    const r = await fetch('/api/devices', { cache: 'no-store' });
    const js = await r.json();
    const rows = _filterRows(Array.isArray(js) ? js : [], $('eq-search')?.value, ['name', 'type', 'status']);
    if ($('eq-meta')) $('eq-meta').textContent = `${rows.length} device(s)`;
    const badge = (s) => /online|connected|ready|streaming/i.test(s)
      ? `<span class="scan-status-badge granted">${_esc(s)}</span>`
      : `<span class="scan-status-badge denied">${_esc(s)}</span>`;
    paginate('eq', rows, 'eq-body', d => `<tr>
      <td><b>${_esc(d.name)}</b></td>
      <td>${_esc(d.type)}</td>
      <td>${badge(d.status)}</td>
      <td>${_esc(d.lastSeen) || '—'}</td>
    </tr>`, 4);
  } catch (e) { tb.innerHTML = _emptyRow(4, 'Failed to load.'); }
}

async function loadBasicSettings() {
  try {
    const s = await (await fetch('/api/settings', { cache: 'no-store' })).json();
    if ($('sb-capacity')) $('sb-capacity').value = s.capacity ?? '';
    if ($('sb-zone'))     $('sb-zone').value     = s.default_entry_zone ?? '';
    if ($('sb-backup'))   $('sb-backup').value   = s.backup_schedule ?? '';
    if ($('se-entry-grace')) $('se-entry-grace').value = s.entry_grace_minutes ?? '';
    if ($('se-exit-grace'))  $('se-exit-grace').value  = s.exit_grace_minutes ?? '';
    if ($('se-cooldown'))    $('se-cooldown').value    = s.rescan_cooldown_seconds ?? '';
    if ($('se-auto-barrier')) $('se-auto-barrier').value = String(s.auto_open_barrier ?? '1');
  } catch (e) { /* ignore */ }
}

$('sb-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = {
    capacity:           parseInt($('sb-capacity').value, 10) || 0,
    default_entry_zone: $('sb-zone').value.trim(),
    backup_schedule:    $('sb-backup').value.trim(),
  };
  try {
    const r = await fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    toast(r.ok ? '✓ Basic settings saved' : '✗ Failed', r.ok ? 'ok' : 'err');
  } catch (err) { toast('✗ Network error', 'err'); }
});

$('se-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = {
    entry_grace_minutes:     parseInt($('se-entry-grace').value, 10) || 0,
    exit_grace_minutes:      parseInt($('se-exit-grace').value, 10) || 0,
    auto_open_barrier:       $('se-auto-barrier').value,
    rescan_cooldown_seconds: parseInt($('se-cooldown').value, 10) || 0,
  };
  try {
    const r = await fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    toast(r.ok ? '✓ Entry/Exit settings saved' : '✗ Failed', r.ok ? 'ok' : 'err');
  } catch (err) { toast('✗ Network error', 'err'); }
});

// Register Phase-4 sections with the open-on-click + live-refresh system.
Object.assign(_liveLoaders, {
  'membership':          loadMembership,
  'type-mgmt':           loadTypes,
  'visitors':            loadVisitorsView,
  'equipment':           loadEquipment,
  'settings-basic':      loadBasicSettings,
  'settings-entry-exit': loadBasicSettings,   // same endpoint feeds both forms
});
document.querySelectorAll('.nav-item, [data-jump]').forEach(btn => {
  const v = btn.dataset.view || btn.dataset.jump;
  if (v && _liveLoaders[v] && ['membership','type-mgmt','visitors','equipment','settings-basic','settings-entry-exit'].includes(v)) {
    btn.addEventListener('click', () => setTimeout(_liveLoaders[v], 30));
  }
});
$('mm-search')?.addEventListener('input', loadMembership);
$('vis-search')?.addEventListener('input', loadVisitorsView);

// ── Phase 5: System Management CRUD (Accounts / Roles / Dictionary) ──────────
async function loadAccounts() {
  const tb = $('acc-body'); if (!tb) return;
  try {
    const raw = await (await fetch('/api/accounts', { cache: 'no-store' })).json();
    const rows = _filterRows(Array.isArray(raw) ? raw : [], $('acc-search')?.value, ['name', 'nickname', 'contact', 'role']);
    if ($('acc-meta')) $('acc-meta').textContent = `${rows.length} account(s)`;
    paginate('acc', rows, 'acc-body', a => `<tr>
      <td><b>${_esc(a.name)}</b></td>
      <td>${_esc(a.nickname) || '—'}</td>
      <td>${_esc(a.contact) || '—'}</td>
      <td>${_esc(a.role) || '—'}</td>
      <td>${_esc(a.created_at)}</td>
      <td><button class="ghost-button" data-edit="${a.id}" data-edit-sec="acc" style="padding:4px 10px; font-size:0.8em; margin-right:4px;">Edit</button><button class="ghost-button acc-del" data-id="${a.id}" style="padding:4px 10px; font-size:0.8em; color:#b74a42;">Delete</button></td>
    </tr>`, 6, (tb) => {
      tb.querySelectorAll('.acc-del').forEach(b => b.addEventListener('click', async () => {
        if (!confirm('Delete this account?')) return;
        await fetch(`/api/accounts/${b.dataset.id}`, { method: 'DELETE' }); loadAccounts();
      }));
    });
  } catch (e) { tb.innerHTML = _emptyRow(6, 'Failed to load.'); }
}

async function loadRolesView() {
  const tb = $('rl-body'); if (!tb) return;
  try {
    const all = await (await fetch('/api/roles', { cache: 'no-store' })).json();
    const allRoles = Array.isArray(all) ? all : [];
    const rows = _filterRows(allRoles, $('rl-search')?.value, ['name', 'description']);
    if ($('rl-meta')) $('rl-meta').textContent = `${rows.length} role(s)`;
    paginate('rl', rows, 'rl-body', r => `<tr>
      <td><b>${_esc(r.name)}</b></td>
      <td>${r.account_count}</td>
      <td>${_esc(r.description) || '—'}</td>
      <td>${_esc(r.created_at)}</td>
      <td><button class="ghost-button" data-edit="${r.id}" data-edit-sec="rl" style="padding:4px 10px; font-size:0.8em; margin-right:4px;">Edit</button><button class="ghost-button rl-del" data-id="${r.id}" style="padding:4px 10px; font-size:0.8em; color:#b74a42;">Delete</button></td>
    </tr>`, 5, (tb) => {
      tb.querySelectorAll('.rl-del').forEach(b => b.addEventListener('click', async () => {
        if (!confirm('Delete this role?')) return;
        await fetch(`/api/roles/${b.dataset.id}`, { method: 'DELETE' }); loadRolesView();
      }));
    });
    // Feed the Account form's role dropdown.
    const sel = $('acc-role');
    if (sel) {
      const cur = sel.value;
      sel.innerHTML = '<option value="">— none —</option>' +
        allRoles.map(r => `<option value="${_esc(r.name)}">${_esc(r.name)}</option>`).join('');
      sel.value = cur;
    }
  } catch (e) { tb.innerHTML = _emptyRow(5, 'Failed to load.'); }
}

async function loadDictionary() {
  const tb = $('dc-body'); if (!tb) return;
  try {
    const raw = await (await fetch('/api/dictionary', { cache: 'no-store' })).json();
    const rows = _filterRows(Array.isArray(raw) ? raw : [], $('dc-search')?.value, ['category', 'key', 'value']);
    if ($('dc-meta')) $('dc-meta').textContent = `${rows.length} entr${rows.length === 1 ? 'y' : 'ies'}`;
    paginate('dc', rows, 'dc-body', d => `<tr>
      <td><b>${_esc(d.category)}</b></td>
      <td>${_esc(d.key)}</td>
      <td>${_esc(d.value) || '—'}</td>
      <td>${_esc(d.created_at)}</td>
      <td><button class="ghost-button" data-edit="${d.id}" data-edit-sec="dc" style="padding:4px 10px; font-size:0.8em; margin-right:4px;">Edit</button><button class="ghost-button dc-del" data-id="${d.id}" style="padding:4px 10px; font-size:0.8em; color:#b74a42;">Delete</button></td>
    </tr>`, 5, (tb) => {
      tb.querySelectorAll('.dc-del').forEach(b => b.addEventListener('click', async () => {
        if (!confirm('Delete this entry?')) return;
        await fetch(`/api/dictionary/${b.dataset.id}`, { method: 'DELETE' }); loadDictionary();
      }));
    });
  } catch (e) { tb.innerHTML = _emptyRow(5, 'Failed to load.'); }
}

function _wireAddForm(formId, btnId, buildBody, url, okMsg, reload) {
  $(formId)?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $(btnId); btn.disabled = true;
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(buildBody()) });
      const js = await r.json();
      if (r.ok && js.status === 'ok') { toast(okMsg, 'ok'); $(formId).reset(); reload(); }
      else { toast('✗ ' + (js.message || 'Failed'), 'err'); }
    } catch (err) { toast('✗ Network error', 'err'); }
    finally { btn.disabled = false; }
  });
}
_wireAddForm('acc-form', 'acc-submit', () => ({
  name: $('acc-name').value.trim(), nickname: $('acc-nick').value.trim(),
  contact: $('acc-contact').value.trim(), role: $('acc-role').value,
}), '/api/accounts', '✓ Account added', loadAccounts);
_wireAddForm('role-mgmt-form', 'rl-submit', () => ({
  name: $('rl-name').value.trim(), description: $('rl-desc').value.trim(),
}), '/api/roles', '✓ Role added', loadRolesView);
_wireAddForm('dict-form', 'dc-submit', () => ({
  category: $('dc-cat').value.trim(), key: $('dc-key').value.trim(), value: $('dc-val').value.trim(),
}), '/api/dictionary', '✓ Dictionary entry added', loadDictionary);

Object.assign(_liveLoaders, {
  'account':    () => { loadRolesView(); loadAccounts(); },  // roles first so dropdown fills
  'role':       loadRolesView,
  'dictionary': loadDictionary,
});
document.querySelectorAll('.nav-item, [data-jump]').forEach(btn => {
  const v = btn.dataset.view || btn.dataset.jump;
  if (v && ['account', 'role', 'dictionary'].includes(v)) {
    btn.addEventListener('click', () => setTimeout(_liveLoaders[v], 30));
  }
});

// Filter inputs for the CRUD/list tables that previously lacked one.
$('tm-search')?.addEventListener('input', loadTypes);
$('eq-search')?.addEventListener('input', loadEquipment);
$('yard-search')?.addEventListener('input', loadYards);
$('region-search')?.addEventListener('input', loadRegions);
$('acc-search')?.addEventListener('input', loadAccounts);
$('rl-search')?.addEventListener('input', loadRolesView);
$('dc-search')?.addEventListener('input', loadDictionary);

// ── Phase 6: generic Edit modal for all CRUD tables ──────────────────────────
// A single modal edits any row. The Edit button in each table row carries
// data-edit (id) + data-edit-sec (section key). We look the row up in the
// paginator's stored rows, populate the modal, and PUT on save. This never
// touches the Add forms, so create/edit stay independent.
const _editCrud = {
  acc:    { url: '/api/accounts', title: 'Edit Account', reload: () => loadAccounts(),
            fields: [{ k: 'name', label: 'Account Name' }, { k: 'nickname', label: 'Nickname' },
                     { k: 'contact', label: 'Contact' }, { k: 'role', label: 'Role', selectFrom: 'acc-role' }] },
  rl:     { url: '/api/roles', title: 'Edit Role', reload: () => loadRolesView(),
            fields: [{ k: 'name', label: 'Role Name' }, { k: 'description', label: 'Description' }] },
  dc:     { url: '/api/dictionary', title: 'Edit Dictionary Entry', reload: () => loadDictionary(),
            fields: [{ k: 'category', label: 'Category' }, { k: 'key', label: 'Key' }, { k: 'value', label: 'Value' }] },
  yard:   { url: '/api/yards', title: 'Edit Yard', reload: () => { loadRegions(); loadYards(); },
            fields: [{ k: 'name', label: 'Yard Name' }, { k: 'capacity', label: 'Capacity', type: 'number' },
                     { k: 'location', label: 'Location' }, { k: 'region', label: 'Region', selectFrom: 'yard-region' }] },
  region: { url: '/api/regions', title: 'Edit Region', reload: () => loadRegions(),
            fields: [{ k: 'name', label: 'Region Name' }, { k: 'description', label: 'Description' }] },
  vis:    { url: '/api/visitors', title: 'Edit Visitor', reload: () => loadVisitorsView(),
            fields: [{ k: 'name', label: 'Visitor Name' }, { k: 'number_plate', label: 'License Plate' },
                     { k: 'contact', label: 'Contact' }, { k: 'purpose', label: 'Purpose' },
                     { k: 'host_employee', label: 'Host Employee' }] },
};
let _editCtx = null;

function openEditModal(sec, id) {
  const cfg = _editCrud[sec]; if (!cfg) return;
  const row = (_pager[sec]?.rows || []).find(r => String(r.id) === String(id));
  if (!row) return;
  _editCtx = { sec, id };
  $('edit-modal-title').textContent = cfg.title;
  const host = $('edit-modal-fields');
  host.innerHTML = cfg.fields.map(f => {
    const val = row[f.k] != null ? row[f.k] : '';
    if (f.selectFrom) {
      const src = $(f.selectFrom);
      return `<label>${f.label}<select data-fk="${f.k}">${src ? src.innerHTML : ''}</select></label>`;
    }
    return `<label>${f.label}<input type="${f.type || 'text'}" data-fk="${f.k}" value="${_esc(val)}"></label>`;
  }).join('');
  // Set select values after the options are in the DOM.
  cfg.fields.filter(f => f.selectFrom).forEach(f => {
    const el = host.querySelector(`[data-fk="${f.k}"]`);
    if (el) el.value = row[f.k] != null ? row[f.k] : '';
  });
  $('edit-modal').style.display = 'flex';
}
function closeEditModal() { const m = $('edit-modal'); if (m) m.style.display = 'none'; _editCtx = null; }

$('edit-modal-cancel')?.addEventListener('click', closeEditModal);
$('edit-modal-x')?.addEventListener('click', closeEditModal);
$('edit-modal')?.addEventListener('click', (e) => { if (e.target.id === 'edit-modal') closeEditModal(); });
$('edit-modal-save')?.addEventListener('click', async () => {
  if (!_editCtx) return;
  const cfg = _editCrud[_editCtx.sec];
  const body = {};
  $('edit-modal-fields').querySelectorAll('[data-fk]').forEach(el => {
    body[el.dataset.fk] = el.type === 'number' ? (parseInt(el.value, 10) || 0) : el.value.trim();
  });
  const btn = $('edit-modal-save'); btn.disabled = true;
  try {
    const r = await fetch(`${cfg.url}/${_editCtx.id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const js = await r.json();
    if (r.ok && js.status === 'ok') { toast('✓ Updated', 'ok'); const reload = cfg.reload; closeEditModal(); reload(); }
    else { toast('✗ ' + (js.message || 'Failed'), 'err'); }
  } catch (e) { toast('✗ Network error', 'err'); }
  finally { btn.disabled = false; }
});
// Delegated: any [data-edit] button opens the modal for its section + id.
document.addEventListener('click', (e) => {
  const b = e.target.closest && e.target.closest('[data-edit]');
  if (b) openEditModal(b.dataset.editSec, b.dataset.edit);
});

// ── Phase 7: Monitoring Center (PDF p4) — Video Monitoring section ───────────
const _MC_DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function _mcSpread(s) {
  return (s && s !== '—') ? String(s).split('').join(' ') : '— — — — — — —';
}

function _mcSetCam(imgId) {
  const img = $(imgId); if (!img) return;
  const offline = img.nextElementSibling;
  img.onload  = () => { img.style.display = '';     if (offline) offline.style.display = 'none'; };
  img.onerror = () => { img.style.display = 'none'; if (offline) offline.style.display = 'flex'; };
  img.src = '/api/latest_frame.jpg?t=' + Date.now();
}

async function loadMonitoring() {
  if (!$('mc-clock')) return;
  // Clock + date (same layout as the PDF: time on one line, "yyyy-mm-dd" + day name).
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  $('mc-clock').textContent = `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  $('mc-date').innerHTML = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}<br>${_MC_DAYS[d.getDay()]}`;

  // Area 1 — Entrance: latest scan from /api/state (dashboard_state).
  try {
    const s = await (await fetch('/api/state', { cache: 'no-store' })).json();
    const plate = (s.latest_plate && !/wait/i.test(s.latest_plate)) ? s.latest_plate : '—';
    $('mc-entry-plate').textContent = plate;
    $('mc-entry-type').textContent  = s.vehicle_type || '—';
    $('mc-entry-time').textContent  = s.latest_tag_time || '—';
    $('mc-entry-mag').textContent   = _mcSpread(plate);
  } catch (e) { /* leave dashes */ }

  // Area 2 — Exit: most recent closed transaction.
  try {
    const txns = await (await fetch('/api/transactions?limit=1', { cache: 'no-store' })).json();
    const t = Array.isArray(txns) && txns[0];
    if (t) {
      $('mc-exit-plate').textContent  = t.vehicle || '—';
      $('mc-exit-type').textContent   = t.type    || '—';
      $('mc-exit-dwell').textContent  = _dwell(t.entryAt, t.exitAt);
      $('mc-exit-charge').textContent = '₹' + (t.total || 0);
      $('mc-exit-mag').textContent    = _mcSpread(t.vehicle);
    }
  } catch (e) { /* leave dashes */ }

  // Cache-bust the camera images so they refresh; onerror swaps in the offline
  // overlay (cloud can't reach the LAN cameras; on-site streams via MJPEG).
  _mcSetCam('mc-cam-entry');
  _mcSetCam('mc-cam-exit');
}

// Wire to the open-on-click + 5s live-refresh system.
Object.assign(_liveLoaders, { 'video': loadMonitoring });
document.querySelectorAll('.nav-item, [data-jump]').forEach(btn => {
  if ((btn.dataset.view || btn.dataset.jump) === 'video') {
    btn.addEventListener('click', () => setTimeout(loadMonitoring, 30));
  }
});
// Tick the clock every second while the Monitoring Center is visible.
setInterval(() => {
  if (document.getElementById('video')?.classList.contains('active')) {
    const d = new Date(); const p = (n) => String(n).padStart(2, '0');
    if ($('mc-clock')) $('mc-clock').textContent = `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }
}, 1000);

// ── Phase 8: Home Page summary (PDF p5 layout) — gradient cards + charts ─────
function _hsAnimateValue(elId, target) {
  const el = $(elId); if (!el) return;
  const start = parseInt(el.textContent.replace(/[^\d-]/g, ''), 10) || 0;
  const dur = 600; const t0 = performance.now();
  function step(now) {
    const t = Math.min(1, (now - t0) / dur);
    el.textContent = Math.round(start + (target - start) * t).toLocaleString();
    if (t < 1) requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}

function _hsRenderBars(daily) {
  const root = $('hs-bar-chart'); if (!root) return;
  if (!daily || !daily.length) { root.innerHTML = '<div style="margin:auto; color:var(--muted);">No data</div>'; return; }
  const maxV = Math.max(1, ...daily.flatMap(d => [d.entries, d.exits]));
  root.innerHTML = daily.map(d => {
    const ePct = (d.entries / maxV) * 100;
    const xPct = (d.exits / maxV) * 100;
    return `<div class="home-bar-group">
      <div class="home-bar" style="height:${ePct}%;">${d.entries ? `<span class="home-bar-value">${d.entries}</span>` : ''}</div>
      <div class="home-bar home-bar-exit" style="height:${xPct}%;">${d.exits ? `<span class="home-bar-value">${d.exits}</span>` : ''}</div>
      <span class="home-bar-label">${d.date.slice(5)}</span>
    </div>`;
  }).join('');
}

function _hsRenderDonut(temp, member) {
  const svg = $('hs-donut'); if (!svg) return;
  const total = temp + member;
  const R = 80, CX = 100, CY = 100, SW = 28;
  const circ = 2 * Math.PI * R;
  if (!total) {
    svg.innerHTML = `<circle cx="${CX}" cy="${CY}" r="${R}" fill="none" stroke="#e5e9ef" stroke-width="${SW}"/>`;
  } else {
    const tempFrac = temp / total;
    const tempLen  = circ * tempFrac;
    const memLen   = circ * (1 - tempFrac);
    svg.innerHTML = `
      <circle cx="${CX}" cy="${CY}" r="${R}" fill="none" stroke="#2cd47f" stroke-width="${SW}"
        stroke-dasharray="${tempLen} ${circ - tempLen}" stroke-dashoffset="0"/>
      <circle cx="${CX}" cy="${CY}" r="${R}" fill="none" stroke="#f59e0b" stroke-width="${SW}"
        stroke-dasharray="${memLen} ${circ - memLen}" stroke-dashoffset="-${tempLen}"/>
    `;
  }
  if ($('hs-income-total')) $('hs-income-total').textContent = '₹' + total.toLocaleString();
  if ($('hs-income-temp'))  $('hs-income-temp').textContent  = '₹' + temp.toLocaleString();
  if ($('hs-income-mem'))   $('hs-income-mem').textContent   = '₹' + member.toLocaleString();
}

async function loadHomeSummary() {
  if (!$('hs-parking-total')) return;
  try {
    const s = await (await fetch('/api/home_summary', { cache: 'no-store' })).json();
    _hsAnimateValue('hs-parking-total', s.parking_total || 0);
    _hsAnimateValue('hs-member-total',  s.member_total  || 0);
    _hsAnimateValue('hs-device-total',  s.device_total  || 0);
    _hsAnimateValue('hs-order-total',   s.order_total   || 0);
    _hsRenderBars(s.daily || []);
    _hsRenderDonut(s.income?.temporary || 0, s.income?.member || 0);
  } catch (e) { /* ignore */ }
}

// Register with the open-on-click + 5s live-refresh system.
Object.assign(_liveLoaders, { 'dashboard': loadHomeSummary });
document.querySelectorAll('.nav-item, [data-jump]').forEach(btn => {
  if ((btn.dataset.view || btn.dataset.jump) === 'dashboard') {
    btn.addEventListener('click', () => setTimeout(loadHomeSummary, 30));
  }
});
// Load once on page load so the dashboard (default view) populates immediately.
loadHomeSummary();
