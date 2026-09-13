from flask_sqlalchemy import SQLAlchemy
from sqlalchemy import text
from datetime import datetime, timedelta, timezone
from werkzeug.security import generate_password_hash, check_password_hash

db = SQLAlchemy()

# Every timestamp stored in the DB is naive UTC (both because Neon Postgres
# defaults to UTC and because Render's runtime is UTC). Operators are in
# India, so every to_dict() must render timestamps as IST (UTC+5:30) or
# they show up 5:30 hours behind on the webportal.
_IST_OFFSET = timedelta(hours=5, minutes=30)

def to_ist(dt, fmt="%Y-%m-%d %H:%M:%S"):
    """Convert a naive-UTC datetime from the DB into an IST-formatted string.
    Returns '' for None. On-site laptops (whose local time IS already IST)
    have naive local timestamps -- for those, the +5:30 shift double-counts,
    so USE_UTC_STORAGE=0 in .env disables the conversion. Cloud stays on."""
    import os
    if dt is None:
        return ''
    if os.environ.get('USE_UTC_STORAGE', '1').strip() == '0':
        return dt.strftime(fmt)
    return (dt + _IST_OFFSET).strftime(fmt)

class Whitelist(db.Model):
    __tablename__ = 'whitelist'
    id = db.Column(db.Integer, primary_key=True)
    # ── Physical-token fields ────────────────────────────────────────────────
    # A single pass can carry TWO different tokens:
    #   rfid_tag = UHF RFID chip's EPC (24-char hex, read by the UHF antenna
    #              at the gate; long range, hands-free)
    #   barcode  = printed 1D/2D barcode on the pass (Code-128, QR, etc.,
    #              scanned by a handheld barcode reader; visual)
    # Either or both can be set. Gate access matches on whichever the
    # scanner reports.
    rfid_tag = db.Column(db.String(100), unique=True, nullable=True, index=True)
    barcode  = db.Column(db.String(100), unique=True, nullable=True, index=True)
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
    # ── External-system integration fields (added 2026-07-18) ────────────────
    # Populated when a third-party barcode/pass issuance system pushes rows
    # in via /api/soap/whitelist. ut_id is the upstream system's stable
    # primary key -- used to UPSERT so re-sends update the existing row
    # instead of duplicating. properties is a free-form JSON string for any
    # extra key/value data the upstream system wants to store.
    ut_id      = db.Column(db.String(80),  nullable=True, index=True, unique=True)
    properties = db.Column(db.Text,        nullable=True)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)
    valid_until = db.Column(db.DateTime, nullable=False)

    @property
    def vehicle_category(self):
        if self.vehicle_type and self.vehicle_type.lower() in ['bike', 'scooty', 'motorcycle', 'two-wheeler']:
            return 'Two-Wheeler'
        return 'Four-Wheeler'

    def is_valid(self):
        return datetime.utcnow() <= self.valid_until

    def to_dict(self):
        return {
            "id": self.id,
            "rfid_tag": self.rfid_tag,
            "barcode":  self.barcode or "",
            "ut_id":    self.ut_id   or "",
            "properties": self.properties or "",
            "number_plate": self.number_plate,
            "owner_name": self.owner_name,
            "department":     self.department or "",
            "contact_number": self.contact_number or "",
            "vehicle_type": self.vehicle_type or "Car",
            "vehicle_category": self.vehicle_category,
            "activated_at":   to_ist(self.activated_at, "%Y-%m-%d %H:%M:%S") or None,
            "activation_months": self.activation_months,
            "payment_method": self.payment_method or "",
            "upi_id":         self.upi_id         or "",
            "transaction_id": self.transaction_id or "",
            "payment_amount": self.payment_amount or 0,
            "paid_at":        to_ist(self.paid_at, "%Y-%m-%d %H:%M:%S") or None,
            "created_at": to_ist(self.created_at, "%Y-%m-%d %H:%M:%S") or "N/A",
            "valid_until": to_ist(self.valid_until, "%Y-%m-%d"),
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
        ("ut_id",            "VARCHAR(80)"),    # upstream barcode-issuer's PK
        ("properties",       "TEXT"),           # free-form JSON payload
        ("barcode",          "VARCHAR(100)"),   # 1D/2D printed barcode, separate from rfid_tag
    ]
    blacklist_new = [
        ("ut_id",      "VARCHAR(80)"),
        ("properties", "TEXT"),
        ("barcode",    "VARCHAR(100)"),
    ]
    access_logs_new = [
        ("department",     "VARCHAR(100)"),
        ("contact_number", "VARCHAR(20)"),
    ]
    # Accounts table: password_hash was added when the login system shipped —
    # roll it onto existing Postgres deploys (db.create_all skips the column
    # because the table already exists).
    accounts_new = [
        ("password_hash", "VARCHAR(255)"),
    ]
    # Ticket / QR binding on parking transactions.
    parking_transactions_new = [
        ("ticket_no",  "VARCHAR(40)"),
        ("qr_payload", "VARCHAR(200)"),
    ]
    # Solution vertical + capability flags on each site (yard).
    yards_new = [
        ("site_type",    "VARCHAR(40)"),
        ("cap_anpr",     "BOOLEAN"),
        ("cap_rfid",     "BOOLEAN"),
        ("cap_qr",       "BOOLEAN"),
        ("cap_barrier",  "BOOLEAN"),
        ("cap_guidance", "BOOLEAN"),
        ("cap_payments", "BOOLEAN"),
        ("cap_visitor",  "BOOLEAN"),
        ("cap_access",   "BOOLEAN"),
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
        for table, cols in (('whitelist',   whitelist_new),
                            ('blacklist',   blacklist_new),
                            ('access_logs', access_logs_new),
                            ('accounts',    accounts_new),
                            ('parking_transactions', parking_transactions_new),
                            ('yards',       yards_new)):
            existing = _existing_cols(conn, table)
            # Skip tables that don't exist yet — db.create_all() (called right
            # after migrate_schema) will create them with the full column set,
            # so ALTER TABLE would fail with no benefit.
            if not existing:
                continue
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
    created_at    = db.Column(db.DateTime,    default=datetime.utcnow)

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
    entry_at       = db.Column(db.DateTime,   nullable=False, default=datetime.utcnow, index=True)
    exit_at        = db.Column(db.DateTime,   nullable=True,  index=True)
    payment_method = db.Column(db.String(20), nullable=True)
    total_amount   = db.Column(db.Integer,    nullable=True)
    lost_ticket    = db.Column(db.Boolean,    nullable=False, default=False)
    # ── Ticket / QR binding (added 2026-09-10) ────────────────────────────────
    # ticket_no is the printed entry ticket's number; qr_payload is what its QR
    # encodes. Scanning that QR at exit resolves this exact transaction, tying
    # entry and exit together. Rolled onto existing DBs by migrate_schema().
    ticket_no      = db.Column(db.String(40),  nullable=True, index=True)
    qr_payload     = db.Column(db.String(200), nullable=True)

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
            "ticketNo":   self.ticket_no or "",
            "qrPayload":  self.qr_payload or "",
        }


class PrintJob(db.Model):
    """A full record of every ticket/receipt/test print — what was printed, to
    which device, whether it succeeded, and WHO printed it (user + role). This
    is the dynamic print history; the printer config itself lives in Setting.
    A new table, so db.create_all() creates it on boot (no migration needed)."""
    __tablename__ = 'print_jobs'
    id              = db.Column(db.Integer, primary_key=True)
    created_at      = db.Column(db.DateTime, default=datetime.utcnow, index=True)
    kind            = db.Column(db.String(20),  nullable=False)   # ticket / receipt / test / cut
    ticket_no       = db.Column(db.String(40),  nullable=True, index=True)
    vehicle_number  = db.Column(db.String(50),  nullable=True, index=True)
    vehicle_type    = db.Column(db.String(20),  nullable=True)
    amount          = db.Column(db.Integer,     nullable=True)
    lane            = db.Column(db.String(40),  nullable=True)
    transport       = db.Column(db.String(10),  nullable=True)   # lan / usb
    target          = db.Column(db.String(120), nullable=True)   # host:port or usb name
    status          = db.Column(db.String(20),  nullable=False, default='sent')  # sent / failed
    message         = db.Column(db.String(255), nullable=True)
    qr_payload      = db.Column(db.String(200), nullable=True)
    printed_by      = db.Column(db.String(120), nullable=True, index=True)
    printed_by_role = db.Column(db.String(80),  nullable=True)

    def to_dict(self):
        return {
            "id":         self.id,
            "when":       to_ist(self.created_at, "%Y-%m-%d %H:%M:%S") or "",
            "kind":       self.kind,
            "ticket_no":  self.ticket_no or "",
            "vehicle":    self.vehicle_number or "",
            "type":       self.vehicle_type or "",
            "amount":     self.amount or 0,
            "lane":       self.lane or "",
            "transport":  (self.transport or "").upper(),
            "target":     self.target or "",
            "status":     self.status or "",
            "message":    self.message or "",
            "printed_by": self.printed_by or "—",
            "role":       self.printed_by_role or "—",
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
    barcode       = db.Column(db.String(100), nullable=True, index=True)  # 1D/2D printed barcode, separate from rfid_tag
    reason        = db.Column(db.String(255), nullable=False, default='')
    added_by      = db.Column(db.String(50),  nullable=True)
    # ── External-system integration fields (added 2026-07-18) ────────────────
    # Same semantics as Whitelist.ut_id / .properties. See /api/soap/blacklist.
    ut_id         = db.Column(db.String(80),  nullable=True, index=True, unique=True)
    properties    = db.Column(db.Text,        nullable=True)
    created_at    = db.Column(db.DateTime,    default=datetime.utcnow)

    def to_dict(self):
        return {
            "id":           self.id,
            "number_plate": self.number_plate or "",
            "rfid_tag":     self.rfid_tag     or "",
            "barcode":      self.barcode      or "",
            "reason":       self.reason       or "",
            "added_by":     self.added_by     or "",
            "ut_id":        self.ut_id        or "",
            "properties":   self.properties   or "",
            "created_at":   to_ist(self.created_at, "%Y-%m-%d %H:%M:%S") or "",
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
    start_at      = db.Column(db.DateTime,    nullable=False, default=datetime.utcnow)
    end_at        = db.Column(db.DateTime,    nullable=False)
    created_at    = db.Column(db.DateTime,    default=datetime.utcnow)

    def is_valid(self):
        now = datetime.utcnow()
        return self.start_at <= now <= self.end_at

    def to_dict(self):
        now = datetime.utcnow()
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
            "start_at":      to_ist(self.start_at, "%Y-%m-%d %H:%M") or "",
            "end_at":        to_ist(self.end_at, "%Y-%m-%d %H:%M") or "",
            "status":        status,
        }


class AuditEvent(db.Model):
    """Unified audit trail for entry/exit/system events."""
    __tablename__ = 'audit_events'
    id        = db.Column(db.Integer,   primary_key=True)
    timestamp = db.Column(db.DateTime,  default=datetime.utcnow, index=True)
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
    timestamp = db.Column(db.DateTime, default=datetime.utcnow)
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
            "timestamp": to_ist(self.timestamp, "%Y-%m-%d %H:%M:%S") or "N/A",
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
    created_at  = db.Column(db.DateTime, default=datetime.utcnow)

    def to_dict(self):
        return {
            "id":          self.id,
            "name":        self.name,
            "description": self.description or "",
            "yard_count":  Yard.query.filter(Yard.region == self.name).count(),
            "created_at":  to_ist(self.created_at, "%Y-%m-%d %H:%M") or "",
        }


class Yard(db.Model):
    __tablename__ = 'yards'
    id         = db.Column(db.Integer, primary_key=True)
    name       = db.Column(db.String(120), nullable=False)
    capacity   = db.Column(db.Integer, default=0)
    location   = db.Column(db.String(200), nullable=True)
    region     = db.Column(db.String(120), nullable=True)   # matches Region.name
    # ── Solution vertical + capabilities (added 2026-09-10) ───────────────────
    # A yard is a "site". site_type tags it as one of the four solution
    # verticals; the cap_* flags record which of the nine platform capabilities
    # are active there. Rolled onto existing DBs by migrate_schema().
    site_type    = db.Column(db.String(40),  nullable=True)   # Gated Community / Shopping Mall / Corporate Campus / Street Parking
    cap_anpr     = db.Column(db.Boolean, default=False)
    cap_rfid     = db.Column(db.Boolean, default=False)
    cap_qr       = db.Column(db.Boolean, default=False)
    cap_barrier  = db.Column(db.Boolean, default=False)
    cap_guidance = db.Column(db.Boolean, default=False)
    cap_payments = db.Column(db.Boolean, default=False)
    cap_visitor  = db.Column(db.Boolean, default=False)
    cap_access   = db.Column(db.Boolean, default=False)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)

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
            "site_type": self.site_type or "",
            "caps": {
                "anpr":     bool(self.cap_anpr),
                "rfid":     bool(self.cap_rfid),
                "qr":       bool(self.cap_qr),
                "barrier":  bool(self.cap_barrier),
                "guidance": bool(self.cap_guidance),
                "payments": bool(self.cap_payments),
                "visitor":  bool(self.cap_visitor),
                "access":   bool(self.cap_access),
            },
            "created_at": to_ist(self.created_at, "%Y-%m-%d %H:%M") or "",
        }


# ── System Management tables (WeParking parity) ──────────────────────────────
# New tables, created automatically by db.create_all() on deploy.
class Account(db.Model):
    __tablename__ = 'accounts'
    id            = db.Column(db.Integer, primary_key=True)
    name          = db.Column(db.String(120), nullable=False)   # login / account name
    nickname      = db.Column(db.String(120), nullable=True)
    contact       = db.Column(db.String(60),  nullable=True)
    role          = db.Column(db.String(80),  nullable=True)
    # Password hash — nullable so legacy rows + admin-created accounts without
    # an initial password still load. PBKDF2/scrypt via werkzeug.security
    # (ships with Flask — no extra dependency). Never store raw passwords.
    password_hash = db.Column(db.String(255), nullable=True)
    created_at    = db.Column(db.DateTime, default=datetime.utcnow)

    def set_password(self, raw):
        """Hash and store a new password. Pass empty/None to leave unchanged."""
        if raw is None or raw == '':
            return
        self.password_hash = generate_password_hash(raw)

    def check_password(self, raw):
        """Constant-time check of a candidate password against the stored hash."""
        return bool(self.password_hash) and check_password_hash(self.password_hash, raw)

    def to_dict(self):
        return {
            "id":        self.id,
            "name":      self.name,
            "nickname":  self.nickname or "",
            "contact":   self.contact or "",
            "role":      self.role or "",
            # has_password flag lets the UI show whether the account can log in
            # without ever exposing the hash itself.
            "has_password": bool(self.password_hash),
            "created_at": to_ist(self.created_at, "%Y-%m-%d %H:%M") or "",
        }


class Role(db.Model):
    __tablename__ = 'roles'
    id          = db.Column(db.Integer, primary_key=True)
    name        = db.Column(db.String(80), nullable=False)
    description = db.Column(db.String(255), nullable=True)
    created_at  = db.Column(db.DateTime, default=datetime.utcnow)

    def to_dict(self):
        return {
            "id":          self.id,
            "name":        self.name,
            "description": self.description or "",
            "account_count": Account.query.filter(Account.role == self.name).count(),
            "created_at":  to_ist(self.created_at, "%Y-%m-%d %H:%M") or "",
        }


class DictionaryEntry(db.Model):
    __tablename__ = 'dictionary'
    id         = db.Column(db.Integer, primary_key=True)
    category   = db.Column(db.String(80),  nullable=False)   # e.g. "Vehicle Category"
    dict_key   = db.Column(db.String(120), nullable=False)
    dict_value = db.Column(db.String(255), nullable=True)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)

    def to_dict(self):
        return {
            "id":       self.id,
            "category": self.category,
            "key":      self.dict_key,
            "value":    self.dict_value or "",
            "created_at": to_ist(self.created_at, "%Y-%m-%d %H:%M") or "",
        }


class MenuPermission(db.Model):
    __tablename__ = 'menu_permissions'
    id         = db.Column(db.Integer, primary_key=True)
    role_name  = db.Column(db.String(80),  nullable=False)
    menu_key   = db.Column(db.String(80),  nullable=False)   # matches sidebar data-view
    allowed    = db.Column(db.Boolean,     default=True)
    created_at = db.Column(db.DateTime,    default=datetime.utcnow)

    def to_dict(self):
        return {
            "id":         self.id,
            "role_name":  self.role_name,
            "menu_key":   self.menu_key,
            "allowed":    bool(self.allowed),
            "status":     "Allowed" if self.allowed else "Blocked",
            "created_at": to_ist(self.created_at, "%Y-%m-%d %H:%M") or "",
        }


class RolePermission(db.Model):
    __tablename__ = 'role_permissions'
    id          = db.Column(db.Integer, primary_key=True)
    role_name   = db.Column(db.String(80), nullable=False)
    section_key = db.Column(db.String(80), nullable=False)
    action      = db.Column(db.String(20), nullable=False)   # read / write / delete
    allowed     = db.Column(db.Boolean,    default=True)
    created_at  = db.Column(db.DateTime,   default=datetime.utcnow)

    def to_dict(self):
        return {
            "id":          self.id,
            "role_name":   self.role_name,
            "section_key": self.section_key,
            "action":      self.action,
            "allowed":     bool(self.allowed),
            "status":      "Allowed" if self.allowed else "Blocked",
            "created_at":  to_ist(self.created_at, "%Y-%m-%d %H:%M") or "",
        }


class UHFEntryEvent(db.Model):
    """One row per UHF-triggered ANPR capture. When the UHF reader sees a tag
    on a vehicle, we snapshot the camera frame, run YOLO+OCR on it ONCE, and
    save both the full vehicle image and the plate crop linked to that tag.
    Decouples the capture-event from the continuous ANPR loop's stream of
    speculative detections."""
    __tablename__ = 'uhf_entry_events'
    id           = db.Column(db.Integer,  primary_key=True)
    timestamp    = db.Column(db.DateTime, default=datetime.utcnow, index=True)
    rfid_tag     = db.Column(db.String(100), nullable=False, index=True)
    plate        = db.Column(db.String(50),  nullable=True)
    vehicle_type = db.Column(db.String(50),  nullable=True)
    confidence   = db.Column(db.Float,       nullable=True)
    full_image   = db.Column(db.String(200), nullable=True)   # filename under detections/
    plate_image  = db.Column(db.String(200), nullable=True)
    owner_name   = db.Column(db.String(100), nullable=True)   # from whitelist lookup
    department   = db.Column(db.String(100), nullable=True)
    status       = db.Column(db.String(80),  nullable=True)   # GRANTED / DENIED / EXPIRED / UNKNOWN

    def to_dict(self):
        return {
            "id":           self.id,
            "timestamp":    to_ist(self.timestamp, "%Y-%m-%d %H:%M:%S") or "",
            "rfid_tag":     self.rfid_tag,
            "plate":        self.plate or "",
            "vehicle_type": self.vehicle_type or "",
            "confidence":   round(self.confidence or 0, 3),
            "full_image":   self.full_image or "",
            "plate_image":  self.plate_image or "",
            "owner_name":   self.owner_name or "",
            "department":   self.department or "",
            "status":       self.status or "",
        }


class ImageBlob(db.Model):
    """Persistent storage for JPEGs so the cloud portal keeps images across
    Render redeploys (Render's application disk is EPHEMERAL — every redeploy
    wipes /detections/). Every UHF capture pushed to /api/cloud_push/uhf gets
    inserted here in addition to the on-disk write, and /image/<filename>
    falls back to this table when the file is missing on disk.

    Bytes live in Neon Postgres bytea; 30 KB per image × 10,000 captures
    is ~300 MB — well within Neon's free tier. A background job trims rows
    older than IMAGE_RETENTION_DAYS (default 90) so growth stays bounded."""
    __tablename__ = 'image_blobs'
    filename   = db.Column(db.String(200), primary_key=True)
    data       = db.Column(db.LargeBinary, nullable=False)
    mime       = db.Column(db.String(40),  nullable=False, default='image/jpeg')
    size_bytes = db.Column(db.Integer,     nullable=False, default=0)
    created_at = db.Column(db.DateTime,    default=datetime.utcnow, index=True)


# ── Mobile driver app (VayAccess driver mobile) ──────────────────────────────
# Self-service mobile users (drivers/customers). Independent of the
# admin-portal Account table — different namespace, different login surface
# (/api/driver/login vs /api/login), different auth (token in Authorization
# header vs session cookie). One driver may own multiple vehicles via
# DriverVehicle; reservations + parking sessions are linked by driver_id.
class DriverUser(db.Model):
    __tablename__ = 'driver_users'
    id            = db.Column(db.Integer,    primary_key=True)
    name          = db.Column(db.String(120), nullable=False)
    email         = db.Column(db.String(160), unique=True, nullable=False, index=True)
    phone         = db.Column(db.String(20),  nullable=True,  index=True)
    password_hash = db.Column(db.String(255), nullable=False)
    primary_plate = db.Column(db.String(50),  nullable=True,  index=True)
    primary_type  = db.Column(db.String(20),  nullable=True, default='Car')
    fastag_id     = db.Column(db.String(40),  nullable=True)
    created_at    = db.Column(db.DateTime,    default=datetime.utcnow)

    def set_password(self, raw):
        if raw:
            self.password_hash = generate_password_hash(raw)

    def check_password(self, raw):
        return bool(self.password_hash) and check_password_hash(self.password_hash, raw)

    def to_dict(self):
        return {
            "id":            self.id,
            "name":          self.name,
            "email":         self.email,
            "phone":         self.phone or "",
            "primary_plate": self.primary_plate or "",
            "primary_type":  self.primary_type  or "Car",
            "fastag_id":     self.fastag_id     or "",
            "created_at":    to_ist(self.created_at, "%Y-%m-%d %H:%M") or "",
        }


class DriverSession(db.Model):
    """Opaque bearer tokens issued at /api/driver/login. Mobile clients send
    `Authorization: Bearer <token>` on every request; this row maps the token
    back to a DriverUser. Cleaner than JWT for this scale (no key-rotation
    headache, instant revoke by row delete)."""
    __tablename__ = 'driver_sessions'
    token       = db.Column(db.String(64),  primary_key=True)
    driver_id   = db.Column(db.Integer,     db.ForeignKey('driver_users.id'), nullable=False, index=True)
    created_at  = db.Column(db.DateTime,    default=datetime.utcnow)
    last_seen   = db.Column(db.DateTime,    default=datetime.utcnow)


class DriverReservation(db.Model):
    """A pre-booked slot at a yard. status: pending → confirmed → consumed/cancelled."""
    __tablename__ = 'driver_reservations'
    id              = db.Column(db.Integer,    primary_key=True)
    driver_id       = db.Column(db.Integer,    db.ForeignKey('driver_users.id'), nullable=False, index=True)
    yard_name       = db.Column(db.String(120), nullable=False)   # matches Yard.name
    vehicle_plate   = db.Column(db.String(50),  nullable=False)
    vehicle_type    = db.Column(db.String(20),  nullable=False, default='Car')
    slot_label      = db.Column(db.String(40),  nullable=True)
    start_at        = db.Column(db.DateTime,    nullable=False)
    end_at          = db.Column(db.DateTime,    nullable=False)
    status          = db.Column(db.String(20),  nullable=False, default='confirmed')   # confirmed / consumed / cancelled / expired
    amount          = db.Column(db.Integer,     nullable=True)
    payment_method  = db.Column(db.String(40),  nullable=True)   # UPI/FASTag/Card/Wallet
    upi_id          = db.Column(db.String(120), nullable=True)
    transaction_id  = db.Column(db.String(40),  nullable=True)
    created_at      = db.Column(db.DateTime,    default=datetime.utcnow)

    def to_dict(self):
        return {
            "id":             self.id,
            "yard":           self.yard_name,
            "vehicle_plate":  self.vehicle_plate,
            "vehicle_type":   self.vehicle_type,
            "slot_label":     self.slot_label or "",
            "start_at":       to_ist(self.start_at, "%Y-%m-%d %H:%M") or "",
            "end_at":         to_ist(self.end_at, "%Y-%m-%d %H:%M") or "",
            "status":         self.status,
            "amount":         self.amount or 0,
            "payment_method": self.payment_method or "",
            "transaction_id": self.transaction_id or "",
            "created_at":     to_ist(self.created_at, "%Y-%m-%d %H:%M") or "",
        }


class DriverNotification(db.Model):
    __tablename__ = 'driver_notifications'
    id         = db.Column(db.Integer, primary_key=True)
    driver_id  = db.Column(db.Integer, db.ForeignKey('driver_users.id'), nullable=False, index=True)
    title      = db.Column(db.String(160), nullable=False)
    body       = db.Column(db.String(800), nullable=True)
    kind       = db.Column(db.String(40),  nullable=True)   # reservation / payment / alert / system
    read_at    = db.Column(db.DateTime,    nullable=True)
    created_at = db.Column(db.DateTime,    default=datetime.utcnow, index=True)

    def to_dict(self):
        return {
            "id":         self.id,
            "title":      self.title,
            "body":       self.body or "",
            "kind":       self.kind or "system",
            "read":       self.read_at is not None,
            "created_at": to_ist(self.created_at, "%Y-%m-%d %H:%M") or "",
        }


class LCDScreen(db.Model):
    __tablename__ = 'lcd_screens'
    id          = db.Column(db.Integer, primary_key=True)
    name        = db.Column(db.String(120), nullable=False)
    location    = db.Column(db.String(200), nullable=True)
    message     = db.Column(db.String(500), nullable=True)
    is_active   = db.Column(db.Boolean, default=True)
    created_at  = db.Column(db.DateTime, default=datetime.utcnow)

    def to_dict(self):
        return {
            "id":         self.id,
            "name":       self.name,
            "location":   self.location or "",
            "message":    self.message or "",
            "is_active":  bool(self.is_active),
            "status":     "Active" if self.is_active else "Inactive",
            "created_at": to_ist(self.created_at, "%Y-%m-%d %H:%M") or "",
        }

