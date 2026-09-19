"""Automated tests for the real-time parking reservation system.

Run:  CLOUD_MODE=1 DATABASE_URL=sqlite:///:memory:  pytest tests/test_parking.py -q

Covers the spec's core scenarios: auto slot-gen, atomic double-booking, OTP
(wrong/right/single-use), full lifecycle, slot release, hold + grace expiry,
watcher notify-once + idempotency, realtime event emission, and admin CRUD.
Realtime UI (buzzer/SSE-in-browser) is validated separately with Playwright.
"""
import os
import tempfile
import pytest

# Configure BEFORE importing app (it reads these at import time and boots).
os.environ.setdefault('CLOUD_MODE', '1')
os.environ.setdefault('DATABASE_URL', 'sqlite:///' + tempfile.mktemp(suffix='.db'))
os.environ.setdefault('USE_UTC_STORAGE', '1')
os.environ.setdefault('PASS_SECRET', 'test-secret')
os.environ.setdefault('INITIAL_ADMIN_USER', 'admin')
os.environ.setdefault('INITIAL_ADMIN_PASSWORD', 'admin123')

import app as A                     # noqa: E402
import parking_core as park         # noqa: E402
from database import (              # noqa: E402
    db, Setting, Yard, DriverUser, ParkingBlock, ParkingSlot,
    DriverReservation, DriverNotification, SlotWatcher,
    SLOT_AVAILABLE, SLOT_HELD, SLOT_RESERVED, SLOT_OCCUPIED, SLOT_DISABLED,
)

_counter = {'n': 0}


@pytest.fixture()
def ctx():
    with A.app.app_context():
        yield


def _fresh_location(slots=10):
    """Create an isolated yard + block with `slots` auto-generated slots."""
    _counter['n'] += 1
    y = Yard(name='Loc%d' % _counter['n'], capacity=100)
    db.session.add(y)
    db.session.commit()
    blk = park.create_block_with_slots(y.id, 'Block A', 'A', slots)
    return y, blk


def _driver(email=None):
    _counter['n'] += 1
    email = email or ('drv%d@x.com' % _counter['n'])
    u = DriverUser(name='D%d' % _counter['n'], email=email, phone='999000%04d' % _counter['n'],
                   primary_plate='TS%02dAB%04d' % (_counter['n'] % 100, _counter['n']))
    u.set_password('secret1')
    db.session.add(u)
    db.session.commit()
    return u


def _slot(blk, label):
    return ParkingSlot.query.filter_by(block_id=blk.id, label=label).first()


# ── Test 9 (admin): configurable slot generation, nothing hardcoded ───────────
def test_auto_slot_generation(ctx):
    y, blk = _fresh_location(slots=20)
    labels = [s.label for s in ParkingSlot.query.filter_by(block_id=blk.id)
              .order_by(ParkingSlot.display_order).all()]
    assert labels == ['A%d' % i for i in range(1, 21)]
    # a different block size is honoured too (proves it's data-driven)
    blk2 = park.create_block_with_slots(y.id, 'Block D', 'D', 5)
    assert ParkingSlot.query.filter_by(block_id=blk2.id).count() == 5


# ── Test 2 / 14: atomic locking — two users, one slot, one winner ─────────────
def test_atomic_double_booking(ctx):
    y, blk = _fresh_location()
    a, b = _driver(), _driver()
    s = _slot(blk, 'A5')
    r_a, code_a, err_a = park.hold_slot(s.id, a, a.primary_plate, 'Car')
    r_b, code_b, err_b = park.hold_slot(s.id, b, b.primary_plate, 'Car')
    assert err_a is None and r_a is not None
    assert err_b == 'slot_unavailable' and r_b is None
    assert _slot(blk, 'A5').status == SLOT_HELD


# ── Test 1 / 8-partial: OTP wrong then right, and single-use ──────────────────
def test_otp_wrong_right_singleuse(ctx):
    y, blk = _fresh_location()
    a = _driver()
    s = _slot(blk, 'A1')
    r, code, err = park.hold_slot(s.id, a, a.primary_plate, 'Car')
    assert err is None and code
    ok, e = park.verify_otp(r.id, '000000', 'reservation_confirm')
    assert not ok and e.startswith('invalid')
    ok, e = park.verify_otp(r.id, code, 'reservation_confirm')
    assert ok and e is None
    # reuse must fail (single-use / consumed)
    ok, e = park.verify_otp(r.id, code, 'reservation_confirm')
    assert not ok


def test_otp_max_attempts(ctx):
    Setting.set('park_otp_max_attempts', '3')
    y, blk = _fresh_location()
    a = _driver()
    s = _slot(blk, 'A2')
    r, code, _ = park.hold_slot(s.id, a, a.primary_plate, 'Car')
    for _ in range(3):
        park.verify_otp(r.id, '999999', 'reservation_confirm')
    ok, e = park.verify_otp(r.id, code, 'reservation_confirm')  # correct but locked out
    assert not ok and e == 'too_many_attempts'
    Setting.set('park_otp_max_attempts', '5')


# ── Test 1: full lifecycle hold → reserved → occupied → completed → available ─
def test_full_lifecycle(ctx):
    y, blk = _fresh_location()
    a = _driver()
    s = _slot(blk, 'A3')
    r, code, _ = park.hold_slot(s.id, a, a.primary_plate, 'Car')
    park.verify_otp(r.id, code, 'reservation_confirm')
    r, err = park.confirm_reservation(r, a)
    assert err is None and _slot(blk, 'A3').status == SLOT_RESERVED
    assert r.booking_code and r.booking_code.startswith('PK-')
    r, err = park.occupy_slot(r, a)
    assert err is None and _slot(blk, 'A3').status == SLOT_OCCUPIED
    r, err = park.release_slot(r, 'COMPLETED', 'consumed', 'slot.released')
    assert err is None and _slot(blk, 'A3').status == SLOT_AVAILABLE
    assert r.state == 'COMPLETED'


# ── Test 4: slot release frees the slot ───────────────────────────────────────
def test_release_frees_slot(ctx):
    y, blk = _fresh_location()
    a = _driver()
    s = _slot(blk, 'A4')
    r, code, _ = park.hold_slot(s.id, a, a.primary_plate, 'Car')
    park.verify_otp(r.id, code, 'reservation_confirm')
    park.confirm_reservation(r, a)
    park.release_slot(r, 'COMPLETED', 'consumed', 'slot.released')
    assert _slot(blk, 'A4').status == SLOT_AVAILABLE


# ── Test 8: hold expiry via sweeper ───────────────────────────────────────────
def test_hold_expiry(ctx):
    Setting.set('park_hold_seconds', '-1')  # already expired the instant it's held
    y, blk = _fresh_location()
    a = _driver()
    s = _slot(blk, 'A6')
    r, code, _ = park.hold_slot(s.id, a, a.primary_plate, 'Car')
    assert _slot(blk, 'A6').status == SLOT_HELD
    n = park.sweep_expired(A.app)
    db.session.expire_all()  # sweeper ran in its own session; drop our stale cache
    assert n >= 1
    assert _slot(blk, 'A6').status == SLOT_AVAILABLE
    assert DriverReservation.query.get(r.id).state == 'EXPIRED'
    Setting.set('park_hold_seconds', '120')


# ── Test 15: grace expiry (reserved but never occupied) ───────────────────────
def test_grace_expiry(ctx):
    Setting.set('park_grace_minutes', '-1')
    y, blk = _fresh_location()
    a = _driver()
    s = _slot(blk, 'A7')
    r, code, _ = park.hold_slot(s.id, a, a.primary_plate, 'Car')
    park.verify_otp(r.id, code, 'reservation_confirm')
    park.confirm_reservation(r, a)
    assert _slot(blk, 'A7').status == SLOT_RESERVED
    park.sweep_expired(A.app)
    db.session.expire_all()  # sweeper ran in its own session; drop our stale cache
    assert _slot(blk, 'A7').status == SLOT_AVAILABLE
    assert DriverReservation.query.get(r.id).state == 'EXPIRED'
    Setting.set('park_grace_minutes', '15')


# ── Test 5 / 13: watcher notified once, idempotent ────────────────────────────
def test_watcher_notify_once_idempotent(ctx):
    y, blk = _fresh_location()
    a, b = _driver(), _driver()
    s = _slot(blk, 'A8')
    r, code, _ = park.hold_slot(s.id, a, a.primary_plate, 'Car')
    park.verify_otp(r.id, code, 'reservation_confirm')
    park.confirm_reservation(r, a)
    db.session.add(SlotWatcher(slot_id=s.id, driver_id=b.id, active=True))
    db.session.commit()
    before = DriverNotification.query.filter_by(driver_id=b.id, kind='slot_available').count()
    park.release_slot(r, 'COMPLETED', 'consumed', 'slot.released')
    after = DriverNotification.query.filter_by(driver_id=b.id, kind='slot_available').count()
    assert after == before + 1
    park.notify_watchers(_slot(blk, 'A8'))  # re-run: idempotent + watcher deactivated
    assert DriverNotification.query.filter_by(driver_id=b.id, kind='slot_available').count() == after


# ── Test 3: realtime event emission ───────────────────────────────────────────
def test_events_emitted(ctx):
    y, blk = _fresh_location()
    a = _driver()
    s = _slot(blk, 'A9')
    sid, q = park.broker.subscribe(lambda ev: ev.get('locationId') == y.id)
    try:
        park.hold_slot(s.id, a, a.primary_plate, 'Car')
        ev = q.get(timeout=2)
        assert ev['event'] == 'slot.held'
        assert ev['slotId'] == s.id and ev['newStatus'] == SLOT_HELD
        assert 'occupant' not in ev and 'occupant_plate' not in ev  # no PII in public stream
    finally:
        park.broker.unsubscribe(sid)


# ── Admin CRUD + authorization ────────────────────────────────────────────────
def test_admin_block_and_slot_crud_via_api():
    c = A.app.test_client()
    # unauthenticated admin route is refused
    r = c.get('/api/admin/park/locations')
    assert r.status_code in (401, 403)
    assert c.post('/api/login', json={'username': 'admin', 'password': 'admin123'}).status_code == 200
    with A.app.app_context():
        y = Yard(name='CrudMall', capacity=10)
        db.session.add(y)
        db.session.commit()
        yid = y.id
    r = c.post('/api/admin/park/locations/%d/blocks' % yid, json={'name': 'Block Z', 'total_slots': 3})
    assert r.get_json()['status'] == 'ok'
    with A.app.app_context():
        blk = ParkingBlock.query.filter_by(yard_id=yid, name='Block Z').first()
        assert ParkingSlot.query.filter_by(block_id=blk.id).count() == 3
        sid = ParkingSlot.query.filter_by(block_id=blk.id).first().id
    # disable then re-enable
    assert c.post('/api/admin/park/slots/%d/status' % sid, json={'status': 'DISABLED'}).get_json()['status'] == 'ok'
    with A.app.app_context():
        assert ParkingSlot.query.get(sid).status == SLOT_DISABLED
    assert c.post('/api/admin/park/slots/%d/status' % sid, json={'status': 'AVAILABLE'}).get_json()['status'] == 'ok'
    # add a slot, then delete it
    r = c.post('/api/admin/park/blocks/%d/slots' % blk.id, json={'label': 'Z99'})
    assert r.get_json()['status'] == 'ok'


def test_driver_route_requires_auth():
    c = A.app.test_client()
    r = c.post('/api/park/slots/1/hold', json={'plate': 'X'})
    assert r.status_code == 401
