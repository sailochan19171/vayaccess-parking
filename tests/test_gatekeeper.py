"""Organization-level gatekeeper tests (REQ-002..010, 013, 017)."""
import os
import tempfile
import pytest

os.environ.setdefault('CLOUD_MODE', '1')
os.environ.setdefault('DATABASE_URL', 'sqlite:///' + tempfile.mktemp(suffix='.db'))
os.environ.setdefault('USE_UTC_STORAGE', '1')
os.environ.setdefault('PASS_SECRET', 'test-secret')
os.environ.setdefault('INITIAL_ADMIN_USER', 'admin')
os.environ.setdefault('INITIAL_ADMIN_PASSWORD', 'admin123')

import app as A                     # noqa: E402
import parking_core as park         # noqa: E402
from database import db, Yard, Company, ParkingBlock, DriverUser  # noqa: E402

_n = {'i': 0}


def _admin():
    c = A.app.test_client()
    c.post('/api/login', json={'username': 'admin', 'password': 'admin123'})
    return c


def _org(c, name, approval=True):
    return c.post('/api/admin/organizations',
                  json={'name': name, 'requires_gatekeeper_approval': approval}).get_json()['organization']


def _facility(oid, blocks=(('Basement A', 'A', 5),)):
    _n['i'] += 1
    with A.app.app_context():
        y = Yard(name='Fac%d' % _n['i'], capacity=100, status='active', organization_id=oid, category='Mall')
        db.session.add(y); db.session.commit(); yid = y.id
        ids = {}
        for nm, code, cnt in blocks:
            b = park.create_block_with_slots(yid, nm, code, cnt); ids[nm] = b.id
    return yid, ids


def _company(c, yid, oid, name):
    co = c.post('/api/admin/companies', json={'name': name, 'location_id': yid}).get_json()['company']
    with A.app.app_context():
        Company.query.get(co['id']).organization_id = oid; db.session.commit()
    return co


def _employee(c, comp, oid, email, plate='TS00AA0000'):
    _n['i'] += 1
    email = 'e%d_%s' % (_n['i'], email)
    c.post('/api/admin/drivers', json={'name': email, 'email': email, 'password': 'pass123',
                                       'company_id': comp['id'], 'primary_plate': plate})
    with A.app.app_context():
        DriverUser.query.filter_by(email=email).first().organization_id = oid; db.session.commit()
    tok = c.post('/api/driver/login', json={'email': email, 'password': 'pass123'}).get_json()['token']
    return {'Authorization': 'Bearer ' + tok}


def _gatekeeper(c, oid, email):
    _n['i'] += 1
    email = 'g%d_%s' % (_n['i'], email)
    c.post(f'/api/admin/organizations/{oid}/gatekeepers',
           json={'name': email, 'email': email, 'password': 'pass123'})
    tok = c.post('/api/driver/login', json={'email': email, 'password': 'pass123'}).get_json()['token']
    return {'Authorization': 'Bearer ' + tok}


def _book(c, H, allocate_comp=None, bA=None):
    md = c.get('/api/mobile/master-data', headers=H).get_json()
    sid = md['allocatedSlots'][0]['id']
    hd = c.post(f'/api/park/slots/{sid}/hold', json={'plate': 'TS09AB1234'}, headers=H).get_json()
    c.post(f"/api/park/reservations/{hd['id']}/confirm-otp", json={'code': hd['otp_dev']}, headers=H)
    return hd['id']


def test_booking_pending_when_org_requires_approval():
    c = _admin(); o = _org(c, 'OrgP', approval=True)
    yid, blk = _facility(o['id']); comp = _company(c, yid, o['id'], 'C')
    c.post(f"/api/admin/companies/{comp['id']}/allocate", json={'block_id': blk['Basement A'], 'count': 5})
    H = _employee(c, comp, o['id'], 'e@x.com')
    rid = _book(c, H)
    with A.app.app_context():
        from database import DriverReservation
        assert DriverReservation.query.get(rid).approval_status == 'PENDING'


def test_gatekeeper_approve_occupies():
    c = _admin(); o = _org(c, 'OrgA', approval=True)
    yid, blk = _facility(o['id']); comp = _company(c, yid, o['id'], 'C')
    c.post(f"/api/admin/companies/{comp['id']}/allocate", json={'block_id': blk['Basement A'], 'count': 5})
    H = _employee(c, comp, o['id'], 'e@x.com'); rid = _book(c, H)
    G = _gatekeeper(c, o['id'], 'g@x.com')
    r = c.post('/api/gate/approve', json={'reservation_id': rid}, headers=G).get_json()
    assert r['booking']['approval_status'] == 'APPROVED' and r['booking']['state'] == 'OCCUPIED'


def test_gatekeeper_reject_releases_slot():
    c = _admin(); o = _org(c, 'OrgR', approval=True)
    yid, blk = _facility(o['id']); comp = _company(c, yid, o['id'], 'C')
    c.post(f"/api/admin/companies/{comp['id']}/allocate", json={'block_id': blk['Basement A'], 'count': 5})
    H = _employee(c, comp, o['id'], 'e@x.com'); rid = _book(c, H)
    with A.app.app_context():
        from database import DriverReservation
        sid = DriverReservation.query.get(rid).slot_id
    G = _gatekeeper(c, o['id'], 'g@x.com')
    r = c.post('/api/gate/reject', json={'reservation_id': rid, 'reason': 'no pass'}, headers=G).get_json()
    assert r['booking']['approval_status'] == 'REJECTED'
    with A.app.app_context():
        from database import ParkingSlot, SLOT_AVAILABLE
        assert ParkingSlot.query.get(sid).status == SLOT_AVAILABLE   # slot NOT occupied


def test_cross_org_gatekeeper_blocked():
    c = _admin()
    o1 = _org(c, 'Org1', approval=True); o2 = _org(c, 'Org2', approval=True)
    yid, blk = _facility(o1['id']); comp = _company(c, yid, o1['id'], 'C')
    c.post(f"/api/admin/companies/{comp['id']}/allocate", json={'block_id': blk['Basement A'], 'count': 5})
    H = _employee(c, comp, o1['id'], 'e@x.com'); rid = _book(c, H)
    G2 = _gatekeeper(c, o2['id'], 'g2@x.com')     # gatekeeper of a DIFFERENT org
    r = c.post('/api/gate/approve', json={'reservation_id': rid}, headers=G2)
    assert r.status_code == 403 and r.get_json()['code'] == 'cross_org'


def test_employee_cannot_use_gatekeeper_api():
    c = _admin(); o = _org(c, 'OrgE', approval=True)
    yid, blk = _facility(o['id']); comp = _company(c, yid, o['id'], 'C')
    c.post(f"/api/admin/companies/{comp['id']}/allocate", json={'block_id': blk['Basement A'], 'count': 5})
    H = _employee(c, comp, o['id'], 'e@x.com')
    assert c.get('/api/gate/bookings', headers=H).status_code == 403


def test_org_gatekeeper_sees_all_companies_bookings():
    """Gatekeeper sees bookings from different companies under the same org."""
    c = _admin(); o = _org(c, 'OrgMulti', approval=True)
    yid, blk = _facility(o['id'], (('Basement A', 'A', 10),))
    cA = _company(c, yid, o['id'], 'CompA'); cB = _company(c, yid, o['id'], 'CompB')
    c.post(f"/api/admin/companies/{cA['id']}/allocate", json={'block_id': blk['Basement A'], 'count': 5})
    c.post(f"/api/admin/companies/{cB['id']}/allocate", json={'block_id': blk['Basement A'], 'count': 5})
    HA = _employee(c, cA, o['id'], 'a@x.com'); HB = _employee(c, cB, o['id'], 'b@x.com')
    _book(c, HA); _book(c, HB)
    G = _gatekeeper(c, o['id'], 'g@x.com')
    rows = c.get('/api/gate/bookings', headers=G).get_json()['bookings']
    assert len(rows) >= 2   # both companies' bookings visible to the org gatekeeper


def test_duplicate_approve_idempotent():
    c = _admin(); o = _org(c, 'OrgD', approval=True)
    yid, blk = _facility(o['id']); comp = _company(c, yid, o['id'], 'C')
    c.post(f"/api/admin/companies/{comp['id']}/allocate", json={'block_id': blk['Basement A'], 'count': 5})
    H = _employee(c, comp, o['id'], 'e@x.com'); rid = _book(c, H)
    G = _gatekeeper(c, o['id'], 'g@x.com')
    r1 = c.post('/api/gate/approve', json={'reservation_id': rid}, headers=G)
    r2 = c.post('/api/gate/approve', json={'reservation_id': rid}, headers=G)
    assert r1.status_code == 200 and r2.status_code == 200
    assert r2.get_json()['booking']['approval_status'] == 'APPROVED'  # no double-toggle
