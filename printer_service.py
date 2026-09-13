# printer_service.py — VAY Printer Service (ESC/POS)
#
# A standalone print layer for the parking app, deliberately separated from the
# core software (per the VAY spec) so BUVVAS / Epson / TVS / Xprinter — any
# ESC/POS device — can be swapped without touching parking logic.
#
#   VAY Parking Application → Print Service → LAN / USB → BUVVAS HS-KH80
#
# Transports:
#   • LAN  — raw TCP to the printer's host:9100 (JetDirect / RAW). This is the
#            production path for the BUVVAS HS-KH80 / BS-P80 (USB + LAN).
#   • USB  — Windows raw spooling via pywin32 (win32print) when installed;
#            otherwise reports a clear "USB needs pywin32" status.
#
# Everything also renders a plain-text PREVIEW so tickets/receipts can be
# designed, tested and verified WITHOUT the physical printer on the bench —
# the same layout the printer receives, minus the ESC/POS control bytes.
#
# No third-party dependency for the LAN path (stdlib socket only).

import os
import socket

# ── ESC/POS control bytes ────────────────────────────────────────────────────
ESC = b"\x1b"
GS = b"\x1d"
INIT = ESC + b"@"
ALIGN_L = ESC + b"a\x00"
ALIGN_C = ESC + b"a\x01"
ALIGN_R = ESC + b"a\x02"
BOLD_ON = ESC + b"E\x01"
BOLD_OFF = ESC + b"E\x00"
DBL_ON = GS + b"!\x11"        # double width + height
DBL_OFF = GS + b"!\x00"
CUT_PARTIAL = GS + b"V\x42\x00"
CUT_FULL = GS + b"V\x00"


def _chars_per_line(width_mm):
    # 80 mm ≈ 48 cols (Font A), 58 mm ≈ 32 cols.
    return 32 if str(width_mm).strip() == "58" else 48


def _line(cols, ch="-"):
    return (ch * cols)


def _center(text, cols):
    text = text[:cols]
    pad = max(0, (cols - len(text)) // 2)
    return (" " * pad) + text


def _lr(left, right, cols):
    """Left text + right text on one line, space-filled between."""
    left = str(left)
    right = str(right)
    space = cols - len(left) - len(right)
    if space < 1:
        # truncate the left so the right (amount) always shows
        left = left[: max(0, cols - len(right) - 1)]
        space = cols - len(left) - len(right)
    return left + (" " * max(1, space)) + right


# ── QR code (ESC/POS GS ( k, model 2) ────────────────────────────────────────
def _qr(data, module=6):
    if not data:
        return b""
    d = data.encode("utf-8", "replace")
    out = bytearray()
    # model 2
    out += GS + b"(k\x04\x00\x31\x41\x32\x00"
    # module size (1..16)
    m = max(1, min(16, int(module)))
    out += GS + b"(k\x03\x00\x31\x43" + bytes([m])
    # error correction level M
    out += GS + b"(k\x03\x00\x31\x45\x31"
    # store data
    n = len(d) + 3
    pL = n & 0xFF
    pH = (n >> 8) & 0xFF
    out += GS + b"(k" + bytes([pL, pH]) + b"\x31\x50\x30" + d
    # print
    out += GS + b"(k\x03\x00\x31\x51\x30"
    return bytes(out)


# ── QR payload binding + preview image ───────────────────────────────────────
# The QR ties a ticket to its exit. Entry encodes VAY|<ticketNo>|<plate>|IN;
# exit encodes VAY|<ticketNo>|<plate>|OUT. Scanning the entry QR at exit yields
# the ticket number, which resolves the open parking transaction.
def qr_payload(kind, data):
    explicit = data.get("qrData")
    if explicit:
        return explicit
    tno = data.get("ticketNo", "")
    veh = data.get("vehicleNo", "")
    tag = "OUT" if kind == "receipt" else "IN"
    return "VAY|%s|%s|%s" % (tno, veh, tag)


def qr_datauri(payload, box=4, border=2):
    """A scannable PNG data: URI for the browser preview (mirrors what the
    printer renders via GS ( k). Empty string if qrcode isn't available."""
    if not payload:
        return ""
    try:
        import io
        import base64
        import qrcode
        qr = qrcode.QRCode(box_size=box, border=border,
                           error_correction=qrcode.constants.ERROR_CORRECT_M)
        qr.add_data(payload)
        qr.make(fit=True)
        img = qr.make_image(fill_color="black", back_color="white")
        buf = io.BytesIO()
        img.save(buf, "PNG")
        return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()
    except Exception:
        return ""


# ── logo raster (ESC/POS GS v 0) ─────────────────────────────────────────────
# The VAY logo is converted to a 1-bit centered raster once per (path,width)
# and cached. Uses OpenCV (already a project dependency); if it isn't importable
# the logo is silently skipped so text-only printing still works.
_LOGO_CACHE = {}


def _logo_path(cfg):
    p = (cfg.get("printer_logo_path") or "").strip()
    if p and os.path.exists(p):
        return p
    return os.path.join(os.path.dirname(os.path.abspath(__file__)),
                        "static", "assets", "vay-logo.jpeg")


def logo_raster(cfg):
    if not _bool(cfg.get("printer_logo")):
        return b""
    path = _logo_path(cfg)
    printable = 384 if str(cfg.get("printer_width", "80")).strip() == "58" else 576
    key = (path, printable)
    if key in _LOGO_CACHE:
        return _LOGO_CACHE[key]
    raster = b""
    try:
        import cv2
        import numpy as np
        img = cv2.imread(path, cv2.IMREAD_GRAYSCALE)
        if img is not None:
            target_w = int(printable * 0.7) // 8 * 8  # keep byte-aligned
            h, w = img.shape[:2]
            new_w = max(8, target_w)
            new_h = max(1, int(h * (new_w / float(w))))
            if new_h > 240:                            # cap tall logos
                new_h = 240
                new_w = max(8, (int(w * (new_h / float(h))) // 8) * 8)
            img = cv2.resize(img, (new_w, new_h), interpolation=cv2.INTER_AREA)
            # dark pixels -> 1 (black/printed)
            _, bw = cv2.threshold(img, 0, 1, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
            left = (printable - new_w) // 2
            canvas = np.zeros((new_h, printable), dtype=np.uint8)
            canvas[:, left:left + new_w] = bw
            packed = np.packbits(canvas, axis=1).tobytes()  # MSB-first, 1=black
            width_bytes = printable // 8
            xL, xH = width_bytes & 0xFF, (width_bytes >> 8) & 0xFF
            yL, yH = new_h & 0xFF, (new_h >> 8) & 0xFF
            raster = GS + b"v0\x00" + bytes([xL, xH, yL, yH]) + packed + b"\n"
    except Exception:
        raster = b""
    _LOGO_CACHE[key] = raster
    return raster


# ── config helpers ───────────────────────────────────────────────────────────
DEFAULTS = {
    "printer_enabled": "0",
    "printer_conn": "lan",           # lan | usb
    "printer_host": "192.168.0.100",
    "printer_port": "9100",
    "printer_usb_name": "",          # Windows printer share/name for USB
    "printer_width": "80",           # 80 | 58 (mm)
    "printer_org": "VAY ACCESS CONTROL SYSTEMS",
    "printer_footer": "VAY Parking Management\nwww.vayaccess.com",
    "printer_qr": "1",
    "printer_logo": "1",             # print the VAY logo raster at the top
    "printer_logo_path": "",         # blank → static/assets/vay-logo.jpeg
    "printer_autocut": "1",
    "printer_lane": "ENTRY-01",
    "public_base_url": "",           # host the QR points at (LAN IP / public URL); blank = request host

    "printer_auto_ticket": "0",      # auto-print on entry (needs hardware on-site)
    "printer_auto_receipt": "0",     # auto-print on exit
}


def load_config(Setting):
    cfg = dict(DEFAULTS)
    for k in DEFAULTS:
        v = Setting.get(k, None)
        if v is not None:
            cfg[k] = v
    return cfg


def save_config(Setting, db, data):
    """Persist only known keys; returns the resulting config dict."""
    for k in DEFAULTS:
        if k in data and data[k] is not None:
            Setting.set(k, str(data[k]))
    db.session.commit()
    return load_config(Setting)


def _bool(v):
    return str(v).strip() in ("1", "true", "True", "yes", "on")


# ── document builders → (escpos_bytes, preview_text) ─────────────────────────
def build_ticket(cfg, data):
    cols = _chars_per_line(cfg.get("printer_width", "80"))
    org = cfg.get("printer_org", DEFAULTS["printer_org"])
    lane = data.get("lane") or cfg.get("printer_lane", "ENTRY-01")
    qr_data = qr_payload("ticket", data)

    rows = [
        _center(org, cols),
        _center("PARKING TICKET", cols),
        "",
        _lr("Ticket No", data.get("ticketNo", ""), cols),
        _lr("Date", data.get("date", ""), cols),
        _lr("Time", data.get("time", ""), cols),
        "",
        _lr("Vehicle", data.get("vehicleNo", ""), cols),
        _lr("Type", (data.get("vehicleType", "") or "").upper(), cols),
        _lr("Lane", lane, cols),
        "",
        _lr("Entry", data.get("entryTime", ""), cols),
        _line(cols),
        _center("Please retain this ticket", cols),
        _line(cols),
    ]
    preview = "\n".join(rows)
    if _bool(cfg.get("printer_qr")):
        preview += "\n\n" + _center("[ QR CODE ]", cols) + "\n" + _center("Scan at Exit", cols)
    footer = cfg.get("printer_footer", "")
    if footer:
        preview += "\n\n" + "\n".join(_center(l, cols) for l in footer.split("\n"))

    # ESC/POS
    b = bytearray()
    b += INIT
    b += ALIGN_C + logo_raster(cfg)
    b += ALIGN_C + BOLD_ON + DBL_ON + org.encode("ascii", "replace") + b"\n" + DBL_OFF
    b += b"PARKING TICKET\n" + BOLD_OFF + b"\n"
    b += ALIGN_L
    for r in rows[3:]:
        b += r.encode("ascii", "replace") + b"\n"
    if _bool(cfg.get("printer_qr")):
        b += b"\n" + ALIGN_C + _qr(qr_data) + b"\n" + b"Scan at Exit\n"
    if footer:
        b += ALIGN_C + b"\n" + footer.encode("ascii", "replace") + b"\n"
    b += b"\n\n\n"
    if _bool(cfg.get("printer_autocut")):
        b += CUT_PARTIAL
    return bytes(b), preview


def build_receipt(cfg, data):
    cols = _chars_per_line(cfg.get("printer_width", "80"))
    org = cfg.get("printer_org", DEFAULTS["printer_org"])
    qr_data = qr_payload("receipt", data)

    def money(v):
        try:
            return "₹%.2f" % float(v or 0)
        except (TypeError, ValueError):
            return str(v)

    rows = [
        _center(org, cols),
        _center("PARKING RECEIPT", cols),
        "",
        _lr("Ticket No", data.get("ticketNo", ""), cols),
        _lr("Vehicle", data.get("vehicleNo", ""), cols),
        "",
        _lr("Entry", data.get("entryTime", ""), cols),
        _lr("Exit", data.get("exitTime", ""), cols),
        _lr("Duration", data.get("duration", ""), cols),
        "",
        _lr("Parking Fee", money(data.get("fee", 0)), cols),
        _lr("Discount", money(data.get("discount", 0)), cols),
        _line(cols),
        _lr("TOTAL", money(data.get("total", 0)), cols),
        "",
        _lr("Payment", (data.get("payment", "") or "").upper(), cols),
        _line(cols),
    ]
    # ASCII-safe preview uses Rs for the rupee glyph
    preview = "\n".join(rows).replace("₹", "Rs ")
    if _bool(cfg.get("printer_qr")):
        preview += "\n\n" + _center("[ QR CODE ]", cols)
    preview += "\n\n" + _center("Thank You", cols) + "\n" + _center("Drive Safely", cols)

    b = bytearray()
    b += INIT
    b += ALIGN_C + logo_raster(cfg)
    b += ALIGN_C + BOLD_ON + DBL_ON + org.encode("ascii", "replace") + b"\n" + DBL_OFF
    b += b"PARKING RECEIPT\n" + BOLD_OFF + b"\n"
    b += ALIGN_L
    for r in rows[3:]:
        b += r.replace("₹", "Rs ").encode("ascii", "replace") + b"\n"
    if _bool(cfg.get("printer_qr")):
        b += b"\n" + ALIGN_C + _qr(qr_data) + b"\n"
    b += ALIGN_C + b"\nThank You\nDrive Safely\n\n\n"
    if _bool(cfg.get("printer_autocut")):
        b += CUT_PARTIAL
    return bytes(b), preview


def build_test(cfg):
    cols = _chars_per_line(cfg.get("printer_width", "80"))
    rows = [
        _center(cfg.get("printer_org", DEFAULTS["printer_org"]), cols),
        _center("PRINTER TEST", cols),
        _line(cols),
        _lr("Width", str(cfg.get("printer_width", "80")) + " mm (" + str(cols) + " cols)", cols),
        _lr("Transport", (cfg.get("printer_conn", "lan") or "").upper(), cols),
        _lr("Target", (cfg.get("printer_host", "") + ":" + str(cfg.get("printer_port", "")))
            if cfg.get("printer_conn") == "lan" else (cfg.get("printer_usb_name") or "USB"), cols),
        _line(cols),
        _center("If you can read this,", cols),
        _center("the printer is wired correctly.", cols),
    ]
    preview = "\n".join(rows)
    b = bytearray()
    b += INIT + ALIGN_C + logo_raster(cfg)
    for r in rows:
        b += r.encode("ascii", "replace") + b"\n"
    b += _qr("VAY-PRINTER-TEST") if _bool(cfg.get("printer_qr")) else b""
    b += b"\n\n\n"
    if _bool(cfg.get("printer_autocut")):
        b += CUT_PARTIAL
    return bytes(b), preview


# ── transport ────────────────────────────────────────────────────────────────
def _send_lan(host, port, payload, timeout=4.0):
    with socket.create_connection((host, int(port)), timeout=timeout) as s:
        s.sendall(payload)
    return True


def _send_usb(name, payload):
    try:
        import win32print
    except Exception:
        raise RuntimeError("USB printing needs pywin32 (win32print). "
                           "Install it, or use LAN.")
    if not name:
        name = win32print.GetDefaultPrinter()
    h = win32print.OpenPrinter(name)
    try:
        win32print.StartDocPrinter(h, 1, ("VAY Ticket", None, "RAW"))
        win32print.StartPagePrinter(h)
        win32print.WritePrinter(h, payload)
        win32print.EndPagePrinter(h)
        win32print.EndDocPrinter(h)
    finally:
        win32print.ClosePrinter(h)
    return True


def send(cfg, payload):
    """Send raw ESC/POS bytes over the configured transport.
    Returns {ok, message}."""
    if not _bool(cfg.get("printer_enabled")):
        return {"ok": False, "message": "Printer is disabled in settings."}
    conn = (cfg.get("printer_conn") or "lan").lower()
    try:
        if conn == "usb":
            _send_usb(cfg.get("printer_usb_name"), payload)
            return {"ok": True, "message": "Sent to USB printer."}
        _send_lan(cfg.get("printer_host"), cfg.get("printer_port"), payload)
        return {"ok": True, "message": "Sent to %s:%s." % (cfg.get("printer_host"), cfg.get("printer_port"))}
    except Exception as e:
        return {"ok": False, "message": str(e)}


def status(cfg):
    """Best-effort reachability check. LAN: try to open the socket.
    Returns {online, message, transport, target}."""
    conn = (cfg.get("printer_conn") or "lan").lower()
    enabled = _bool(cfg.get("printer_enabled"))
    if conn == "usb":
        try:
            import win32print  # noqa: F401
            return {"online": enabled, "transport": "USB",
                    "target": cfg.get("printer_usb_name") or "default",
                    "message": "USB ready" if enabled else "Disabled"}
        except Exception:
            return {"online": False, "transport": "USB", "target": "n/a",
                    "message": "USB needs pywin32 on this host"}
    host, port = cfg.get("printer_host"), cfg.get("printer_port")
    target = "%s:%s" % (host, port)
    if not host:
        return {"online": False, "transport": "LAN", "target": target, "message": "No host set"}
    try:
        with socket.create_connection((host, int(port)), timeout=1.5):
            pass
        return {"online": True, "transport": "LAN", "target": target,
                "message": "Reachable" + ("" if enabled else " (but disabled)")}
    except Exception as e:
        return {"online": False, "transport": "LAN", "target": target,
                "message": "Unreachable: %s" % e}
