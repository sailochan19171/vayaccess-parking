# Smart Parking — real-time slot reservation

Real-time, multi-user parking reservation built on the existing Flask app.
**The backend is the source of truth**: two users can never both reserve the
same active slot.

## Architecture (reuses the existing stack)

- **Server**: the existing Flask app on `waitress` (single process, N threads).
  Realtime uses an **in-process SSE broker** — no eventlet/gevent/Redis. On
  Render free (single instance) this is exactly right; to scale to multiple
  instances, move the broker to Redis pub/sub (only `parking_core.broker` and
  the SSE route change).
- **DB**: SQLite (local) / Neon Postgres (cloud), via the existing
  `migrate_schema` additive-migration pattern. New tables come from
  `db.create_all()`; new columns are ALTERed in idempotently.
- **Auth**: reuses the two existing surfaces — admin **session cookie**
  (`admin_required`) for setup/dashboard, and driver **Bearer token**
  (`_driver_auth_required`, `request.driver`) for booking.

## Hierarchy

`Yard (parking location)` → `ParkingBlock` → `ParkingSlot`. Slot counts are
**never hardcoded** — an admin sets them per block and slots auto-generate
(`A1..An`) or take explicit labels.

## Slot lifecycle (each transition is atomic)

`AVAILABLE → HELD → RESERVED → OCCUPIED → COMPLETED → AVAILABLE`, plus
`CANCELLED` / `EXPIRED`. Every transition is a single conditional
`UPDATE parking_slots SET status=… WHERE id=? AND status=<expected>` whose
`rowcount` decides success — atomic on both SQLite and Postgres. Colours:
green=AVAILABLE, yellow=HELD, red=RESERVED/OCCUPIED, grey=DISABLED/OUT_OF_SERVICE.

## OTP

`OtpVerification` stores only a **hash** of the code, with expiry, max attempts,
resend limit and single-use (`consumed_at`). Delivery is **pluggable**
(`parking_core.register_otp_sink`). With no SMS provider configured, the OTP is
shown on-screen (dev echo, `Setting park_otp_dev_echo=1`) and an in-app
notification says an OTP was *sent* (the code itself is never persisted in the
notification). To add real SMS/email later, register a sink and set
`park_otp_dev_echo=0`.

## Realtime + notifications

- **SSE**: `GET /api/events/slots?location=<id>` streams `slot.*` events
  (held/reserved/occupied/released/expired/disabled/enabled). Public — carries
  **no occupant PII**, only which slot changed to what colour. The web UI uses
  `EventSource`; each connection is capped at 10 min and auto-reconnects.
- **Watchers**: `SlotWatcher` + a **notify-once, idempotent** fan-out
  (time-bucketed `event_key`). When a watched slot frees up, the watcher gets an
  in-app `DriverNotification`, an SSE update (buzzer + browser notification in
  the active web app), and — once mobile FCM ships — a push (`DeviceToken` +
  `register_push_sink`).
- **Buzzer**: Web Audio tone in the browser when a watched slot frees up; a
  per-viewer on/off toggle.

## Background sweeper

A daemon thread (`parking_core.start_sweeper`, started in `_boot` on cloud +
on-site) expires stale **holds** (`park_hold_seconds`) and grace-expired
**reservations** (`park_grace_minutes`), frees their slots, and notifies watchers.

## Configurable knobs (all in the `Setting` key/value table — live-tunable)

| key | default | meaning |
|---|---|---|
| `park_hold_seconds` | 120 | AVAILABLE→HELD window before auto-expire |
| `park_grace_minutes` | 15 | RESERVED "must arrive by" grace |
| `park_default_reservation_hours` | 4 | default booking length |
| `park_otp_length` | 6 | OTP digits |
| `park_otp_ttl_seconds` | 300 | OTP validity |
| `park_otp_max_attempts` | 5 | wrong-code attempts before lockout |
| `park_otp_resend_max` | 3 | resends per booking |
| `park_otp_dev_echo` | 1 | show OTP on-screen (set 0 with a real SMS sink) |

## APIs

User (Bearer): `GET /api/park/locations`, `/locations/<id>/blocks`,
`/blocks/<id>/slots`, `/slots/<id>`; `POST /api/park/slots/<id>/hold`,
`/reservations/<id>/confirm-otp`, `/resend-otp`, `/occupy`, `/exit`, `/cancel`;
`GET /api/park/reservations/mine`; `POST|DELETE /api/park/slots/<id>/watch`;
`GET /api/park/watches`; `POST /api/park/device-token`;
`GET /api/park/reservations/<id>/qr.png`; `GET /api/events/slots`.

Admin (session): `GET /api/admin/park/locations`;
`GET|POST /api/admin/park/locations/<yid>/blocks`;
`PUT|DELETE /api/admin/park/blocks/<id>`;
`GET|POST /api/admin/park/blocks/<id>/slots`;
`PUT|DELETE /api/admin/park/slots/<id>`;
`POST /api/admin/park/slots/<id>/status` (DISABLED/OUT_OF_SERVICE/AVAILABLE);
`POST /api/admin/park/slots/<id>/force-release`;
`GET /api/admin/park/locations/<yid>/dashboard` (live, with occupant).

## Web UI (under "Smart Parking" in the sidebar)

- **Book Parking** — driver self-service (own login): location → block → slot
  grid → confirm → OTP → reserved (QR pass) → My Parking (occupy/exit/cancel) +
  watch/notify-me + buzzer. Live via SSE.
- **Live Parking Dashboard** (admin) — per-block counts + slot grid with
  occupant, live via SSE + poll.
- **Parking Setup** (admin) — create blocks (auto-generate slots), add/remove
  slots, disable/mark-unavailable/enable, force-release.

## Files

- `database.py` — new models + migrate columns.
- `parking_core.py` — SSE broker, atomic transitions, OTP, watchers, sweeper.
- `app.py` — user/admin APIs, SSE route, QR PNG, `'r'` reservation kind on `/v/`.
- `templates/index.html`, `static/parkvision.js`, `static/styles.css` — 3 views.
- `tests/test_parking.py` — 12 tests (atomic booking, OTP, lifecycle, expiry,
  watcher, events, admin CRUD, authz).

## Environment

No new required env vars (knobs live in `Setting`). For real OTP SMS/email or
mobile FCM push later, add the provider credentials as env vars and register the
corresponding sink (`register_otp_sink` / `register_push_sink`).

## Mobile (next phase)

The bare-RN app already talks to this same backend. Remaining: wire its screens
to the `/api/park/*` slot APIs, add `@react-native-firebase/messaging`, register
the device token via `POST /api/park/device-token`, and add an FCM
`register_push_sink` server-side so notifications survive app-kill. (Requires a
Firebase project + native Gradle/Xcode build — code + guide to follow.)
