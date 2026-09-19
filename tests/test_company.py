"""Company / tenancy layer tests (spec 30/31 + tests 1,2,3,5,14,15,16).

Run:  CLOUD_MODE=1 pytest tests/test_company.py -q
"""
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
import company_core as company      # noqa: E402
from database import (              # noqa: E402
    db, Yard, Company, ParkingBlock, ParkingSlot, DriverUser, SLOT_AVAILABLE,
)

_n = {'i': 0}


def _admin():
    c = A.app.test_client()
    c.post('/api/login', json={'username': 'admin', 'password': 'admin123'})
    return c


def _location(blocks=(('Basement A', 'A', 10),)):
    _n['i'] += 1
    with A.app.app_context():
        y = Yard(name='Loc%d' % _n['i'], capacity=100, status='active')
        db.session.add(y); db.session.commit(); yid = y.id
        ids = {}
        for name, code, cnt in blocks:
            b = park.create_block_with_slots(yid, name, code, cnt)
            ids[name] = b.id
    return yid, ids


def _company(c, yid, name):
    return c.post('/api/admin/companies', json={'name': name, 'location_id': yid}).get_json()['company']


def _employee(c, comp, email, plate='TS00AA0000', emp='EMP1'):
    _n['i'] += 1
    email = 'u%d_%s' % (_n['i'], email)  # unique per call (tests share one DB)
    r = c.post('/api/admin/drivers', json={'name': email, 'email': email, 'password': 'pass123',
                                           'company_id': comp['id'], 'employee_id': emp, 'primary_plate': plate})
    assert r.get_json().get('status') == 'ok', r.get_json()
    tok = c.post('/api/driver/login', json={'email': email, 'password': 'pass123'}).get_json()['token']
    return {'Authorization': 'Bearer ' + tok}


# Test 1: location -> company -> employees -> allocated slots
def test_allocation_assigns_exact_count():
    c = _admin()
    yid, blocks = _location([('Basement A', 'A', 10)])
    comp = _company(c, yid, 'Company A')
    r = c.post(f"/api/admin/companies/{comp['id']}/allocate",
               json={'block_id': blocks['Basement A'], 'count': 10}).get_json()
    assert r['assigned'] == 10 and r['allocation']['allocated'] == 10
    H = _employee(c, comp, 'e1@a.com')
    md = c.get('/api/mobile/master-data', headers=H).get_json()
    assert len(md['allocatedSlots']) == 10
    assert all(s['label'].startswith('A') for s in md['allocatedSlots'])


# Test 3 + 16: Company A user cannot see or book Company B slots / other location
def test_company_isolation():
    c = _admin()
    yid, blocks = _location([('Basement A', 'A', 5), ('Basement B', 'B', 5)])
    cA = _company(c, yid, 'Company A'); cB = _company(c, yid, 'Company B')
    c.post(f"/api/admin/companies/{cA['id']}/allocate", json={'block_id': blocks['Basement A'], 'count': 5})
    c.post(f"/api/admin/companies/{cB['id']}/allocate", json={'block_id': blocks['Basement B'], 'count': 5})
    HA = _employee(c, cA, 'ea@x.com'); HB = _employee(c, cB, 'eb@x.com')
    mdA = c.get('/api/mobile/master-data', headers=HA).get_json()
    a_slot = mdA['allocatedSlots'][0]
    # B cannot book A's slot
    r = c.post(f"/api/park/slots/{a_slot['id']}/hold", json={'plate': 'X'}, headers=HB)
    assert r.status_code == 403 and r.get_json().get('code') == 'not_allocated'
    # B's master data has only Basement B
    mdB = c.get('/api/mobile/master-data', headers=HB).get_json()
    assert all(s['label'].startswith('B') for s in mdB['allocatedSlots'])


# Test 5 + 26: change allocation up/down, keep booked slots + history
def test_reallocation_grow_and_shrink_preserves_bookings():
    c = _admin()
    yid, blocks = _location([('Basement A', 'A', 10)])
    comp = _company(c, yid, 'Company A')
    bA = blocks['Basement A']
    c.post(f"/api/admin/companies/{comp['id']}/allocate", json={'block_id': bA, 'count': 5})
    with A.app.app_context():
        assert ParkingSlot.query.filter_by(company_id=comp['id']).count() == 5
    # grow 5 -> 8
    r = c.post(f"/api/admin/companies/{comp['id']}/allocate", json={'block_id': bA, 'count': 8}).get_json()
    assert r['assigned'] == 8
    # book one company slot
    H = _employee(c, comp, 'e@x.com')
    md = c.get('/api/mobile/master-data', headers=H).get_json()
    sid = md['allocatedSlots'][0]['id']
    hd = c.post(f"/api/park/slots/{sid}/hold", json={'plate': 'TS0'}, headers=H).get_json()
    # shrink 8 -> 1: the booked slot must be kept (history preserved)
    c.post(f"/api/admin/companies/{comp['id']}/allocate", json={'block_id': bA, 'count': 1})
    with A.app.app_context():
        from database import DriverReservation
        r2 = DriverReservation.query.get(hd['id'])
        assert r2 is not None                       # booking preserved
        assert r2.company_name == 'Company A'       # snapshot preserved
        booked = ParkingSlot.query.get(sid)
        assert booked.company_id == comp['id']      # booked slot NOT unassigned


# Test 15: inactive company cannot create bookings
def test_inactive_company_cannot_book():
    c = _admin()
    yid, blocks = _location([('Basement A', 'A', 3)])
    comp = _company(c, yid, 'Company A')
    c.post(f"/api/admin/companies/{comp['id']}/allocate", json={'block_id': blocks['Basement A'], 'count': 3})
    H = _employee(c, comp, 'e@x.com')
    md = c.get('/api/mobile/master-data', headers=H).get_json()
    sid = md['allocatedSlots'][0]['id']
    c.put(f"/api/admin/companies/{comp['id']}", json={'status': 'inactive'})
    r = c.post(f"/api/park/slots/{sid}/hold", json={'plate': 'X'}, headers=H)
    assert r.status_code == 403 and r.get_json().get('code') == 'company_inactive'


# Test 14: inactive/disabled slot cannot be booked
def test_disabled_slot_cannot_book():
    c = _admin()
    yid, blocks = _location([('Basement A', 'A', 3)])
    comp = _company(c, yid, 'Company A')
    c.post(f"/api/admin/companies/{comp['id']}/allocate", json={'block_id': blocks['Basement A'], 'count': 3})
    H = _employee(c, comp, 'e@x.com')
    md = c.get('/api/mobile/master-data', headers=H).get_json()
    sid = md['allocatedSlots'][0]['id']
    c.post(f"/api/admin/park/slots/{sid}/status", json={'status': 'DISABLED'})
    r = c.post(f"/api/park/slots/{sid}/hold", json={'plate': 'X'}, headers=H)
    assert r.status_code == 409  # slot_unavailable (atomic guard: not AVAILABLE)


# Test 2: one location, many companies
def test_many_companies_one_location():
    c = _admin()
    yid, _ = _location([('Basement A', 'A', 50)])
    for i in range(25):
        r = c.post('/api/admin/companies', json={'name': f'C{i}', 'location_id': yid})
        assert r.get_json()['status'] == 'ok'
    rows = c.get(f'/api/admin/companies?location={yid}').get_json()
    assert len(rows) == 25
