/* ParkVision Pro · VAY ParkOps integration
 * Drives view switching + live data binding for Dashboard, Devices, Admin.
 * Entry/Exit/Tariffs/Reports are scaffolded placeholders for now.
 */

// ── Session gate ─────────────────────────────────────────────────────────────
// Run BEFORE the rest of this file does any work. If /api/me reports the user
// is not logged in and we're on the dashboard root, bounce to /login. We keep
// this fire-and-forget — the rest of the page still hydrates, but any
// protected /api/* calls will 401 and the user lands on /login almost
// immediately anyway.
window.__currentUser = null;
(function _gateSession() {
  const path = window.location.pathname || '/';
  // /login and /v/* are public; never redirect them from here.
  if (path === '/login' || path.indexOf('/v/') === 0) return;
  fetch('/api/me', { cache: 'no-store', credentials: 'same-origin' })
    .then(r => r.ok ? r.json() : { logged_in: false })
    .then(js => {
      if (!js || js.logged_in !== true) {
        // Only force the redirect on the dashboard root — sub-pages may be
        // served standalone (e.g. /activate) and shouldn't be hijacked.
        if (path === '/') window.location.href = '/login';
        return;
      }
      window.__currentUser = { id: js.id, name: js.name, role: js.role || '' };
      _hydrateTopbarUser();
      // Sidebar filter runs after DOM is ready + currentUser known.
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', applyMenuPermissions);
      } else {
        applyMenuPermissions();
      }
    })
    .catch(() => { /* network blip — skip silently */ });
})();

function _hydrateTopbarUser() {
  const u = window.__currentUser;
  if (!u) return;
  // Topbar chip — show username + caret; full info in the dropdown.
  const nameEl = document.getElementById('topbar-username');
  if (nameEl) {
    // Preserve the caret span if it exists, otherwise inject it.
    const caret = nameEl.querySelector('.topbar-caret');
    nameEl.textContent = u.name || '';
    if (caret) nameEl.appendChild(caret);
    else nameEl.insertAdjacentHTML('beforeend', ' <span class="topbar-caret">▾</span>');
  }
  const av = document.getElementById('topbar-avatar');
  if (av) av.textContent = (u.name || '?').trim().charAt(0).toUpperCase();
  const infoName = document.getElementById('topbar-user-info-name');
  if (infoName) infoName.textContent = u.name || '—';
  const infoRole = document.getElementById('topbar-user-info-role');
  if (infoRole) infoRole.textContent = u.role || 'No role assigned';
  // Welcome line in the topbar header. Replaces the hardcoded "Hello root".
  const greeting = document.getElementById('welcome-greeting');
  if (greeting && u.name) {
    greeting.textContent = `Hello ${u.name}, Welcome to VayAccess Management System`;
  }
}

// Topbar user dropdown — click to toggle, click-outside or Escape to close,
// Logout item posts to /api/logout then hard-redirects to /login.
document.addEventListener('DOMContentLoaded', function () {
  const wrap = document.getElementById('topbar-user');
  const menu = document.getElementById('topbar-user-menu');
  const logoutBtn = document.getElementById('topbar-logout');
  if (!wrap || !menu) return;

  function setOpen(open) {
    wrap.setAttribute('aria-expanded', String(!!open));
    if (open) menu.removeAttribute('hidden');
    else      menu.setAttribute('hidden', '');
  }

  // Toggle on click of the chip (but ignore clicks inside the menu itself —
  // those are handled by the menu items' own listeners).
  wrap.addEventListener('click', function (e) {
    if (menu.contains(e.target)) return;
    setOpen(wrap.getAttribute('aria-expanded') !== 'true');
  });
  // Keyboard: Enter/Space toggles, Escape closes.
  wrap.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen(wrap.getAttribute('aria-expanded') !== 'true'); }
    if (e.key === 'Escape') setOpen(false);
  });
  // Click outside closes.
  document.addEventListener('click', function (e) {
    if (!wrap.contains(e.target)) setOpen(false);
  });
  // Logout.
  if (logoutBtn) {
    logoutBtn.addEventListener('click', async function () {
      try { await fetch('/api/logout', { method: 'POST', credentials: 'same-origin' }); }
      catch (_) { /* bounce to login even if the call fails */ }
      window.location.href = '/login';
    });
  }
});

// applyMenuPermissions — hide sidebar items the current role isn't allowed
// to see. Administrator bypasses entirely. Filter is best-effort: a missing
// row defaults to allowed so an admin who hasn't configured permissions yet
// still has a working UI.
async function applyMenuPermissions() {
  const cur = window.__currentUser;
  if (!cur) return;
  if ((cur.role || '').trim().toLowerCase() === 'administrator') return;
  try {
    const res = await fetch('/api/menu_permissions', { cache: 'no-store', credentials: 'same-origin' });
    if (!res.ok) return;
    const all = await res.json();
    if (!Array.isArray(all)) return;
    const blocked = new Set(
      all.filter(p => (p.role_name || '').trim().toLowerCase() === (cur.role || '').trim().toLowerCase())
         .filter(p => p.allowed === false)
         .map(p => p.menu_key));
    if (!blocked.size) return;
    document.querySelectorAll('.nav-item[data-view]').forEach(btn => {
      if (blocked.has(btn.dataset.view)) btn.style.display = 'none';
    });
  } catch (_) { /* ignore — sidebar stays open */ }
}

const $ = (id) => document.getElementById(id);

// ── View switching (sidebar nav) ─────────────────────────────────────────────
// Branded view-switch loader: brief logo+spinner overlay shown every time
// the user picks a section so the transition feels intentional.
function showViewLoader(minMs) {
  const el = document.getElementById('view-loader');
  if (!el) return;
  el.hidden = false;
  el.setAttribute('aria-hidden', 'false');
  clearTimeout(showViewLoader._t);
  showViewLoader._t = setTimeout(() => {
    el.hidden = true;
    el.setAttribute('aria-hidden', 'true');
  }, minMs || 450);
}

function switchView(name) {
  showViewLoader();
  document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.id === name));
  document.querySelectorAll('.nav-item').forEach(b => b.classList.toggle('active',
                                                                        b.dataset.view === name));
  // Labels match the WeParking sidebar from VAY Parking Management.pdf.
  const titleMap = {
    dashboard: 'Home Page',          solutions: 'Parking Solutions',
    printer: 'Printer & Ticketing',
    reports: 'Statistical Management',
    video: 'Video Monitoring',       'parking-records': 'Parking Records',
    'scanning-record': 'Scanning Record', devices: 'Lane Monitoring',
    exit: 'Manual Exit Record',      orders: 'Order Management',
    'manual-entry': 'Manual Entry',
    admin: 'Whitelist',              registered: 'Registered Vehicle',
    blacklist: 'Black List',         yard: 'Parking Facility',
    region: 'Region Management',     entry: 'Entry', tariffs: 'Tariffs',
    membership: 'Monthly Membership', 'type-mgmt': 'Type Management',
    visitors: 'Visitor Management',  equipment: 'Equipment Management',
    'settings-basic': 'Basic Settings', 'settings-entry-exit': 'Entry / Exit Settings',
    account: 'Account Management',   lcd: 'LCD Display',
    'menu-mgmt': 'Menu Management',  role: 'Role Management',
    'role-perm': 'Role Permission',  dictionary: 'Dictionary Managed',
    'audit-log': 'Audit Log',         'uhf-captures': 'UHF Captures',
    'driver-users': 'Driver Users (Mobile)',
    'park-book': 'Book Parking',      'park-live': 'Live Parking Dashboard',
    'park-setup': 'Parking Setup',
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
      tb.innerHTML = `<tr><td colspan="12" style="text-align:center; opacity:0.6; padding:20px;">No access events match the filters.</td></tr>`;
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
      // UHF capture photos (attached server-side in /api/logs by joining
      // access_logs with uhf_entry_events on tag + timestamp ±30s).
      const photoCell = (full, plate) => {
        if (!full && !plate) return '<span style="opacity:0.4;">—</span>';
        const t = (fn, lbl) => fn
          ? `<a href="/image/${encodeURIComponent(fn)}" target="_blank" rel="noopener" title="${lbl}"><img src="/image/${encodeURIComponent(fn)}" alt="${lbl}" style="width:48px; height:32px; object-fit:cover; border-radius:4px; border:1px solid var(--line); display:block;"></a>`
          : '';
        return `<div style="display:flex; gap:4px;">${t(full, 'Vehicle')}${t(plate, 'Plate')}</div>`;
      };
      return `
      <tr>
        <td>${photoCell(l.full_image, l.plate_image)}</td>
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
    tb.innerHTML = `<tr><td colspan="12" style="text-align:center; color: #b74a42; padding:20px;">Failed to load access events: ${err.message}</td></tr>`;
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
    // Multi-field Search Conditions: Plate / Vehicle Type / Match Status /
    // Entry from / Entry to.
    const plate = ($('pr-search')?.value || '').trim().toUpperCase();
    const vty   = $('pr-type')?.value   || '';
    const st    = $('pr-status')?.value || '';   // '' | 'parked' | 'exited'
    const dFrom = $('pr-from')?.value || '';
    const dTo   = $('pr-to')?.value   || '';
    const rows = (Array.isArray(js) ? js : []).filter(t => {
      if (plate && !(t.vehicle || '').toUpperCase().includes(plate)) return false;
      if (vty   && t.type !== vty) return false;
      if (st === 'parked' && !t.isActive) return false;
      if (st === 'exited' &&  t.isActive) return false;
      if ((dFrom || dTo) && t.entryAt) {
        const day = new Date(t.entryAt).toISOString().slice(0, 10);
        if (dFrom && day < dFrom) return false;
        if (dTo   && day > dTo)   return false;
      }
      return true;
    });
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
        <td style="font-family:monospace; font-size:0.88em;">${_esc(e.barcode) || '—'}</td>
        <td style="font-family:monospace; font-size:0.88em;">${_esc(e.rfid_tag) || '—'}</td>
        <td>${_esc(e.vehicle_type) || '—'}</td>
        <td>${_esc(e.department) || '—'}</td>
        <td>${pay}</td>
        <td>${_esc(e.valid_until) || '—'}</td>
        <td>${badge}</td>
        <td><button class="ghost-button" data-qr data-qr-kind="member" data-qr-id="${e.id}"
            data-qr-title="Member Pass — ${_esc(e.owner_name) || ''}"
            data-qr-meta="<b>${_esc(e.owner_name) || '—'}</b><br>Plate: ${plate}<br>Barcode: ${_esc(e.barcode) || '—'}<br>UHF: ${_esc(e.rfid_tag) || '—'}<br>Dept: ${_esc(e.department) || '—'}<br>Valid until: ${_esc(e.valid_until) || '—'}"
            style="padding:4px 10px; font-size:0.8em; margin-right:4px;">QR</button><button class="ghost-button" data-wa data-wa-kind="m" data-wa-id="${e.id}"
            data-wa-phone="${_esc((e.contact_number||'').replace(/\\D/g,''))}"
            data-wa-name="${_esc(e.owner_name) || ''}"
            style="padding:4px 10px; font-size:0.8em; background:#25d366; color:#fff; border-color:#1ea152;">WhatsApp</button></td>
      </tr>`;
    }, 10);
  } catch (e) { tb.innerHTML = _emptyRow(10, 'Failed to load.'); }
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
      <td style="font-family:monospace; font-size:0.88em;">${_esc(b.barcode) || '—'}</td>
      <td style="font-family:monospace; font-size:0.88em;">${_esc(b.rfid_tag) || '—'}</td>
      <td>${_esc(b.reason) || '—'}</td>
      <td>${_esc(b.added_by) || '—'}</td>
      <td>${_esc(b.created_at) || '—'}</td>
    </tr>`, 6);
  } catch (e) { tb.innerHTML = _emptyRow(6, 'Failed to load.'); }
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
    // Multi-field Search Conditions: Order Number / Type / Status / Plate /
    // Start Time / End Time — each empty = no constraint.
    const orderNo = ($('od-search')?.value || '').trim().toUpperCase();
    const orderTy = $('od-type')?.value || '';
    const orderSt = $('od-status')?.value || '';
    const plate   = ($('od-plate')?.value || '').trim().toUpperCase();
    const dFrom   = $('od-from')?.value || '';
    const dTo     = $('od-to')?.value || '';
    const rows = (Array.isArray(js) ? js : []).filter(o => {
      if (orderNo && !(o.order_no || '').toUpperCase().includes(orderNo)) return false;
      if (orderTy && o.type   !== orderTy) return false;
      if (orderSt && o.status !== orderSt) return false;
      if (plate   && !(o.plate || '').toUpperCase().includes(plate))   return false;
      const day = (o.created_at || '').slice(0, 10);  // "yyyy-mm-dd"
      if (dFrom && day && day < dFrom) return false;
      if (dTo   && day && day > dTo)   return false;
      return true;
    });
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
// Extra Search Conditions fields for Order Management (PDF p13 pattern).
$('od-status')?.addEventListener('change', loadOrders);
$('od-plate') ?.addEventListener('input',  loadOrders);
$('od-from')  ?.addEventListener('change', loadOrders);
$('od-to')    ?.addEventListener('change', loadOrders);
$('od-reset') ?.addEventListener('click', () => {
  ['od-status', 'od-type', 'od-search', 'od-plate', 'od-from', 'od-to']
    .forEach(id => { const el = $(id); if (el) el.value = ''; });
  loadOrders();
});
// Extra Search Conditions fields for Parking Records (PDF p8 pattern).
$('pr-type')  ?.addEventListener('change', loadParkingRecords);
$('pr-status')?.addEventListener('change', loadParkingRecords);
$('pr-from')  ?.addEventListener('change', loadParkingRecords);
$('pr-to')    ?.addEventListener('change', loadParkingRecords);
$('pr-reset') ?.addEventListener('click', () => {
  ['pr-search', 'pr-type', 'pr-status', 'pr-from', 'pr-to']
    .forEach(id => { const el = $(id); if (el) el.value = ''; });
  loadParkingRecords();
});

// ── Phase 10: per-table Refresh + CSV Export + Member-expiry alerts ──────────
// Each data table's panel-head gets a small action group (Refresh + 📥 CSV)
// injected once at load. Avoids editing every section's HTML by hand.
const _exportCfg = {
  pr:     { loader: 'parking-records', name: 'parking-records',
            cols: [['vehicle','License Plate'],['type','Vehicle Type'],['entryAt','Entry Time'],['exitAt','Exit Time'],['total','Amount'],['payment','Payment'],['isActive','Active']] },
  sr:     { loader: 'scanning-record', name: 'scanning-record',
            cols: [['timestamp','Scan Time'],['number_plate','License Plate'],['rfid_tag','Tag (EPC)'],['owner_name','Owner'],['department','Department'],['vehicle_type','Type'],['status','Status']] },
  rv:     { loader: 'registered', name: 'registered-vehicles',
            cols: [['owner_name','Owner'],['number_plate','License Plate'],['rfid_tag','Tag (EPC)'],['vehicle_type','Type'],['department','Department'],['payment_method','Payment'],['payment_amount','Amount'],['valid_until','Valid Until'],['status','Status']] },
  bl:     { loader: 'blacklist', name: 'blacklist',
            cols: [['number_plate','License Plate'],['rfid_tag','Tag (EPC)'],['reason','Reason'],['added_by','Added By'],['created_at','Added On']] },
  od:     { loader: 'orders', name: 'orders',
            cols: [['order_no','Order Number'],['type','Order Type'],['plate','License Plate'],['amount','Amount'],['payment','Payment'],['created_at','Created'],['admission','Admission'],['status','Status']] },
  mm:     { loader: 'membership', name: 'monthly-membership',
            cols: [['owner_name','Member'],['number_plate','License Plate'],['rfid_tag','Tag (EPC)'],['department','Department'],['activation_months','Plan (months)'],['payment_amount','Amount'],['valid_until','Valid Until'],['status','Status']] },
  tm:     { loader: 'type-mgmt', name: 'vehicle-types',
            cols: [['type','Vehicle Type'],['model','Tariff Model'],['rate','Hourly Rate'],['dailyCap','Daily Cap'],['lost','Lost Ticket']] },
  vis:    { loader: 'visitors', name: 'visitors',
            cols: [['name','Visitor'],['number_plate','License Plate'],['contact','Contact'],['purpose','Purpose'],['host_employee','Host'],['start_at','Valid From'],['end_at','Valid To'],['status','Status']] },
  eq:     { loader: 'equipment', name: 'equipment',
            cols: [['name','Device'],['type','Type'],['status','Status'],['lastSeen','Last Seen']] },
  yard:   { loader: 'yard', name: 'yards',
            cols: [['name','Yard'],['capacity','Capacity'],['occupied','Occupied'],['available','Available'],['location','Location'],['region','Region']] },
  region: { loader: 'region', name: 'regions',
            cols: [['name','Region'],['yard_count','Yards'],['description','Description'],['created_at','Created']] },
  acc:    { loader: 'account', name: 'accounts',
            cols: [['name','Account'],['nickname','Nickname'],['contact','Contact'],['role','Role'],['created_at','Created']] },
  rl:     { loader: 'role', name: 'roles',
            cols: [['name','Role'],['account_count','Accounts'],['description','Description'],['created_at','Created']] },
  dc:     { loader: 'dictionary', name: 'dictionary',
            cols: [['category','Category'],['key','Key'],['value','Value'],['created_at','Created']] },
};

function _csvEscape(v) {
  if (v == null) return '';
  let s = String(v);
  // Convert millisecond timestamps to ISO date for time fields.
  if (typeof v === 'number' && v > 1_000_000_000_000) {
    try { s = new Date(v).toISOString().replace('T', ' ').slice(0, 19); } catch (e) {}
  }
  // Excel auto-formats date-looking strings into a date type that shows as
  // ##### whenever the column is too narrow. Force text rendering via the
  // ="…" formula trick so dates ALWAYS display in full regardless of width.
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
    return `="${s.replace(/"/g, '""')}"`;
  }
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function exportTableCSV(key) {
  const cfg = _exportCfg[key]; if (!cfg) return;
  const rows = _pager[key]?.rows || [];
  if (!rows.length) { toast('Nothing to export', 'err'); return; }
  const header = cfg.cols.map(c => c[1]).join(',');
  const body = rows.map(r => cfg.cols.map(([k]) => _csvEscape(r[k])).join(',')).join('\n');
  // UTF-8 BOM (﻿) so Excel opens the CSV with the right encoding instead
  // of mojibake-ing rupee signs and Indian script.
  const blob = new Blob(['﻿', header + '\n' + body], { type: 'text/csv;charset=utf-8;' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${cfg.name}-${new Date().toISOString().slice(0,10)}.csv`;
  document.body.appendChild(a); a.click(); setTimeout(() => { a.remove(); URL.revokeObjectURL(a.href); }, 0);
}

// Inject Refresh + 📥 CSV buttons into every data table's panel-head once.
function _injectTableActions() {
  Object.keys(_exportCfg).forEach(key => {
    const cfg = _exportCfg[key];
    const tbl = document.getElementById(`${key}-table`); if (!tbl) return;
    const panel = tbl.closest('.panel');
    const head  = panel && panel.querySelector('.panel-head');
    if (!head || head.querySelector('.table-actions')) return;  // already done
    const actions = document.createElement('div');
    actions.className = 'table-actions';
    actions.innerHTML = `
      <button class="ghost-button" data-refresh="${cfg.loader}" title="Refresh">↻</button>
      <button class="ghost-button" data-export-key="${key}" title="Export CSV">📥 CSV</button>`;
    head.appendChild(actions);
  });
}
_injectTableActions();

// Delegated: refresh + export.
document.addEventListener('click', (e) => {
  const ref = e.target.closest && e.target.closest('[data-refresh]');
  if (ref) {
    const fn = _liveLoaders[ref.dataset.refresh];
    if (fn) { fn(); toast('↻ Refreshed', 'ok'); }
    return;
  }
  const exp = e.target.closest && e.target.closest('[data-export-key]');
  if (exp) { exportTableCSV(exp.dataset.exportKey); return; }
});

// Member-expiry alerts on the dashboard. Renders a banner+list of members
// whose validity ends in the next 14 days OR has already passed (Expired).
async function loadExpiryAlerts() {
  const host = $('hs-expiry-host'); if (!host) return;
  try {
    const all = await (await fetch('/api/employees', { cache: 'no-store' })).json();
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const horizon = new Date(today.getTime() + 14 * 86_400_000);
    const items = (Array.isArray(all) ? all : [])
      .filter(e => e.valid_until)
      .map(e => ({ ...e, _vd: new Date(e.valid_until + 'T00:00:00') }))
      .filter(e => e._vd <= horizon)
      .sort((a, b) => a._vd - b._vd);
    if (!items.length) { host.style.display = 'none'; return; }
    host.style.display = '';
    $('hs-expiry-count').textContent = items.length;
    $('hs-expiry-list').innerHTML = items.slice(0, 12).map(e => {
      const days = Math.ceil((e._vd - today) / 86_400_000);
      const tag = days < 0 ? `<span style="color:#b74a42; font-weight:700;">Expired ${Math.abs(days)}d ago</span>`
        : days === 0 ? `<span style="color:#b74a42; font-weight:700;">Expires today</span>`
        : `<span style="color:#a87217; font-weight:700;">${days}d left</span>`;
      return `<div class="hs-expiry-item">
        <span><b>${_esc(e.owner_name) || '—'}</b> <span style="opacity:0.6;">${_esc(e.number_plate) || '—'}</span></span>
        <span style="font-size:0.85em;">${_esc(e.valid_until)} · ${tag}</span>
      </div>`;
    }).join('') + (items.length > 12 ? `<div style="opacity:0.7; font-size:0.85em; margin-top:6px;">+${items.length - 12} more</div>` : '');
  } catch (e) { /* ignore */ }
}
// Update the dashboard's live-refresh hook so the 5s tick AND nav-click
// refresh the expiry alerts alongside the home summary. (Just replacing the
// _liveLoaders.dashboard reference — no need to mutate loadHomeSummary itself.)
_liveLoaders.dashboard = async function () {
  await loadHomeSummary();
  await loadExpiryAlerts();
};
// Initial load of expiry alerts (home summary was already loaded above).
loadExpiryAlerts();

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
        <td><button class="ghost-button" data-qr data-qr-kind="member" data-qr-id="${e.id}"
            data-qr-title="Member Pass — ${_esc(e.owner_name) || ''}"
            data-qr-meta="<b>${_esc(e.owner_name) || '—'}</b><br>Plate: ${_esc(e.number_plate) || '—'}<br>Tag: ${_esc(e.rfid_tag) || '—'}<br>Dept: ${_esc(e.department) || '—'}<br>Valid until: ${_esc(e.valid_until) || '—'}"
            style="padding:4px 10px; font-size:0.8em; margin-right:4px;">QR</button><button class="ghost-button" data-wa data-wa-kind="m" data-wa-id="${e.id}"
            data-wa-phone="${_esc((e.contact_number||'').replace(/\\D/g,''))}"
            data-wa-name="${_esc(e.owner_name) || ''}"
            style="padding:4px 10px; font-size:0.8em; background:#25d366; color:#fff; border-color:#1ea152;">WhatsApp</button></td>
      </tr>`;
    }, 9);
  } catch (e) { tb.innerHTML = _emptyRow(9, 'Failed to load.'); }
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
        <td>
          <button class="ghost-button" data-qr data-qr-kind="visitor" data-qr-id="${v.id}"
                  data-qr-title="Visitor Pass — ${_esc(v.name)}"
                  data-qr-meta="<b>${_esc(v.name)}</b><br>Plate: ${_esc(v.number_plate) || '—'}<br>Host: ${_esc(v.host_employee) || '—'}<br>Valid: ${_esc(v.start_at) || '—'} → ${_esc(v.end_at) || '—'}"
                  style="padding:4px 10px; font-size:0.8em; margin-right:4px;">QR</button><button class="ghost-button" data-wa data-wa-kind="v" data-wa-id="${v.id}"
                  data-wa-phone="${_esc((v.contact||'').replace(/\\D/g,''))}"
                  data-wa-name="${_esc(v.name)}"
                  style="padding:4px 10px; font-size:0.8em; margin-right:4px; background:#25d366; color:#fff; border-color:#1ea152;">WhatsApp</button><button class="ghost-button" data-edit="${v.id}" data-edit-sec="vis" style="padding:4px 10px; font-size:0.8em; margin-right:4px;">Edit</button><button class="ghost-button vis-del" data-id="${v.id}"
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
      <td>
        <button class="ghost-button" data-edit="${a.id}" data-edit-sec="acc" style="padding:4px 10px; font-size:0.8em; margin-right:4px;">Edit</button>
        <button class="ghost-button acc-pwd" data-id="${a.id}" data-name="${_esc(a.name)}" style="padding:4px 10px; font-size:0.8em; margin-right:4px;">Change Password</button>
        <button class="ghost-button acc-del" data-id="${a.id}" style="padding:4px 10px; font-size:0.8em; color:#b74a42;">Delete</button>
      </td>
    </tr>`, 6, (tb) => {
      tb.querySelectorAll('.acc-del').forEach(b => b.addEventListener('click', async () => {
        if (!confirm('Delete this account?')) return;
        await fetch(`/api/accounts/${b.dataset.id}`, { method: 'DELETE' }); loadAccounts();
      }));
      // Change Password: two prompts (new + confirm). window.prompt is OK
      // per the task spec — keeps the row UI from getting cluttered.
      tb.querySelectorAll('.acc-pwd').forEach(b => b.addEventListener('click', async () => {
        const name = b.dataset.name || 'account';
        const p1 = window.prompt(`Set new password for "${name}":`, '');
        if (p1 === null) return;
        if ((p1 || '').length < 4) { toast('✗ Password must be at least 4 characters', 'err'); return; }
        const p2 = window.prompt('Re-enter new password to confirm:', '');
        if (p2 === null) return;
        if (p1 !== p2) { toast('✗ Passwords do not match', 'err'); return; }
        try {
          const r = await fetch(`/api/accounts/${b.dataset.id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify({ password: p1, password_confirm: p2 }),
          });
          const js = await r.json();
          if (r.ok && js.status === 'ok') toast('✓ Password updated', 'ok');
          else toast('✗ ' + (js.message || 'Failed'), 'err');
        } catch (_) { toast('✗ Network error', 'err'); }
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
// Client-side password match check — abort with a toast instead of letting
// the request hit the server when the two fields differ. The server still
// enforces this, but a snappy local check feels better.
$('acc-form')?.addEventListener('submit', function (e) {
  const p1 = $('acc-password')?.value || '';
  const p2 = $('acc-password2')?.value || '';
  if (p1 || p2) {
    if (p1 !== p2) { e.preventDefault(); e.stopImmediatePropagation(); toast('✗ Passwords do not match', 'err'); return; }
    if (p1.length < 4) { e.preventDefault(); e.stopImmediatePropagation(); toast('✗ Password must be at least 4 characters', 'err'); return; }
  }
}, true);  // capture phase — runs before _wireAddForm's submit handler

_wireAddForm('acc-form', 'acc-submit', () => ({
  name: $('acc-name').value.trim(), nickname: $('acc-nick').value.trim(),
  contact: $('acc-contact').value.trim(), role: $('acc-role').value,
  password:         $('acc-password')?.value  || '',
  password_confirm: $('acc-password2')?.value || '',
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

// ── Phase 9: QR pass modal (Visitor + Member passes) ─────────────────────────
function openQrModal(kind, id, title, meta) {
  if (!$('qr-modal')) return;
  const url = kind === 'visitor' ? `/api/visitors/${id}/qr` : `/api/employees/${id}/qr`;
  $('qr-modal-title').textContent = title || 'Pass QR Code';
  $('qr-modal-img').src = url + '?t=' + Date.now();
  $('qr-modal-meta').innerHTML = meta || '';
  $('qr-modal').style.display = 'flex';
}
function closeQrModal() { const m = $('qr-modal'); if (m) m.style.display = 'none'; }
$('qr-modal-x')?.addEventListener('click', closeQrModal);
$('qr-modal-close')?.addEventListener('click', closeQrModal);
$('qr-modal')?.addEventListener('click', (e) => { if (e.target.id === 'qr-modal') closeQrModal(); });

// Print: open a tiny window with just the QR + meta and trigger window.print().
$('qr-modal-print')?.addEventListener('click', () => {
  const img = $('qr-modal-img').src;
  const title = $('qr-modal-title').textContent;
  const meta = $('qr-modal-meta').innerHTML;
  const w = window.open('', '_blank', 'width=420,height=620');
  if (!w) { toast('✗ Pop-up blocked — allow pop-ups to print', 'err'); return; }
  w.document.write(`<!doctype html><html><head><title>${title}</title>
    <style>body{font-family:'Inter',sans-serif;text-align:center;padding:24px;color:#1f2a3d;}
    h2{margin:0 0 16px;font-size:18px;}
    img{width:280px;height:280px;background:#fff;border:1px solid #e5e9ef;border-radius:8px;padding:8px;}
    .meta{margin-top:14px;font-size:13px;line-height:1.6;}
    @media print{button{display:none;}}</style></head>
    <body onload="setTimeout(()=>window.print(),250);">
    <h2>${title}</h2><img src="${img}"><div class="meta">${meta}</div></body></html>`);
  w.document.close();
});

// Delegated [data-qr] click: data-qr="visitor:42:Display Title:meta html" or
// data-qr="member:7:Member Name:meta html". Colons in title/meta are escaped
// by the rowFn (the meta uses _esc + we encode the title plain).
document.addEventListener('click', (e) => {
  const b = e.target.closest && e.target.closest('[data-qr]');
  if (!b) return;
  // data-qr-kind, data-qr-id, data-qr-title, data-qr-meta (separate attrs avoid escaping pain)
  openQrModal(b.dataset.qrKind, b.dataset.qrId, b.dataset.qrTitle, b.dataset.qrMeta);
});

// ── WhatsApp share for Visitor + Member passes ───────────────────────────────
// Click WhatsApp button -> fetch the pass URL from the server (same URL the QR
// encodes) and open wa.me with a pre-filled message. If the row had a contact
// phone we prefill the recipient; otherwise the operator picks from contacts.
document.addEventListener('click', (e) => {
  const b = e.target.closest && e.target.closest('[data-wa]');
  if (!b) return;
  const kind  = b.dataset.waKind;
  const id    = b.dataset.waId;
  const name  = b.dataset.waName || '';
  const phone = (b.dataset.waPhone || '').replace(/[^0-9]/g, '');
  fetch(`/api/${kind === 'v' ? 'visitors' : 'employees'}/${id}/pass_url`, { cache: 'no-store' })
    .then(r => r.json())
    .then(js => {
      const url = js.url;
      if (!url) { toast('✗ Could not generate pass URL', 'err'); return; }
      const text = kind === 'v'
        ? `Hi ${name},\n\nYour VayAccess visitor pass:\n${url}\n\nOpen this link on your phone to view your QR code. Show it at the gate.`
        : `Hi ${name},\n\nYour VayAccess member pass:\n${url}\n\nOpen this link on your phone any time to verify your membership.`;
      // Default to India country code if a 10-digit local number was stored.
      const num = phone ? (phone.length === 10 ? '91' + phone : phone) : '';
      window.open(`https://wa.me/${num}?text=${encodeURIComponent(text)}`, '_blank', 'noopener');
    })
    .catch(() => toast('✗ Network error', 'err'));
});

// ── Phase 11: LCD Display CRUD + Batch Delete on CRUD tables ─────────────────
async function loadLCD() {
  const tb = $('lcd-body'); if (!tb) return;
  try {
    const raw = await (await fetch('/api/lcd', { cache: 'no-store' })).json();
    const rows = _filterRows(Array.isArray(raw) ? raw : [], $('lcd-search')?.value, ['name', 'location', 'message']);
    if ($('lcd-meta')) $('lcd-meta').textContent = `${rows.length} screen(s)`;
    paginate('lcd', rows, 'lcd-body', s => `<tr>
      <td><b>${_esc(s.name)}</b></td>
      <td>${_esc(s.location) || '—'}</td>
      <td>${_esc(s.message) || '—'}</td>
      <td><span class="scan-status-badge ${s.is_active ? 'granted' : 'denied'}">${_esc(s.status)}</span></td>
      <td>${_esc(s.created_at)}</td>
      <td>
        <button class="ghost-button" data-edit="${s.id}" data-edit-sec="lcd" style="padding:4px 10px; font-size:0.8em; margin-right:4px;">Edit</button>
        <button class="ghost-button lcd-del" data-id="${s.id}" style="padding:4px 10px; font-size:0.8em; color:#b74a42;">Delete</button>
      </td>
    </tr>`, 6, (tb) => {
      tb.querySelectorAll('.lcd-del').forEach(b => b.addEventListener('click', async () => {
        if (!confirm('Delete this LCD screen?')) return;
        await fetch(`/api/lcd/${b.dataset.id}`, { method: 'DELETE' });
        loadLCD();
      }));
    });
  } catch (e) { tb.innerHTML = _emptyRow(6, 'Failed to load.'); }
}

_wireAddForm('lcd-form', 'lcd-submit', () => ({
  name:      $('lcd-name').value.trim(),
  location:  $('lcd-location').value.trim(),
  message:   $('lcd-message').value.trim(),
  is_active: $('lcd-active').value === '1',
}), '/api/lcd', '✓ LCD added', loadLCD);

_editCrud.lcd = {
  url: '/api/lcd', title: 'Edit LCD Display', reload: () => loadLCD(),
  fields: [{ k: 'name', label: 'Screen Name' }, { k: 'location', label: 'Location' },
           { k: 'message', label: 'Message' }],
};
_exportCfg.lcd = {
  loader: 'lcd', name: 'lcd-screens',
  cols: [['name', 'Screen Name'], ['location', 'Location'], ['message', 'Message'],
         ['status', 'Status'], ['created_at', 'Created']],
};
_liveLoaders.lcd = loadLCD;
document.querySelectorAll('.nav-item, [data-jump]').forEach(btn => {
  if ((btn.dataset.view || btn.dataset.jump) === 'lcd') {
    btn.addEventListener('click', () => setTimeout(loadLCD, 30));
  }
});
$('lcd-search')?.addEventListener('input', loadLCD);
// Re-inject table-actions so the new lcd-table picks up Refresh + 📥 CSV.
_injectTableActions();

// ── Batch Delete on CRUD tables (deletes all currently-filtered rows) ────────
// PDF p20 etc. show a "Batch delete" button alongside Add. This implementation
// deletes all rows currently in the paginator's row set (i.e. everything
// matching the active filter). Confirms with a count first.
const _batchable = {
  acc:    '/api/accounts',
  rl:     '/api/roles',
  dc:     '/api/dictionary',
  yard:   '/api/yards',
  region: '/api/regions',
  vis:    '/api/visitors',
  lcd:    '/api/lcd',
};

async function batchDelete(key) {
  const url = _batchable[key]; if (!url) return;
  const rows = _pager[key]?.rows || [];
  if (!rows.length) { toast('Nothing to delete', 'err'); return; }
  if (!confirm(`Delete all ${rows.length} currently-filtered row(s)? This cannot be undone.`)) return;
  let ok = 0;
  for (const r of rows) {
    try {
      const res = await fetch(`${url}/${r.id}`, { method: 'DELETE' });
      if (res.ok) ok++;
    } catch (e) { /* skip */ }
  }
  toast(`✓ Deleted ${ok} of ${rows.length} row(s)`, ok ? 'ok' : 'err');
  _liveLoaders[_exportCfg[key]?.loader]?.();
}

// Append a 🗑 Batch button to each batchable table's existing action group.
function _injectBatchButtons() {
  Object.keys(_batchable).forEach(key => {
    const tbl = document.getElementById(`${key}-table`); if (!tbl) return;
    const actions = tbl.closest('.panel')?.querySelector('.table-actions');
    if (!actions || actions.querySelector('[data-batch-key]')) return;
    const btn = document.createElement('button');
    btn.className = 'ghost-button';
    btn.dataset.batchKey = key;
    btn.title = 'Delete all currently-filtered rows';
    btn.style.color = '#b74a42';
    btn.textContent = '🗑 Batch';
    actions.appendChild(btn);
  });
}
_injectBatchButtons();

document.addEventListener('click', (e) => {
  const bd = e.target.closest && e.target.closest('[data-batch-key]');
  if (bd) batchDelete(bd.dataset.batchKey);
});

// ── Phase 12: Menu Management + Role Permission (real CRUD) ──────────────────
// Copy the Menu Management option list into the Role-Permission Section dropdown
// (avoids duplicating 25 options in the HTML).
(function _shareMenuOptions() {
  const src = document.querySelector('#mn-menu[data-menu-options]');
  const dst = document.querySelector('#rp-section[data-menu-options]');
  if (src && dst) dst.innerHTML = src.innerHTML.replace('— Select menu —', '— Select section —');
})();

// Populate Role dropdowns from /api/roles. Refresh whenever Menu/RolePerm loads.
async function _populateRoleDropdowns() {
  try {
    const roles = await (await fetch('/api/roles', { cache: 'no-store' })).json();
    const opts  = '<option value="">— Select role —</option>' +
      (Array.isArray(roles) ? roles : []).map(r => `<option value="${_esc(r.name)}">${_esc(r.name)}</option>`).join('');
    ['mn-role', 'rp-role'].forEach(id => {
      const el = $(id); if (!el) return;
      const cur = el.value;
      el.innerHTML = opts;
      el.value = cur;
    });
  } catch (e) { /* ignore */ }
}

async function loadMenuPerms() {
  const tb = $('mn-body'); if (!tb) return;
  _populateRoleDropdowns();
  try {
    const raw = await (await fetch('/api/menu_permissions', { cache: 'no-store' })).json();
    const rows = _filterRows(Array.isArray(raw) ? raw : [], $('mn-search')?.value, ['role_name', 'menu_key']);
    if ($('mn-meta')) $('mn-meta').textContent = `${rows.length} rule(s)`;
    paginate('mn', rows, 'mn-body', m => `<tr>
      <td><b>${_esc(m.role_name)}</b></td>
      <td style="font-family:monospace; font-size:0.88em;">${_esc(m.menu_key)}</td>
      <td><span class="scan-status-badge ${m.allowed ? 'granted' : 'denied'}">${_esc(m.status)}</span></td>
      <td>${_esc(m.created_at)}</td>
      <td><button class="ghost-button mn-del" data-id="${m.id}" style="padding:4px 10px; font-size:0.8em; color:#b74a42;">Delete</button></td>
    </tr>`, 5, (tb) => {
      tb.querySelectorAll('.mn-del').forEach(b => b.addEventListener('click', async () => {
        if (!confirm('Delete this menu permission?')) return;
        await fetch(`/api/menu_permissions/${b.dataset.id}`, { method: 'DELETE' });
        loadMenuPerms();
      }));
    });
  } catch (e) { tb.innerHTML = _emptyRow(5, 'Failed to load.'); }
}

async function loadRolePerms() {
  const tb = $('rp-body'); if (!tb) return;
  _populateRoleDropdowns();
  try {
    const raw = await (await fetch('/api/role_permissions', { cache: 'no-store' })).json();
    const rows = _filterRows(Array.isArray(raw) ? raw : [], $('rp-search')?.value, ['role_name', 'section_key', 'action']);
    if ($('rp-meta')) $('rp-meta').textContent = `${rows.length} grant(s)`;
    paginate('rp', rows, 'rp-body', r => `<tr>
      <td><b>${_esc(r.role_name)}</b></td>
      <td style="font-family:monospace; font-size:0.88em;">${_esc(r.section_key)}</td>
      <td><span class="scan-status-badge scanning">${_esc(r.action)}</span></td>
      <td><span class="scan-status-badge ${r.allowed ? 'granted' : 'denied'}">${_esc(r.status)}</span></td>
      <td>${_esc(r.created_at)}</td>
      <td><button class="ghost-button rp-del" data-id="${r.id}" style="padding:4px 10px; font-size:0.8em; color:#b74a42;">Delete</button></td>
    </tr>`, 6, (tb) => {
      tb.querySelectorAll('.rp-del').forEach(b => b.addEventListener('click', async () => {
        if (!confirm('Delete this role permission?')) return;
        await fetch(`/api/role_permissions/${b.dataset.id}`, { method: 'DELETE' });
        loadRolePerms();
      }));
    });
  } catch (e) { tb.innerHTML = _emptyRow(6, 'Failed to load.'); }
}

_wireAddForm('mn-form', 'mn-submit', () => ({
  role_name: $('mn-role').value, menu_key: $('mn-menu').value,
  allowed: $('mn-allowed').value === '1',
}), '/api/menu_permissions', '✓ Menu permission saved', loadMenuPerms);

_wireAddForm('rp-form', 'rp-submit', () => ({
  role_name: $('rp-role').value, section_key: $('rp-section').value,
  action: $('rp-action').value, allowed: $('rp-allowed').value === '1',
}), '/api/role_permissions', '✓ Role permission saved', loadRolePerms);

_exportCfg.mn = { loader: 'menu-mgmt', name: 'menu-permissions',
  cols: [['role_name', 'Role'], ['menu_key', 'Menu'], ['status', 'Status'], ['created_at', 'Created']] };
_exportCfg.rp = { loader: 'role-perm', name: 'role-permissions',
  cols: [['role_name', 'Role'], ['section_key', 'Section'], ['action', 'Action'], ['status', 'Status'], ['created_at', 'Created']] };
Object.assign(_liveLoaders, { 'menu-mgmt': loadMenuPerms, 'role-perm': loadRolePerms });
_batchable.mn = '/api/menu_permissions';
_batchable.rp = '/api/role_permissions';
document.querySelectorAll('.nav-item, [data-jump]').forEach(btn => {
  const v = btn.dataset.view || btn.dataset.jump;
  if (v === 'menu-mgmt') btn.addEventListener('click', () => setTimeout(loadMenuPerms, 30));
  if (v === 'role-perm') btn.addEventListener('click', () => setTimeout(loadRolePerms, 30));
});
$('mn-search')?.addEventListener('input', loadMenuPerms);
$('rp-search')?.addEventListener('input', loadRolePerms);

// ── Permission Matrix (roles x sections, click-to-toggle) ────────────────
// Renders a grid: each role is a row, each sidebar section is a column.
// Every cell has 3 checkboxes (R/W/D). Click any checkbox and the change
// POSTs immediately to /api/role_permissions — no save button.
// Sections are derived DYNAMICALLY from the sidebar nav — never hardcoded — so
// every section (including Solutions, Printer & Ticketing and anything added
// later) is automatically governed by the permission matrix and appears in
// Menu Management. Administrator bypasses all filtering (applyMenuPermissions).
function _pmSections() {
  var seen = {}, out = [];
  document.querySelectorAll('.nav-item[data-view]').forEach(function (btn) {
    var key = btn.dataset.view;
    if (!key || seen[key]) return;
    seen[key] = 1;
    var label = (btn.textContent || '').replace(/\s+/g, ' ').trim();
    out.push([key, label || key]);
  });
  return out;
}
const _PM_ACTIONS = ['read','write','delete'];

// Rebuild the Menu-Management <select> from the live sidebar, so every section
// is selectable there without hand-editing the template. Preserves the current
// choice if still present. Runs once the DOM is ready.
function _populateMenuOptions() {
  var sel = document.getElementById('mn-menu');
  if (!sel) return;
  var prev = sel.value;
  var opts = ['<option value="">— Select menu —</option>'];
  _pmSections().forEach(function (s) {
    opts.push('<option value="' + s[0] + '">' + _esc(s[1]) + '</option>');
  });
  sel.innerHTML = opts.join('');
  if (prev) sel.value = prev;
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', _populateMenuOptions);
else _populateMenuOptions();

async function loadPermissionMatrix() {
  const head = $('pm-matrix-head'); const body = $('pm-matrix-body');
  if (!head || !body) return;
  const _SECTIONS = _pmSections();
  try {
    // Grab roles + existing permissions in parallel
    const [roles, perms] = await Promise.all([
      fetch('/api/roles',            { cache: 'no-store' }).then(r => r.json()),
      fetch('/api/role_permissions', { cache: 'no-store' }).then(r => r.json()),
    ]);
    if (!Array.isArray(roles) || !Array.isArray(perms)) {
      body.innerHTML = '<tr><td>Failed to load roles/permissions.</td></tr>';
      return;
    }
    // Index existing perms by role|section|action -> {id, allowed}
    const idx = {};
    perms.forEach(p => {
      const k = `${(p.role_name||'').toLowerCase()}|${p.section_key||''}|${p.action||''}`;
      idx[k] = p;
    });

    // Build header row
    let h = '<tr><th class="pm-role-th">Role</th>';
    _SECTIONS.forEach(([k, label]) => {
      h += `<th class="pm-section-th" title="${k}">${label}<div class="pm-rwd">R W D</div></th>`;
    });
    h += '</tr>';
    head.innerHTML = h;

    // Build body rows
    body.innerHTML = roles.map(r => {
      const cells = _SECTIONS.map(([k]) => {
        const cbs = _PM_ACTIONS.map(a => {
          const existing = idx[`${r.name.toLowerCase()}|${k}|${a}`];
          const checked = existing && existing.allowed ? 'checked' : '';
          return `<input type="checkbox" class="pm-cb"
                    data-role="${_esc(r.name)}" data-section="${k}" data-action="${a}"
                    ${checked}>`;
        }).join('');
        return `<td class="pm-cell">${cbs}</td>`;
      }).join('');
      return `<tr><td class="pm-role-cell">${_esc(r.name)}</td>${cells}</tr>`;
    }).join('') || '<tr><td colspan="99">No roles yet -- add one in Role Management first.</td></tr>';

  } catch (e) {
    body.innerHTML = `<tr><td>Error: ${_esc(e.message)}</td></tr>`;
  }
}

// Delegated click-to-toggle. Fires POST /api/role_permissions on every change.
document.addEventListener('change', async (ev) => {
  const cb = ev.target;
  if (!cb || !cb.classList || !cb.classList.contains('pm-cb')) return;
  const payload = {
    role_name:   cb.dataset.role,
    section_key: cb.dataset.section,
    action:      cb.dataset.action,
    allowed:     cb.checked ? 1 : 0,
  };
  cb.disabled = true;
  try {
    const res = await fetch('/api/role_permissions', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (e) {
    alert(`Failed to save: ${e.message}`);
    cb.checked = !cb.checked;   // revert on failure
  } finally {
    cb.disabled = false;
  }
});

$('pm-refresh')?.addEventListener('click', loadPermissionMatrix);
// Refresh matrix when role-perm view is opened, alongside the existing row list.
Object.assign(_liveLoaders, {
  'role-perm': () => { loadRolePerms(); loadPermissionMatrix(); }
});
document.querySelectorAll('.nav-item, [data-jump]').forEach(btn => {
  const v = btn.dataset.view || btn.dataset.jump;
  if (v === 'role-perm') btn.addEventListener('click',
      () => setTimeout(loadPermissionMatrix, 30));
});

// Pick up the new tables in Refresh/Export/Batch button injections.
_injectTableActions();
_injectBatchButtons();

// ── Phase 13: Monthly Report (server-rendered PDF download) ──────────────────
$('rpt-monthly-pdf')?.addEventListener('click', () => {
  const m = $('rpt-month')?.value || new Date().toISOString().slice(0, 7);
  const a = document.createElement('a');
  a.href = `/api/reports/monthly_pdf?month=${encodeURIComponent(m)}`;
  a.download = `VayAccess-Report-${m}.pdf`;
  document.body.appendChild(a); a.click(); a.remove();
  toast('📄 Generating monthly report…', 'ok');
});

// ── Phase 14: Audit Log viewer + Bulk CSV import (visitors + members) ───────
async function loadAuditLog() {
  const tb = $('al-body'); if (!tb) return;
  try {
    const raw = await (await fetch('/api/audit', { cache: 'no-store' })).json();
    const all = Array.isArray(raw) ? raw : [];
    const q = ($('al-search')?.value || '').trim().toUpperCase();
    const rows = all.filter(e => !q || (e.area || '').toUpperCase().includes(q) || (e.message || '').toUpperCase().includes(q));
    if ($('al-meta')) $('al-meta').textContent = `${rows.length} of ${all.length} event(s)`;
    paginate('al', rows.map(r => ({
      ...r,
      when_str: r.at ? new Date(r.at).toLocaleString() : '—',
    })), 'al-body', a => `<tr>
      <td>${_esc(a.when_str)}</td>
      <td><span class="scan-status-badge ${/admin|system/i.test(a.area || '') ? 'scanning' : 'granted'}">${_esc(a.area) || '—'}</span></td>
      <td>${_esc(a.message)}</td>
    </tr>`, 3);
  } catch (e) { tb.innerHTML = _emptyRow(3, 'Failed to load.'); }
}

_exportCfg.al = { loader: 'audit-log', name: 'audit-log',
  cols: [['when_str', 'When'], ['area', 'Area'], ['message', 'Message']] };
_liveLoaders['audit-log'] = loadAuditLog;
document.querySelectorAll('.nav-item, [data-jump]').forEach(btn => {
  if ((btn.dataset.view || btn.dataset.jump) === 'audit-log') {
    btn.addEventListener('click', () => setTimeout(loadAuditLog, 30));
  }
});
$('al-search')?.addEventListener('input', loadAuditLog);
_injectTableActions();

// ── UHF-triggered ANPR captures (on-site only) ──────────────────────────────
// Each row shows two thumbnails the on-site PC saved: the full vehicle photo
// and the plate crop. Images are served by /image/<filename> from the
// detections/ folder. Cloud deploys will show empty rows since CLOUD_MODE
// skips the capture pipeline.
async function loadUhfCaptures() {
  const tb = $('uc-body'); if (!tb) return;
  try {
    const raw = await (await fetch('/api/uhf_captures', { cache: 'no-store' })).json();
    const q = ($('uc-search')?.value || '').trim().toUpperCase();
    const rows = (Array.isArray(raw) ? raw : []).filter(e => !q ||
      (e.rfid_tag || '').toUpperCase().includes(q) ||
      (e.plate    || '').toUpperCase().includes(q) ||
      (e.owner_name || '').toUpperCase().includes(q));
    if ($('uc-meta')) $('uc-meta').textContent =
      `${rows.length} capture(s) — newest first`;
    // loading="lazy" + decoding="async" means the browser only fetches images
    // as they scroll into view. Without this, opening the UHF Captures page
    // fetches ALL thumbnails at once (80 requests for 40 rows) and blocks the
    // page for ~10 s. With lazy loading, only the ~6 visible rows fetch on
    // page load — everything else defers until scroll.
    //
    // onerror swaps the broken image for a "no image" placeholder card so
    // mobile viewers don't see a broken-image icon (which looks awful and
    // still eats a tap). Uses the row-level plate/tag as fallback context.
    const thumb = (filename, label) => filename
      ? `<a href="/image/${encodeURIComponent(filename)}" target="_blank" rel="noopener"
           title="${label} — tap to view full"
           class="uhf-thumb-link">
           <img src="/image/${encodeURIComponent(filename)}" alt="${label}"
                loading="lazy" decoding="async"
                class="uhf-thumb-img"
                onerror="this.onerror=null; this.parentElement.classList.add('uhf-thumb-missing'); this.parentElement.setAttribute('href','#'); this.style.display='none'; this.parentElement.innerHTML='&#128247;<br><span style=&quot;font-size:0.72em;&quot;>image<br>syncing</span>';">
         </a>`
      : '<span class="uhf-thumb-empty">—</span>';
    const badge = (st) => /grant/i.test(st || '') ? `<span class="scan-status-badge granted">${_esc(st)}</span>`
      : /den/i.test(st || '') ? `<span class="scan-status-badge denied">${_esc(st)}</span>`
      : `<span class="scan-status-badge scanning">${_esc(st) || '—'}</span>`;
    paginate('uc', rows, 'uc-body', e => `<tr>
      <td>${_esc(e.timestamp)}</td>
      <td>${thumb(e.full_image, 'Vehicle')}</td>
      <td>${thumb(e.plate_image, 'Plate')}</td>
      <td style="font-family:monospace; font-size:0.88em;">${_esc(e.rfid_tag)}</td>
      <td style="font-family:monospace;">${_esc(e.plate) || '—'}</td>
      <td>${_esc(e.owner_name) || '—'}</td>
      <td>${badge(e.status)}</td>
    </tr>`, 7);
  } catch (e) { tb.innerHTML = _emptyRow(7, 'Failed to load.'); }
}

_exportCfg.uc = { loader: 'uhf-captures', name: 'uhf-captures',
  cols: [['timestamp','When'], ['rfid_tag','Tag (EPC)'], ['plate','Plate'],
         ['owner_name','Owner'], ['vehicle_type','Vehicle Type'], ['status','Status'],
         ['full_image','Vehicle Photo'], ['plate_image','Plate Photo']] };
_liveLoaders['uhf-captures'] = loadUhfCaptures;
document.querySelectorAll('.nav-item, [data-jump]').forEach(btn => {
  if ((btn.dataset.view || btn.dataset.jump) === 'uhf-captures') {
    btn.addEventListener('click', () => setTimeout(loadUhfCaptures, 30));
  }
});
$('uc-search')?.addEventListener('input', loadUhfCaptures);

// Cleanup button — deletes duplicate rows whose image files 404 on this server.
// Keeps rows that still have a working sibling; blanks out filenames for
// orphan rows so the placeholder text stops showing.
$('uc-cleanup-btn')?.addEventListener('click', async () => {
  const btn = $('uc-cleanup-btn'); if (!btn) return;
  if (!confirm('Scan UHF Captures for rows whose image files are missing on this server, and clean them up? Non-destructive: rows with a working duplicate get merged; orphans keep the scan record but the broken thumbnail disappears.')) return;
  const originalText = btn.textContent;
  btn.textContent = 'Cleaning...';
  btn.disabled = true;
  try {
    const res = await fetch('/api/uhf_captures/cleanup', { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || res.statusText);
    alert(`Cleanup complete.\n\nScanned:  ${data.scanned}\nDropped duplicates: ${data.dropped_duplicates}\nOrphans blanked: ${data.nulled_orphans}`);
    loadUhfCaptures();
  } catch (e) {
    alert('Cleanup failed: ' + e.message);
  } finally {
    btn.textContent = originalText;
    btn.disabled = false;
  }
});

// ── Watermark address input (webportal-side editor for GATE_ADDRESS_LINE) ──
// Reads /api/settings/gate_address on view-open; POSTs the same URL on Save
// or Clear. Backend caches the value and refreshes it every 15 s from the
// settings table, so the next UHF capture uses the new text within seconds.
async function loadWatermarkAddress() {
  const input = $('wm-addr-input');
  const status = $('wm-addr-status');
  if (!input) return;
  try {
    const r = await fetch('/api/settings/gate_address', {cache: 'no-store'});
    const d = await r.json();
    input.value = d.value || '';
    if (status) {
      status.textContent = (d.value)
        ? `Current: "${d.value}"  (source: ${d.source})`
        : 'No address set — watermark shows date/time only.';
    }
  } catch (e) {
    if (status) status.textContent = 'Could not load current address: ' + e.message;
  }
}

async function saveWatermarkAddress(newValue) {
  const status = $('wm-addr-status');
  const saveBtn = $('wm-addr-save');
  if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'Saving...'; }
  try {
    const r = await fetch('/api/settings/gate_address', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({value: newValue}),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || r.statusText);
    if (status) {
      status.textContent = newValue
        ? `Saved: "${d.value}"  — will appear on the next capture (within ~15 s).`
        : 'Cleared — watermark now shows date/time only.';
      status.style.color = '#16a34a';
      setTimeout(() => { status.style.color = ''; loadWatermarkAddress(); }, 3000);
    }
  } catch (e) {
    if (status) {
      status.textContent = 'Save failed: ' + e.message;
      status.style.color = '#dc2626';
    }
  } finally {
    if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Save'; }
  }
}

$('wm-addr-save')?.addEventListener('click', () => {
  const input = $('wm-addr-input');
  if (input) saveWatermarkAddress((input.value || '').trim());
});
$('wm-addr-input')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); $('wm-addr-save')?.click(); }
});
$('wm-addr-clear')?.addEventListener('click', () => {
  const input = $('wm-addr-input');
  if (input) { input.value = ''; saveWatermarkAddress(''); }
});

// Re-fetch the current value whenever the operator navigates to UHF Captures
// so they always see the truth (in case someone else edited it on another tab).
if (typeof _liveLoaders !== 'undefined') {
  const _prevLoader = _liveLoaders['uhf-captures'];
  _liveLoaders['uhf-captures'] = async () => {
    if (_prevLoader) await _prevLoader();
    loadWatermarkAddress();
  };
}


// ── Zone-wise Gate Entry — live per-zone occupancy + recent entries ────────
async function loadZoneLive() {
  const grid = $('zl-grid'); const meta = $('zl-meta');
  if (!grid) return;
  try {
    const r = await fetch('/api/zones', { cache: 'no-store' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    let zones = await r.json();
    const q = ($('zl-search')?.value || '').trim().toLowerCase();
    if (q) {
      zones = zones.filter(z =>
        z.zone.toLowerCase().includes(q) ||
        (z.region || '').toLowerCase().includes(q) ||
        (z.recent || []).some(e => (e.vehicle || '').toLowerCase().includes(q)));
    }
    if (meta) {
      const totalOcc = zones.reduce((s, z) => s + (z.occupied || 0), 0);
      const totalCap = zones.reduce((s, z) => s + (z.capacity || 0), 0);
      const totalEnt = zones.reduce((s, z) => s + (z.entries_last_hour || 0), 0);
      meta.textContent =
        `${zones.length} zones · ${totalOcc}/${totalCap || '∞'} parked · ${totalEnt} entries in the last hour`;
    }
    if (!zones.length) {
      grid.innerHTML = `<div style="padding:40px; text-align:center; opacity:0.6;">No zones match.</div>`;
      return;
    }
    grid.innerHTML = zones.map(z => {
      const cap = z.capacity || 0;
      const full = cap > 0 && z.available === 0;
      const tight = !full && cap > 0 && z.available <= 5;
      const pillClass = full ? 'full' : (tight ? 'warn' : 'ok');
      const pillText  = cap > 0 ? `${z.available} / ${cap}` : `${z.occupied} parked`;
      const cardCls   = full ? 'zone-card is-full' : (tight ? 'zone-card is-tight' : 'zone-card');
      const recent = (z.recent || []).slice(0, 8);
      return `
        <div class="${cardCls}">
          <div class="zone-card-head">
            <div>
              <h3>${z.zone}</h3>
              ${z.region ? `<div class="region">${z.region}</div>` : ''}
            </div>
            <span class="zone-pill ${pillClass}">${pillText}</span>
          </div>
          <div class="zone-stats">
            <div class="zone-stat"><div class="lbl">Occupied</div><div class="val">${z.occupied}</div></div>
            <div class="zone-stat"><div class="lbl">Entries/hr</div><div class="val">${z.entries_last_hour || 0}</div></div>
            <div class="zone-stat"><div class="lbl">Exits/hr</div><div class="val">${z.exits_last_hour || 0}</div></div>
          </div>
          <div class="zone-recent">
            ${recent.length === 0
              ? '<div style="opacity:0.6; padding:6px 0;">No gate entries in the last hour.</div>'
              : recent.map(e => `
                  <div class="zone-recent-row">
                    <div>
                      <span class="plate">${e.vehicle || '—'}</span>
                      <span style="opacity:0.6; margin-left:6px;">${e.vehicle_type || ''}</span>
                    </div>
                    <div style="text-align:right;">
                      <span class="scan-status-badge ${e.still_parked ? 'granted' : 'scanning'}">${e.still_parked ? 'IN' : 'OUT'}</span>
                      <div class="time">${(e.entry_at || '').slice(11, 19)}</div>
                    </div>
                  </div>`).join('')}
          </div>
        </div>`;
    }).join('');
  } catch (err) {
    grid.innerHTML = `<div style="padding:40px; text-align:center; color:#b74a42;">Failed to load: ${err.message}</div>`;
  }
}
_liveLoaders['zone-live'] = loadZoneLive;
document.querySelectorAll('.nav-item, [data-jump]').forEach(btn => {
  if ((btn.dataset.view || btn.dataset.jump) === 'zone-live') {
    btn.addEventListener('click', () => setTimeout(loadZoneLive, 30));
  }
});
$('zl-search')?.addEventListener('input', loadZoneLive);
$('zl-refresh')?.addEventListener('click', loadZoneLive);

// ── Driver Users (VayAccess mobile) — admin-side live management ───────────
async function loadDriverUsers() {
  const tb = $('du-body'); const meta = $('du-meta');
  if (!tb) return;
  try {
    const q = ($('du-search')?.value || '').trim();
    const r = await fetch('/api/admin/drivers' + (q ? `?q=${encodeURIComponent(q)}` : ''),
                         { cache: 'no-store' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const rows = await r.json();
    if (meta) {
      const live = rows.filter(u => u.active).length;
      const unread = rows.reduce((s, u) => s + (u.unread || 0), 0);
      meta.textContent = `${rows.length} users · ${live} currently parked · ${unread} unread alerts across all`;
    }
    if (!rows.length) {
      tb.innerHTML = `<tr><td colspan="10" style="text-align:center; opacity:0.6; padding:20px;">No mobile users registered yet.</td></tr>`;
      return;
    }
    tb.innerHTML = rows.map(u => `
      <tr data-driver="${u.id}">
        <td><b>${u.name || '—'}</b></td>
        <td style="font-size:0.85em;">${u.email || '—'}</td>
        <td style="font-family:monospace; font-size:0.85em;">${u.phone || '—'}</td>
        <td style="font-family:monospace;">${u.primary_plate || '—'}</td>
        <td>${u.primary_type || 'Car'}</td>
        <td>${u.active
          ? '<span class="scan-status-badge granted">PARKED</span>'
          : '<span style="opacity:0.5;">—</span>'}</td>
        <td>${u.unread > 0
          ? `<span class="scan-status-badge denied">${u.unread}</span>`
          : '<span style="opacity:0.5;">0</span>'}</td>
        <td>${u.reservation_count || 0}</td>
        <td style="font-size:0.82em; opacity:0.85;">${u.last_seen || '—'}</td>
        <td style="white-space:nowrap;">
          <button class="btn-sm" data-du-notify="${u.id}" title="Send a push alert to this user">Send Alert</button>
          <button class="btn-sm" data-du-edit="${u.id}" title="Edit profile">Edit</button>
          <button class="btn-sm" data-du-logout="${u.id}" title="Revoke every active mobile session">Force Logout</button>
          <button class="btn-sm danger" data-du-delete="${u.id}" title="Delete account + all reservations">Delete</button>
        </td>
      </tr>`).join('');
  } catch (err) {
    tb.innerHTML = `<tr><td colspan="10" style="text-align:center; color:#b74a42; padding:20px;">Failed to load: ${err.message}</td></tr>`;
  }
}
_liveLoaders['driver-users'] = loadDriverUsers;
document.querySelectorAll('.nav-item, [data-jump]').forEach(btn => {
  if ((btn.dataset.view || btn.dataset.jump) === 'driver-users') {
    btn.addEventListener('click', () => setTimeout(loadDriverUsers, 30));
  }
});
$('du-search')?.addEventListener('input', loadDriverUsers);
$('du-refresh')?.addEventListener('click', loadDriverUsers);
// Admin provisions a login (email + password) to hand to a user. They can then
// sign in on the mobile app or the web "Book Parking" view and book slots.
$('du-add')?.addEventListener('click', async () => {
  const name  = prompt('Full name:'); if (!name) return;
  const email = prompt('Login email:'); if (!email) return;
  const pwd   = prompt('Password (min 6 chars):'); if (!pwd) return;
  const phone = prompt('Phone (optional):') || '';
  const plate = prompt('Primary vehicle plate (optional):') || '';
  const type  = prompt('Vehicle type (Car / Bike):', 'Car') || 'Car';
  try {
    const r = await fetch('/api/admin/drivers', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, email, password: pwd, phone,
                             primary_plate: plate, primary_type: type }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.status === 'error') throw new Error(j.message || `HTTP ${r.status}`);
    alert(`User created.\n\nEmail: ${email}\nPassword: ${pwd}\n\nShare these — they can sign in on the mobile app or the web "Book Parking" page.`);
    loadDriverUsers();
  } catch (e) { alert('Could not create user: ' + e.message); }
});

// Delegated action handlers for the Driver Users row buttons.
document.addEventListener('click', async (ev) => {
  const t = ev.target;
  if (!t || !t.dataset) return;
  const id = t.dataset.duNotify || t.dataset.duLogout || t.dataset.duDelete || t.dataset.duEdit;
  if (!id) return;
  try {
    if (t.dataset.duNotify) {
      const title = prompt('Alert title:'); if (!title) return;
      const body  = prompt('Alert message (optional):') || '';
      const r = await fetch(`/api/admin/drivers/${id}/notify`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, body, kind: 'system' }),
      });
      if (!r.ok) throw new Error((await r.json()).error || `HTTP ${r.status}`);
      alert('Alert sent — it will surface on the user\'s phone within ~5 seconds.');
      loadDriverUsers();
    } else if (t.dataset.duLogout) {
      if (!confirm('Revoke every active mobile session for this user?')) return;
      const r = await fetch(`/api/admin/drivers/${id}/logout_all`, { method: 'POST' });
      if (!r.ok) throw new Error((await r.json()).error || `HTTP ${r.status}`);
      const j = await r.json();
      alert(`Revoked ${j.revoked} session(s).`);
      loadDriverUsers();
    } else if (t.dataset.duDelete) {
      if (!confirm('Delete this driver account and ALL their reservations? This cannot be undone.')) return;
      const r = await fetch(`/api/admin/drivers/${id}`, { method: 'DELETE' });
      if (!r.ok) throw new Error((await r.json()).error || `HTTP ${r.status}`);
      loadDriverUsers();
    } else if (t.dataset.duEdit) {
      const row = t.closest('tr');
      const cur = {
        name: row.children[0].innerText.trim(),
        phone: row.children[2].innerText.trim().replace(/^—$/, ''),
        primary_plate: row.children[3].innerText.trim().replace(/^—$/, ''),
        primary_type: row.children[4].innerText.trim(),
      };
      const name  = prompt('Name:',  cur.name)  ?? cur.name;
      const phone = prompt('Phone:', cur.phone) ?? cur.phone;
      const plate = prompt('Primary Plate:', cur.primary_plate) ?? cur.primary_plate;
      const type  = prompt('Vehicle Type (Car / Bike):', cur.primary_type || 'Car') ?? cur.primary_type;
      const pwd   = prompt('Reset password (leave blank to keep current):') || '';
      const r = await fetch(`/api/admin/drivers/${id}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, phone, primary_plate: plate, primary_type: type, password: pwd }),
      });
      if (!r.ok) throw new Error((await r.json()).error || `HTTP ${r.status}`);
      loadDriverUsers();
    }
  } catch (e) {
    alert('Failed: ' + e.message);
  }
});

_injectTableActions();

// ── Bulk CSV import (Visitors + Members) ────────────────────────────────────
// Injects a "📤 Import" button next to Refresh/CSV/Batch on importable tables.
// Click opens a file picker, parses CSV client-side (tolerant of headers in
// any order), POSTs the rows to the matching bulk endpoint.
const _bulkImportable = {
  vis: { url: '/api/bulk_import/visitors', loader: 'visitors',
         template: 'name,number_plate,contact,purpose,host_employee\n"John Doe","TS09AB1234","9876543210","Meeting","Satya"' },
  mm:  { url: '/api/bulk_import/members',  loader: 'membership',
         template: 'owner_name,number_plate,rfid_tag,department,contact_number,vehicle_type,activation_months\n"John Doe","TS09AB1234","E2806894...","Engineering","9876543210","Car",12' },
};

function _parseCSV(text) {
  // Tiny CSV parser (handles quoted fields + commas inside quotes).
  const lines = text.replace(/\r\n/g, '\n').split('\n').filter(l => l.trim());
  if (!lines.length) return [];
  const parseLine = (l) => {
    const out = []; let cur = '', inQ = false;
    for (let i = 0; i < l.length; i++) {
      const c = l[i];
      if (inQ) {
        if (c === '"' && l[i + 1] === '"') { cur += '"'; i++; }
        else if (c === '"') { inQ = false; }
        else cur += c;
      } else {
        if (c === '"') inQ = true;
        else if (c === ',') { out.push(cur); cur = ''; }
        else cur += c;
      }
    }
    out.push(cur);
    return out;
  };
  const header = parseLine(lines[0]).map(h => h.trim());
  return lines.slice(1).map(l => {
    const cells = parseLine(l);
    const row = {};
    header.forEach((h, i) => { row[h] = (cells[i] || '').trim(); });
    return row;
  });
}

// Per-import-type schema. Each column lists its accepted header aliases
// (case-insensitive), whether it's required, and a validator key.
const _bulkImportSchemas = {
  vis: {
    label: 'visitor',
    columns: {
      name:          { aliases: ['name'],                          required: true,  type: 'text' },
      number_plate:  { aliases: ['number_plate', 'plate'],         required: false, type: 'plate' },
      contact:       { aliases: ['contact'],                       required: false, type: 'phone' },
      purpose:       { aliases: ['purpose'],                       required: false, type: 'text' },
      host_employee: { aliases: ['host_employee', 'host'],         required: false, type: 'text' },
      valid_from:    { aliases: ['valid_from'],                    required: false, type: 'datetime' },
      valid_to:      { aliases: ['valid_to'],                      required: false, type: 'datetime' },
    },
  },
  mm: {
    label: 'member',
    columns: {
      owner_name:        { aliases: ['owner_name', 'name'],            required: true,  type: 'text' },
      number_plate:      { aliases: ['number_plate', 'plate'],         required: true,  type: 'plate' },
      rfid_tag:          { aliases: ['rfid_tag', 'tag'],               required: false, type: 'text' },
      department:        { aliases: ['department'],                    required: false, type: 'text' },
      contact_number:    { aliases: ['contact_number', 'contact'],     required: false, type: 'phone' },
      vehicle_type:      { aliases: ['vehicle_type', 'type'],          required: false, type: 'vehicle' },
      activation_months: { aliases: ['activation_months', 'months'],   required: false, type: 'months' },
      payment_amount:    { aliases: ['payment_amount', 'amount'],      required: false, type: 'amount' },
    },
  },
};

// Validators return null on success or a short error message on failure.
const _bulkValidators = {
  text:     (v) => v.length > 0 ? null : 'must not be empty',
  plate:    (v) => /^[A-Z0-9\-\s]{4,15}$/i.test(v) ? null : 'must look like a plate (4–15 letters/digits, e.g. TS09AB1234)',
  phone:    (v) => /^[+0-9\s\-]{7,20}$/.test(v) ? null : 'must be 7–20 digits (with optional + - space)',
  datetime: (v) => /^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2})?)?$/.test(v) ? null : 'must be YYYY-MM-DD or YYYY-MM-DD HH:MM',
  vehicle:  (v) => /^(Car|Bike)$/i.test(v) ? null : 'must be "Car" or "Bike"',
  months:   (v) => { const n = parseInt(v, 10); return (!isNaN(n) && n >= 1 && n <= 60) ? null : 'must be an integer between 1 and 60'; },
  amount:   (v) => { const n = parseInt(v, 10); return (!isNaN(n) && n >= 0) ? null : 'must be a non-negative integer (in INR)'; },
};

function _validateBulkRows(key, headerRow, rows) {
  const schema = _bulkImportSchemas[key]; if (!schema) return { errors: [], warnings: [] };
  const errors = [], warnings = [];
  const headerLC = headerRow.map(h => (h || '').trim().toLowerCase());

  // Map canonical field names -> actual header strings present in the CSV.
  const fieldToHeader = {};
  const allAliasesLC = new Set();
  for (const [field, cfg] of Object.entries(schema.columns)) {
    for (const alias of cfg.aliases) allAliasesLC.add(alias.toLowerCase());
    const idx = cfg.aliases
      .map(a => headerLC.indexOf(a.toLowerCase()))
      .find(i => i >= 0);
    if (idx !== undefined && idx >= 0) {
      fieldToHeader[field] = headerRow[idx];
    }
  }

  // 1. Required columns must be in the header.
  for (const [field, cfg] of Object.entries(schema.columns)) {
    if (cfg.required && !fieldToHeader[field]) {
      errors.push({ row: 0, column: field, message: `required column "${field}" not in CSV header` });
    }
  }

  // 2. Unknown columns -> warning (we'll ignore them, but tell the user).
  headerRow.forEach((h) => {
    const lc = (h || '').trim().toLowerCase();
    if (lc && !allAliasesLC.has(lc)) {
      warnings.push({ row: 0, column: h, message: `unknown column "${h}" — will be ignored` });
    }
  });

  // 3. Per-row data-type validation.
  rows.forEach((row, idx) => {
    const rowNum = idx + 2;   // +1 for 0-index, +1 for the header line
    for (const [field, cfg] of Object.entries(schema.columns)) {
      const h = fieldToHeader[field];
      const val = h ? String(row[h] ?? '').trim() : '';
      if (!val) {
        if (cfg.required) errors.push({ row: rowNum, column: field, message: 'required, but empty' });
        continue;
      }
      const v = _bulkValidators[cfg.type];
      const err = v ? v(val) : null;
      if (err) errors.push({ row: rowNum, column: field, message: `${err} (got "${val}")` });
    }
  });

  return { errors, warnings };
}

function _formatBulkIssues(label, issues, max) {
  const lines = issues.slice(0, max).map(e =>
    e.row === 0
      ? `• ${label} — "${e.column}": ${e.message}`
      : `• Row ${e.row}, "${e.column}": ${e.message}`
  );
  if (issues.length > max) lines.push(`…and ${issues.length - max} more`);
  return lines.join('\n');
}

function bulkImport(key) {
  const cfg = _bulkImportable[key]; if (!cfg) return;
  const schema = _bulkImportSchemas[key];
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.csv,text/csv';
  input.onchange = async () => {
    const file = input.files && input.files[0]; if (!file) return;
    try {
      const text = await file.text();
      const rows = _parseCSV(text);
      if (!rows.length) { alert('CSV is empty — nothing to import.'); return; }

      // Schema validation BEFORE we send anything to the server.
      const headerRow = Object.keys(rows[0] || {});
      const { errors, warnings } = _validateBulkRows(key, headerRow, rows);

      if (errors.length) {
        const errBlock = _formatBulkIssues('Header', errors, 20);
        alert(
          `Cannot import — ${errors.length} validation error(s) in "${file.name}":\n\n` +
          errBlock + '\n\n' +
          `Please fix these in your CSV and try again.\n\n` +
          `Expected columns for ${schema.label} import:\n` +
          Object.entries(schema.columns)
            .map(([f, c]) => `  ${c.required ? '* ' : '  '}${f}${c.aliases.length > 1 ? ' (or ' + c.aliases.slice(1).join('/') + ')' : ''} — ${c.type}`)
            .join('\n')
        );
        return;
      }

      // Soft warnings (unknown columns) — show before confirm but don't block.
      let confirmMsg = `Import ${rows.length} ${schema.label} row(s) from "${file.name}"?`;
      if (warnings.length) {
        confirmMsg = `Warning — ${warnings.length} issue(s) found:\n\n` +
                     _formatBulkIssues('Header', warnings, 10) + '\n\n' + confirmMsg;
      }
      if (!confirm(confirmMsg)) return;

      toast(`📤 Importing ${rows.length} row(s)…`, 'ok');
      const r = await fetch(cfg.url, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rows }),
      });
      const js = await r.json();
      if (r.ok && js.status === 'ok') {
        if (js.skipped && Array.isArray(js.rejections) && js.rejections.length) {
          // Show the operator EXACTLY which rows were rejected and why
          // (duplicate plate, duplicate phone, etc.).
          const lines = js.rejections.slice(0, 30)
            .map(rej => `• Row ${rej.row}: ${rej.reason}`);
          if (js.rejections.length > 30) lines.push(`…and ${js.rejections.length - 30} more`);
          alert(`Imported ${js.imported} row(s) successfully.\n\n` +
                `${js.skipped} row(s) were REJECTED by the server:\n\n` +
                lines.join('\n') + '\n\n' +
                `Common reasons: duplicate plate, duplicate phone number, ` +
                `or a value already in use by another visitor / member.`);
        } else {
          toast(`✓ Imported ${js.imported}`, 'ok');
        }
        _liveLoaders[cfg.loader]?.();
      } else if (r.status === 401) {
        alert('Login required — your session has expired. Sign in again to bulk import.');
      } else if (r.status === 403) {
        alert('Access denied — bulk import requires an Administrator account.');
      } else {
        alert('✗ Import failed: ' + (js.message || `HTTP ${r.status}`));
      }
    } catch (e) {
      alert('✗ Could not read CSV: ' + (e.message || 'unknown error'));
    }
  };
  input.click();
}

function _injectImportButtons() {
  Object.keys(_bulkImportable).forEach(key => {
    const tbl = document.getElementById(`${key}-table`); if (!tbl) return;
    const actions = tbl.closest('.panel')?.querySelector('.table-actions');
    if (!actions || actions.querySelector('[data-bulk-key]')) return;
    const btn = document.createElement('button');
    btn.className = 'ghost-button';
    btn.dataset.bulkKey = key;
    btn.title = 'Bulk import from CSV';
    btn.textContent = '📤 Import';
    actions.appendChild(btn);
  });
}
_injectImportButtons();

document.addEventListener('click', (e) => {
  const b = e.target.closest && e.target.closest('[data-bulk-key]');
  if (b) bulkImport(b.dataset.bulkKey);
});

// ── Manual Entry workflow (me-form) ──────────────────────────────────────────
// Operator-driven fallback when ANPR / RFID miss a vehicle. POSTs the same
// JSON body shape used by the Dashboard entry form so the backend code path
// is canonical. On success we display the new ticket number inline.
document.addEventListener('DOMContentLoaded', function () {
  const form = document.getElementById('me-form');
  if (!form) return;
  form.addEventListener('submit', async function (e) {
    e.preventDefault();
    const btn = document.getElementById('me-submit');
    const result = document.getElementById('me-result');
    const plate = ($('me-plate')?.value || '').trim().toUpperCase();
    if (!plate) { toast('✗ License plate is required', 'err'); return; }
    const body = {
      vehicle:  plate,
      type:     $('me-type')?.value     || 'Car',
      mode:     $('me-mode')?.value     || 'Manual Ticket',
      identity: ($('me-identity')?.value || '').trim().toUpperCase(),
      zone:     ($('me-zone')?.value    || '').trim() || 'GMR Cargo Staff Parking',
      emp_name: ($('me-owner')?.value   || '').trim(),
      vip:      !!$('me-vip')?.checked,
      staff:    !!$('me-staff')?.checked,
      // notes is metadata-only; backend ignores unknown keys.
      notes:    ($('me-notes')?.value   || '').trim(),
    };
    if (btn) btn.disabled = true;
    try {
      const r = await fetch('/api/entries', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body:    JSON.stringify(body),
      });
      const js = await r.json();
      if (r.ok && js.status === 'ok') {
        const tx = js.transaction || {};
        const ticket = tx.id ? ('PK' + String(tx.id).padStart(8, '0')) : '—';
        if (result) {
          result.style.display = 'block';
          result.innerHTML = '<b>✓ Entry recorded.</b> Ticket: <code>' + ticket
                           + '</code> · Vehicle: <b>' + (tx.vehicle || plate) + '</b>'
                           + ' · Mode: ' + (tx.mode || body.mode);
        }
        toast('✓ Entry recorded: ticket ' + ticket, 'ok');
        form.reset();
        // Reset the zone to the operational default after the form clears.
        if ($('me-zone')) $('me-zone').value = 'GMR Cargo Staff Parking';
        // Refresh dashboard widgets if they're around.
        if (typeof refreshAll === 'function') { try { refreshAll(); } catch (_) {} }
      } else {
        toast('✗ ' + (js.message || 'Entry failed'), 'err');
      }
    } catch (err) {
      toast('✗ Network error', 'err');
    } finally {
      if (btn) btn.disabled = false;
    }
  });
});

/* ──────────────────────────────────────────────────────────────────────────
   Solutions page — the four verticals, live & configurable.
   A site (yard) is tagged as one of four verticals and carries capability
   flags. This module renders each site with LIVE occupancy (from /api/yards,
   which computes it from current parking transactions) and its active
   capabilities, and lets an admin create/configure/delete a site. Capability
   chips deep-link into the real existing modules, so it is genuinely
   end-to-end, not a mock. Self-contained IIFE — no globals re-declared.
─────────────────────────────────────────────────────────────────────────── */
(function () {
  var VERTS = [
    ['Gated Community',  '🏘️', 'sol-card-purple'],
    ['Shopping Mall',    '🛍️', 'sol-card-blue'],
    ['Corporate Campus', '🏢', 'sol-card-cyan'],
    ['Street Parking',   '🅿️', 'sol-card-orange']
  ];
  var VMETA = {};
  VERTS.forEach(function (v) { VMETA[v[0]] = { emoji: v[1], cls: v[2] }; });

  // key, label, and the existing view a chip deep-links to
  var CAPS = [
    ['anpr',     'ANPR',             'video'],
    ['rfid',     'RFID/UHF',         'uhf-captures'],
    ['qr',       'QR Code',          'visitors'],
    ['barrier',  'Boom Barriers',    'equipment'],
    ['guidance', 'Parking Guidance', 'zone-live'],
    ['payments', 'Payments',         'orders'],
    ['visitor',  'Visitor Mgmt',     'visitors'],
    ['access',   'Access Control',   'role-perm']
  ];

  // Default capability set per vertical, straight from the solution spec.
  var PRESETS = {
    'Gated Community':  { anpr: 1, rfid: 1, qr: 1, barrier: 1, guidance: 1, payments: 0, visitor: 1, access: 1 },
    'Shopping Mall':    { anpr: 1, rfid: 1, qr: 1, barrier: 1, guidance: 1, payments: 1, visitor: 0, access: 0 },
    'Corporate Campus': { anpr: 1, rfid: 1, qr: 0, barrier: 1, guidance: 0, payments: 0, visitor: 1, access: 1 },
    'Street Parking':   { anpr: 1, rfid: 0, qr: 1, barrier: 0, guidance: 0, payments: 1, visitor: 0, access: 0 }
  };

  var solGet = function (id) { return document.getElementById(id); };
  function solEsc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c];
    });
  }
  function solToast(msg) {
    if (typeof toast === 'function') { toast(msg); return; }
    var t = solGet('toast'); if (!t) return;
    t.textContent = msg; t.classList.add('show');
    clearTimeout(solToast._t); solToast._t = setTimeout(function () { t.classList.remove('show'); }, 2600);
  }

  var solSites = [];
  var solFilter = 'all';
  var solPollTimer = null;

  function solActive() {
    var v = solGet('solutions');
    return v && v.classList.contains('active');
  }

  function solFetch() {
    return fetch('/api/yards', { cache: 'no-store', credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : []; })
      .then(function (rows) { return Array.isArray(rows) ? rows : []; })
      .catch(function () { return []; });
  }

  function solRender() {
    solFetch().then(function (rows) {
      solSites = rows;
      solPaintSummary();
      solPaintFilter();
      solPaintGrid();
    });
  }

  function solPaintSummary() {
    var el = solGet('sol-summary'); if (!el) return;
    var cap = 0, occ = 0;
    solSites.forEach(function (s) { cap += (s.capacity || 0); occ += (s.occupied || 0); });
    var pct = cap ? Math.round((occ / cap) * 100) : 0;
    var configured = solSites.filter(function (s) { return s.site_type; }).length;
    el.innerHTML =
      solStat(solSites.length, 'Sites', configured + ' configured') +
      solStat(occ + ' / ' + cap, 'Live occupancy', pct + '% full') +
      solStat(Math.max(0, cap - occ), 'Available now', 'across all sites') +
      solStat(VERTS.length, 'Verticals', 'one platform');
  }
  function solStat(v, label, sub) {
    return '<div class="sol-stat"><div class="sol-stat-v">' + solEsc(v) + '</div>' +
      '<div class="sol-stat-l">' + solEsc(label) + '</div>' +
      '<div class="sol-stat-s">' + solEsc(sub) + '</div></div>';
  }

  function solPaintFilter() {
    var el = solGet('sol-vfilter'); if (!el) return;
    var parts = ['<button class="sol-chip' + (solFilter === 'all' ? ' on' : '') + '" data-vf="all">All sites</button>'];
    VERTS.forEach(function (v) {
      var n = solSites.filter(function (s) { return s.site_type === v[0]; }).length;
      parts.push('<button class="sol-chip' + (solFilter === v[0] ? ' on' : '') + '" data-vf="' +
        solEsc(v[0]) + '">' + v[1] + ' ' + solEsc(v[0]) + ' (' + n + ')</button>');
    });
    el.innerHTML = parts.join('');
    el.querySelectorAll('[data-vf]').forEach(function (b) {
      b.addEventListener('click', function () { solFilter = b.dataset.vf; solPaintFilter(); solPaintGrid(); });
    });
  }

  function solPaintGrid() {
    var el = solGet('sol-grid'); if (!el) return;
    var list = solSites.filter(function (s) { return solFilter === 'all' || s.site_type === solFilter; });
    if (!list.length) {
      el.innerHTML = '<div class="sol-empty">No sites yet. Use <b>+ Configure a Site</b> to add one and pick its vertical.</div>';
      return;
    }
    el.innerHTML = list.map(solCard).join('');
    el.querySelectorAll('[data-edit]').forEach(function (b) {
      b.addEventListener('click', function () { solOpen(b.dataset.edit); });
    });
    el.querySelectorAll('[data-del]').forEach(function (b) {
      b.addEventListener('click', function () { solDelete(b.dataset.del, b.dataset.name); });
    });
    el.querySelectorAll('[data-go]').forEach(function (b) {
      b.addEventListener('click', function () {
        if (typeof switchView === 'function') switchView(b.dataset.go);
        if (typeof scrollMainToTop === 'function') scrollMainToTop();
      });
    });
  }

  function solCard(s) {
    var meta = VMETA[s.site_type] || { emoji: '📍', cls: 'sol-card-plain' };
    var cap = s.capacity || 0, occ = s.occupied || 0;
    var pct = cap ? Math.min(100, Math.round((occ / cap) * 100)) : 0;
    var caps = s.caps || {};
    var chips = CAPS.map(function (c) {
      var on = !!caps[c[0]];
      return '<button class="sol-cap-chip' + (on ? ' on' : '') + '" ' +
        (on ? 'data-go="' + c[2] + '" title="Open ' + solEsc(c[1]) + '"' : 'disabled title="Not enabled"') +
        '>' + solEsc(c[1]) + '</button>';
    }).join('');
    return '<article class="sol-card ' + meta.cls + '">' +
      '<div class="sol-card-head"><span class="sol-emoji">' + meta.emoji + '</span>' +
        '<div class="sol-card-titles"><h3>' + solEsc(s.name) + '</h3>' +
        '<span class="sol-card-vert">' + solEsc(s.site_type || 'Unconfigured') + '</span></div></div>' +
      '<div class="sol-occ"><div class="sol-occ-nums"><b>' + occ + '</b> / ' + cap +
        ' <span>(' + Math.max(0, cap - occ) + ' free)</span></div>' +
        '<div class="sol-occ-bar"><i style="width:' + pct + '%"></i></div></div>' +
      (s.region || s.location ? '<div class="sol-card-loc">' + solEsc([s.region, s.location].filter(Boolean).join(' · ')) + '</div>' : '') +
      '<div class="sol-card-caps">' + chips + '</div>' +
      '<div class="sol-card-acts"><button class="sol-btn sol-btn-sm" data-edit="' + s.id + '">Configure</button>' +
        '<button class="sol-btn sol-btn-sm sol-btn-danger" data-del="' + s.id + '" data-name="' + solEsc(s.name) + '">Delete</button></div>' +
      '</article>';
  }

  // ── modal ────────────────────────────────────────────────────────────────
  function solPaintCapChecks(preset) {
    var box = solGet('sol-f-caps'); if (!box) return;
    box.innerHTML = CAPS.map(function (c) {
      var on = preset && preset[c[0]];
      return '<label class="sol-capchk"><input type="checkbox" data-cap="' + c[0] + '"' +
        (on ? ' checked' : '') + '><span>' + solEsc(c[1]) + '</span></label>';
    }).join('');
  }

  function solOpen(id) {
    var site = id ? solSites.filter(function (s) { return String(s.id) === String(id); })[0] : null;
    solGet('sol-modal-title').textContent = site ? 'Configure Site' : 'Add a Site';
    solGet('sol-f-id').value = site ? site.id : '';
    solGet('sol-f-name').value = site ? (site.name || '') : '';
    solGet('sol-f-type').value = site ? (site.site_type || '') : '';
    solGet('sol-f-capacity').value = site ? (site.capacity || '') : '';
    solGet('sol-f-region').value = site ? (site.region || '') : '';
    solGet('sol-f-location').value = site ? (site.location || '') : '';
    solPaintCapChecks(site ? site.caps : null);
    var err = solGet('sol-modal-err'); err.hidden = true; err.textContent = '';
    solGet('sol-modal').hidden = false;
  }
  function solClose() { solGet('sol-modal').hidden = true; }

  function solReadCaps() {
    var caps = {};
    document.querySelectorAll('#sol-f-caps [data-cap]').forEach(function (cb) {
      caps[cb.dataset.cap] = cb.checked;
    });
    return caps;
  }

  function solSave() {
    var id = solGet('sol-f-id').value;
    var name = solGet('sol-f-name').value.trim();
    var type = solGet('sol-f-type').value;
    var err = solGet('sol-modal-err');
    if (!name) { err.textContent = 'Site name is required.'; err.hidden = false; return; }
    if (!type) { err.textContent = 'Please pick a vertical.'; err.hidden = false; return; }
    // "+ Configure a Site" with a name that already exists should reconfigure
    // that site rather than dead-end as a duplicate. Match case-insensitively
    // against the sites already loaded so the save becomes a PUT, not a POST.
    if (!id) {
      var match = solSites.filter(function (s) {
        return (s.name || '').trim().toLowerCase() === name.toLowerCase();
      })[0];
      if (match) id = String(match.id);
    }
    var payload = {
      name: name, site_type: type,
      capacity: parseInt(solGet('sol-f-capacity').value, 10) || 0,
      region: solGet('sol-f-region').value.trim(),
      location: solGet('sol-f-location').value.trim(),
      caps: solReadCaps()
    };
    var url = id ? '/api/yards/' + id : '/api/yards';
    var method = id ? 'PUT' : 'POST';
    solGet('sol-save').disabled = true;
    fetch(url, {
      method: method, credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
      .then(function (res) {
        solGet('sol-save').disabled = false;
        if (!res.ok || (res.d && res.d.status === 'error')) {
          err.textContent = (res.d && res.d.message) || 'Could not save the site.'; err.hidden = false; return;
        }
        solClose();
        solToast(id ? 'Site updated.' : 'Site configured.');
        solRender();
      }).catch(function () {
        solGet('sol-save').disabled = false;
        err.textContent = 'Network error while saving.'; err.hidden = false;
      });
  }

  function solDelete(id, name) {
    if (!window.confirm('Delete site "' + name + '"? This removes the site configuration.')) return;
    fetch('/api/yards/' + id, { method: 'DELETE', credentials: 'same-origin' })
      .then(function (r) { return r.json().catch(function () { return {}; }); })
      .then(function () { solToast('Site deleted.'); solRender(); })
      .catch(function () { solToast('Could not delete the site.'); });
  }

  // ── wiring ─────────────────────────────────────────────────────────────────
  function solWire() {
    var add = solGet('sol-add-btn');
    if (add && !add._wired) { add._wired = 1; add.addEventListener('click', function () { solOpen(null); }); }
    var close = solGet('sol-modal-close'), cancel = solGet('sol-cancel'), save = solGet('sol-save');
    if (close && !close._wired) { close._wired = 1; close.addEventListener('click', solClose); }
    if (cancel && !cancel._wired) { cancel._wired = 1; cancel.addEventListener('click', solClose); }
    if (save && !save._wired) { save._wired = 1; save.addEventListener('click', solSave); }
    var type = solGet('sol-f-type');
    if (type && !type._wired) {
      type._wired = 1;
      type.addEventListener('change', function () {
        // Re-preset capabilities when a vertical is chosen for a NEW site,
        // or when the admin switches an existing site's vertical.
        var preset = PRESETS[type.value] || null;
        if (preset) solPaintCapChecks(preset);
      });
    }
    var back = solGet('sol-modal');
    if (back && !back._wired) {
      back._wired = 1;
      back.addEventListener('click', function (e) { if (e.target === back) solClose(); });
    }
  }

  // Init — runs immediately (this script loads at end of <body>, so the nav +
  // modal DOM already exist) and again on DOMContentLoaded as a fallback. All
  // wiring is idempotent (guarded by _wired flags), so double-calls are safe.
  function solInit() {
    solWire();
    var btn = document.querySelector('.nav-item[data-view="solutions"]');
    if (btn && !btn._solwired) {
      btn._solwired = 1;
      btn.addEventListener('click', function () { solWire(); solRender(); });
    }
    if (!solInit._poll) {
      // real-time occupancy: refresh every 15s while the page is open + no modal.
      solInit._poll = setInterval(function () {
        var m = solGet('sol-modal');
        if (solActive() && (!m || m.hidden)) solRender();
      }, 15000);
    }
    if (solActive()) solRender();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', solInit);
  else solInit();

  // Belt-and-suspenders: also render when the app's own switchView lands on the
  // Solutions view (covers deep-links and any nav path that bypasses the click).
  if (typeof switchView === 'function') {
    var _solOrigSwitch = switchView;
    switchView = function (n) {
      _solOrigSwitch(n);
      if (n === 'solutions') { solWire(); solRender(); }
    };
  }
})();

/* ──────────────────────────────────────────────────────────────────────────
   Printer & Ticketing console. Talks to the /api/printer/* endpoints
   (config/status/preview/test/print-ticket/print-receipt). The preview is
   rendered server-side by the SAME builder the printer receives, so what you
   see is what prints. Self-contained IIFE; no globals re-declared.
─────────────────────────────────────────────────────────────────────────── */
(function () {
  var g = function (id) { return document.getElementById(id); };
  var prnDoc = 'ticket';
  var prnCfgLoaded = false;

  function prnMsg(text, kind) {
    var m = g('prn-msg'); if (!m) return;
    m.textContent = text; m.hidden = false;
    m.className = 'prn-msg' + (kind === 'error' ? ' prn-msg-err' : ' prn-msg-ok');
    clearTimeout(prnMsg._t); prnMsg._t = setTimeout(function () { m.hidden = true; }, 4000);
  }

  function prnActive() { var v = g('printer'); return v && v.classList.contains('active'); }

  function prnLoadConfig() {
    return fetch('/api/printer/config', { cache: 'no-store', credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (c) {
        if (!c) return;
        g('prn-enabled').checked = c.printer_enabled === '1' || c.printer_enabled === true;
        g('prn-conn').value = c.printer_conn || 'lan';
        g('prn-host').value = c.printer_host || '';
        g('prn-port').value = c.printer_port || '9100';
        g('prn-usb-name').value = c.printer_usb_name || '';
        g('prn-width').value = c.printer_width || '80';
        g('prn-lane').value = c.printer_lane || '';
        if (g('prn-baseurl')) g('prn-baseurl').value = c.public_base_url || '';
        g('prn-org').value = c.printer_org || '';
        g('prn-footer').value = c.printer_footer || '';
        g('prn-logo').checked = c.printer_logo === '1' || c.printer_logo === true;
        g('prn-qr').checked = c.printer_qr === '1' || c.printer_qr === true;
        g('prn-autocut').checked = c.printer_autocut === '1' || c.printer_autocut === true;
        g('prn-auto-ticket').checked = c.printer_auto_ticket === '1' || c.printer_auto_ticket === true;
        g('prn-auto-receipt').checked = c.printer_auto_receipt === '1' || c.printer_auto_receipt === true;
        prnToggleConn();
        prnLogoImg();
        prnCfgLoaded = true;
      }).catch(function () {});
  }

  // Show/hide the logo image in the white paper preview to mirror the toggle.
  function prnLogoImg() {
    var img = g('prn-paper-logo');
    if (img) img.hidden = !g('prn-logo').checked;
  }

  // Render the bound QR image (data URI from the server) on the paper preview.
  function prnSetQr(uri) {
    var img = g('prn-paper-qr');
    if (!img) return;
    if (uri && g('prn-qr').checked) { img.src = uri; img.hidden = false; }
    else { img.hidden = true; img.removeAttribute('src'); }
  }

  // Lay the paper out as: ticket body → QR image (at the "[ QR CODE ]" spot) →
  // remainder (Scan at Exit + footer). Splits the server preview text on the
  // placeholder line so the QR sits inline where it prints, not at the bottom.
  function prnRenderPreview(text, qr) {
    var top = g('prn-preview'), bot = g('prn-preview-bot');
    text = text || '';
    var showQr = !!qr && g('prn-qr').checked;
    var parts = text.split(/[ \t]*\[ ?QR ?CODE ?\][ \t]*\r?\n?/i);
    if (showQr && parts.length >= 2) {
      top.textContent = parts[0].replace(/\s+$/, '');
      bot.textContent = parts.slice(1).join('').replace(/^\r?\n/, '');
      bot.hidden = false;
    } else {
      top.textContent = text;
      bot.textContent = '';
      bot.hidden = true;
    }
    prnSetQr(qr);
  }

  function prnToggleConn() {
    var lan = g('prn-conn').value !== 'usb';
    var lanB = document.querySelector('.prn-lan'), usbB = document.querySelector('.prn-usb');
    if (lanB) lanB.hidden = !lan;
    if (usbB) usbB.hidden = lan;
  }

  function prnGather() {
    return {
      printer_enabled: g('prn-enabled').checked ? '1' : '0',
      printer_conn: g('prn-conn').value,
      printer_host: g('prn-host').value.trim(),
      printer_port: g('prn-port').value.trim() || '9100',
      printer_usb_name: g('prn-usb-name').value.trim(),
      printer_width: g('prn-width').value,
      printer_lane: g('prn-lane').value.trim(),
      public_base_url: g('prn-baseurl') ? g('prn-baseurl').value.trim() : '',
      printer_org: g('prn-org').value.trim(),
      printer_footer: g('prn-footer').value,
      printer_logo: g('prn-logo').checked ? '1' : '0',
      printer_qr: g('prn-qr').checked ? '1' : '0',
      printer_autocut: g('prn-autocut').checked ? '1' : '0',
      printer_auto_ticket: g('prn-auto-ticket').checked ? '1' : '0',
      printer_auto_receipt: g('prn-auto-receipt').checked ? '1' : '0'
    };
  }

  function prnSave() {
    g('prn-save').disabled = true;
    fetch('/api/printer/config', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(prnGather())
    }).then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
      .then(function (res) {
        g('prn-save').disabled = false;
        if (!res.ok) { prnMsg((res.d && res.d.message) || 'Save failed (admin only).', 'error'); return; }
        prnMsg('Settings saved.', 'ok'); prnStatus(); prnPreview();
      }).catch(function () { g('prn-save').disabled = false; prnMsg('Network error.', 'error'); });
  }

  function prnStatus() {
    var dot = document.querySelector('#prn-status .prn-dot');
    var txt = g('prn-status-text');
    fetch('/api/printer/status', { cache: 'no-store', credentials: 'same-origin' })
      .then(function (r) { return r.json(); })
      .then(function (s) {
        if (txt) txt.textContent = (s.transport || '') + ' · ' + (s.message || '');
        if (dot) dot.className = 'prn-dot ' + (s.online ? 'on' : 'off');
      }).catch(function () { if (txt) txt.textContent = 'status unavailable'; });
  }

  function prnLoadJobs() {
    var body = g('prn-jobs-body'); if (!body) return;
    fetch('/api/printer/jobs', { cache: 'no-store', credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : []; })
      .then(function (rows) {
        if (!Array.isArray(rows) || !rows.length) {
          body.innerHTML = '<tr><td colspan="8" style="text-align:center;color:var(--muted)">No prints yet.</td></tr>';
          var m0 = g('prn-jobs-meta'); if (m0) m0.textContent = 'No prints yet.';
          return;
        }
        body.innerHTML = rows.map(function (j) {
          var col = j.status === 'sent' ? 'var(--ok)' : 'var(--danger)';
          var st = '<span style="font-weight:700;color:' + col + '">' + _esc(j.status) + '</span>';
          var amt = j.amount ? ('₹' + j.amount) : '—';
          var dev = _esc(j.transport) + (j.target ? ' · ' + _esc(j.target) : '');
          return '<tr><td>' + _esc(j.when) + '</td><td>' + _esc(j.kind) +
            '</td><td>' + _esc(j.ticket_no || '—') + '</td><td>' + _esc(j.vehicle || '—') +
            '</td><td>' + amt + '</td><td style="font-size:0.85em">' + dev +
            '</td><td>' + _esc(j.printed_by) + ' <small style="color:var(--muted)">(' + _esc(j.role) + ')</small>' +
            '</td><td>' + st + '</td></tr>';
        }).join('');
        var m = g('prn-jobs-meta'); if (m) m.textContent = rows.length + ' recent prints';
      }).catch(function () {});
  }

  function prnData() {
    if (prnDoc === 'receipt') {
      return {
        ticketNo: g('pr-ticket').value, vehicleNo: g('pr-vehicle').value,
        entryTime: g('pr-entry').value, exitTime: g('pr-exit').value,
        duration: g('pr-duration').value, total: g('pr-total').value,
        fee: g('pr-total').value, discount: 0, payment: g('pr-payment').value,
        qrData: g('pr-ticket').value
      };
    }
    var now = new Date();
    return {
      ticketNo: g('pt-ticket').value, vehicleNo: g('pt-vehicle').value,
      vehicleType: g('pt-type').value, entryTime: g('pt-entry').value,
      date: now.toLocaleDateString('en-GB'),
      time: now.toLocaleTimeString('en-GB'),
      qrData: g('pt-ticket').value
    };
  }

  function prnPreview() {
    var pre = g('prn-preview'); if (!pre) return;
    fetch('/api/printer/preview', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: prnDoc, data: prnData() })
    }).then(function (r) { return r.json(); })
      .then(function (d) { prnRenderPreview(d.preview || '(no preview)', d.qr); })
      .catch(function () { pre.textContent = '(preview unavailable)'; });
  }

  function prnPrint() {
    var url = prnDoc === 'receipt' ? '/api/printer/print-receipt' : '/api/printer/print-ticket';
    g('prn-print').disabled = true;
    fetch(url, {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(prnData())
    }).then(function (r) { return r.json(); })
      .then(function (d) {
        g('prn-print').disabled = false;
        if (d.preview) prnRenderPreview(d.preview, d.qr); else prnSetQr(d.qr);
        prnLoadJobs();
        prnMsg(d.message || (d.status === 'ok' ? 'Sent to printer.' : 'Print failed.'),
          d.status === 'ok' ? 'ok' : 'error');
      }).catch(function () { g('prn-print').disabled = false; prnMsg('Network error.', 'error'); });
  }

  function prnTest() {
    g('prn-test').disabled = true;
    fetch('/api/printer/test', { method: 'POST', credentials: 'same-origin' })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        g('prn-test').disabled = false;
        if (d.preview) prnRenderPreview(d.preview, d.qr); else prnSetQr(d.qr);
        prnLoadJobs();
        prnMsg(d.message || 'Test sent.', d.status === 'ok' ? 'ok' : 'error');
      }).catch(function () { g('prn-test').disabled = false; prnMsg('Network error.', 'error'); });
  }

  function prnSwitchDoc(doc) {
    prnDoc = doc;
    document.querySelectorAll('.prn-tab').forEach(function (t) { t.classList.toggle('on', t.dataset.doc === doc); });
    var st = g('prn-sample-ticket'), sr = g('prn-sample-receipt');
    if (st) st.hidden = doc !== 'ticket';
    if (sr) sr.hidden = doc !== 'receipt';
    prnPreview();
  }

  function prnWire() {
    var save = g('prn-save'); if (save && !save._w) { save._w = 1; save.addEventListener('click', prnSave); }
    var test = g('prn-test'); if (test && !test._w) { test._w = 1; test.addEventListener('click', prnTest); }
    var pr = g('prn-print'); if (pr && !pr._w) { pr._w = 1; pr.addEventListener('click', prnPrint); }
    var conn = g('prn-conn'); if (conn && !conn._w) { conn._w = 1; conn.addEventListener('change', prnToggleConn); }
    var logo = g('prn-logo'); if (logo && !logo._w) { logo._w = 1; logo.addEventListener('change', prnLogoImg); }
    document.querySelectorAll('.prn-tab').forEach(function (t) {
      if (!t._w) { t._w = 1; t.addEventListener('click', function () { prnSwitchDoc(t.dataset.doc); }); }
    });
    // live preview as sample fields change
    ['pt-ticket','pt-vehicle','pt-type','pt-entry','pr-ticket','pr-vehicle','pr-entry','pr-exit','pr-duration','pr-total','pr-payment',
     'prn-org','prn-footer','prn-width','prn-qr','prn-lane'].forEach(function (id) {
      var el = g(id);
      if (el && !el._w) { el._w = 1; el.addEventListener('input', function () { clearTimeout(prnWire._t); prnWire._t = setTimeout(prnPreview, 250); }); }
    });
  }

  function prnEnter() {
    prnWire();
    (prnCfgLoaded ? Promise.resolve() : prnLoadConfig()).then(function () { prnStatus(); prnPreview(); });
    prnLoadJobs();
  }

  function prnInit() {
    var btn = document.querySelector('.nav-item[data-view="printer"]');
    if (btn && !btn._prnw) { btn._prnw = 1; btn.addEventListener('click', prnEnter); }
    if (!prnInit._poll) {
      prnInit._poll = setInterval(function () { if (prnActive()) prnStatus(); }, 20000);
    }
    if (prnActive()) prnEnter();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', prnInit);
  else prnInit();

  if (typeof switchView === 'function') {
    var _prnOrigSwitch = switchView;
    switchView = function (n) { _prnOrigSwitch(n); if (n === 'printer') prnEnter(); };
  }
})();

// ═══════════════════════════ SMART PARKING (real-time) ═══════════════════════
// Three views share one IIFE so they can share the driver token, buzzer and
// SSE helpers. Follows the sol*/prn* module conventions (Active/Enter/poll +
// switchView wrap). Backend is the source of truth; SSE pushes live changes.
(function () {
  var g = function (id) { return document.getElementById(id); };
  var esc = window._esc || function (s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; });
  };
  var toastFn = function (m, k) { if (typeof toast === 'function') toast(m, k || 'ok'); };

  // ── driver auth (own token, independent of the admin session cookie) ────────
  var TOKEN_KEY = 'vay_driver_token', USER_KEY = 'vay_driver_user';
  function getTok() { try { return localStorage.getItem(TOKEN_KEY) || ''; } catch (e) { return ''; } }
  function getUser() { try { return JSON.parse(localStorage.getItem(USER_KEY) || '{}'); } catch (e) { return {}; } }
  function setAuth(t, u) { try { localStorage.setItem(TOKEN_KEY, t); localStorage.setItem(USER_KEY, JSON.stringify(u || {})); } catch (e) {} }
  function clearAuth() { try { localStorage.removeItem(TOKEN_KEY); localStorage.removeItem(USER_KEY); } catch (e) {} }
  function authHdrs(json) { var h = {}; if (json) h['Content-Type'] = 'application/json'; var t = getTok(); if (t) h['Authorization'] = 'Bearer ' + t; return h; }
  function jget(url) { return fetch(url, { headers: authHdrs(false), cache: 'no-store', credentials: 'same-origin' }).then(function (r) { return r.json(); }); }
  function jsend(url, method, body) {
    return fetch(url, { method: method, headers: authHdrs(true), credentials: 'same-origin',
      body: body ? JSON.stringify(body) : undefined })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, status: r.status, d: d }; })
        .catch(function () { return { ok: r.ok, status: r.status, d: {} }; }); });
  }

  // ── buzzer + browser notification ───────────────────────────────────────────
  var _actx = null;
  function soundOn() { try { return localStorage.getItem('pk_sound') !== '0'; } catch (e) { return true; } }
  function setSound(on) { try { localStorage.setItem('pk_sound', on ? '1' : '0'); } catch (e) {} }
  function buzz() {
    if (!soundOn()) return;
    try {
      _actx = _actx || new (window.AudioContext || window.webkitAudioContext)();
      var ctx = _actx, t = ctx.currentTime;
      [880, 1175].forEach(function (f, i) {
        var o = ctx.createOscillator(), gn = ctx.createGain();
        o.type = 'sine'; o.frequency.value = f; o.connect(gn); gn.connect(ctx.destination);
        var st = t + i * 0.18;
        gn.gain.setValueAtTime(0.0001, st);
        gn.gain.exponentialRampToValueAtTime(0.3, st + 0.02);
        gn.gain.exponentialRampToValueAtTime(0.0001, st + 0.16);
        o.start(st); o.stop(st + 0.17);
      });
    } catch (e) {}
  }
  function notify(title, body) {
    try {
      if (!('Notification' in window)) return;
      if (Notification.permission === 'granted') new Notification(title, { body: body });
      else if (Notification.permission !== 'denied') Notification.requestPermission();
    } catch (e) {}
  }

  // ── SSE: one connection per active view, filtered by location ───────────────
  function makeSSE(locationId, onEvent, onState) {
    var es = null, closed = false;
    function open() {
      if (closed) return;
      try {
        es = new EventSource('/api/events/slots?location=' + locationId);
        es.onopen = function () { onState && onState(true); };
        es.onmessage = function (ev) { try { onEvent(JSON.parse(ev.data)); } catch (e) {} };
        es.onerror = function () { onState && onState(false); }; // EventSource auto-reconnects
      } catch (e) { onState && onState(false); }
    }
    open();
    return { close: function () { closed = true; if (es) { try { es.close(); } catch (e) {} } } };
  }

  var STATUS_TEXT = { AVAILABLE: 'Available', HELD: 'Held', RESERVED: 'Reserved',
                      OCCUPIED: 'Occupied', DISABLED: 'Disabled', OUT_OF_SERVICE: 'Out of svc' };

  // ═══════════════════════ 1) BOOK PARKING (driver) ════════════════════════════
  var pbk = {
    loc: null, block: null, slots: {}, mine: [], watches: {}, sse: null, otpRes: null
  };
  function pbkActive() { var el = g('park-book'); return el && el.classList.contains('active'); }

  function pbkEnter() {
    if (!pbkActive()) return;
    if (getTok()) { pbkShowApp(); } else { pbkShowLogin(); }
  }
  function pbkShowLogin() { g('pbk-login').hidden = false; g('pbk-app').hidden = true; }
  function pbkShowApp() {
    g('pbk-login').hidden = true; g('pbk-app').hidden = false;
    var u = getUser();
    g('pbk-who').textContent = (u && u.name) ? u.name : (u && u.email) || 'Driver';
    g('pbk-sound').checked = soundOn();
    pbkLoadLocations(); pbkLoadMine(); pbkLoadWatches();
    notify('', '');  // nudge permission prompt (no-op notification)
  }

  function pbkMsg(t, ok) { var el = g('pbk-login-msg'); if (!el) return; el.textContent = t || ''; el.hidden = !t; el.className = 'pk-msg' + (ok ? ' ok' : ''); }

  function pbkLogin() {
    var email = (g('pbk-email').value || '').trim().toLowerCase();
    var pass = g('pbk-pass').value || '';
    if (!email || !pass) { pbkMsg('Enter email and password.'); return; }
    g('pbk-login-btn').disabled = true;
    fetch('/api/driver/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email, password: pass }) })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
      .then(function (res) {
        g('pbk-login-btn').disabled = false;
        if (!res.ok || !res.d.token) { pbkMsg(res.d.error || 'Sign in failed.'); return; }
        setAuth(res.d.token, res.d.user); pbkMsg('', true); pbkShowApp();
      }).catch(function () { g('pbk-login-btn').disabled = false; pbkMsg('Network error.'); });
  }

  function pbkRegister() {
    var email = (g('pbk-email').value || '').trim().toLowerCase();
    var pass = g('pbk-pass').value || '';
    if (!email || pass.length < 6) { pbkMsg('Enter email and a 6+ char password to register.'); return; }
    var name = email.split('@')[0];
    g('pbk-reg-btn').disabled = true;
    fetch('/api/driver/register', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name, email: email, password: pass }) })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
      .then(function (res) {
        g('pbk-reg-btn').disabled = false;
        if (!res.ok || !res.d.token) { pbkMsg(res.d.error || 'Registration failed.'); return; }
        setAuth(res.d.token, res.d.user); pbkMsg('', true); pbkShowApp();
      }).catch(function () { g('pbk-reg-btn').disabled = false; pbkMsg('Network error.'); });
  }

  function pbkLogout() {
    if (pbk.sse) { pbk.sse.close(); pbk.sse = null; }
    clearAuth(); pbk.loc = null; pbk.block = null; pbk.slots = {};
    pbkShowLogin();
  }

  function pbkLoadLocations() {
    jget('/api/park/locations').then(function (rows) {
      var row = g('pbk-loc-row');
      if (!rows || !rows.length) { row.innerHTML = '<span class="pk-muted">No bookable locations yet. An admin adds blocks &amp; slots in Parking Setup.</span>'; return; }
      row.innerHTML = rows.map(function (l) {
        return '<button class="pk-chip' + (pbk.loc === l.id ? ' on' : '') + '" data-loc="' + l.id + '">' +
          esc(l.name) + ' <span class="pk-muted">(' + l.available + '/' + l.total_slots + ')</span></button>';
      }).join('');
      row.querySelectorAll('[data-loc]').forEach(function (b) {
        b.addEventListener('click', function () { pbkSelectLoc(parseInt(b.dataset.loc, 10)); });
      });
      if (pbk.loc == null && rows.length === 1) pbkSelectLoc(rows[0].id);
    });
  }

  function pbkSelectLoc(id) {
    pbk.loc = id; pbk.block = null;
    document.querySelectorAll('#pbk-loc-row .pk-chip').forEach(function (b) {
      b.classList.toggle('on', parseInt(b.dataset.loc, 10) === id); });
    g('pbk-slotwrap').hidden = true;
    pbkLoadBlocks();
    if (pbk.sse) pbk.sse.close();
    pbk.sse = makeSSE(id, pbkOnEvent, function (on) {
      var c = g('pbk-conn'); if (c) { c.textContent = on ? '● live' : '● offline'; c.classList.toggle('on', on); }
    });
  }

  function pbkLoadBlocks() {
    jget('/api/park/locations/' + pbk.loc + '/blocks').then(function (data) {
      var wrap = g('pbk-blockwrap'); wrap.hidden = false;
      var blocks = (data && data.blocks) || [];
      g('pbk-block-title').textContent = (data.location ? data.location.name : 'Blocks');
      var el = g('pbk-blocks');
      if (!blocks.length) { el.innerHTML = '<div class="pk-empty">No blocks configured here yet.</div>'; return; }
      el.innerHTML = blocks.map(function (b) {
        var pct = b.total_slots ? Math.round((b.occupied / b.total_slots) * 100) : 0;
        return '<div class="pk-block-card' + (pbk.block === b.id ? ' on' : '') + '" data-block="' + b.id + '">' +
          '<h4>' + esc(b.name) + '</h4>' +
          '<div class="pk-block-counts"><span class="pk-c-green"><b>' + b.available + '</b> free</span>' +
          '<span class="pk-c-red"><b>' + b.occupied + '</b> taken</span>' +
          '<span class="pk-c-total">' + b.total_slots + ' total</span></div>' +
          '<div class="pk-bar"><i style="width:' + pct + '%"></i></div></div>';
      }).join('');
      el.querySelectorAll('[data-block]').forEach(function (c) {
        c.addEventListener('click', function () { pbkSelectBlock(parseInt(c.dataset.block, 10), c.querySelector('h4').textContent); });
      });
    });
  }

  function pbkSelectBlock(id, name) {
    pbk.block = id;
    document.querySelectorAll('#pbk-blocks .pk-block-card').forEach(function (c) {
      c.classList.toggle('on', parseInt(c.dataset.block, 10) === id); });
    g('pbk-slot-title').textContent = 'Slots · ' + (name || '');
    g('pbk-slotwrap').hidden = false;
    pbkLoadSlots();
  }

  function pbkLoadSlots() {
    jget('/api/park/blocks/' + pbk.block + '/slots').then(function (data) {
      pbk.slots = {};
      (data.slots || []).forEach(function (s) { pbk.slots[s.id] = s; });
      pbkRenderSlots();
    });
  }

  function pbkRenderSlots() {
    var el = g('pbk-grid');
    var arr = Object.keys(pbk.slots).map(function (k) { return pbk.slots[k]; });
    arr.sort(function (a, b) { return (a.display_order - b.display_order) || a.label.localeCompare(b.label); });
    g('pbk-grid-empty').hidden = arr.length > 0;
    var mineSlotIds = {};
    pbk.mine.forEach(function (r) { if (r.slot_id) mineSlotIds[r.slot_id] = r; });
    el.innerHTML = arr.map(function (s) {
      var cls = 's-' + (s.color || 'grey');
      var mine = mineSlotIds[s.id] ? ' mine' : '';
      var watching = pbk.watches[s.id] ? '<span class="pk-watch" title="Watching">🔔</span>' : '';
      return '<button class="pk-slot ' + cls + mine + '" data-slot="' + s.id + '" ' +
        'aria-label="Slot ' + esc(s.label) + ' ' + esc(STATUS_TEXT[s.status] || s.status) + '">' +
        watching +
        '<span class="pk-slot-lbl">' + esc(s.label) + '</span>' +
        '<span class="pk-slot-st">' + esc(STATUS_TEXT[s.status] || s.status) + '</span></button>';
    }).join('');
    el.querySelectorAll('[data-slot]').forEach(function (b) {
      b.addEventListener('click', function () { pbkSlotClick(parseInt(b.dataset.slot, 10)); });
    });
  }

  function pbkSlotClick(id) {
    var s = pbk.slots[id]; if (!s) return;
    if (s.status === 'AVAILABLE') { pbkOpenBooking(s); return; }
    if (s.status === 'RESERVED' || s.status === 'OCCUPIED' || s.status === 'HELD') {
      // offer watch / unwatch
      if (pbk.watches[id]) {
        jsend('/api/park/slots/' + id + '/watch', 'DELETE').then(function () {
          delete pbk.watches[id]; pbkRenderSlots(); toastFn('Stopped watching ' + s.label);
        });
      } else if (window.confirm('Slot ' + s.label + ' is ' + (STATUS_TEXT[s.status] || s.status).toLowerCase() + '.\nNotify me (buzzer + notification) when it frees up?')) {
        jsend('/api/park/slots/' + id + '/watch', 'POST').then(function () {
          pbk.watches[id] = true; pbkRenderSlots(); toastFn('You will be notified when ' + s.label + ' frees up.', 'ok');
        });
      }
      return;
    }
    toastFn('Slot ' + s.label + ' is not available.', 'error');
  }

  // ── booking modal (confirm → OTP → success) ─────────────────────────────────
  function pbkModal(open) { g('pbk-modal').hidden = !open; if (!open) pbk.otpRes = null; }
  function pbkModalMsg(t, ok) { var el = g('pbk-modal-msg'); el.textContent = t || ''; el.hidden = !t; el.className = 'pk-msg' + (ok ? ' ok' : ''); }

  function pbkOpenBooking(s) {
    var u = getUser();
    g('pbk-modal-title').textContent = 'Confirm slot ' + s.label;
    g('pbk-modal-body').innerHTML =
      '<div class="pk-field"><label>Vehicle plate</label><input id="pbk-plate" value="' + esc(u.primary_plate || '') + '" placeholder="TS09AB1234"></div>' +
      '<div class="pk-field"><label>Duration (hours)</label><input id="pbk-hours" type="number" min="1" max="24" value="4"></div>' +
      '<p class="pk-muted">An OTP will be sent to confirm this booking.</p>';
    g('pbk-modal-foot').innerHTML =
      '<button class="pk-btn" id="pbk-cancel-btn">Cancel</button>' +
      '<button class="pk-btn pk-btn-primary" id="pbk-hold-btn">Send OTP &amp; hold</button>';
    pbkModalMsg('');
    pbkModal(true);
    g('pbk-cancel-btn').onclick = function () { pbkModal(false); };
    g('pbk-hold-btn').onclick = function () { pbkDoHold(s); };
  }

  function pbkDoHold(s) {
    var plate = (g('pbk-plate').value || '').trim().toUpperCase();
    var hours = parseInt(g('pbk-hours').value, 10) || 4;
    if (!plate) { pbkModalMsg('Enter your vehicle plate.'); return; }
    g('pbk-hold-btn').disabled = true;
    jsend('/api/park/slots/' + s.id + '/hold', 'POST', { plate: plate, hours: hours }).then(function (res) {
      g('pbk-hold-btn').disabled = false;
      if (!res.ok) { pbkModalMsg(res.d.error || 'Could not hold the slot.'); pbkLoadSlots(); return; }
      pbk.otpRes = res.d;
      pbkOtpStep(res.d);
    }).catch(function () { g('pbk-hold-btn').disabled = false; pbkModalMsg('Network error.'); });
  }

  function pbkOtpStep(r) {
    g('pbk-modal-title').textContent = 'Enter OTP';
    var dev = r.otp_dev ? '<div class="pk-otp-dev">Demo mode — your OTP is <b>' + esc(r.otp_dev) + '</b> (no SMS provider configured yet)</div>' : '';
    g('pbk-modal-body').innerHTML =
      '<p class="pk-muted">OTP sent to ' + esc(r.otp_sent_to || 'your device') + ' for slot <b>' + esc(r.slot_label) + '</b>.</p>' +
      dev +
      '<input id="pbk-otp" class="pk-field" style="width:100%;padding:12px;font-size:20px;letter-spacing:6px;text-align:center" ' +
      'inputmode="numeric" maxlength="8" placeholder="______">' +
      '<p class="pk-muted" style="text-align:center">This slot is held for you for a short time.</p>';
    g('pbk-modal-foot').innerHTML =
      '<button class="pk-btn" id="pbk-otp-resend">Resend</button>' +
      '<button class="pk-btn" id="pbk-otp-cancel">Cancel</button>' +
      '<button class="pk-btn pk-btn-primary" id="pbk-otp-verify">Verify</button>';
    pbkModalMsg('');
    g('pbk-otp').focus();
    g('pbk-otp-verify').onclick = function () { pbkVerify(r); };
    g('pbk-otp-cancel').onclick = function () { pbkCancelHold(r); };
    g('pbk-otp-resend').onclick = function () { pbkResend(r); };
  }

  function pbkVerify(r) {
    var code = (g('pbk-otp').value || '').trim();
    if (!code) { pbkModalMsg('Enter the OTP.'); return; }
    g('pbk-otp-verify').disabled = true;
    jsend('/api/park/reservations/' + r.id + '/confirm-otp', 'POST', { code: code }).then(function (res) {
      g('pbk-otp-verify').disabled = false;
      if (!res.ok) { pbkModalMsg(res.d.error || 'Incorrect OTP.'); return; }
      pbkSuccess(res.d);
      pbkLoadMine(); pbkLoadSlots();
    }).catch(function () { g('pbk-otp-verify').disabled = false; pbkModalMsg('Network error.'); });
  }

  function pbkResend(r) {
    jsend('/api/park/reservations/' + r.id + '/resend-otp', 'POST').then(function (res) {
      if (!res.ok) { pbkModalMsg(res.d.error || 'Could not resend.'); return; }
      pbkModalMsg(res.d.otp_dev ? ('New OTP (demo): ' + res.d.otp_dev) : 'A new OTP was sent.', true);
    });
  }

  function pbkCancelHold(r) {
    jsend('/api/park/reservations/' + r.id + '/cancel', 'POST').then(function () {
      pbkModal(false); pbkLoadSlots(); pbkLoadMine();
    });
  }

  function pbkSuccess(r) {
    g('pbk-modal-title').textContent = 'Reservation confirmed';
    g('pbk-modal-body').innerHTML =
      '<div class="pk-qr"><img src="/api/park/reservations/' + r.id + '/qr.png" alt="Booking QR"></div>' +
      '<div class="pk-kv"><span>Booking</span><b>' + esc(r.booking_code || '') + '</b></div>' +
      '<div class="pk-kv"><span>Location</span><b>' + esc(r.yard || '') + '</b></div>' +
      '<div class="pk-kv"><span>Slot</span><b>' + esc(r.slot_label || '') + '</b></div>' +
      '<div class="pk-kv"><span>Vehicle</span><b>' + esc(r.vehicle_plate || '') + '</b></div>' +
      '<div class="pk-kv"><span>Must arrive by</span><b>' + esc(r.grace_until || '—') + '</b></div>' +
      '<p class="pk-muted" style="margin-top:10px">Scan this QR at the gate. Manage it under “My parking”.</p>';
    g('pbk-modal-foot').innerHTML = '<button class="pk-btn pk-btn-primary" id="pbk-done">Done</button>';
    pbkModalMsg('');
    g('pbk-done').onclick = function () { pbkModal(false); };
    toastFn('Slot ' + r.slot_label + ' reserved — ' + (r.booking_code || ''), 'ok');
  }

  // ── my parking ──────────────────────────────────────────────────────────────
  function pbkLoadMine() {
    jget('/api/park/reservations/mine').then(function (data) {
      pbk.mine = (data && data.active) || [];
      pbkRenderMine();
      if (Object.keys(pbk.slots).length) pbkRenderSlots();
    });
  }

  function pbkRenderMine() {
    var el = g('pbk-mine');
    if (!pbk.mine.length) { el.innerHTML = ''; return; }
    el.innerHTML = pbk.mine.map(function (r) {
      var actions = '';
      if (r.state === 'OTP_PENDING') {
        actions = '<button class="pk-btn" data-act="otp" data-id="' + r.id + '">Enter OTP</button>' +
                  '<button class="pk-btn" data-act="cancel" data-id="' + r.id + '">Cancel</button>';
      } else if (r.state === 'RESERVED') {
        actions = '<button class="pk-btn" data-act="occupy" data-id="' + r.id + '">I have parked</button>' +
                  '<button class="pk-btn" data-act="qr" data-id="' + r.id + '">View QR</button>' +
                  '<button class="pk-btn" data-act="cancel" data-id="' + r.id + '">Cancel</button>';
      } else if (r.state === 'OCCUPIED') {
        actions = '<button class="pk-btn" data-act="exit" data-id="' + r.id + '">Exit parking</button>' +
                  '<button class="pk-btn" data-act="qr" data-id="' + r.id + '">View QR</button>';
      }
      return '<div class="pk-mine-card"><h4>My parking</h4>' +
        '<div class="pk-mine-slot">' + esc(r.slot_label || '') + ' <span class="pk-mine-badge">' + esc(r.state || '') + '</span></div>' +
        '<div>' + esc(r.yard || '') + ' · ' + esc(r.booking_code || '') + '</div>' +
        (r.grace_until && r.state === 'RESERVED' ? '<div class="pk-muted" style="color:#dbe6ff">Arrive by ' + esc(r.grace_until) + '</div>' : '') +
        '<div class="pk-mine-actions">' + actions + '</div></div>';
    }).join('');
    el.querySelectorAll('[data-act]').forEach(function (b) {
      b.addEventListener('click', function () { pbkMineAction(b.dataset.act, parseInt(b.dataset.id, 10)); });
    });
  }

  function pbkMineAction(act, id) {
    var r = pbk.mine.filter(function (x) { return x.id === id; })[0];
    if (act === 'otp') { pbk.otpRes = r; pbkModal(true); pbkOtpStep(r); return; }
    if (act === 'qr') {
      g('pbk-modal-title').textContent = 'Booking pass';
      g('pbk-modal-body').innerHTML = '<div class="pk-qr"><img src="/api/park/reservations/' + id + '/qr.png"></div>' +
        '<div class="pk-kv"><span>Booking</span><b>' + esc(r.booking_code || '') + '</b></div>' +
        '<div class="pk-kv"><span>Slot</span><b>' + esc(r.slot_label || '') + '</b></div>';
      g('pbk-modal-foot').innerHTML = '<button class="pk-btn pk-btn-primary" id="pbk-done2">Close</button>';
      pbkModalMsg(''); pbkModal(true); g('pbk-done2').onclick = function () { pbkModal(false); };
      return;
    }
    var url = '/api/park/reservations/' + id + '/' + (act === 'occupy' ? 'occupy' : act === 'exit' ? 'exit' : 'cancel');
    if (act === 'cancel' && !window.confirm('Cancel this reservation?')) return;
    jsend(url, 'POST').then(function (res) {
      if (!res.ok) { toastFn(res.d.error || 'Action failed.', 'error'); return; }
      toastFn(act === 'occupy' ? 'Parked — enjoy!' : act === 'exit' ? 'Exited. Slot freed.' : 'Cancelled.', 'ok');
      pbkLoadMine(); pbkLoadSlots();
    });
  }

  function pbkLoadWatches() {
    jget('/api/park/watches').then(function (ids) {
      pbk.watches = {}; (ids || []).forEach(function (id) { pbk.watches[id] = true; });
      if (Object.keys(pbk.slots).length) pbkRenderSlots();
    });
  }

  // ── live SSE handler ────────────────────────────────────────────────────────
  function pbkOnEvent(ev) {
    if (!ev || !ev.slotId) return;
    var s = pbk.slots[ev.slotId];
    var wasWatched = pbk.watches[ev.slotId];
    if (s) {
      s.status = ev.newStatus; s.color = ev.color; s.version = ev.version;
      pbkRenderSlots();
      // flash + buzzer when a slot I'm watching frees up
      if (ev.newStatus === 'AVAILABLE' && wasWatched) {
        buzz(); notify('🚗 Slot available', 'Slot ' + (ev.slotLabel || s.label) + ' is now free.');
        var cell = g('pbk-grid').querySelector('[data-slot="' + ev.slotId + '"]');
        if (cell) { var f = document.createElement('span'); f.className = 'pk-flash'; cell.appendChild(f); setTimeout(function () { try { cell.removeChild(f); } catch (e) {} }, 3500); }
        pbk.watches[ev.slotId] = false; pbkLoadWatches();
      }
    } else if (ev.newStatus === 'AVAILABLE' && wasWatched) {
      // watched slot in another (not-open) block: still alert
      buzz(); notify('🚗 Slot available', 'Slot ' + (ev.slotLabel || '') + ' is now free.');
      pbk.watches[ev.slotId] = false; pbkLoadWatches();
    }
    // keep block counts fresh
    if (pbk.loc) pbkLoadBlocks();
  }

  function pbkInit() {
    var wire = function (id, fn, evt) { var e = g(id); if (e && !e._pkw) { e._pkw = 1; e.addEventListener(evt || 'click', fn); } };
    wire('pbk-login-btn', pbkLogin); wire('pbk-reg-btn', pbkRegister); wire('pbk-logout', pbkLogout);
    wire('pbk-modal-close', function () { pbkModal(false); });
    wire('pbk-sound', function () { setSound(g('pbk-sound').checked); if (g('pbk-sound').checked) buzz(); }, 'change');
    var pass = g('pbk-pass'); if (pass && !pass._pkw) { pass._pkw = 1; pass.addEventListener('keydown', function (e) { if (e.key === 'Enter') pbkLogin(); }); }
    var back = g('pbk-modal'); if (back && !back._pkw) { back._pkw = 1; back.addEventListener('click', function (e) { if (e.target === back) pbkModal(false); }); }
    var btn = document.querySelector('.nav-item[data-view="park-book"]');
    if (btn && !btn._pkw) { btn._pkw = 1; btn.addEventListener('click', pbkEnter); }
    if (!pbkInit._poll) pbkInit._poll = setInterval(function () { if (pbkActive() && getTok()) pbkLoadMine(); }, 15000);
    if (pbkActive()) pbkEnter();
  }

  // ═══════════════════════ 2) LIVE DASHBOARD (admin) ═══════════════════════════
  var plv = { loc: null, sse: null, locs: [] };
  function plvActive() { var el = g('park-live'); return el && el.classList.contains('active'); }

  function plvEnter() {
    if (!plvActive()) return;
    jget('/api/admin/park/locations').then(function (rows) {
      plv.locs = rows || [];
      var row = g('plv-loc-row');
      if (!plv.locs.length) { row.innerHTML = '<span class="pk-muted">No locations. Add blocks in Parking Setup.</span>'; g('plv-empty').hidden = false; return; }
      row.innerHTML = plv.locs.map(function (l) {
        return '<button class="pk-chip' + (plv.loc === l.id ? ' on' : '') + '" data-loc="' + l.id + '">' + esc(l.name) + '</button>';
      }).join('');
      row.querySelectorAll('[data-loc]').forEach(function (b) {
        b.addEventListener('click', function () { plvSelect(parseInt(b.dataset.loc, 10)); });
      });
      if (plv.loc == null) plvSelect(plv.locs[0].id); else plvLoad();
    });
  }

  function plvSelect(id) {
    plv.loc = id;
    document.querySelectorAll('#plv-loc-row .pk-chip').forEach(function (b) { b.classList.toggle('on', parseInt(b.dataset.loc, 10) === id); });
    plvLoad();
    if (plv.sse) plv.sse.close();
    plv.sse = makeSSE(id, function () { plvLoad(); }, function (on) {
      var c = g('plv-conn'); if (c) { c.textContent = on ? '● live' : '● offline'; c.classList.toggle('on', on); }
    });
  }

  function plvLoad() {
    if (!plv.loc) return;
    jget('/api/admin/park/locations/' + plv.loc + '/dashboard').then(function (data) {
      g('plv-empty').hidden = true;
      var blocks = (data && data.blocks) || [];
      var tot = 0, avail = 0, occ = 0;
      blocks.forEach(function (b) { tot += b.total_slots; avail += b.available; occ += b.occupied; });
      g('plv-summary').innerHTML =
        stat(tot, 'Total slots') + stat(avail, 'Available') + stat(occ, 'Occupied') +
        stat((data.sse_clients || 0), 'Live viewers');
      g('plv-blocks').innerHTML = blocks.map(function (b) {
        return '<div class="pk-panel"><div class="pk-panel-head"><h3>' + esc(b.name) +
          ' <span class="pk-muted">' + b.available + ' free / ' + b.total_slots + '</span></h3></div>' +
          '<div class="pk-slot-grid">' + (b.slots || []).map(function (s) {
            var cls = 's-' + (s.color || 'grey');
            var occ = (s.occupant_name || s.occupant_plate) ? '<span class="pk-occ">' + esc(s.occupant_name || s.occupant_plate) + '</span>' : '';
            return '<div class="pk-slot ' + cls + '" title="' + esc(s.status) + (s.booking_code ? ' · ' + esc(s.booking_code) : '') + '">' +
              '<span class="pk-slot-lbl">' + esc(s.label) + '</span>' +
              '<span class="pk-slot-st">' + esc(STATUS_TEXT[s.status] || s.status) + '</span>' + occ + '</div>';
          }).join('') + '</div></div>';
      }).join('');
    });
  }
  function stat(v, l) { return '<div class="pk-stat"><div class="pk-stat-v">' + v + '</div><div class="pk-stat-l">' + esc(l) + '</div></div>'; }

  function plvInit() {
    var btn = document.querySelector('.nav-item[data-view="park-live"]');
    if (btn && !btn._pkw) { btn._pkw = 1; btn.addEventListener('click', plvEnter); }
    if (!plvInit._poll) plvInit._poll = setInterval(function () { if (plvActive()) plvLoad(); }, 8000);
    if (plvActive()) plvEnter();
  }

  // ═══════════════════════ 3) PARKING SETUP (admin) ════════════════════════════
  var pst = { loc: null, locs: [] };
  function pstActive() { var el = g('park-setup'); return el && el.classList.contains('active'); }

  function pstEnter() {
    if (!pstActive()) return;
    jget('/api/admin/park/locations').then(function (rows) {
      pst.locs = rows || [];
      var row = g('pst-loc-row');
      if (!pst.locs.length) { row.innerHTML = '<span class="pk-muted">No parking facilities yet. Create one under “Parking Facility”.</span>'; return; }
      row.innerHTML = pst.locs.map(function (l) {
        return '<button class="pk-chip' + (pst.loc === l.id ? ' on' : '') + '" data-loc="' + l.id + '">' +
          esc(l.name) + ' <span class="pk-muted">(' + l.blocks + ' blk / ' + l.total_slots + ' slot)</span></button>';
      }).join('');
      row.querySelectorAll('[data-loc]').forEach(function (b) {
        b.addEventListener('click', function () { pstSelect(parseInt(b.dataset.loc, 10)); });
      });
      if (pst.loc == null && pst.locs.length) pstSelect(pst.locs[0].id);
      else if (pst.loc) pstLoad();
    });
  }

  function pstSelect(id) {
    pst.loc = id; g('pst-body').hidden = false;
    document.querySelectorAll('#pst-loc-row .pk-chip').forEach(function (b) { b.classList.toggle('on', parseInt(b.dataset.loc, 10) === id); });
    pstLoad();
  }

  function pstMsg(t, ok) { var el = g('pst-blk-msg'); el.textContent = t || ''; el.hidden = !t; el.className = 'pk-msg' + (ok ? ' ok' : ''); }

  function pstAddBlock() {
    var name = (g('pst-blk-name').value || '').trim();
    var code = (g('pst-blk-code').value || '').trim();
    var total = parseInt(g('pst-blk-total').value, 10) || 0;
    var type = g('pst-blk-type').value;
    if (!name) { pstMsg('Block name is required.'); return; }
    g('pst-blk-add').disabled = true;
    jsend('/api/admin/park/locations/' + pst.loc + '/blocks', 'POST',
      { name: name, code: code, total_slots: total, slot_type: type }).then(function (res) {
      g('pst-blk-add').disabled = false;
      if (!res.ok || (res.d && res.d.status === 'error')) { pstMsg((res.d && res.d.message) || 'Could not create block.'); return; }
      pstMsg('', true); g('pst-blk-name').value = ''; g('pst-blk-code').value = '';
      toastFn('Block created with ' + total + ' slots.', 'ok'); pstEnter();
    });
  }

  function pstLoad() {
    if (!pst.loc) return;
    jget('/api/admin/park/locations/' + pst.loc + '/blocks').then(function (blocks) {
      var el = g('pst-blocks');
      if (!blocks || !blocks.length) { el.innerHTML = '<div class="pk-empty">No blocks yet. Add one above.</div>'; return; }
      el.innerHTML = blocks.map(function (b) {
        return '<div class="pk-setup-block" data-block="' + b.id + '">' +
          '<div class="pk-setup-block-head"><h3 style="margin:0">' + esc(b.name) +
          ' <span class="pk-muted">(' + b.total_slots + ' slots · ' + b.available + ' free)</span></h3>' +
          '<div class="pk-setup-actions">' +
          '<button class="pk-btn pk-btn-sm" data-badd="' + b.id + '">+ Slot</button>' +
          '<button class="pk-btn pk-btn-sm pk-btn-danger" data-bdel="' + b.id + '">Delete block</button></div></div>' +
          '<div class="pk-slot-grid" id="pst-slots-' + b.id + '"><div class="pk-muted">loading…</div></div></div>';
      }).join('');
      blocks.forEach(function (b) { pstLoadSlots(b.id); });
      el.querySelectorAll('[data-badd]').forEach(function (x) { x.addEventListener('click', function () { pstAddSlot(parseInt(x.dataset.badd, 10)); }); });
      el.querySelectorAll('[data-bdel]').forEach(function (x) { x.addEventListener('click', function () { pstDelBlock(parseInt(x.dataset.bdel, 10)); }); });
    });
  }

  function pstLoadSlots(bid) {
    jget('/api/admin/park/blocks/' + bid + '/slots').then(function (slots) {
      var el = g('pst-slots-' + bid); if (!el) return;
      if (!slots.length) { el.innerHTML = '<div class="pk-muted">No slots.</div>'; return; }
      el.innerHTML = slots.map(function (s) {
        var cls = 's-' + (s.color || 'grey');
        return '<div class="pk-slot ' + cls + '" data-sid="' + s.id + '" title="Click to manage ' + esc(s.label) + '">' +
          '<span class="pk-slot-lbl">' + esc(s.label) + '</span>' +
          '<span class="pk-slot-st">' + esc(STATUS_TEXT[s.status] || s.status) + '</span></div>';
      }).join('');
      el.querySelectorAll('[data-sid]').forEach(function (x) {
        x.addEventListener('click', function () { pstSlotMenu(parseInt(x.dataset.sid, 10), bid); });
      });
    });
  }

  function pstSlotMenu(sid, bid) {
    var choice = window.prompt('Manage slot — type one:\n  disable   (mark disabled)\n  unavail   (out of service)\n  enable    (make available)\n  release   (force-release live slot)\n  remove    (delete slot)\n');
    if (!choice) return;
    choice = choice.trim().toLowerCase();
    var done = function (res) {
      if (!res.ok || (res.d && res.d.status === 'error')) { toastFn((res.d && res.d.message) || 'Action failed.', 'error'); return; }
      toastFn('Done.', 'ok'); pstLoadSlots(bid); pstEnter();
    };
    if (choice === 'remove') { if (window.confirm('Delete this slot?')) jsend('/api/admin/park/slots/' + sid, 'DELETE').then(done); return; }
    if (choice === 'release') { jsend('/api/admin/park/slots/' + sid + '/force-release', 'POST').then(done); return; }
    var map = { disable: 'DISABLED', unavail: 'OUT_OF_SERVICE', enable: 'AVAILABLE' };
    if (map[choice]) { jsend('/api/admin/park/slots/' + sid + '/status', 'POST', { status: map[choice] }).then(done); return; }
    toastFn('Unknown option.', 'error');
  }

  function pstAddSlot(bid) {
    var label = window.prompt('New slot label (blank = auto):', '');
    if (label === null) return;
    jsend('/api/admin/park/blocks/' + bid + '/slots', 'POST', { label: label.trim() }).then(function (res) {
      if (!res.ok || (res.d && res.d.status === 'error')) { toastFn((res.d && res.d.message) || 'Could not add slot.', 'error'); return; }
      toastFn('Slot added.', 'ok'); pstLoadSlots(bid); pstEnter();
    });
  }

  function pstDelBlock(bid) {
    if (!window.confirm('Delete this block and ALL its slots?')) return;
    jsend('/api/admin/park/blocks/' + bid, 'DELETE').then(function () { toastFn('Block deleted.', 'ok'); pstEnter(); });
  }

  function pstInit() {
    var add = g('pst-blk-add'); if (add && !add._pkw) { add._pkw = 1; add.addEventListener('click', pstAddBlock); }
    var btn = document.querySelector('.nav-item[data-view="park-setup"]');
    if (btn && !btn._pkw) { btn._pkw = 1; btn.addEventListener('click', pstEnter); }
    if (pstActive()) pstEnter();
  }

  // ── boot all three + switchView chain ───────────────────────────────────────
  function pkBoot() { pbkInit(); plvInit(); pstInit(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', pkBoot);
  else pkBoot();

  if (typeof switchView === 'function') {
    var _pkOrigSwitch = switchView;
    switchView = function (n) {
      _pkOrigSwitch(n);
      if (n === 'park-book') pbkEnter();
      else if (n === 'park-live') plvEnter();
      else if (n === 'park-setup') pstEnter();
    };
  }
})();
