"""Real-time parking slot reservation core.

This module owns the *source of truth* logic for the smart-parking feature:

  * an in-process Server-Sent-Events (SSE) broker (`broker`) — works under
    waitress (synchronous WSGI, single process, N threads) with no eventlet /
    gevent / Redis needed;
  * atomic slot state transitions — every one is a single conditional
    ``UPDATE ... WHERE status=<expected>`` whose ``rowcount`` decides success,
    so two concurrent users can NEVER both book the same slot (works
    identically on SQLite and Postgres);
  * a pluggable OTP subsystem (hashed at rest, expiry, attempts, resend,
    single-use);
  * slot watchers + idempotent notification fan-out;
  * a background sweeper that expires stale holds / unclaimed reservations.

Nothing here is hardcoded per-facility: every knob is read from the Setting
key/value store with a sane default, so admins can tune it live.

Routes live in app.py and are thin wrappers over these functions; the sweeper
thread is started from app.py's _boot().
"""
import time
import queue
import threading
import secrets
from datetime import datetime, timedelta

from werkzeug.security import generate_password_hash, check_password_hash
from sqlalchemy import text

from database import (
    db, Setting, Yard, DriverReservation, DriverNotification,
    ParkingBlock, ParkingSlot, OtpVerification, SlotWatcher,
    SLOT_AVAILABLE, SLOT_HELD, SLOT_RESERVED, SLOT_OCCUPIED,
    SLOT_DISABLED, SLOT_OUT_OF_SERVICE, SLOT_STATUS_COLORS,
)

# ── Configurable knobs (live-tunable via Setting; never hardcoded) ────────────
_CFG_DEFAULTS = {
    'park_hold_seconds':            '120',   # AVAILABLE→HELD window before auto-expire
    'park_grace_minutes':           '15',    # RESERVED "must arrive by" grace
    'park_default_reservation_hours': '4',   # default booking length
    'park_otp_length':              '6',
    'park_otp_ttl_seconds':         '300',
    'park_otp_max_attempts':        '5',
    'park_otp_resend_max':          '3',
    'park_otp_dev_echo':            '1',     # 1 = return OTP on-screen (no SMS provider yet)
}


def cfg(key):
    try:
        return Setting.get(key, _CFG_DEFAULTS.get(key))
    except Exception:
        return _CFG_DEFAULTS.get(key)


def cfg_int(key):
    try:
        return int(cfg(key))
    except (TypeError, ValueError):
        return int(_CFG_DEFAULTS.get(key, '0'))


def _now():
    return datetime.utcnow()


# ── SSE broker ────────────────────────────────────────────────────────────────
class _Broker:
    """Fan-out pub/sub for SSE. Each subscriber gets a bounded Queue; a slow
    consumer drops events rather than blocking publishers. Predicate lets a
    subscriber receive only events for one location."""
    def __init__(self):
        self._lock = threading.Lock()
        self._subs = {}     # sid -> (Queue, predicate|None)
        self._seq = 0

    def subscribe(self, predicate=None):
        q = queue.Queue(maxsize=200)
        with self._lock:
            self._seq += 1
            sid = self._seq
            self._subs[sid] = (q, predicate)
        return sid, q

    def unsubscribe(self, sid):
        with self._lock:
            self._subs.pop(sid, None)

    def publish(self, event):
        event.setdefault('timestamp', _now().isoformat() + 'Z')
        with self._lock:
            items = list(self._subs.items())
        for sid, (q, pred) in items:
            try:
                if pred and not pred(event):
                    continue
                q.put_nowait(event)
            except queue.Full:
                pass  # drop for slow consumers; client re-syncs via REST

    def count(self):
        with self._lock:
            return len(self._subs)


broker = _Broker()


# ── Pluggable delivery sinks (OTP + push) ─────────────────────────────────────
# No SMS/email/FCM provider ships today; these registries let app.py or a future
# integration plug real delivery in without touching this module.
_otp_sinks = []
_push_sinks = []


def register_otp_sink(fn):
    """fn(destination, code, purpose) -> None. e.g. an SMS/email sender."""
    _otp_sinks.append(fn)


def register_push_sink(fn):
    """fn(driver_id, title, body, data:dict) -> None. e.g. an FCM sender."""
    _push_sinks.append(fn)


def _push_to_driver(driver_id, title, body, data=None):
    for fn in _push_sinks:
        try:
            fn(driver_id, title, body, data or {})
        except Exception:
            pass


# ── Event emission ────────────────────────────────────────────────────────────
def emit_slot_event(kind, slot, prev_status, new_status, extra=None):
    """Publish a slot.* realtime event. Deliberately carries NO occupant PII —
    the public slot stream only says which slot changed to what colour."""
    payload = {
        'event':          kind,
        'locationId':     slot.yard_id,
        'blockId':        slot.block_id,
        'slotId':         slot.id,
        'slotLabel':      slot.label,
        'previousStatus': prev_status,
        'newStatus':      new_status,
        'color':          SLOT_STATUS_COLORS.get(new_status, 'grey'),
        'version':        slot.version,
    }
    if extra:
        payload.update(extra)
    broker.publish(payload)


# ── OTP subsystem ─────────────────────────────────────────────────────────────
def _gen_code(n):
    return ''.join(secrets.choice('0123456789') for _ in range(n))


def _mask(dest):
    if not dest:
        return ''
    s = str(dest)
    if '@' in s:  # email
        name, _, dom = s.partition('@')
        return (name[:2] + '***@' + dom) if len(name) > 2 else ('***@' + dom)
    return '******' + s[-4:] if len(s) >= 4 else '****'


def create_otp(purpose, driver_id=None, reservation_id=None, destination=None):
    """Create a fresh OTP challenge (hashed at rest). Returns (row, dev_code)
    where dev_code is the plaintext ONLY when park_otp_dev_echo=1 (no SMS
    provider yet) so the UI can show it on-screen; otherwise None."""
    length = cfg_int('park_otp_length')
    ttl = cfg_int('park_otp_ttl_seconds')
    code = _gen_code(length)
    row = OtpVerification(
        purpose=purpose, driver_id=driver_id, reservation_id=reservation_id,
        destination=_mask(destination), code_hash=generate_password_hash(code),
        max_attempts=cfg_int('park_otp_max_attempts'),
        expires_at=_now() + timedelta(seconds=ttl),
    )
    db.session.add(row)
    db.session.commit()
    _deliver_otp(driver_id, destination, code, purpose)
    dev_code = code if cfg('park_otp_dev_echo') == '1' else None
    return row, dev_code


def _deliver_otp(driver_id, destination, code, purpose):
    """Deliver the OTP. In-app: a notification that an OTP was SENT (never the
    code itself — no plaintext OTP is ever persisted). On-screen: the code is
    returned to the caller as dev_code. External: any registered sink (SMS)."""
    if driver_id:
        try:
            db.session.add(DriverNotification(
                driver_id=driver_id,
                title='Parking OTP sent',
                body='An OTP was sent for %s to %s.' % (
                    purpose.replace('_', ' '), _mask(destination) or 'your device'),
                kind='system'))
            db.session.commit()
        except Exception:
            db.session.rollback()
    for fn in _otp_sinks:
        try:
            fn(destination, code, purpose)
        except Exception:
            pass


def verify_otp(reservation_id, code, purpose='reservation_confirm'):
    """Validate an OTP server-side. Enforces expiry, max attempts and single
    use. Returns (ok:bool, error:str|None)."""
    row = (OtpVerification.query
           .filter_by(reservation_id=reservation_id, purpose=purpose, consumed_at=None)
           .order_by(OtpVerification.id.desc()).first())
    if not row:
        return False, 'no_otp'
    if row.is_expired():
        return False, 'expired'
    if (row.attempts or 0) >= (row.max_attempts or 5):
        return False, 'too_many_attempts'
    row.attempts = (row.attempts or 0) + 1
    if not check_password_hash(row.code_hash, str(code or '')):
        db.session.commit()
        remaining = max(0, (row.max_attempts or 5) - row.attempts)
        return False, 'invalid:%d' % remaining
    row.consumed_at = _now()
    db.session.commit()
    return True, None


def resend_otp(reservation_id, driver, purpose='reservation_confirm'):
    """Invalidate prior challenges and issue a new one, honouring resend cap."""
    prior = (OtpVerification.query
             .filter_by(reservation_id=reservation_id, purpose=purpose)
             .order_by(OtpVerification.id.desc()).first())
    resends = (prior.resend_count + 1) if prior else 0
    if resends > cfg_int('park_otp_resend_max'):
        return None, None, 'resend_limit'
    # consume any live prior challenge so only the newest is valid
    if prior and prior.consumed_at is None:
        prior.consumed_at = _now()
        db.session.commit()
    dest = (driver.phone or driver.email) if driver else None
    row, dev_code = create_otp(purpose, driver_id=(driver.id if driver else None),
                               reservation_id=reservation_id, destination=dest)
    row.resend_count = resends
    db.session.commit()
    return row, dev_code, None


# ── Helpers ───────────────────────────────────────────────────────────────────
def _yard_name(yard_id):
    y = db.session.get(Yard, yard_id) if yard_id else None
    return y.name if y else ''


def _booking_code(rid):
    return 'PK-%d-%06d' % (_now().year, rid)


def _sync_legacy_status(reservation):
    """Map the new fine-grained `state` onto the original coarse `status` so the
    already-shipped mobile screens keep rendering correctly."""
    m = {
        'HELD': 'confirmed', 'OTP_PENDING': 'confirmed', 'RESERVED': 'confirmed',
        'OCCUPIED': 'confirmed', 'EXIT_PENDING': 'confirmed',
        'COMPLETED': 'consumed', 'CANCELLED': 'cancelled', 'EXPIRED': 'expired',
    }
    reservation.status = m.get(reservation.state, reservation.status)


# ── State transitions (each atomic) ───────────────────────────────────────────
def hold_slot(slot_id, driver, plate, vehicle_type, hours=None):
    """AVAILABLE → HELD for this driver, atomically. Creates a reservation in
    OTP_PENDING and issues an OTP. Returns (reservation, dev_code, error)."""
    now = _now()
    hold_until = now + timedelta(seconds=cfg_int('park_hold_seconds'))
    r1 = db.session.execute(text(
        "UPDATE parking_slots SET status=:held, held_by=:drv, held_until=:hu, "
        "version=version+1, updated_at=:now WHERE id=:sid AND status=:avail"),
        dict(held=SLOT_HELD, drv=driver.id, hu=hold_until, now=now,
             sid=slot_id, avail=SLOT_AVAILABLE))
    if r1.rowcount != 1:
        db.session.rollback()
        return None, None, 'slot_unavailable'
    slot = db.session.get(ParkingSlot, slot_id)  # label/block/yard unchanged by UPDATE
    hours = hours or cfg_int('park_default_reservation_hours')
    r = DriverReservation(
        driver_id=driver.id, yard_name=_yard_name(slot.yard_id),
        vehicle_plate=plate, vehicle_type=vehicle_type or 'Car',
        slot_label=slot.label, slot_id=slot.id, block_id=slot.block_id,
        location_id=slot.yard_id, start_at=now, end_at=now + timedelta(hours=hours),
        state='OTP_PENDING', held_until=hold_until)
    _sync_legacy_status(r)
    db.session.add(r)
    db.session.flush()
    r.booking_code = _booking_code(r.id)
    db.session.execute(text("UPDATE parking_slots SET reservation_id=:rid WHERE id=:sid"),
                       dict(rid=r.id, sid=slot_id))
    db.session.commit()
    slot = db.session.get(ParkingSlot, slot_id)
    _row, dev_code = create_otp('reservation_confirm', driver.id, r.id,
                                driver.phone or driver.email)
    emit_slot_event('slot.held', slot, SLOT_AVAILABLE, SLOT_HELD, {'reservationId': r.id})
    return r, dev_code, None


def confirm_reservation(reservation, driver):
    """HELD → RESERVED after OTP success, atomically. Returns (reservation, error)."""
    now = _now()
    r1 = db.session.execute(text(
        "UPDATE parking_slots SET status=:res, held_until=NULL, version=version+1, "
        "updated_at=:now WHERE id=:sid AND status=:held AND held_by=:drv"),
        dict(res=SLOT_RESERVED, now=now, sid=reservation.slot_id,
             held=SLOT_HELD, drv=driver.id))
    if r1.rowcount != 1:
        db.session.rollback()
        return None, 'slot_state_changed'
    reservation.state = 'RESERVED'
    reservation.otp_verified_at = now
    reservation.grace_until = now + timedelta(minutes=cfg_int('park_grace_minutes'))
    _sync_legacy_status(reservation)
    db.session.commit()
    slot = db.session.get(ParkingSlot, reservation.slot_id)
    emit_slot_event('slot.reserved', slot, SLOT_HELD, SLOT_RESERVED,
                    {'reservationId': reservation.id})
    return reservation, None


def occupy_slot(reservation, driver):
    """RESERVED → OCCUPIED when the driver arrives/parks, atomically."""
    now = _now()
    r1 = db.session.execute(text(
        "UPDATE parking_slots SET status=:occ, occupant_driver_id=:drv, "
        "occupant_plate=:plate, version=version+1, updated_at=:now "
        "WHERE id=:sid AND status=:res"),
        dict(occ=SLOT_OCCUPIED, drv=driver.id, plate=reservation.vehicle_plate,
             now=now, sid=reservation.slot_id, res=SLOT_RESERVED))
    if r1.rowcount != 1:
        db.session.rollback()
        return None, 'slot_state_changed'
    reservation.state = 'OCCUPIED'
    reservation.occupied_at = now
    _sync_legacy_status(reservation)
    db.session.commit()
    slot = db.session.get(ParkingSlot, reservation.slot_id)
    emit_slot_event('slot.occupied', slot, SLOT_RESERVED, SLOT_OCCUPIED,
                    {'reservationId': reservation.id})
    return reservation, None


def release_slot(reservation, terminal_state='COMPLETED', legacy='consumed', event='slot.released'):
    """Any active state → AVAILABLE. Used by exit, cancel and force-release.
    Frees the slot, closes the reservation, then notifies watchers."""
    now = _now()
    slot_before = db.session.get(ParkingSlot, reservation.slot_id)
    prev = slot_before.status if slot_before else SLOT_AVAILABLE
    db.session.execute(text(
        "UPDATE parking_slots SET status=:avail, held_by=NULL, held_until=NULL, "
        "reservation_id=NULL, occupant_driver_id=NULL, occupant_plate=NULL, "
        "version=version+1, updated_at=:now WHERE id=:sid"),
        dict(avail=SLOT_AVAILABLE, now=now, sid=reservation.slot_id))
    reservation.state = terminal_state
    reservation.status = legacy
    reservation.exited_at = reservation.exited_at or now
    if terminal_state == 'COMPLETED':
        reservation.completed_at = now
    elif terminal_state == 'CANCELLED':
        reservation.cancelled_at = now
    db.session.commit()
    slot = db.session.get(ParkingSlot, reservation.slot_id)
    if slot:
        emit_slot_event(event, slot, prev, SLOT_AVAILABLE,
                        {'reservationId': reservation.id})
        notify_watchers(slot)
    return reservation, None


# ── Watchers + fan-out ────────────────────────────────────────────────────────
def notify_watchers(slot):
    """Notify every active watcher of a now-available slot. Idempotent via a
    time-bucketed event_key so re-processing can't duplicate. Business rule:
    ALL watchers are notified; the first to successfully re-book wins (the
    atomic hold_slot guarantees only one succeeds)."""
    watchers = SlotWatcher.query.filter_by(slot_id=slot.id, active=True).all()
    if not watchers:
        return
    bucket = int(time.time() // 30)
    for w in watchers:
        ekey = 'slot_available:%d:%d:%d' % (slot.id, w.driver_id, bucket)
        if DriverNotification.query.filter_by(event_key=ekey).first():
            continue
        db.session.add(DriverNotification(
            driver_id=w.driver_id,
            title='🚗 Parking slot available',
            body='Slot %s is now available. Open the app to reserve it.' % slot.label,
            kind='slot_available', event_key=ekey))
        w.notified_at = _now()
        w.active = False  # one-shot; user re-arms by watching again
        _push_to_driver(w.driver_id, 'Parking slot available',
                        'Slot %s is now free' % slot.label,
                        {'slotId': slot.id, 'blockId': slot.block_id,
                         'locationId': slot.yard_id})
    db.session.commit()


# ── Admin transitions ─────────────────────────────────────────────────────────
def set_slot_admin_status(slot, new_status):
    """Admin disable/enable/mark-unavailable. Only valid from/to non-active
    states (never yanks a slot out from under a live reservation)."""
    prev = slot.status
    if prev in (SLOT_HELD, SLOT_RESERVED, SLOT_OCCUPIED):
        return None, 'slot_in_use'
    slot.status = new_status
    slot.version = (slot.version or 0) + 1
    slot.updated_at = _now()
    db.session.commit()
    slot = db.session.get(ParkingSlot, slot.id)
    ev = 'slot.enabled' if new_status == SLOT_AVAILABLE else 'slot.disabled'
    emit_slot_event(ev, slot, prev, new_status)
    if new_status == SLOT_AVAILABLE:
        notify_watchers(slot)
    return slot, None


def force_release(slot):
    """Admin override: free a slot regardless of state and close its reservation."""
    r = None
    if slot.reservation_id:
        r = db.session.get(DriverReservation, slot.reservation_id)
    if not r and slot.id:
        r = (DriverReservation.query.filter_by(slot_id=slot.id)
             .filter(DriverReservation.state.in_(DriverReservation.ACTIVE_STATES))
             .order_by(DriverReservation.id.desc()).first())
    if r:
        return release_slot(r, terminal_state='CANCELLED', legacy='cancelled',
                            event='slot.released')
    # no reservation — just flip to AVAILABLE
    prev = slot.status
    slot.status = SLOT_AVAILABLE
    slot.held_by = None
    slot.held_until = None
    slot.occupant_driver_id = None
    slot.occupant_plate = None
    slot.version = (slot.version or 0) + 1
    slot.updated_at = _now()
    db.session.commit()
    slot = db.session.get(ParkingSlot, slot.id)
    emit_slot_event('slot.released', slot, prev, SLOT_AVAILABLE)
    notify_watchers(slot)
    return slot, None


# ── Block/slot provisioning ───────────────────────────────────────────────────
def _auto_code(name):
    """Derive a slot-label prefix from a block name: 'Block A' -> 'A'."""
    parts = (name or '').split()
    if parts and len(parts[-1]) <= 3:
        return parts[-1].upper()
    return (name or 'X').strip()[:1].upper()


def create_block_with_slots(yard_id, name, code=None, total_slots=0,
                            labels=None, slot_type='standard', start_index=1):
    """Create a block and auto-generate its slots. If `labels` is given, uses
    those names verbatim; else generates '<code><n>' for n in 1..total_slots."""
    code = (code or _auto_code(name)).strip()
    blk = ParkingBlock(yard_id=yard_id, name=name, code=code)
    db.session.add(blk)
    db.session.flush()
    if labels:
        names = [str(x).strip() for x in labels if str(x).strip()]
    else:
        names = ['%s%d' % (code, i) for i in range(start_index, start_index + int(total_slots))]
    for i, lbl in enumerate(names, start=1):
        db.session.add(ParkingSlot(block_id=blk.id, yard_id=yard_id, label=lbl,
                                   display_order=i, slot_type=slot_type,
                                   status=SLOT_AVAILABLE))
    db.session.commit()
    return blk


def add_slot(block, label=None, slot_type='standard'):
    """Add a single slot to a block. Auto-labels if none given."""
    if not label:
        n = ParkingSlot.query.filter_by(block_id=block.id).count() + 1
        label = '%s%d' % ((block.code or _auto_code(block.name)), n)
    if ParkingSlot.query.filter_by(block_id=block.id, label=label).first():
        return None, 'duplicate_label'
    order = ParkingSlot.query.filter_by(block_id=block.id).count() + 1
    slot = ParkingSlot(block_id=block.id, yard_id=block.yard_id, label=label,
                       display_order=order, slot_type=slot_type, status=SLOT_AVAILABLE)
    db.session.add(slot)
    db.session.commit()
    return slot, None


# ── Background sweeper ────────────────────────────────────────────────────────
def sweep_expired(app):
    """Expire stale HELD/OTP_PENDING holds and grace-expired RESERVED bookings,
    freeing their slots and notifying watchers. Runs inside an app context."""
    with app.app_context():
        now = _now()
        n = 0
        # 1) expired holds (never confirmed within park_hold_seconds)
        stale_holds = (ParkingSlot.query
                       .filter(ParkingSlot.status == SLOT_HELD,
                               ParkingSlot.held_until.isnot(None),
                               ParkingSlot.held_until < now).all())
        for slot in stale_holds:
            r = (DriverReservation.query.filter_by(slot_id=slot.id)
                 .filter(DriverReservation.state.in_(('HELD', 'OTP_PENDING')))
                 .order_by(DriverReservation.id.desc()).first())
            if r:
                r.state = 'EXPIRED'
                r.status = 'expired'
            prev = slot.status
            db.session.execute(text(
                "UPDATE parking_slots SET status=:a, held_by=NULL, held_until=NULL, "
                "reservation_id=NULL, version=version+1, updated_at=:now "
                "WHERE id=:sid AND status=:held"),
                dict(a=SLOT_AVAILABLE, now=now, sid=slot.id, held=SLOT_HELD))
            db.session.commit()
            fresh = db.session.get(ParkingSlot, slot.id)
            emit_slot_event('slot.expired', fresh, prev, SLOT_AVAILABLE)
            notify_watchers(fresh)
            n += 1
        # 2) grace-expired reservations (confirmed but driver never arrived)
        stale_res = (DriverReservation.query
                     .filter(DriverReservation.state == 'RESERVED',
                             DriverReservation.grace_until.isnot(None),
                             DriverReservation.grace_until < now).all())
        for r in stale_res:
            slot = db.session.get(ParkingSlot, r.slot_id) if r.slot_id else None
            if slot and slot.status == SLOT_RESERVED:
                prev = slot.status
                db.session.execute(text(
                    "UPDATE parking_slots SET status=:a, reservation_id=NULL, "
                    "version=version+1, updated_at=:now WHERE id=:sid AND status=:res"),
                    dict(a=SLOT_AVAILABLE, now=now, sid=slot.id, res=SLOT_RESERVED))
                r.state = 'EXPIRED'
                r.status = 'expired'
                db.session.commit()
                fresh = db.session.get(ParkingSlot, slot.id)
                emit_slot_event('slot.expired', fresh, prev, SLOT_AVAILABLE)
                notify_watchers(fresh)
                n += 1
            else:
                r.state = 'EXPIRED'
                r.status = 'expired'
                db.session.commit()
        return n


def start_sweeper(app, interval_seconds=10):
    """Launch the sweeper as a daemon thread (called from app._boot())."""
    def _loop():
        while True:
            try:
                sweep_expired(app)
            except Exception as e:  # never let the loop die
                try:
                    print('[park] sweeper error:', e)
                except Exception:
                    pass
            time.sleep(interval_seconds)
    t = threading.Thread(target=_loop, name='park-sweeper', daemon=True)
    t.start()
    return t
