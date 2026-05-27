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
            "created_at": self.created_at.strftime("%Y-%m-%d %H:%M:%S") if self.created_at else "N/A",
            "valid_until": self.valid_until.strftime("%Y-%m-%d"),
            "status": "Active" if self.is_valid() else "Expired"
        }


def migrate_schema(engine):
    """Idempotently add new columns to whitelist for existing SQLite parking.db
    files. SQLite ADD COLUMN was used to evolve schemas in place. For Postgres
    deployments db.create_all() already includes every column in the model, so
    this becomes a no-op. We detect the dialect and skip on non-sqlite."""
    if engine.dialect.name != 'sqlite':
        return
    new_cols = [
        ("department",       "VARCHAR(100)"),
        ("contact_number",   "VARCHAR(20)"),
        ("activated_at",     "DATETIME"),
        ("activation_months","INTEGER"),
    ]
    with engine.connect() as conn:
        existing = {row[1] for row in conn.execute(text("PRAGMA table_info(whitelist)"))}
        for col, ctype in new_cols:
            if col not in existing:
                conn.execute(text(f"ALTER TABLE whitelist ADD COLUMN {col} {ctype}"))
                print(f"[DB] migrate: added whitelist.{col}")

        # access_logs: snapshot of employee fields for the Reports view
        existing_al = {row[1] for row in conn.execute(text("PRAGMA table_info(access_logs)"))}
        for col, ctype in (("department", "VARCHAR(100)"), ("contact_number", "VARCHAR(20)")):
            if col not in existing_al:
                conn.execute(text(f"ALTER TABLE access_logs ADD COLUMN {col} {ctype}"))
                print(f"[DB] migrate: added access_logs.{col}")
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

