"""One-shot SQLite -> PostgreSQL migration for VayAccess parking app.

Reads every row from instance/parking.db (the legacy SQLite file) and inserts
into the configured Postgres database (parkops_db). Tables migrated:

  whitelist, parking_transactions, access_logs, audit_events, tariffs, settings

The script is idempotent — wipes Postgres tables first so re-running is safe.
Sequence values are bumped to MAX(id)+1 after the copy so future inserts don't
collide with existing IDs.

Run:
    python migrate_sqlite_to_pg.py
"""
import os, sqlite3, sys
from app import app, db
from database import (Whitelist, AccessLog, ParkingTransaction,
                      Setting, AuditEvent, Tariff)

SQLITE_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                            'instance', 'parking.db')

def _rows(conn, table):
    cur = conn.execute(f"SELECT * FROM {table}")
    cols = [d[0] for d in cur.description]
    return [dict(zip(cols, r)) for r in cur.fetchall()]

def _parse_dt(v):
    """Convert SQLite text datetimes to Python datetime where needed.
    SQLAlchemy on Postgres expects datetime objects, not strings."""
    if v is None or v == '':
        return None
    if isinstance(v, str):
        # SQLite stores datetimes as 'YYYY-MM-DD HH:MM:SS[.ffffff]'
        from datetime import datetime
        try:
            return datetime.fromisoformat(v)
        except ValueError:
            # Try without fractional seconds
            return datetime.strptime(v.split('.')[0], '%Y-%m-%d %H:%M:%S')
    return v


def main():
    if not os.path.exists(SQLITE_PATH):
        print(f"[ERR] SQLite file not found: {SQLITE_PATH}")
        sys.exit(1)

    src = sqlite3.connect(SQLITE_PATH)
    src.row_factory = sqlite3.Row

    with app.app_context():
        # 1. Create tables in Postgres
        db.create_all()
        print("[OK] Postgres schema ready (db.create_all)")

        # 2. Wipe target tables (delete order respects no FK — none defined)
        for tbl in ['audit_events', 'access_logs', 'parking_transactions',
                    'whitelist', 'tariffs', 'settings']:
            db.session.execute(db.text(f"DELETE FROM {tbl}"))
        db.session.commit()
        print("[OK] Wiped target tables")

        # 3. Copy each table
        # (table, Model, columns to copy, datetime columns, BOOL columns)
        # — `tariffs.lost_ticket` is an INTEGER (₹ surcharge amount),
        #   `parking_transactions.lost_ticket` is BOOLEAN. Hence per-table.
        copy_plan = [
            ('whitelist',            Whitelist,
             ['id', 'rfid_tag', 'number_plate', 'owner_name', 'department',
              'contact_number', 'activated_at', 'activation_months',
              'vehicle_type', 'created_at', 'valid_until'],
             ['activated_at', 'created_at', 'valid_until'],
             []),
            ('tariffs',              Tariff,
             ['id', 'vehicle_type', 'model', 'rate', 'daily_cap',
              'lost_ticket', 'created_at'],
             ['created_at'],
             []),
            ('parking_transactions', ParkingTransaction,
             ['id', 'vehicle', 'vehicle_type', 'mode', 'identity', 'zone',
              'owner_name', 'is_vip', 'is_staff', 'entry_at', 'exit_at',
              'payment_method', 'total_amount', 'lost_ticket'],
             ['entry_at', 'exit_at'],
             ['is_vip', 'is_staff', 'lost_ticket']),
            ('settings',             Setting,
             ['key', 'value'], [], []),
            ('audit_events',         AuditEvent,
             ['id', 'timestamp', 'message', 'area'],
             ['timestamp'],
             []),
            ('access_logs',          AccessLog,
             ['id', 'timestamp', 'number_plate', 'rfid_tag', 'owner_name',
              'department', 'contact_number', 'vehicle_type',
              'vehicle_category', 'status'],
             ['timestamp'],
             []),
        ]

        totals = {}
        for table, Model, cols, dt_cols, bool_cols in copy_plan:
            try:
                rows = _rows(src, table)
            except sqlite3.OperationalError as e:
                print(f"[--] {table}: skipped ({e})")
                continue
            for r in rows:
                kw = {c: r.get(c) for c in cols if c in r.keys()}
                for c in dt_cols:
                    if c in kw:
                        kw[c] = _parse_dt(kw[c])
                for c in bool_cols:
                    if c in kw and kw[c] is not None:
                        kw[c] = bool(kw[c])
                db.session.add(Model(**kw))
            db.session.commit()
            totals[table] = len(rows)
            print(f"[OK] {table}: copied {len(rows)} rows")

        # 4. Bump Postgres sequences past max(id) so new inserts don't collide
        for table in ['whitelist', 'tariffs', 'parking_transactions',
                      'audit_events', 'access_logs']:
            try:
                db.session.execute(db.text(
                    f"SELECT setval(pg_get_serial_sequence('{table}', 'id'), "
                    f"COALESCE((SELECT MAX(id) FROM {table}), 1))"))
            except Exception as e:
                print(f"[--] sequence bump skipped for {table}: {e}")
        db.session.commit()
        print("[OK] Sequences bumped")

        print("\nSummary:")
        for t, n in totals.items():
            print(f"  {t:24s} {n:>6d} rows")

    src.close()
    print("\n✓ Migration complete.")

if __name__ == '__main__':
    main()
