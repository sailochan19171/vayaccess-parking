"""Organization-level gatekeeper logic.

A gatekeeper is a DriverUser with role='gatekeeper', assigned to one or more
ORGANIZATIONS via GatekeeperAllocation. Gatekeepers see/approve/reject bookings
that belong to their assigned organizations only. All authorization is derived
from trusted DB records — never from client-supplied ids.
"""
from datetime import datetime
from sqlalchemy import text

from database import (
    db, Organization, GatekeeperAllocation, DriverReservation, DriverUser,
    ParkingSlot, AuditEvent, SLOT_OCCUPIED, SLOT_RESERVED,
)
import parking_core as park


def _now():
    return datetime.utcnow()


def is_gatekeeper(driver):
    return (getattr(driver, 'role', None) or '') == 'gatekeeper'


def active_org_ids(driver):
    """Organization ids this gatekeeper is actively allocated to (trusted)."""
    rows = GatekeeperAllocation.query.filter_by(gatekeeper_id=driver.id, active=True).all()
    return [r.organization_id for r in rows]


def orgs_for(driver):
    ids = active_org_ids(driver)
    if not ids:
        return []
    return [o.to_dict() for o in Organization.query.filter(Organization.id.in_(ids)).all()]


def bookings_for(driver, org_id=None, status=None, limit=200):
    """Bookings across the gatekeeper's authorized organizations."""
    ids = active_org_ids(driver)
    if not ids:
        return []
    q = DriverReservation.query.filter(DriverReservation.organization_id.in_(ids))
    if org_id and org_id in ids:
        q = q.filter(DriverReservation.organization_id == org_id)
    if status:
        q = q.filter(DriverReservation.approval_status == status.upper())
    return q.order_by(DriverReservation.id.desc()).limit(limit).all()


def can_act_on(driver, reservation):
    """(ok, reason) — is this gatekeeper authorized for this booking's org?"""
    if not reservation:
        return False, 'not_found'
    if reservation.organization_id is None:
        return False, 'no_org'
    if reservation.organization_id not in active_org_ids(driver):
        return False, 'cross_org'
    return True, None


def approve(driver, reservation):
    """Approve a booking: mark APPROVED and occupy its slot for the EMPLOYEE,
    atomically (RESERVED -> OCCUPIED). Idempotent-ish: re-approving an already
    APPROVED booking returns it unchanged."""
    st = (reservation.approval_status or '').upper()
    if st == 'APPROVED':
        return reservation, None
    if st == 'REJECTED':
        return None, 'already_rejected'
    now = _now()
    # Occupy the slot for the employee (occupant = booking owner, not gatekeeper).
    r1 = db.session.execute(text(
        "UPDATE parking_slots SET status=:occ, occupant_driver_id=:emp, occupant_plate=:plate, "
        "version=version+1, updated_at=:now WHERE id=:sid AND status=:res"),
        dict(occ=SLOT_OCCUPIED, emp=reservation.driver_id, plate=reservation.vehicle_plate,
             now=now, sid=reservation.slot_id, res=SLOT_RESERVED))
    if r1.rowcount != 1:
        db.session.rollback()
        return None, 'slot_state_changed'
    reservation.approval_status = 'APPROVED'
    reservation.approved_by = driver.id
    reservation.approved_at = now
    reservation.state = 'OCCUPIED'
    reservation.occupied_at = reservation.occupied_at or now
    reservation.status = 'confirmed'
    db.session.commit()
    slot = db.session.get(ParkingSlot, reservation.slot_id)
    if slot:
        park.emit_slot_event('slot.occupied', slot, SLOT_RESERVED, SLOT_OCCUPIED,
                             {'reservationId': reservation.id})
    AuditEvent.log(f"Gatekeeper {driver.id} APPROVED {reservation.booking_code}", 'Gatekeeper')
    return reservation, None


def reject(driver, reservation, reason=None):
    """Reject a booking: mark REJECTED and release its slot (not occupied)."""
    st = (reservation.approval_status or '').upper()
    if st == 'APPROVED':
        return None, 'already_approved'
    if st == 'REJECTED':
        return reservation, None
    # Free the slot if it was held/reserved for this booking.
    park.release_slot(reservation, terminal_state='CANCELLED', legacy='cancelled',
                      event='slot.released')
    reservation.approval_status = 'REJECTED'
    reservation.rejected_at = _now()
    reservation.reject_reason = (reason or '').strip()[:200] or None
    db.session.commit()
    AuditEvent.log(f"Gatekeeper {driver.id} REJECTED {reservation.booking_code}", 'Gatekeeper')
    return reservation, None
