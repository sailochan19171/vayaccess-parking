"""Company / tenancy layer over the existing parking engine.

Location = Yard, Basement = ParkingBlock, Slot = ParkingSlot (reused).
This module adds:
  * slot allocation to a company (assign/unassign physical slots, capped safely),
  * company-scoped visibility (an employee sees only their company's slots),
  * the consolidated per-user master-data payload the mobile app consumes.

Allocation model: a company "owns" a POOL of specific slots (slot.company_id).
Any employee of the company may book any free slot in that pool; the pool size
IS the capacity, so the existing atomic slot booking already enforces the
"never exceed allocation" rule with no extra locking.
"""
from datetime import datetime

from database import (
    db, Yard, Company, CompanyAllocation, DriverUser, ParkingBlock, ParkingSlot,
    DriverReservation, AuditEvent, Setting, Vehicle,
    SLOT_AVAILABLE,
)
import parking_core as park


def _now():
    return datetime.utcnow()


# ── Allocation ────────────────────────────────────────────────────────────────
def allocate(company, block, target_count):
    """Assign/unassign physical slots so the company holds `target_count` slots
    in this basement. Grows by claiming FREE unallocated slots; shrinks by
    releasing only FREE company slots (never touches booked ones -> history +
    active bookings are preserved). Upserts the CompanyAllocation config row.
    Returns (allocation, assigned_now, warning|None)."""
    target = max(0, int(target_count or 0))
    assigned = ParkingSlot.query.filter_by(company_id=company.id, block_id=block.id).all()
    warning = None

    if target > len(assigned):
        need = target - len(assigned)
        free = (ParkingSlot.query
                .filter_by(block_id=block.id, company_id=None, status=SLOT_AVAILABLE)
                .order_by(ParkingSlot.display_order, ParkingSlot.label)
                .limit(need).all())
        for s in free:
            s.company_id = company.id
        if len(free) < need:
            warning = ("Only %d free slot(s) available in %s; assigned those. "
                       "Add more slots to the basement to reach %d."
                       % (len(assigned) + len(free), block.name, target))
    elif target < len(assigned):
        remove = len(assigned) - target
        # release only FREE company slots (keep RESERVED/OCCUPIED/HELD ones)
        releasable = [s for s in assigned if s.status == SLOT_AVAILABLE]
        for s in releasable[:remove]:
            s.company_id = None
        if len(releasable) < remove:
            warning = ("Reduced to %d, but %d slot(s) are currently in use and "
                       "were kept until freed." % (target, remove - len(releasable)))

    row = CompanyAllocation.query.filter_by(company_id=company.id, block_id=block.id).first()
    old = row.allocated_count if row else 0
    if not row:
        row = CompanyAllocation(company_id=company.id, block_id=block.id,
                                yard_id=block.yard_id, allocated_count=target)
        db.session.add(row)
    else:
        row.allocated_count = target
        row.updated_at = _now()
    db.session.commit()
    AuditEvent.log("Allocation: %s / %s %d -> %d slots" % (company.name, block.name, old, target), 'Admin')
    return row, row.assigned_now(), warning


# ── Company-scoped visibility ─────────────────────────────────────────────────
def slots_query_for_driver(driver):
    """Base query of slots this driver may see:
       - employee (company_id set) -> only that company's slots
       - legacy self-service driver -> only unallocated (company_id IS NULL) slots
    """
    if getattr(driver, 'company_id', None):
        return ParkingSlot.query.filter_by(company_id=driver.company_id)
    return ParkingSlot.query.filter_by(company_id=None)


def can_book(driver, slot):
    """A slot is bookable by this driver only if it belongs to their scope."""
    if getattr(driver, 'company_id', None):
        return slot.company_id == driver.company_id
    return slot.company_id is None


# ── Consolidated master data (per authenticated user) ─────────────────────────
def master_data(driver):
    """Everything the mobile app needs for THIS user — nothing about other
    companies/locations. See spec 29."""
    company = db.session.get(Company, driver.company_id) if getattr(driver, 'company_id', None) else None
    loc_id = driver.location_id or (company.yard_id if company else None)
    location = db.session.get(Yard, loc_id) if loc_id else None

    my_slots = slots_query_for_driver(driver).all()
    block_ids = sorted({s.block_id for s in my_slots})
    blocks = (ParkingBlock.query.filter(ParkingBlock.id.in_(block_ids)).all()
              if block_ids else [])
    block_by_id = {b.id: b for b in blocks}

    # basements with per-company counts
    basements = []
    for b in sorted(blocks, key=lambda x: (x.display_order or 0, x.name)):
        bslots = [s for s in my_slots if s.block_id == b.id]
        avail = sum(1 for s in bslots if s.status == SLOT_AVAILABLE)
        basements.append({**b.to_dict(with_counts=False),
                          "allocated": len(bslots), "available": avail})

    slots = [s.to_dict(public=True) for s in
             sorted(my_slots, key=lambda s: (s.block_id, s.display_order or 0, s.label))]

    vrows = Vehicle.query.filter_by(driver_id=driver.id).order_by(Vehicle.is_primary.desc(), Vehicle.id).all()
    if vrows:
        vehicles = [v.to_dict() for v in vrows]
    elif driver.primary_plate:
        vehicles = [{"id": None, "plate": driver.primary_plate, "type": driver.primary_type or "Car",
                     "make": "", "model": "", "color": "", "is_primary": True}]
    else:
        vehicles = []

    return {
        "user": driver.to_dict(),
        "location": location.to_dict() if location else None,
        "company": company.to_dict() if company else None,
        "basements": basements,
        "allocatedSlots": slots,
        "vehicles": vehicles,
        "configuration": {
            "hold_seconds": park.cfg_int('park_hold_seconds'),
            "grace_minutes": park.cfg_int('park_grace_minutes'),
            "default_hours": park.cfg_int('park_default_reservation_hours'),
            "otp_required": True,
        },
        "server_time": _now().isoformat() + 'Z',
        "updated_at": _now().isoformat() + 'Z',
    }
