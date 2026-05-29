"""Seed Postgres directly — no SQLite intermediary.

Run this once (or after schema changes) to make sure the Postgres database
configured via DATABASE_URL has the schema and default rows the app
expects. Idempotent — safe to re-run.

What it does (same as what _boot() runs on Render start):
  1. db.create_all()         — create any missing tables
  2. migrate_schema(engine)  — ALTER TABLE to add new columns to existing
                                tables (handles both SQLite and Postgres)
  3. seed_defaults()         — insert default tariffs + settings if absent

It then prints row counts so you can confirm what's in there.

Usage:
    # Your .env (in this folder) must have DATABASE_URL set to the Neon
    # connection string. Then:
    python seed_postgres.py
"""
import os
import sys

# Force cloud mode so app.py's _boot() doesn't spin up the camera + UHF
# reader + YOLO + EasyOCR threads. We only want the DB-lifecycle calls.
os.environ['CLOUD_MODE'] = '1'

# Pull DATABASE_URL from the local .env if it isn't already exported.
# We do this BEFORE importing app.py so the SQLAlchemy URI is correct on
# the first read in app.py (line 82).
def _bootstrap_database_url():
    url = os.environ.get('DATABASE_URL', '')
    if url:
        return url
    env_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), '.env')
    if not os.path.exists(env_path):
        return ''
    with open(env_path, 'r', encoding='utf-8') as f:
        for line in f:
            line = line.strip()
            if line.startswith('DATABASE_URL='):
                url = line.split('=', 1)[1].strip().strip('"').strip("'")
                os.environ['DATABASE_URL'] = url
                return url
    return ''

db_url = _bootstrap_database_url()
if not db_url:
    sys.exit("[ERR] DATABASE_URL not set. Put it in .env (DATABASE_URL=postgresql://...) "
             "or export it in this shell, then re-run.")
if not db_url.lower().startswith(('postgres://', 'postgresql://', 'postgresql+psycopg2://')):
    sys.exit(f"[ERR] DATABASE_URL must point at Postgres. Got: {db_url[:40]}…")

# Strip channel_binding=require if present — psycopg2-binary chokes on it
# on some builds; sslmode=require alone is enough for Neon.
if 'channel_binding=require' in db_url:
    db_url = db_url.replace('&channel_binding=require', '').replace('?channel_binding=require', '?')
    os.environ['DATABASE_URL'] = db_url
    print("[INFO] Stripped channel_binding=require from DATABASE_URL")

# Importing app triggers _boot(), which already runs db.create_all() +
# migrate_schema() + seed_defaults() inside an app_context. That IS the seed.
print(f"[INFO] Seeding host: {db_url.split('@')[-1].split('/')[0]}")
from app import app, db  # noqa: E402  (env vars must be set before import)
from database import (Whitelist, Tariff, Setting, ParkingTransaction,
                      AccessLog, AuditEvent, Blacklist, Visitor, Region, Yard)

with app.app_context():
    counts = {
        'whitelist':            Whitelist.query.count(),
        'tariffs':              Tariff.query.count(),
        'settings':             Setting.query.count(),
        'parking_transactions': ParkingTransaction.query.count(),
        'access_logs':          AccessLog.query.count(),
        'audit_events':         AuditEvent.query.count(),
        'blacklist':            Blacklist.query.count(),
        'visitors':             Visitor.query.count(),
        'regions':              Region.query.count(),
        'yards':                Yard.query.count(),
    }

print()
print("[OK] Postgres seed complete. Current row counts:")
for table, n in counts.items():
    print(f"  {table:<24} {n:>5} rows")
print()
print("Next: open https://vayaccess-cloud.onrender.com - Admin tab should "
      "show the same data.")
