from flask_sqlalchemy import SQLAlchemy
from sqlalchemy import text
from datetime import datetime, timedelta

db = SQLAlchemy()

class Whitelist(db.Model):
    __tablename__ = 'whitelist'
    id = db.Column(db.Integer, primary_key=True)
    rfid_tag = db.Column(db.String(100), unique=True, nullable=True)
    number_plate = db.Column(db.String(50), unique=True, nullable=False)
    owner_name = db.Column(db.String(100), nullable=False)
    # ── Employee-activation fields (added 2026-05-24) ─────────────────────────
    # An "employee" is a Whitelist entry with these populated; legacy rows
    # without them still work as plain vehicle entries.
    department      = db.Column(db.String(100), nullable=True)
    contact_number  = db.Column(db.String(20),  nullable=True)
    activated_at    = db.Column(db.DateTime,    nullable=True)
    activation_months = db.Column(db.Integer,   nullable=True)  # original validity period, kept for renewal
    vehicle_type = db.Column(db.String(50), nullable=True, default="Car") # e.g. Car, Truck, Bike, Scooty
    # ── Activation payment (added 2026-05-27) ─────────────────────────────────
    # Mandatory at activation time for new enrollments. Legacy rows have NULLs.
    payment_method = db.Column(db.String(40),  nullable=True)  # PhonePe / Paytm / Google Pay / BHIM / Amazon Pay / Other UPI
    upi_id         = db.Column(db.String(120), nullable=True)  # e.g. 9876543210@ybl
    transaction_id = db.Column(db.String(40),  nullable=True)  # 8-30 alphanumeric
    payment_amount = db.Column(db.Integer,     nullable=True)  # INR
    paid_at        = db.Column(db.DateTime,    nullable=True)
    created_at = db.Column(db.DateTime, default=datetime.now)
    valid_until = db.Column(db.DateTime, nullable=False)

    @property
    def vehicle_category(self):
        if self.vehicle_type and self.vehicle_type.lower() in ['bike', 'scooty', 'motorcycle', 'two-wheeler']:
            return 'Two-Wheeler'
        return 'Four-Wheeler'

    def is_valid(self):
        return datetime.now() <= self.valid_until

    def to_dict(self):
        return {
            "id": self.id,
            "rfid_tag": self.rfid_tag,
            "number_plate": self.number_plate,
            "owner_name": self.owner_name,
            "department":     self.department or "",
            "contact_number": self.contact_number or "",
            "vehicle_type": self.vehicle_type or "Car",
            "vehicle_category": self.vehicle_category,
            "activated_at":   self.activated_at.strftime("%Y-%m-%d %H:%M:%S") if self.activated_at else None,
            "activation_months": self.activation_months,
            "payment_method": self.payment_method or "",
            "upi_id":         self.upi_id         or "",
            "transaction_id": self.transaction_id or "",
            "payment_amount": self.payment_amount or 0,
            "paid_at":        self.paid_at.strftime("%Y-%m-%d %H:%M:%S") if self.paid_at else None,
            "created_at": self.created_at.strftime("%Y-%m-%d %H:%M:%S") if self.created_at else "N/A",
            "valid_until": self.valid_until.strftime("%Y-%m-%d"),
            "status": "Active" if self.is_valid() else "Expired"
        }


def migrate_schema(engine):
    """Idempotently add new columns to evolved tables. Handles both SQLite
    (local dev) and Postgres (Render/Neon). db.create_all() only creates
    missing tables, not missing columns on existing tables — so when a
    deployed Postgres already has the table from an earlier deploy, we still
    need ALTER TABLE to roll new columns forward."""
    dialect = engine.dialect.name
    if dialect not in ('sqlite', 'postgresql'):
        return

    # Columns to ensure exist on each table. Same types map cleanly to both
    # dialects below (SQLite is type-flexible; Postgres needs proper types).
    whitelist_new = [
        ("department",       "VARCHAR(100)"),
        ("contact_number",   "VARCHAR(20)"),
        ("activated_at",     "TIMESTAMP"),       # SQLite accepts; Postgres needs TIMESTAMP not DATETIME
        ("activation_months","INTEGER"),
        ("payment_method",   "VARCHAR(40)"),
        ("upi_id",           "VARCHAR(120)"),
        ("transaction_id",   "VARCHAR(40)"),
        ("payment_amount",   "INTEGER"),
        ("paid_at",          "TIMESTAMP"),
    ]
    access_logs_new = [
        ("department",     "VARCHAR(100)"),
        ("contact_number", "VARCHAR(20)"),
    ]

    def _existing_cols(conn, table):
        if dialect == 'sqlite':
            return {row[1] for row in conn.execute(text(f"PRAGMA table_info({table})"))}
        # Postgres
        rows = conn.execute(text("""
            SELECT column_name FROM information_schema.columns
            WHERE table_name = :t
        """), {"t": table})
        return {r[0] for r in rows}

    with engine.connect() as conn:
        for table, cols in (('whitelist', whitelist_new),
                            ('access_logs', access_logs_new)):
            existing = _existing_cols(conn, table)
            for col, ctype in cols:
                if col not in existing:
                    # IF NOT EXISTS works on both modern SQLite and Postgres,
                    # but SQLite added it only in 3.35. Guard via the existence
                    # check we just did, so a bare ADD COLUMN works everywhere.
                    conn.execute(text(f"ALTER TABLE {table} ADD COLUMN {col} {ctype}"))
                    print(f"[DB] migrate: added {table}.{col}")
        conn.commit()


class Tariff(db.Model):
    """Per-vehicle-type tariff rule used by the Exit module to compute bills."""
    __tablename__ = 'tariffs'
    id            = db.Column(db.Integer, primary_key=True)
    vehicle_type  = db.Column(db.String(20),  nullable=False, unique=True)
    model         = db.Column(db.String(20),  nullable=False, default='Hourly')
    rate          = db.Column(db.Integer,     nullable=False, default=40)
    daily_cap     = db.Column(db.Integer,     nullable=False, default=240)
    lost_ticket   = db.Column(db.Integer,     nullable=False, default=300)
    created_at    = db.Column(db.DateTime,    default=datetime.now)

    def to_dict(self):
        return {
            "id": self.id, "type": self.vehicle_type, "model": self.model,
            "rate": self.rate, "dailyCap": self.daily_cap, "lost": self.lost_ticket,
        }


class ParkingTransaction(db.Model):
    """One row per vehicle entry. exit_at is NULL while the vehicle is still
    inside; populated when the operator closes the ticket via Exit."""
    __tablename__ = 'parking_transactions'
    id             = db.Column(db.Integer,    primary_key=True)
    vehicle        = db.Column(db.String(50), nullable=False, index=True)
    vehicle_type   = db.Column(db.String(20), nullable=False, default='Car')
    mode           = db.Column(db.String(20), nullable=False, default='RFID/UHF')
    identity       = db.Column(db.String(80), nullable=True,  index=True)
    zone           = db.Column(db.String(40), nullable=False, default='Basement A')
    owner_name     = db.Column(db.String(100), nullable=True)
    is_vip         = db.Column(db.Boolean,    nullable=False, default=False)
    is_staff       = db.Column(db.Boolean,    nullable=False, default=False)
    entry_at       = db.Column(db.DateTime,   nullable=False, default=datetime.now, index=True)
    exit_at        = db.Column(db.DateTime,   nullable=True,  index=True)
    payment_method = db.Column(db.String(20), nullable=True)
    total_amount   = db.Column(db.Integer,    nullable=True)
    lost_ticket    = db.Column(db.Boolean,    nullable=False, default=False)

    @property
    def is_active(self):
        return self.exit_at is None

    def to_dict(self):
        return {
            "id":         self.id,
            "vehicle":    self.vehicle,
            "type":       self.vehicle_type,
            "mode":       self.mode,
            "identity":   self.identity,
            "zone":       self.zone,
            "owner":      self.owner_name,
            "vip":        self.is_vip,
            "staff":      self.is_staff,
            "entryAt":    int(self.entry_at.timestamp() * 1000) if self.entry_at else None,
            "exitAt":     int(self.exit_at.timestamp()  * 1000) if self.exit_at  else None,
            "total":      self.total_amount or 0,
            "payment":    self.payment_method or "",
            "lostTicket": self.lost_ticket,
            "isActive":   self.is_active,
        }


class Setting(db.Model):
    """Simple key/value store for facility-wide knobs."""
    __tablename__ = 'settings'
    key   = db.Column(db.String(50), primary_key=True)
    value = db.Column(db.String(200), nullable=False)

    @staticmethod
    def get(key, default=None):
        row = Setting.query.get(key)
        return row.value if row else default

    @staticmethod
    def set(key, value):
        row = Setting.query.get(key)
        if row:
            row.value = str(value)
        else:
            db.session.add(Setting(key=key, value=str(value)))
        db.session.commit()


class Blacklist(db.Model):
    """Banned plates / tags. Always denied at the gate, regardless of whether
    they also appear in the whitelist. Use case: terminated employees who
    still hold their physical RFID tag, lost/stolen tags, denylisted visitors."""
    __tablename__ = 'blacklist'
    id            = db.Column(db.Integer,    primary_key=True)
    number_plate  = db.Column(db.String(50), nullable=True, index=True)
    rfid_tag      = db.Column(db.String(100), nullable=True, index=True)
    reason        = db.Column(db.String(255), nullable=False, default='')
    added_by      = db.Column(db.String(50),  nullable=True)
    created_at    = db.Column(db.DateTime,    default=datetime.now)

    def to_dict(self):
        return {
            "id":           self.id,
            "number_plate": self.number_plate or "",
            "rfid_tag":     self.rfid_tag     or "",
            "reason":       self.reason       or "",
            "added_by":     self.added_by     or "",
            "created_at":   self.created_at.strftime("%Y-%m-%d %H:%M:%S") if self.created_at else "",
        }


class Visitor(db.Model):
    """Time-bound temporary access for non-employees (couriers, contractors,
    guest cars). Unlike Whitelist (months-long), validity here is start_at
    → end_at (typically hours or a single day)."""
    __tablename__ = 'visitors'
    id            = db.Column(db.Integer,    primary_key=True)
    name          = db.Column(db.String(100), nullable=False)
    number_plate  = db.Column(db.String(50), nullable=False, index=True)
    rfid_tag      = db.Column(db.String(100), nullable=True, index=True)
    purpose       = db.Column(db.String(200), nullable=True)
    contact       = db.Column(db.String(50),  nullable=True)
    host_employee = db.Column(db.String(100), nullable=True)
    start_at      = db.Column(db.DateTime,    nullable=False, default=datetime.now)
    end_at        = db.Column(db.DateTime,    nullable=False)
    created_at    = db.Column(db.DateTime,    default=datetime.now)

    def is_valid(self):
        now = datetime.now()
        return self.start_at <= now <= self.end_at

    def to_dict(self):
        now = datetime.now()
        status = ("Active"   if self.is_valid()
                  else "Future" if now < self.start_at
                  else "Expired")
        return {
            "id":            self.id,
            "name":          self.name,
            "number_plate":  self.number_plate,
            "rfid_tag":      self.rfid_tag or "",
            "purpose":       self.purpose or "",
            "contact":       self.contact or "",
            "host_employee": self.host_employee or "",
            "start_at":      self.start_at.strftime("%Y-%m-%d %H:%M") if self.start_at else "",
            "end_at":        self.end_at.strftime("%Y-%m-%d %H:%M")   if self.end_at   else "",
            "status":        status,
        }


class AuditEvent(db.Model):
    """Unified audit trail for entry/exit/system events."""
    __tablename__ = 'audit_events'
    id        = db.Column(db.Integer,   primary_key=True)
    timestamp = db.Column(db.DateTime,  default=datetime.now, index=True)
    message   = db.Column(db.String(255), nullable=False)
    area      = db.Column(db.String(40),  nullable=False, default='System')

    def to_dict(self):
        return {
            "message": self.message,
            "area":    self.area,
            "at":      int(self.timestamp.timestamp() * 1000) if self.timestamp else None,
        }

    @staticmethod
    def log(message, area='System'):
        try:
            db.session.add(AuditEvent(message=message, area=area))
            db.session.commit()
        except Exception:
            db.session.rollback()


class AccessLog(db.Model):
    __tablename__ = 'access_logs'
    id = db.Column(db.Integer, primary_key=True)
    timestamp = db.Column(db.DateTime, default=datetime.now)
    number_plate = db.Column(db.String(50), nullable=True)
    rfid_tag = db.Column(db.String(100), nullable=True)
    owner_name = db.Column(db.String(100), nullable=True)
    # Snapshot of employee fields at the moment of the scan — so Reports can
    # show department/contact even if the whitelist row is later edited/deleted.
    department      = db.Column(db.String(100), nullable=True)
    contact_number  = db.Column(db.String(20),  nullable=True)
    vehicle_type = db.Column(db.String(50), nullable=True)
    vehicle_category = db.Column(db.String(50), nullable=True)
    status = db.Column(db.String(100), nullable=False)

    def to_dict(self):
        return {
            "id": self.id,
            "timestamp": self.timestamp.strftime("%Y-%m-%d %H:%M:%S") if self.timestamp else "N/A",
            "number_plate": self.number_plate or "N/A",
            "rfid_tag": self.rfid_tag or "N/A",
            "owner_name": self.owner_name or "N/A",
            "department":     self.department     or "",
            "contact_number": self.contact_number or "",
            "vehicle_type": self.vehicle_type or "N/A",
            "vehicle_category": self.vehicle_category or "N/A",
            "status": self.status
        }


# ── Region + Yard (org hierarchy, WeParking parity) ──────────────────────────
# New tables — db.create_all() creates them automatically on deploy, no
# migrate_schema needed. A Region groups one or more Yards (parking lots).
class Region(db.Model):
    __tablename__ = 'regions'
    id          = db.Column(db.Integer, primary_key=True)
    name        = db.Column(db.String(120), nullable=False)
    description = db.Column(db.String(300), nullable=True)
    created_at  = db.Column(db.DateTime, default=datetime.now)

    def to_dict(self):
        return {
            "id":          self.id,
            "name":        self.name,
            "description": self.description or "",
            "yard_count":  Yard.query.filter(Yard.region == self.name).count(),
            "created_at":  self.created_at.strftime("%Y-%m-%d %H:%M") if self.created_at else "",
        }


class Yard(db.Model):
    __tablename__ = 'yards'
    id         = db.Column(db.Integer, primary_key=True)
    name       = db.Column(db.String(120), nullable=False)
    capacity   = db.Column(db.Integer, default=0)
    location   = db.Column(db.String(200), nullable=True)
    region     = db.Column(db.String(120), nullable=True)   # matches Region.name
    created_at = db.Column(db.DateTime, default=datetime.now)

    def occupied(self):
        # Live occupancy = vehicles currently parked in this yard (zone match).
        return ParkingTransaction.query.filter(
            ParkingTransaction.zone == self.name,
            ParkingTransaction.exit_at.is_(None)).count()

    def to_dict(self):
        occ = self.occupied()
        cap = self.capacity or 0
        return {
            "id":        self.id,
            "name":      self.name,
            "capacity":  cap,
            "occupied":  occ,
            "available": max(0, cap - occ),
            "location":  self.location or "",
            "region":    self.region or "",
            "created_at": self.created_at.strftime("%Y-%m-%d %H:%M") if self.created_at else "",
        }


# ── System Management tables (WeParking parity) ──────────────────────────────
# New tables, created automatically by db.create_all() on deploy.
class Account(db.Model):
    __tablename__ = 'accounts'
    id         = db.Column(db.Integer, primary_key=True)
    name       = db.Column(db.String(120), nullable=False)   # login / account name
    nickname   = db.Column(db.String(120), nullable=True)
    contact    = db.Column(db.String(60),  nullable=True)
    role       = db.Column(db.String(80),  nullable=True)
    created_at = db.Column(db.DateTime, default=datetime.now)

    def to_dict(self):
        return {
            "id":        self.id,
            "name":      self.name,
            "nickname":  self.nickname or "",
            "contact":   self.contact or "",
            "role":      self.role or "",
            "created_at": self.created_at.strftime("%Y-%m-%d %H:%M") if self.created_at else "",
        }


class Role(db.Model):
    __tablename__ = 'roles'
    id          = db.Column(db.Integer, primary_key=True)
    name        = db.Column(db.String(80), nullable=False)
    description = db.Column(db.String(255), nullable=True)
    created_at  = db.Column(db.DateTime, default=datetime.now)

    def to_dict(self):
        return {
            "id":          self.id,
            "name":        self.name,
            "description": self.description or "",
            "account_count": Account.query.filter(Account.role == self.name).count(),
            "created_at":  self.created_at.strftime("%Y-%m-%d %H:%M") if self.created_at else "",
        }


class DictionaryEntry(db.Model):
    __tablename__ = 'dictionary'
    id         = db.Column(db.Integer, primary_key=True)
    category   = db.Column(db.String(80),  nullable=False)   # e.g. "Vehicle Category"
    dict_key   = db.Column(db.String(120), nullable=False)
    dict_value = db.Column(db.String(255), nullable=True)
    created_at = db.Column(db.DateTime, default=datetime.now)

    def to_dict(self):
        return {
            "id":       self.id,
            "category": self.category,
            "key":      self.dict_key,
            "value":    self.dict_value or "",
            "created_at": self.created_at.strftime("%Y-%m-%d %H:%M") if self.created_at else "",
        }


class MenuPermission(db.Model):
    __tablename__ = 'menu_permissions'
    id         = db.Column(db.Integer, primary_key=True)
    role_name  = db.Column(db.String(80),  nullable=False)
    menu_key   = db.Column(db.String(80),  nullable=False)   # matches sidebar data-view
    allowed    = db.Column(db.Boolean,     default=True)
    created_at = db.Column(db.DateTime,    default=datetime.now)

    def to_dict(self):
        return {
            "id":         self.id,
            "role_name":  self.role_name,
            "menu_key":   self.menu_key,
            "allowed":    bool(self.allowed),
            "status":     "Allowed" if self.allowed else "Blocked",
            "created_at": self.created_at.strftime("%Y-%m-%d %H:%M") if self.created_at else "",
        }


class RolePermission(db.Model):
    __tablename__ = 'role_permissions'
    id          = db.Column(db.Integer, primary_key=True)
    role_name   = db.Column(db.String(80), nullable=False)
    section_key = db.Column(db.String(80), nullable=False)
    action      = db.Column(db.String(20), nullable=False)   # read / write / delete
    allowed     = db.Column(db.Boolean,    default=True)
    created_at  = db.Column(db.DateTime,   default=datetime.now)

    def to_dict(self):
        return {
            "id":          self.id,
            "role_name":   self.role_name,
            "section_key": self.section_key,
            "action":      self.action,
            "allowed":     bool(self.allowed),
            "status":      "Allowed" if self.allowed else "Blocked",
            "created_at":  self.created_at.strftime("%Y-%m-%d %H:%M") if self.created_at else "",
        }


class LCDScreen(db.Model):
    __tablename__ = 'lcd_screens'
    id          = db.Column(db.Integer, primary_key=True)
    name        = db.Column(db.String(120), nullable=False)
    location    = db.Column(db.String(200), nullable=True)
    message     = db.Column(db.String(500), nullable=True)
    is_active   = db.Column(db.Boolean, default=True)
    created_at  = db.Column(db.DateTime, default=datetime.now)

    def to_dict(self):
        return {
            "id":         self.id,
            "name":       self.name,
            "location":   self.location or "",
            "message":    self.message or "",
            "is_active":  bool(self.is_active),
            "status":     "Active" if self.is_active else "Inactive",
            "created_at": self.created_at.strftime("%Y-%m-%d %H:%M") if self.created_at else "",
        }

