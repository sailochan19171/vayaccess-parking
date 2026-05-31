import os
# CLOUD_MODE=1  → admin/reports/API only, no hardware threads, no ML libs.
#                 Use this when deploying to a PaaS (Render/Fly/Koyeb free tier)
#                 where there's no USB serial reader, no LAN gate reader, and
#                 no RTSP camera reachable — and no RAM for torch/yolo/easyocr.
# CLOUD_MODE=0  → full system: ANPR pipeline, USB reader, LAN gate reader, MJPEG.
#                 Use this on the PC physically at the parking site.
CLOUD_MODE = os.environ.get('CLOUD_MODE', '0') == '1'

if not CLOUD_MODE:
    # UDP transport for RTSP — phone-based RTSP servers deliver frames much more
    # reliably over UDP. Combined with nobuffer/low_delay we get fresh frames
    # with minimum buffering. Only relevant when the camera_loop will run.
    os.environ["OPENCV_FFMPEG_CAPTURE_OPTIONS"] = "rtsp_transport;udp|fflags;nobuffer|flags;low_delay|stimeout;5000000"

from flask import Flask, render_template, request, jsonify, Response, session, redirect, url_for
from functools import wraps
from database import (db, Whitelist, AccessLog, Tariff, ParkingTransaction,
                      Setting, AuditEvent, Blacklist, Visitor, Region, Yard,
                      Account, Role, DictionaryEntry, LCDScreen,
                      MenuPermission, RolePermission, migrate_schema)
from api_integration import clean_plate_number
from sqlalchemy import or_
import threading
import time
import queue
import json
import re

from datetime import datetime, timedelta

if not CLOUD_MODE:
    # Heavy hardware/ML deps — only imported on-site. Hosted free tiers have
    # neither the RAM (torch+ultralytics ≈ 1.2 GB) nor the connected hardware
    # (USB reader, RTSP camera), so importing these in CLOUD_MODE would just
    # crash the dyno on boot.
    from reader_integration import RFIDReader
    from desktop_reader import DesktopReader, list_available_ports
    import cv2
    import easyocr
    import numpy as np
    from ultralytics import YOLO
    import torch
    import concurrent.futures

    # Give PyTorch (YOLO) most cores; cap OpenCV at 2 threads so cv2 ops in the
    # camera loop don't oversubscribe and stall on per-call thread spawn overhead.
    _cpu_threads = max(2, (os.cpu_count() or 4) - 1)
    torch.set_num_threads(_cpu_threads)
    cv2.setNumThreads(2)
else:
    # Names that cloud-mode endpoints still touch (read-only) — kept None so a
    # stray reference fails loudly instead of silently dereferencing a stub.
    RFIDReader = DesktopReader = list_available_ports = None
    cv2 = easyocr = np = YOLO = torch = concurrent = None

app = Flask(__name__)
# Required to use Flask sessions for login. In production the real secret MUST
# be set via the SECRET_KEY environment variable (Render/Fly/Koyeb dashboard);
# the fallback is only here so local dev boots without configuration. Rotate
# this default before going to production — sessions can be forged otherwise.
app.secret_key = os.environ.get('SECRET_KEY', 'vayaccess-default-secret-CHANGE-ME-IN-PROD')

# DB connection. The real Neon URL is NEVER hardcoded here — this file is
# committed to a public GitHub repo. Set DATABASE_URL via:
#   • on-site PC: a local `.env` (gitignored, see .env.example)
#   • Render/Fly/Koyeb: the dashboard's Environment Variables panel
# Fallback if no env var is found: a local SQLite file (zero-config dev mode).
def _load_dotenv():
    """Minimal .env loader — no python-dotenv dependency.
    Reads KEY=VALUE lines from a .env file next to app.py."""
    env_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), '.env')
    if not os.path.exists(env_path):
        return
    try:
        with open(env_path, 'r', encoding='utf-8') as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith('#') or '=' not in line:
                    continue
                k, v = line.split('=', 1)
                k = k.strip()
                v = v.strip().strip('"').strip("'")
                # Existing env wins so cloud platforms can still override.
                os.environ.setdefault(k, v)
    except Exception as e:
        print(f"[ENV] failed to load .env: {e}")

_load_dotenv()
_db_uri = os.environ.get('DATABASE_URL', 'sqlite:///parking.db')
# Render/Heroku-style URLs come back as 'postgres://…' — SQLAlchemy needs psycopg2 prefix.
if _db_uri.startswith('postgres://'):
    _db_uri = _db_uri.replace('postgres://', 'postgresql+psycopg2://', 1)
app.config['SQLALCHEMY_DATABASE_URI'] = _db_uri
app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False
# Re-render templates from disk when they change — avoids needing a server
# restart every time index.html / activate.html is edited.
app.config['TEMPLATES_AUTO_RELOAD'] = True
app.jinja_env.auto_reload = True
db.init_app(app)

# ── Hardware ──────────────────────────────────────────────────────────────────
# In CLOUD_MODE these are placeholder objects with the same attribute surface
# the dashboard/devices endpoints poll — so /api/state and /api/devices keep
# responding without crashing, they just always report "Offline".
class _StubReader:
    status = 'Offline (cloud mode)'
    port = None; baudrate = None; active_protocol = None
    def start(self): pass
    def peek_latest_tag(self): return None
    def get_raw_dump(self, n=512): return ''
    def clear_latest_tag(self): pass

if CLOUD_MODE:
    rfid          = _StubReader()
    desktop_rfid  = _StubReader()
    reader = model = alpr = None
    USE_FAST_ALPR = False
    print("[CLOUD] CLOUD_MODE active — skipping hardware + ML init")
else:
    rfid   = RFIDReader(ip='192.168.0.200', port=200)
    # Desktop SRK-F206 reader for the /activate enrollment workflow. Auto-detects
    # a USB-serial COM port; UI also exposes /api/desktop_reader/* to configure it.
    desktop_rfid = DesktopReader(port=None, baudrate=115200)
    reader = easyocr.Reader(['en'], gpu=False)   # legacy fallback OCR
    model  = YOLO('yolov8n.pt')

    # FastALPR — plate-specific YOLO-v9 detector + MobileViT plate OCR (ONNX).
    # Models auto-download on first run (~80 MB cached under ~/.cache).
    # Falls back to EasyOCR (still loaded above) if import or init fails.
    try:
        from fast_alpr import ALPR
        alpr = ALPR(
            detector_model="yolo-v9-t-384-license-plate-end2end",
            ocr_model="global-plates-mobile-vit-v2-model",
            # 0.20 (was 0.30) — keeps angled/small/partially-occluded plates in play
            # so the OCR stage gets a chance instead of dropping them silently.
            detector_conf_thresh=0.20,
        )
        USE_FAST_ALPR = True
        print("[ALPR] FastALPR engine ready")
    except Exception as _alpr_init_err:
        alpr = None
        USE_FAST_ALPR = False
        print(f"[ALPR] FastALPR unavailable, falling back to EasyOCR: {_alpr_init_err}")

# ── Dashboard state ───────────────────────────────────────────────────────────
dashboard_state = {
    "latest_plate":    "Waiting...",
    "latest_tag":      "Waiting...",
    "latest_tag_time": "N/A",
    "status":          "Scanning",
    "owner":           "N/A",
    "department":      "",       # populated on whitelist match
    "contact_number":  "",       # populated on whitelist match
    "vehicle_type":    "N/A",
    "vehicle_category":"N/A",
    "reader_status":   "Disconnected",
    "plate_confidence": 0,
    "detection_stage":  "idle",
    # Set when a GRANTED scan finds the vehicle already inside (re-scan).
    # Cleared when status changes back to anything else.
    "already_inside_since": None,   # ISO-format entry timestamp
}

# ── Shared frame / detection state ────────────────────────────────────────────
latest_frame     = None          # BGR frame with boxes drawn (kept for /api/latest_frame.jpg)
latest_jpeg      = None          # Pre-encoded JPEG bytes — produced once per frame in
                                 # camera_loop so the MJPEG stream serves bytes directly
                                 # without per-request encoding (removes CPU contention).
latest_highres   = None          # Raw frame for high-quality OCR crop
frame_lock       = threading.Lock()
frame_id         = 0

# Detections written by worker_thread, read by camera_loop
detections_lock  = threading.Lock()
active_detections = []           # list of {box, label, conf, primary}

# Plate-overlay state — drawn by camera_loop around the detected number plate.
# Updated each cycle in worker_thread when EasyOCR returns a plate candidate.
plate_overlay_lock      = threading.Lock()
plate_overlay           = None   # dict: {"box":[x1,y1,x2,y2], "text":str, "prob":float,
                                 #        "committed":bool, "ts":float} in DISPLAY coords
PLATE_OVERLAY_TTL       = 2.0    # seconds — clear stale overlay if no new read

freeze_feed = False

# Motion-gating state. The camera loop computes a cheap inter-frame diff and
# bumps `last_motion_t` when something changes; worker_thread only fires when
# motion was recent OR a vehicle was recently confirmed. This keeps CPU free
# for the live stream during idle periods.
motion_lock          = threading.Lock()
last_motion_t        = 0.0       # set by camera_loop
last_vehicle_seen_t  = 0.0       # set by worker_thread when YOLO finds a vehicle
MOTION_ACTIVE_WINDOW = 5.0       # seconds — motion is considered "active" this long after last change
VEHICLE_HOLD_WINDOW  = 12.0      # seconds — keep processing this long after vehicle last seen
                                  # (long enough that a static "photo held to camera" keeps refreshing itself)

# Plate voting buffer: aggregate OCR reads across multiple frames before committing,
# so a single noisy frame can't lock in the wrong plate.
plate_vote_lock          = threading.Lock()
plate_votes              = {}    # cleaned_plate -> {"score", "count", "last_prob", "last_seen"}
PLATE_VOTE_TTL              = 6.0   # entries older than this (seconds) are pruned
# Aggressive commit thresholds — guarantees detection within ~10s of a vehicle
# (or vehicle photo) appearing. Trade-off: small chance of committing a wrong
# plate, mitigated by the 30s dedup cooldown and the DB whitelist check downstream.
PLATE_VOTE_COMMIT_SCORE     = 0.9   # aggregated score required to commit a plate (was 1.5)
PLATE_VOTE_COMMIT_COUNT     = 2     # same plate must appear at least N times
PLATE_FUZZY_DISTANCE        = 1     # treat reads within this Levenshtein distance as the same plate
PLATE_HIGH_CONF_SHORTCIRCUIT = 0.55 # commit a SINGLE read immediately if conf >= this (was 0.85)

# Plate dedup cooldown (ReolinkANPR pattern): once a plate is committed, don't
# re-commit the same plate (or a fuzzy-equivalent) for this many seconds. Keeps
# the dashboard from spamming the same car as it idles at the gate.
PLATE_DEDUP_COOLDOWN_S      = 30.0
last_committed_plates       = {}    # plate -> commit_timestamp
last_committed_lock         = threading.Lock()

# ── Saved-plate gallery (ReolinkANPR pattern) ────────────────────────────────
# On every committed plate, save the full vehicle crop + the plate-only crop
# to disk so the dashboard can show a thumbnail / history.
DETECTIONS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "detections")
os.makedirs(DETECTIONS_DIR, exist_ok=True)
recent_detections = []          # list of dicts kept in memory for the dashboard API
recent_detections_lock = threading.Lock()
RECENT_KEEP = 50                # keep last N detections in memory

def save_plate_artifacts(plate_text, crop_img, bbox_in_crop, confidence):
    """Save full vehicle crop + plate crop. Returns dict with relative paths."""
    ts = datetime.now().strftime("%Y%m%d_%H%M%S_%f")[:-3]
    safe = "".join(c for c in plate_text if c.isalnum()) or "PLATE"
    full_name = f"{ts}_{safe}_full.jpg"
    crop_name = f"{ts}_{safe}_crop.jpg"
    full_path = os.path.join(DETECTIONS_DIR, full_name)
    crop_path = os.path.join(DETECTIONS_DIR, crop_name)
    try:
        cv2.imwrite(full_path, crop_img, [cv2.IMWRITE_JPEG_QUALITY, 85])
        x1, y1, x2, y2 = bbox_in_crop
        x1 = max(0, x1); y1 = max(0, y1)
        x2 = min(crop_img.shape[1], x2); y2 = min(crop_img.shape[0], y2)
        if x2 > x1 and y2 > y1:
            cv2.imwrite(crop_path, crop_img[y1:y2, x1:x2], [cv2.IMWRITE_JPEG_QUALITY, 90])
        rec = {
            "plate":      plate_text,
            "confidence": round(float(confidence), 3),
            "timestamp":  datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            "full_image": full_name,
            "plate_crop": crop_name,
        }
        with recent_detections_lock:
            recent_detections.insert(0, rec)
            del recent_detections[RECENT_KEEP:]
        print(f"[SAVE] {full_name}  +  {crop_name}")
        return rec
    except Exception as ex:
        print(f"[SAVE] Failed to save plate artifacts: {ex}")
        return None

# ── Plate Region Detector (contour-based) ─────────────────────────────────────
def detect_plate_regions(vehicle_crop, max_regions=5):
    """Find rectangular plate-like regions in a vehicle crop using contour detection.
    Returns list of (x, y, w, h) tuples sorted by area descending."""
    h, w = vehicle_crop.shape[:2]
    if h < 20 or w < 40:
        return []

    # Convert to grayscale and enhance edges
    gray = cv2.cvtColor(vehicle_crop, cv2.COLOR_BGR2GRAY)
    
    # Apply CLAHE for contrast enhancement
    clahe = cv2.createCLAHE(clipLimit=3.0, tileGridSize=(8, 8))
    gray = clahe.apply(gray)
    
    # Bilateral filter to reduce noise while keeping edges
    gray = cv2.bilateralFilter(gray, 11, 17, 17)
    
    # Edge detection
    edges = cv2.Canny(gray, 30, 200)
    
    # Dilate edges to close gaps
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3))
    edges = cv2.dilate(edges, kernel, iterations=1)
    
    # Find contours
    contours, _ = cv2.findContours(edges, cv2.RETR_TREE, cv2.CHAIN_APPROX_SIMPLE)
    
    plate_candidates = []
    min_plate_area = h * w * 0.002   # Plate must be at least 0.2% of vehicle crop
    max_plate_area = h * w * 0.25    # Plate can't be more than 25% of vehicle crop
    
    for cnt in contours:
        area = cv2.contourArea(cnt)
        if area < min_plate_area or area > max_plate_area:
            continue
        
        # Approximate the contour to a polygon
        peri = cv2.arcLength(cnt, True)
        approx = cv2.approxPolyDP(cnt, 0.02 * peri, True)
        
        # Plates are roughly rectangular (4 vertices)
        if len(approx) >= 4 and len(approx) <= 8:
            x, y, bw, bh = cv2.boundingRect(approx)
            
            # Check aspect ratio: plates are wide (2:1 to 7:1)
            if bh > 0:
                aspect_ratio = bw / bh
                if 1.5 <= aspect_ratio <= 7.0:
                    # Plate should be in the bottom 80% of the vehicle
                    if y > h * 0.10:
                        # Add padding around the detected region
                        pad_x = int(bw * 0.08)
                        pad_y = int(bh * 0.15)
                        px1 = max(0, x - pad_x)
                        py1 = max(0, y - pad_y)
                        px2 = min(w, x + bw + pad_x)
                        py2 = min(h, y + bh + pad_y)
                        plate_candidates.append((px1, py1, px2 - px1, py2 - py1, area))
    
    # Also try adaptive threshold approach as a second method
    thresh = cv2.adaptiveThreshold(gray, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
                                    cv2.THRESH_BINARY_INV, 19, 9)
    kernel2 = cv2.getStructuringElement(cv2.MORPH_RECT, (5, 3))
    thresh = cv2.morphologyEx(thresh, cv2.MORPH_CLOSE, kernel2)
    
    contours2, _ = cv2.findContours(thresh, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    for cnt in contours2:
        area = cv2.contourArea(cnt)
        if area < min_plate_area or area > max_plate_area:
            continue
        x, y, bw, bh = cv2.boundingRect(cnt)
        if bh > 0:
            aspect_ratio = bw / bh
            if 1.5 <= aspect_ratio <= 7.0 and y > h * 0.10:
                pad_x = int(bw * 0.08)
                pad_y = int(bh * 0.15)
                px1 = max(0, x - pad_x)
                py1 = max(0, y - pad_y)
                px2 = min(w, x + bw + pad_x)
                py2 = min(h, y + bh + pad_y)
                # Avoid duplicates (overlapping with existing candidates)
                is_dup = False
                for (cx, cy, cw, ch, _) in plate_candidates:
                    overlap_x = max(0, min(px1 + (px2 - px1), cx + cw) - max(px1, cx))
                    overlap_y = max(0, min(py1 + (py2 - py1), cy + ch) - max(py1, cy))
                    overlap_area = overlap_x * overlap_y
                    if overlap_area > 0.5 * min(area, cw * ch):
                        is_dup = True
                        break
                if not is_dup:
                    plate_candidates.append((px1, py1, px2 - px1, py2 - py1, area))
    
    # Sort by area descending and return top N
    plate_candidates.sort(key=lambda c: c[4], reverse=True)
    return [(c[0], c[1], c[2], c[3]) for c in plate_candidates[:max_regions]]

# ── YOLO class map ────────────────────────────────────────────────────────────
CLASS_NAMES = {2: "Car", 3: "Motorcycle", 5: "Bus", 7: "Truck"}

# ── Camera Config system and Connection Helper ──────────────────────────────
CONFIG_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "camera_config.json")

def load_camera_config():
    if os.path.exists(CONFIG_PATH):
        try:
            with open(CONFIG_PATH, "r") as f:
                config = json.load(f)
                return config.get("camera_source", "rtsp://admin:@192.168.1.12:8557/stream2")
        except Exception as e:
            print(f"[CONFIG] Error reading config: {e}")
    return "rtsp://admin:@192.168.1.12:8557/stream2"

def save_camera_config(source):
    try:
        with open(CONFIG_PATH, "w") as f:
            json.dump({"camera_source": source}, f)
        print(f"[CONFIG] Camera config saved: {source}")
        return True
    except Exception as e:
        print(f"[CONFIG] Error saving config: {e}")
        return False

def open_capture_with_timeout(source, timeout=5.0):
    result = {"cap": None}
    def target():
        try:
            src = source
            if isinstance(source, str) and source.isdigit():
                src = int(source)
            
            cap = cv2.VideoCapture(src)
            if cap.isOpened():
                result["cap"] = cap
        except Exception as e:
            print(f"[CAM] Error opening capture source {source}: {e}")

    t = threading.Thread(target=target, daemon=True)
    t.start()
    t.join(timeout=timeout)
    if t.is_alive():
        print(f"[CAM] Connection timed out after {timeout} seconds for: {source}")
        return None
    return result["cap"]

# ─────────────────────────────────────────────────────────────────────────────
# 1. VideoStream: dedicated capture thread, always holds the LATEST frame
# ─────────────────────────────────────────────────────────────────────────────
class VideoStream:
    """Continuously reads from RTSP/webcam; keeps both a downscaled (fast for display)
    and a full-resolution (best for plate OCR) view of the freshest frame."""
    def __init__(self, rtsp_url):
        self.rtsp_url   = rtsp_url
        self.cap        = None
        self._q         = queue.Queue(maxsize=1)   # downscaled 720p — fed to display loop
        self._fullres   = None                     # full-res 3MP — read by OCR worker
        self._fullres_lock = threading.Lock()
        self.running    = True
        self.lock       = threading.Lock()
        self._t         = threading.Thread(target=self._update, daemon=True)
        self._t.start()

    def get_fullres(self):
        """Return the most recent full-resolution frame (or None)."""
        with self._fullres_lock:
            return self._fullres

    def change_source(self, new_source):
        with self.lock:
            print(f"[CAM] Changing source to: {new_source}")
            self.rtsp_url = new_source
            if self.cap:
                self.cap.release()
                self.cap = None

    def _update(self):
        while self.running:
            # ── Connect if needed ──────────────────────────────────────────
            with self.lock:
                cap_is_none = self.cap is None
                cap_is_closed = (self.cap is not None and not self.cap.isOpened())
            
            if cap_is_none or cap_is_closed:
                with self.lock:
                    url = self.rtsp_url
                
                is_rtsp = isinstance(url, str) and url.startswith("rtsp://")
                
                if is_rtsp:
                    print(f"[CAM] Connecting to RTSP: {url} …")
                    cap = open_capture_with_timeout(url, timeout=12.0)
                    with self.lock:
                        if cap and cap.isOpened():
                            cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
                            self.cap = cap
                            print("[CAM] RTSP connected successfully.")
                        else:
                            print("[CAM] RTSP connection failed — retrying in 5 s …")
                            self.cap = None
                            time.sleep(5)
                else:
                    print(f"[CAM] Connecting to Webcam/Source: {url} …")
                    cap = open_capture_with_timeout(url, timeout=5.0)
                    with self.lock:
                        if cap and cap.isOpened():
                            self.cap = cap
                            print(f"[CAM] Webcam/Source {url} connected successfully.")
                        else:
                            print(f"[CAM] Webcam/Source {url} failed. Retrying in 5 s …")
                            self.cap = None
                            time.sleep(5)
                continue

            with self.lock:
                cap_obj = self.cap
            
            if cap_obj is None:
                continue

            # Resilient read: a single failed read often means the camera buffer
            # momentarily emptied (wifi jitter on a phone-based RTSP source).
            # Retry a few times before tearing down the connection.
            ok, frame = cap_obj.read()
            if not ok:
                retry_ok = False
                for _ in range(3):
                    time.sleep(0.05)
                    ok2, frame2 = cap_obj.read()
                    if ok2:
                        frame    = frame2
                        retry_ok = True
                        break
                if not retry_ok:
                    print("[CAM] Frame read failed (3 retries) — reconnecting …")
                    with self.lock:
                        if self.cap:
                            self.cap.release()
                        self.cap = None
                    time.sleep(0.2)
                    continue

            # Publish the FULL-RESOLUTION frame for OCR — high-res = larger plate
            # pixels = far better FastALPR accuracy. Just an atomic reference swap,
            # no copying, so cap.read() isn't starved.
            with self._fullres_lock:
                self._fullres = frame

            # And a downscaled 720p copy for the display loop. The downscale is what
            # keeps the camera_loop / MJPEG encode lightweight and the stream smooth.
            display_frame = frame
            if display_frame.shape[1] > 1280:
                scale = 1280.0 / display_frame.shape[1]
                display_frame = cv2.resize(display_frame, None, fx=scale, fy=scale,
                                           interpolation=cv2.INTER_AREA)

            # Drop old display frame, push new one (non-blocking)
            if not self._q.empty():
                try:
                    self._q.get_nowait()
                except queue.Empty:
                    pass
            self._q.put(display_frame)

    def get_frame(self, timeout=0.05):
        try:
            return True, self._q.get(timeout=timeout)
        except queue.Empty:
            return False, None

    def release(self):
        self.running = False
        with self.lock:
            if self.cap:
                self.cap.release()


# ─────────────────────────────────────────────────────────────────────────────
# 2. Plate OCR helper + worker thread
#
# Replaces the previous yolo_thread → ocr_queue → ocr_thread pipeline. Queues
# between heavy stages caused back-pressure: when one stage stalled, the other
# accumulated stale work. Now a single worker_thread reads the latest captured
# frame directly and runs YOLO → OCR serially. No queues, no semaphores.
# ─────────────────────────────────────────────────────────────────────────────

_PLATE_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'

def _score_plate(plate, prob):
    """Score a candidate plate read (higher is better). 0 means reject."""
    if not plate:
        return 0
    # Discard low-probability OCR junk before any format-match bonus can rescue it.
    if prob < 0.15:
        return 0
    score = prob
    if re.match(r'^[A-Z]{2}\d{2}[A-Z]{2}\d{4}$', plate):
        score += 1.5
    elif re.match(r'^[A-Z]{2}\d{2}[A-Z]{1}\d{4}$', plate):
        score += 1.2
    elif re.match(r'^[A-Z]{2}\d{2}\d{4}$', plate):
        score += 1.0
    elif re.match(r'^[A-Z]{2}\d{1,2}[A-Z]{1,2}\d{4}$', plate):
        score += 0.9
    elif len(plate) >= 6 and plate[:2].isalpha() and plate[-4:].isdigit():
        score += 0.6
    elif len(plate) >= 4 and plate[-4:].isdigit():
        score += 0.3
    return score

def _levenshtein(a, b):
    """Iterative Levenshtein distance, O(len(a)*len(b)). Used so the voter
    treats reads like 'MH12AB1234' and 'MH12A81234' (one char swap) as the
    same underlying plate — FastALPR routinely mis-reads B<->8, O<->0, etc."""
    if a == b:
        return 0
    if len(a) < len(b):
        a, b = b, a
    if not b:
        return len(a)
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        curr = [i] + [0] * len(b)
        for j, cb in enumerate(b, 1):
            curr[j] = min(prev[j] + 1, curr[j-1] + 1, prev[j-1] + (ca != cb))
        prev = curr
    return prev[-1]


def _run_easy_ocr(image):
    try:
        return reader.readtext(
            image,
            decoder='greedy',
            workers=0,
            allowlist=_PLATE_CHARS,
            min_size=15,
        )
    except Exception as ex:
        print(f"[OCR Pass Error] {ex}")
        return []

def _ocr_with_fast_alpr(crop_img):
    """Run FastALPR on the vehicle crop. Returns list of
    (cleaned_plate, prob, bbox_in_crop) tuples — bbox is already in crop coords."""
    out = []
    try:
        results = alpr.predict(crop_img)
    except Exception as ex:
        print(f"[ALPR] error: {ex}")
        return out
    for r in results:
        if r.ocr is None:
            continue
        cleaned = clean_plate_number(r.ocr.text)
        # Indian plates are 9-10 chars (XX00X0000 / XX00XX0000). Anything <8 is
        # almost always FastALPR catching a partial plate region — those reads
        # are confident on their fragment but wrong, so we drop them outright
        # instead of letting them poison the voting buffer.
        if not cleaned or len(cleaned) < 8:
            continue
        # fast_plate_ocr 1.1.x returns per-character confidences as a list;
        # collapse to an overall plate confidence (mean of per-char probs).
        raw_conf = r.ocr.confidence
        if isinstance(raw_conf, (list, tuple)) and raw_conf:
            prob = float(sum(raw_conf) / len(raw_conf))
        else:
            prob = float(raw_conf)
        bb   = r.detection.bounding_box
        bbox = (int(bb.x1), int(bb.y1), int(bb.x2), int(bb.y2))
        out.append((cleaned, prob, bbox))
        print(f"[ALPR]   raw={r.ocr.text!r:>14}  prob={prob:.2f}  cleaned={cleaned!r}")
    return out


def process_vehicle_crop(crop_img, det_type, det_cat):
    """Run plate OCR on a vehicle crop and push candidates into the vote buffer.
    Uses FastALPR (plate-specific YOLO + CRNN) when available; falls back to
    EasyOCR for environments without it.
    Returns the best candidate's bbox in CROP_IMG coordinates (or None), so
    the caller can map it to display coords for the live-feed overlay."""
    best_bbox_in_crop = None
    best_cleaned_text = None
    best_prob         = 0.0
    best_committed    = False
    try:
        h, w = crop_img.shape[:2]
        if h < 20 or w < 40:
            return None

        dashboard_state["detection_stage"] = "reading"
        candidates = []     # list of (cleaned, prob, score, bbox_in_crop)

        if USE_FAST_ALPR:
            for cleaned, prob, bbox in _ocr_with_fast_alpr(crop_img):
                score = prob  # FastALPR's own confidence is meaningful on its own;
                              # no format-bonus hacks needed.
                if not any(c[0] == cleaned for c in candidates):
                    candidates.append((cleaned, prob, score, bbox))
        else:
            # Fallback: EasyOCR over upscaled+CLAHE'd crop (legacy path)
            target_w = 960 if w < 600 else max(640, w)
            scale    = target_w / w
            target_h = int(h * scale)
            prepped  = cv2.resize(crop_img, (target_w, target_h),
                                  interpolation=cv2.INTER_CUBIC)
            gray  = cv2.cvtColor(prepped, cv2.COLOR_BGR2GRAY)
            clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
            ocr_input = cv2.cvtColor(clahe.apply(gray), cv2.COLOR_GRAY2BGR)
            ocr_results = _run_easy_ocr(ocr_input)
            print(f"[OCR] {len(ocr_results)} text region(s) on {crop_img.shape[:2]} crop")
            for (poly, text, prob) in ocr_results:
                cleaned = clean_plate_number(text)
                print(f"[OCR]   raw={text!r:>14}  prob={prob:.2f}  cleaned={cleaned!r}")
                if not cleaned or len(cleaned) < 6:
                    continue
                score = _score_plate(cleaned, prob)
                if score <= 0:
                    continue
                xs = [p[0] / scale for p in poly]
                ys = [p[1] / scale for p in poly]
                bbox = (int(min(xs)), int(min(ys)), int(max(xs)), int(max(ys)))
                if not any(c[0] == cleaned for c in candidates):
                    candidates.append((cleaned, prob, score, bbox))

        if candidates:
            candidates.sort(key=lambda x: x[2], reverse=True)
            # The top-scoring read this frame is what we want to outline live on the feed.
            best_cleaned_text = candidates[0][0]
            best_prob         = candidates[0][1]
            best_bbox_in_crop = candidates[0][3]

            # Short-circuit: commit a single read immediately ONLY when it BOTH
            #   (a) clears the confidence threshold, AND
            #   (b) matches a real Indian plate format (XX00X0000 / XX00XX0000).
            # Without (b), high-confidence-but-garbage fragments like "K23962"
            # commit before the voter can converge on the real plate.
            is_indian_format = bool(
                re.match(r'^[A-Z]{2}\d{2}[A-Z]{1,2}\d{4}$', best_cleaned_text or "")
                or re.match(r'^[A-Z]{2}\d{2}\d{4}$',         best_cleaned_text or "")
            )
            shortcircuit = (best_prob >= PLATE_HIGH_CONF_SHORTCIRCUIT
                            and is_indian_format)

            now = time.time()
            with plate_vote_lock:
                cutoff = now - PLATE_VOTE_TTL
                for k in [k for k, v in plate_votes.items() if v["last_seen"] < cutoff]:
                    del plate_votes[k]
                for cand_plate, cand_prob, cand_score, _cand_bbox in candidates[:2]:
                    # Fuzzy-merge: if a similar plate (Levenshtein <= PLATE_FUZZY_DISTANCE)
                    # is already in the buffer, fold this read into THAT bucket.
                    # Stops "MH12AB1234" / "MH12A81234" from voting as separate plates.
                    merged_key = cand_plate
                    if cand_plate not in plate_votes:
                        for existing in plate_votes.keys():
                            if (abs(len(existing) - len(cand_plate)) <= PLATE_FUZZY_DISTANCE
                                    and _levenshtein(existing, cand_plate) <= PLATE_FUZZY_DISTANCE):
                                merged_key = existing
                                break
                    entry = plate_votes.setdefault(merged_key,
                                                    {"score": 0.0, "count": 0,
                                                     "last_prob": 0.0, "last_seen": 0.0})
                    entry["score"]     += cand_score
                    entry["count"]     += 1
                    entry["last_prob"]  = max(entry["last_prob"], cand_prob)
                    entry["last_seen"]  = now
                best_plate, best_entry = max(plate_votes.items(),
                                              key=lambda kv: kv[1]["score"])
                best_entry = dict(best_entry)

            # Decide whether to commit. Two paths:
            #   (A) Short-circuit: a single read came back at very high confidence.
            #   (B) Voting: this plate accumulated enough evidence across recent frames.
            if shortcircuit:
                commit_plate = best_cleaned_text
                commit_prob  = best_prob
                commit_reason = f"⚡ HIGH-CONF (prob={best_prob:.2f})"
            elif (best_entry["score"] >= PLATE_VOTE_COMMIT_SCORE
                    and best_entry["count"] >= PLATE_VOTE_COMMIT_COUNT):
                commit_plate = best_plate
                commit_prob  = best_entry["last_prob"]
                commit_reason = (f"✅ VOTED (agg_score={best_entry['score']:.2f},"
                                  f" votes={best_entry['count']})")
            else:
                commit_plate = None
                commit_reason = None

            if commit_plate is not None:
                # 30s dedup cooldown — don't re-commit the same plate (or fuzzy match)
                # if it just landed. Stops "MH12AB1234" from logging 8 times while a
                # car sits at the gate.
                now_dedup = time.time()
                with last_committed_lock:
                    # Prune stale entries first
                    for k in [k for k, t in last_committed_plates.items()
                              if (now_dedup - t) > PLATE_DEDUP_COOLDOWN_S]:
                        del last_committed_plates[k]
                    cooling = False
                    for existing, t in last_committed_plates.items():
                        if (existing == commit_plate
                                or (abs(len(existing) - len(commit_plate)) <= PLATE_FUZZY_DISTANCE
                                    and _levenshtein(existing, commit_plate) <= PLATE_FUZZY_DISTANCE)):
                            cooling = True
                            break
                if cooling:
                    print(f"[OCR] 🕒 Dedup: {commit_plate} already committed within "
                          f"{PLATE_DEDUP_COOLDOWN_S:.0f}s — skipping")
                else:
                    print(f"[OCR] {commit_reason}  →  committing  {commit_plate}")
                    with last_committed_lock:
                        last_committed_plates[commit_plate] = now_dedup
                    dashboard_state["latest_plate"]     = commit_plate
                    dashboard_state["plate_confidence"] = int(commit_prob * 100)
                    check_access(det_type, det_cat)
                    # Save full vehicle crop + plate-only crop to disk (ReolinkANPR pattern).
                    save_plate_artifacts(commit_plate, crop_img, best_bbox_in_crop,
                                          commit_prob)
                    best_committed    = True
                    best_cleaned_text = commit_plate
            else:
                print(f"[OCR] ⏳ Tracking: {best_plate} "
                      f"(agg_score={best_entry['score']:.2f}, votes={best_entry['count']}) "
                      f"— need score>={PLATE_VOTE_COMMIT_SCORE} count>={PLATE_VOTE_COMMIT_COUNT}"
                      f" OR single-read prob>={PLATE_HIGH_CONF_SHORTCIRCUIT}")
        else:
            print("[OCR] ❌ No plate candidates this frame.")
    except Exception as e:
        import traceback
        print(f"[OCR] Pipeline Error: {e}")
        traceback.print_exc()
    finally:
        dashboard_state["detection_stage"] = "idle"

    if best_bbox_in_crop is None:
        return None
    return {
        "bbox_in_crop": best_bbox_in_crop,
        "text":         best_cleaned_text,
        "prob":         best_prob,
        "committed":    best_committed,
    }


def _update_plate_overlay(ocr_result, crop_origin, highres_shape, display_shape):
    """Map the OCR'd plate bbox from crop_img → highres → display coords and
    publish it for camera_loop to draw. ocr_result may be None (no plate this frame)."""
    if ocr_result is None:
        return
    cx0, cy0       = crop_origin
    hh, hw         = highres_shape
    dh, dw         = display_shape
    bx1, by1, bx2, by2 = ocr_result["bbox_in_crop"]
    # crop → highres
    hx1 = cx0 + bx1; hy1 = cy0 + by1
    hx2 = cx0 + bx2; hy2 = cy0 + by2
    # highres → display
    sx = dw / hw; sy = dh / hh
    dx1 = max(0, min(dw - 1, int(hx1 * sx)))
    dy1 = max(0, min(dh - 1, int(hy1 * sy)))
    dx2 = max(0, min(dw - 1, int(hx2 * sx)))
    dy2 = max(0, min(dh - 1, int(hy2 * sy)))
    with plate_overlay_lock:
        global plate_overlay
        plate_overlay = {
            "box":       [dx1, dy1, dx2, dy2],
            "text":      ocr_result["text"],
            "prob":      ocr_result["prob"],
            "committed": ocr_result["committed"],
            "ts":        time.time(),
        }


def worker_thread():
    """Reads the latest captured frame, runs YOLO, then OCR (serially).
    Heavily throttled and motion-gated: it only fires when something is
    actually moving in the scene OR a vehicle was just seen. Between cycles
    it rests for ~0.5s so the camera loop has uncontested CPU to keep the
    live stream smooth.
    """
    global active_detections, last_vehicle_seen_t
    frame_count = 0
    last_full_band_ocr_t = 0.0
    last_processed_frame_id = -1
    last_debug_snapshot_t = 0.0
    YOLO_W, YOLO_H = 640, 360
    YOLO_CONF_THRESHOLD = 0.10   # lowered from 0.30 to catch low-confidence vehicles

    while True:
        # Motion gate: if nothing has moved recently AND no vehicle was seen
        # recently, skip YOLO+OCR entirely. This is what frees the camera loop
        # to keep the live feed smooth — without it, YOLO+FastALPR hold the GIL
        # ~300-800ms every 0.5s and the stream visibly stutters.
        now_gate = time.time()
        with motion_lock:
            motion_age  = now_gate - last_motion_t
            vehicle_age = now_gate - last_vehicle_seen_t
        if motion_age > MOTION_ACTIVE_WINDOW and vehicle_age > VEHICLE_HOLD_WINDOW:
            time.sleep(0.20)
            continue

        # Frame-id dedupe: don't re-process the same frame the camera just gave us.
        with frame_lock:
            curr_id       = frame_id
            highres_frame = latest_highres
        # NOTE: previously this preferred the FULL-RES (3MP) frame for OCR. That gave
        # marginally better plate-OCR accuracy but doubled the per-cycle GIL hold time
        # (cv2.resize on a 2304x1296 BGR frame alone is ~30-50ms, plus FastALPR runs
        # slower on larger crops). The display loop then couldn't update during each
        # worker cycle, which is what made the live feed lag behind the user's motion.
        # Trade-off accepted: use the same 720p frame the display uses — much smoother
        # live feed, modest plate-accuracy reduction (FastALPR still works fine on 720p
        # vehicle crops as long as the plate is reasonably close to the camera).
        if highres_frame is None or freeze_feed:
            time.sleep(0.10)
            continue
        if curr_id == last_processed_frame_id:
            time.sleep(0.05)
            continue
        last_processed_frame_id = curr_id

        frame_count += 1
        display_frame = cv2.resize(highres_frame, (YOLO_W, YOLO_H))

        # Debug snapshot: every 10s, dump exactly what's being fed to YOLO + a
        # raw-frame copy. Lets us SEE whether the camera frame actually contains a
        # vehicle, independent of whether YOLO scores it.
        now = time.time()
        if now - last_debug_snapshot_t > 10.0:
            last_debug_snapshot_t = now
            try:
                dbg_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                       "debug_snapshots")
                os.makedirs(dbg_dir, exist_ok=True)
                ts = datetime.now().strftime("%H%M%S")
                cv2.imwrite(os.path.join(dbg_dir, f"raw_{ts}.jpg"), highres_frame,
                            [cv2.IMWRITE_JPEG_QUALITY, 80])
                cv2.imwrite(os.path.join(dbg_dir, f"yolo_input_{ts}.jpg"), display_frame,
                            [cv2.IMWRITE_JPEG_QUALITY, 80])
                print(f"[DEBUG] wrote snapshot raw_{ts}.jpg + yolo_input_{ts}.jpg "
                      f"to {dbg_dir}")
            except Exception as ex:
                print(f"[DEBUG] snapshot save failed: {ex}")

        # Run YOLO with no class filter and very low conf so we see EVERYTHING.
        # We'll filter to vehicles + the YOLO_CONF_THRESHOLD below in Python so
        # we can also log the rejected detections for diagnosis.
        results = model(display_frame, verbose=False, imgsz=480, conf=0.05)

        new_dets    = []
        max_area    = 0
        primary_idx = -1
        raw_log     = []   # everything YOLO saw — for diagnostic output

        for r in results:
            cls_names = r.names      # full COCO class name table from the model
            for box in r.boxes:
                cls_id = int(box.cls[0].item())
                conf   = float(box.conf[0].item())
                cls_nm = cls_names.get(cls_id, str(cls_id)) if isinstance(cls_names, dict) else str(cls_id)
                raw_log.append(f"{cls_nm}:{conf:.2f}")
                # Keep only vehicle classes (car/moto/bus/truck) above our threshold
                if cls_id not in CLASS_NAMES:
                    continue
                if conf < YOLO_CONF_THRESHOLD:
                    continue
                x1, y1, x2, y2 = box.xyxy[0].int().tolist()
                area = (x2 - x1) * (y2 - y1)
                if area > max_area:
                    max_area    = area
                    primary_idx = len(new_dets)
                new_dets.append({
                    "box":     [x1, y1, x2, y2],
                    "label":   CLASS_NAMES.get(cls_id, "Vehicle"),
                    "conf":    conf,
                    "primary": False,
                })

        if primary_idx >= 0:
            new_dets[primary_idx]["primary"] = True
            with motion_lock:
                last_vehicle_seen_t = time.time()

        with detections_lock:
            active_detections = new_dets

        # Log raw YOLO output too — if the camera shows a car and this list is
        # empty, the problem is the frame contents, not the threshold.
        raw_summary = ", ".join(raw_log) if raw_log else "(nothing)"
        print(f"[YOLO] frame#{frame_count}: kept={len(new_dets)}  raw=[{raw_summary}]")

        if primary_idx >= 0:
            pv = new_dets[primary_idx]
            det_type, det_cat = map_vehicle_info(pv["label"])
            dashboard_state["vehicle_type"]     = det_type
            dashboard_state["vehicle_category"] = det_cat
            dashboard_state["detection_stage"]  = "vehicle_found"

            x1, y1, x2, y2 = pv["box"]
            dh, dw = display_frame.shape[:2]
            hh, hw = highres_frame.shape[:2]
            sx, sy = hw / dw, hh / dh

            hx1 = int(x1 * sx); hx2 = int(x2 * sx)
            hy1 = int(y1 * sy); hy2 = int(y2 * sy)
            pad_x = int((hx2 - hx1) * 0.15)
            pad_y = int((hy2 - hy1) * 0.15)
            hx1_pad = max(0,  hx1 - pad_x)
            hx2_pad = min(hw, hx2 + pad_x)
            hy1_pad = max(0,  hy1 - pad_y)
            hy2_pad = min(hh, hy2 + pad_y)

            vehicle_crop = highres_frame[hy1_pad:hy2_pad, hx1_pad:hx2_pad]
            if vehicle_crop.size > 0:
                ocr_result = process_vehicle_crop(vehicle_crop, det_type, det_cat)
                _update_plate_overlay(ocr_result,
                                      crop_origin=(hx1_pad, hy1_pad),
                                      highres_shape=highres_frame.shape[:2],
                                      display_shape=(YOLO_H, YOLO_W))
        else:
            # Fallback for when YOLO finds no vehicle: scan a middle-bottom band
            # (e.g. user shows a phone with just a plate photo, or YOLO misses
            # the vehicle on a held photo). Throttled to every 1.5s. No extra
            # motion check here — the worker itself is already motion-gated up
            # top, so we only get here when the scene is actually active.
            now_t = time.time()
            if now_t - last_full_band_ocr_t >= 1.5:
                last_full_band_ocr_t = now_t
                h, w = highres_frame.shape[:2]
                band_y0 = int(h * 0.20)
                full_band = highres_frame[band_y0: int(h * 0.95), :]
                if full_band.size > 0:
                    dashboard_state["detection_stage"] = "vehicle_found"
                    ocr_result = process_vehicle_crop(full_band, "Car", "Four-Wheeler")
                    _update_plate_overlay(ocr_result,
                                          crop_origin=(0, band_y0),
                                          highres_shape=highres_frame.shape[:2],
                                          display_shape=(YOLO_H, YOLO_W))

        # When the scene is active, run ~3 cycles/sec so a plate commits within
        # a couple of seconds. Camera-loop smoothness is preserved by the motion
        # gate at the top of this loop — when nothing's moving, we don't get here.
        time.sleep(0.30)


active_stream = None

# ─────────────────────────────────────────────────────────────────────────────
# 4. Camera loop: reads frames, composites boxes, writes latest_frame
#    NEVER blocks on YOLO or OCR — those run in background threads
# ─────────────────────────────────────────────────────────────────────────────
def camera_loop():
    global latest_frame, latest_jpeg, latest_highres, frame_id, active_stream
    global last_motion_t
    initial_source = load_camera_config()
    active_stream   = VideoStream(initial_source)

    # 640x360 display — matches the YOLO inference resolution in worker_thread,
    # so detection boxes line up with the drawn frame without any rescaling.
    DISPLAY_W, DISPLAY_H = 640, 360

    # Motion-detection state (tiny grayscale frame, very cheap)
    prev_motion_gray = None
    MOTION_PIX_THRESHOLD = 25      # per-pixel diff to count as changed
    MOTION_COUNT_THRESHOLD = 60    # need this many changed pixels to flag motion

    while True:
        ok, raw = active_stream.get_frame()
        if not ok:
            time.sleep(0.01)
            continue

        if freeze_feed:
            time.sleep(0.05)
            continue

        # ── Prepare display frame ──────────────────────────────────────────
        display = cv2.resize(raw, (DISPLAY_W, DISPLAY_H))
        highres = raw  # original frame — worker_thread reads this for OCR crops

        # ── Cheap motion detection (160x90 grayscale diff, ~sub-millisecond) ──
        # Gates the worker thread so YOLO/OCR don't burn CPU when the scene is idle.
        motion_gray = cv2.resize(cv2.cvtColor(raw, cv2.COLOR_BGR2GRAY), (160, 90))
        motion_gray = cv2.GaussianBlur(motion_gray, (5, 5), 0)
        if prev_motion_gray is not None:
            diff = cv2.absdiff(motion_gray, prev_motion_gray)
            changed = int(np.count_nonzero(diff > MOTION_PIX_THRESHOLD))
            if changed > MOTION_COUNT_THRESHOLD:
                with motion_lock:
                    last_motion_t = time.time()
        prev_motion_gray = motion_gray

        # worker_thread independently picks up `latest_highres` and runs YOLO+OCR
        # when motion or a recent vehicle is active.

        # ── Composite detections onto display frame ────────────────────────
        with detections_lock:
            dets = list(active_detections)

        out_frame = display.copy()
        for d in dets:
            x1, y1, x2, y2 = d["box"]
            label = d["label"]
            conf  = d["conf"]

            plate_text = None
            if d["primary"]:
                p = dashboard_state["latest_plate"]
                if p not in ("Waiting...", "No Plate Detected"):
                    plate_text = p

            if plate_text:
                st = dashboard_state.get("status", "")
                color = (0, 255, 0) if "GRANTED" in st else (0, 0, 255) if "DENIED" in st else (0, 200, 50)
            else:
                color = (0, 140, 255)   # Orange tracking color: vehicle found, scanning for plate

            # Beautiful HUD corner brackets
            length = min(30, int((x2 - x1) * 0.15))
            # Top-Left corner
            cv2.line(out_frame, (x1, y1), (x1 + length, y1), color, 3)
            cv2.line(out_frame, (x1, y1), (x1, y1 + length), color, 3)
            # Top-Right corner
            cv2.line(out_frame, (x2, y1), (x2 - length, y1), color, 3)
            cv2.line(out_frame, (x2, y1), (x2, y1 + length), color, 3)
            # Bottom-Left corner
            cv2.line(out_frame, (x1, y2), (x1 + length, y2), color, 3)
            cv2.line(out_frame, (x1, y2), (x1, y2 - length), color, 3)
            # Bottom-Right corner
            cv2.line(out_frame, (x2, y2), (x2 - length, y2), color, 3)
            cv2.line(out_frame, (x2, y2), (x2, y2 - length), color, 3)
            
            # Draw thin connection border
            cv2.rectangle(out_frame, (x1, y1), (x2, y2), color, 1, cv2.LINE_AA)

            text = f"{label} {conf*100:.0f}%"
            if plate_text:
                text += f" | {plate_text}"

            (tw, th), _ = cv2.getTextSize(text, cv2.FONT_HERSHEY_SIMPLEX, 0.55, 2)
            lx1, ly1 = x1, max(0, y1 - 24)
            cv2.rectangle(out_frame, (lx1, ly1), (lx1 + tw + 6, ly1 + 24), color, -1)
            cv2.putText(out_frame, text, (lx1 + 3, ly1 + 17),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.55, (0, 0, 0), 2, cv2.LINE_AA)

        # ── Draw the plate-specific box (ML-style: bbox + "TEXT  90%") ──
        with plate_overlay_lock:
            overlay = dict(plate_overlay) if plate_overlay else None
        if overlay is not None and (time.time() - overlay["ts"]) <= PLATE_OVERLAY_TTL:
            px1, py1, px2, py2 = overlay["box"]
            ocolor = (0, 255, 0) if overlay["committed"] else (0, 200, 255)  # green=committed, yellow=tracking
            cv2.rectangle(out_frame, (px1, py1), (px2, py2), ocolor, 2, cv2.LINE_AA)
            label = f"{overlay['text']}  {int(overlay['prob'] * 100)}%"
            (lw, lh), _ = cv2.getTextSize(label, cv2.FONT_HERSHEY_SIMPLEX, 0.55, 2)
            tx1 = px1
            ty1 = max(0, py1 - lh - 6)
            cv2.rectangle(out_frame, (tx1, ty1), (tx1 + lw + 8, ty1 + lh + 6), ocolor, -1)
            cv2.putText(out_frame, label, (tx1 + 4, ty1 + lh + 1),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.55, (0, 0, 0), 2, cv2.LINE_AA)

        # Overlay HUD scan header & status indicator
        cv2.putText(out_frame, "ANPR LIVE TRACKING", (15, 30),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 255), 2, cv2.LINE_AA)
        
        # Draw status dot
        is_scanning = dashboard_state.get("detection_stage") in ["vehicle_found", "reading"]
        dot_color = (0, 165, 255) if is_scanning else (0, 255, 0)
        cv2.circle(out_frame, (230, 23), 6, dot_color, -1)
        status_lbl = "SCANNING..." if is_scanning else "ACTIVE"
        cv2.putText(out_frame, status_lbl, (245, 30),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.5, dot_color, 1, cv2.LINE_AA)

        # Overlay tiny status chip: OCR active indicator
        if is_scanning:
            # Add a bottom progress overlay bar
            cv2.rectangle(out_frame, (0, DISPLAY_H - 6), (DISPLAY_W, DISPLAY_H), (0, 165, 255), -1)

        # Encode JPEG once here so the streaming endpoint just copies bytes.
        # Previously every browser request re-encoded the frame, contending with YOLO for CPU.
        ok_enc, buf = cv2.imencode('.jpg', out_frame, [cv2.IMWRITE_JPEG_QUALITY, 60])
        jpeg_bytes = buf.tobytes() if ok_enc else None

        with frame_lock:
            latest_frame   = out_frame
            latest_jpeg    = jpeg_bytes
            latest_highres = highres
            frame_id += 1

        time.sleep(0.066)   # ~15 FPS display loop (browser monitoring doesn't need 30 FPS;
                            # halving frame production also halves JPEG-encode load downstream)

# ─────────────────────────────────────────────────────────────────────────────
# gen_frames: MJPEG streaming generator
# ─────────────────────────────────────────────────────────────────────────────
def gen_frames():
    last_id = -1
    while True:
        with frame_lock:
            fid    = frame_id
            jpeg_b = latest_jpeg

        if jpeg_b is not None and fid != last_id:
            last_id = fid
            yield (b'--frame\r\nContent-Type: image/jpeg\r\n\r\n'
                   + jpeg_b + b'\r\n')
            time.sleep(0.066)   # cap at ~15 FPS to browser
        else:
            # No new frame yet — wait a tiny bit and try again
            time.sleep(0.01)

# ─────────────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────────────
def map_vehicle_info(yolo_label):
    if yolo_label == "Motorcycle":
        return "Bike", "Two-Wheeler"
    elif yolo_label in ("Car", "Truck", "Bus"):
        return yolo_label, "Four-Wheeler"
    return "Car", "Four-Wheeler"


last_logged_plate = None
last_logged_tag = None
last_logged_time = 0.0

def dump_to_csv(plate, tag, owner, vtype, category, status):
    csv_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "detections_dump.csv")
    file_exists = os.path.exists(csv_path)
    try:
        import csv
        with open(csv_path, mode="a", newline="", encoding="utf-8") as f:
            writer = csv.writer(f)
            if not file_exists:
                writer.writerow(["Timestamp", "Number Plate", "RFID Tag", "Owner Name", "Vehicle Type", "Vehicle Category", "Status"])
            writer.writerow([
                datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
                plate or "N/A",
                tag or "N/A",
                owner or "N/A",
                vtype or "N/A",
                category or "N/A",
                status
            ])
        print(f"[CSV] Dumped detection to {csv_path}")
    except Exception as e:
        print(f"[CSV] Error dumping to CSV: {e}")

def check_access(det_type=None, det_cat=None):
    global last_logged_plate, last_logged_tag, last_logged_time
    with app.app_context():
        tag   = dashboard_state["latest_tag"]
        plate = dashboard_state["latest_plate"]

        tag_c   = tag.strip().upper()   if (tag   and tag   != "Waiting...") else ""
        plate_c = clean_plate_number(plate) if (plate and plate != "Waiting...") else ""

        if not tag_c and not plate_c:
            return

        # ── Stage 0: BLACKLIST — denied regardless of whitelist ───────────
        blk = None
        if tag_c:
            blk = Blacklist.query.filter(
                db.func.upper(Blacklist.rfid_tag) == tag_c).first()
        if not blk and plate_c:
            blk = Blacklist.query.filter(
                db.func.upper(Blacklist.number_plate) == plate_c).first()
        if blk:
            dashboard_state["status"]           = "ACCESS DENIED (BLACKLISTED)"
            dashboard_state["owner"]            = "Blacklisted"
            dashboard_state["department"]       = blk.reason or "(no reason)"
            dashboard_state["contact_number"]   = ""
            dashboard_state["vehicle_type"]     = det_type or "N/A"
            dashboard_state["vehicle_category"] = det_cat  or "N/A"
            # Write a log row + audit (still 10s deduped further down)
            try:
                db.session.add(AccessLog(
                    number_plate=plate_c or None, rfid_tag=tag_c or None,
                    owner_name='Blacklisted', department=blk.reason or None,
                    status="ACCESS DENIED (BLACKLISTED)"))
                db.session.commit()
            except Exception as e:
                db.session.rollback()
                print(f"[BLACKLIST] log write failed: {e}")
            print(f"[BLACKLIST] denied scan: plate={plate_c} tag={tag_c} reason={blk.reason}")
            return

        # ── Stage 1: Time-window block (Setting 'entry_blocked_windows') ──
        # Format: 'HH:MM-HH:MM,HH:MM-HH:MM' (e.g. '22:00-23:59,00:00-05:00')
        # If current time falls in any window, all entries are denied.
        windows_setting = Setting.get('entry_blocked_windows', '') or ''
        if windows_setting.strip():
            from datetime import time as _time
            now_mins = datetime.now().hour * 60 + datetime.now().minute
            for win in [w.strip() for w in windows_setting.split(',') if w.strip()]:
                try:
                    a, b = win.split('-')
                    ah, am = [int(x) for x in a.split(':')]
                    bh, bm = [int(x) for x in b.split(':')]
                    start = ah*60 + am
                    end   = bh*60 + bm
                    in_window = (start <= now_mins <= end) if start <= end else (
                                  now_mins >= start or now_mins <= end)
                    if in_window:
                        dashboard_state["status"] = f"ACCESS DENIED (CLOSED HOURS {win})"
                        dashboard_state["owner"]            = "N/A"
                        dashboard_state["department"]       = ""
                        dashboard_state["contact_number"]   = ""
                        dashboard_state["vehicle_type"]     = det_type or "N/A"
                        dashboard_state["vehicle_category"] = det_cat  or "N/A"
                        print(f"[TIME-WINDOW] denied scan within {win} block")
                        return
                except Exception:
                    pass  # malformed window — ignore

        # ── Stage 2: Whitelist lookup (existing behaviour) ────────────────
        if tag_c and plate_c:
            q = Whitelist.query.filter(
                (db.func.upper(Whitelist.rfid_tag)     == tag_c) |
                (db.func.upper(Whitelist.number_plate) == plate_c)
            ).first()
        elif tag_c:
            q = Whitelist.query.filter(
                db.func.upper(Whitelist.rfid_tag) == tag_c).first()
        else:
            q = Whitelist.query.filter(
                db.func.upper(Whitelist.number_plate) == plate_c).first()

        # ── Stage 3: Visitor lookup (only if no whitelist match) ──────────
        if not q:
            visitor = None
            if tag_c:
                visitor = Visitor.query.filter(
                    db.func.upper(Visitor.rfid_tag) == tag_c).first()
            if not visitor and plate_c:
                visitor = Visitor.query.filter(
                    db.func.upper(Visitor.number_plate) == plate_c).first()
            if visitor and visitor.is_valid():
                dashboard_state["status"]           = "ACCESS GRANTED (VISITOR)"
                dashboard_state["owner"]            = visitor.name
                dashboard_state["department"]       = visitor.purpose or "Visitor"
                dashboard_state["contact_number"]   = visitor.contact or ""
                dashboard_state["vehicle_type"]     = "Car"
                dashboard_state["vehicle_category"] = "Four-Wheeler"
                print(f"[VISITOR] grant {visitor.name} plate={plate_c} until {visitor.end_at}")
                # Fall through to logging + auto-entry below
                q = type('VisitorShim', (), {
                    'is_valid':       lambda s: True,
                    'owner_name':     visitor.name,
                    'department':     visitor.purpose or 'Visitor',
                    'contact_number': visitor.contact,
                    'vehicle_type':   'Car',
                    'vehicle_category': 'Four-Wheeler',
                    'number_plate':   visitor.number_plate,
                    'rfid_tag':       visitor.rfid_tag,
                })()

        if q:
            if q.is_valid():
                dashboard_state["status"]           = "ACCESS GRANTED"
                dashboard_state["owner"]            = q.owner_name
                dashboard_state["department"]       = q.department     or ""
                dashboard_state["contact_number"]   = q.contact_number or ""
                dashboard_state["vehicle_type"]     = q.vehicle_type or "Car"
                dashboard_state["vehicle_category"] = q.vehicle_category
            else:
                dashboard_state["status"]           = "ACCESS DENIED (EXPIRED)"
                dashboard_state["owner"]            = q.owner_name
                dashboard_state["department"]       = q.department     or ""
                dashboard_state["contact_number"]   = q.contact_number or ""
                dashboard_state["vehicle_type"]     = q.vehicle_type or "Car"
                dashboard_state["vehicle_category"] = q.vehicle_category
        else:
            dashboard_state["status"]           = "ACCESS DENIED (UNKNOWN)"
            dashboard_state["owner"]            = "N/A"
            dashboard_state["department"]       = ""
            dashboard_state["contact_number"]   = ""
            dashboard_state["vehicle_type"]     = det_type or "N/A"
            dashboard_state["vehicle_category"] = det_cat  or "N/A"

        # Log & Dump logic with 10s cooldown
        now = time.time()
        is_duplicate = False
        if plate_c and plate_c == last_logged_plate and (now - last_logged_time < 10):
            is_duplicate = True
        if tag_c and tag_c == last_logged_tag and (now - last_logged_time < 10):
            is_duplicate = True

        if not is_duplicate:
            # 1. Save to Database AccessLog table
            try:
                log_entry = AccessLog(
                    number_plate=plate_c or None,
                    rfid_tag=tag_c or None,
                    owner_name=dashboard_state["owner"] if dashboard_state["owner"] != "N/A" else None,
                    department=dashboard_state.get("department") or None,
                    contact_number=dashboard_state.get("contact_number") or None,
                    vehicle_type=dashboard_state["vehicle_type"] if dashboard_state["vehicle_type"] != "N/A" else None,
                    vehicle_category=dashboard_state["vehicle_category"] if dashboard_state["vehicle_category"] != "N/A" else None,
                    status=dashboard_state["status"]
                )
                db.session.add(log_entry)
                db.session.commit()
                print(f"[DB] Saved access log: {dashboard_state['status']} for Plate: {plate_c or 'N/A'}, Tag: {tag_c or 'N/A'}")
            except Exception as e:
                db.session.rollback()
                print(f"[DB] Error saving access log: {e}")

            # 1b. AUTO-CREATE a ParkingTransaction on ACCESS GRANTED so the
            # whitelisted vehicle's entry/exit/duration shows in Reports
            # without the operator having to manually click Entry. Exit
            # is still operator-driven via the Exit tab.
            #
            # If the same vehicle is ALREADY inside (re-scan attempt), we do
            # NOT create a duplicate transaction — we surface this via a
            # distinct "ACCESS GRANTED (ALREADY INSIDE)" status + expose the
            # original entry time so the Dashboard can alert the operator
            # and Reports keeps showing one entry, not many.
            if q and q.is_valid():
                try:
                    veh_plate = (q.number_plate or '').upper() if q.number_plate else ''
                    veh_tag   = (tag_c or '').upper()
                    already_inside_q = ParkingTransaction.query.filter(
                        ParkingTransaction.exit_at.is_(None))
                    conds = []
                    if veh_plate:
                        conds.append(db.func.upper(ParkingTransaction.vehicle)  == veh_plate)
                    if veh_tag:
                        conds.append(db.func.upper(ParkingTransaction.identity) == veh_tag)
                    if conds:
                        already_inside = already_inside_q.filter(or_(*conds)).first()
                    else:
                        already_inside = None
                    if already_inside:
                        # Vehicle is currently parked → any re-scan from ANPR or
                        # RFID closes the session. The upstream dedup layers
                        # (10s in check_access, 30s in ANPR plate commit) mean
                        # the gap between scans is naturally >= 10s, so we
                        # don't need a minimum-stay guard.
                        now_ts  = datetime.now()
                        elapsed = max(1, int((now_ts - already_inside.entry_at).total_seconds()))
                        mins    = max(1, elapsed // 60)
                        already_inside.exit_at        = now_ts
                        already_inside.payment_method = None
                        already_inside.total_amount   = 0
                        already_inside.lost_ticket    = False
                        db.session.commit()
                        dashboard_state["status"]              = "ACCESS GRANTED (AUTO-EXITED)"
                        dashboard_state["already_inside_since"] = None
                        AuditEvent.log(
                            f"Auto-exit: {q.owner_name} ({veh_plate or veh_tag[-8:]}) "
                            f"after {mins}m via {already_inside.mode} re-scan",
                            area='Exit')
                        print(f"[EXIT] auto-closed tx #{already_inside.id} for "
                              f"{q.owner_name} ({mins}m stay) via re-scan")
                    else:
                        # Zone for auto-entries comes from the configurable
                        # 'default_entry_zone' setting (Devices tab). Falls
                        # back to "Auto Gate" if not set.
                        auto_zone = Setting.get('default_entry_zone', 'Auto Gate')
                        tx = ParkingTransaction(
                            vehicle      = veh_plate or f"TAG-{veh_tag[-8:]}",
                            vehicle_type = q.vehicle_type or "Car",
                            mode         = "RFID/UHF" if veh_tag else "ANPR",
                            identity     = veh_tag or None,
                            zone         = auto_zone,
                            owner_name   = q.owner_name,
                            is_vip       = False,
                            is_staff     = False,
                        )
                        db.session.add(tx)
                        db.session.commit()
                        dashboard_state["already_inside_since"] = None
                        AuditEvent.log(
                            f"Auto-entry: {q.owner_name} ({veh_plate or veh_tag[-8:]}) via {tx.mode}",
                            area='Entry')
                        print(f"[ENTRY] auto-created tx #{tx.id} for {q.owner_name}")
                except Exception as e:
                    db.session.rollback()
                    print(f"[ENTRY] auto-entry failed: {e}")
            else:
                # Not granted → not inside (clear stale state)
                dashboard_state["already_inside_since"] = None

            # 2. Dump to CSV file
            dump_to_csv(
                plate_c,
                tag_c,
                dashboard_state["owner"] if dashboard_state["owner"] != "N/A" else None,
                dashboard_state["vehicle_type"] if dashboard_state["vehicle_type"] != "N/A" else None,
                dashboard_state["vehicle_category"] if dashboard_state["vehicle_category"] != "N/A" else None,
                dashboard_state["status"]
            )

            # Update cache
            last_logged_plate = plate_c
            last_logged_tag = tag_c
            last_logged_time = now


def rfid_monitor():
    while True:
        dashboard_state["reader_status"] = rfid.status
        tag = rfid.get_latest_tag()
        if tag:
            dashboard_state["latest_tag"]      = tag
            dashboard_state["latest_tag_time"] = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
            check_access()
        time.sleep(0.5)


# ─────────────────────────────────────────────────────────────────────────────
# Static image test (pauses live feed, processes a still)
# ─────────────────────────────────────────────────────────────────────────────
def process_static_frame(frame):
    global latest_frame, active_detections
    resized = cv2.resize(frame, (800, 450))
    results = model(resized, classes=[2, 3, 5, 7], verbose=False, imgsz=640)

    new_dets  = []
    plate_txt = None
    max_area  = 0
    pv        = None

    for r in results:
        for box in r.boxes:
            cls_id = int(box.cls[0].item())
            conf   = float(box.conf[0].item())
            if conf < 0.25:
                continue
            x1, y1, x2, y2 = box.xyxy[0].int().tolist()
            area = (x2 - x1) * (y2 - y1)
            if area > max_area:
                max_area = area
                pv = {"class": CLASS_NAMES.get(cls_id, "Vehicle"),
                      "box": [x1, y1, x2, y2]}

            hh, hw = frame.shape[:2]
            sx, sy = hw / 800, hh / 450
            crop = frame[int(y1*sy):int(y2*sy), int(x1*sx):int(x2*sx)]
            detected_plate = None
            if crop.size > 0:
                ch = crop.shape[0]
                zone = crop[ch // 2:, :]
                if zone.size > 0:
                    target_w = max(400, zone.shape[1])
                    scale = target_w / zone.shape[1]
                    zone = cv2.resize(zone, (target_w, int(zone.shape[0]*scale)),
                                      interpolation=cv2.INTER_CUBIC)
                    gray = cv2.cvtColor(zone, cv2.COLOR_BGR2GRAY)
                    gray = cv2.createCLAHE(clipLimit=3.0, tileGridSize=(8,8)).apply(gray)
                    gray = cv2.bilateralFilter(gray, 9, 75, 75)
                    proc = cv2.cvtColor(gray, cv2.COLOR_GRAY2BGR)
                    for (_, text, prob) in reader.readtext(proc, decoder='greedy', workers=0):
                        cleaned = clean_plate_number(text)
                        if cleaned and prob >= 0.20:
                            detected_plate = cleaned
                            plate_txt = cleaned
                            break

            new_dets.append({"box": [x1,y1,x2,y2],
                              "label": CLASS_NAMES.get(cls_id, "Vehicle"),
                              "conf": conf, "plate": detected_plate})

    # Fallback: full-frame OCR if no vehicle crop gave a plate
    if not plate_txt:
        h, w = resized.shape[:2]
        band = resized[int(h*0.25):, int(w*0.05):int(w*0.95)]
        for (_, text, prob) in reader.readtext(band, decoder='greedy', workers=0):
            cleaned = clean_plate_number(text)
            if cleaned and prob >= 0.20:
                plate_txt = cleaned
                break

    # Draw
    for d in new_dets:
        x1, y1, x2, y2 = d["box"]
        color = (0, 255, 0) if d["plate"] else (0, 140, 255)
        cv2.rectangle(resized, (x1,y1), (x2,y2), color, 2)
        txt = f"{d['label']} {d['conf']*100:.0f}%"
        if d["plate"]:
            txt += f" | {d['plate']}"
        (tw, th), _ = cv2.getTextSize(txt, cv2.FONT_HERSHEY_SIMPLEX, 0.55, 2)
        cv2.rectangle(resized, (x1, max(0,y1-24)), (x1+tw+6, y1), color, -1)
        cv2.putText(resized, txt, (x1+3, max(17,y1-7)),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.55, (0,0,0), 2, cv2.LINE_AA)

    with detections_lock:
        active_detections = new_dets

    det_type, det_cat = ("Car", "Four-Wheeler")
    if pv:
        det_type, det_cat = map_vehicle_info(pv["class"])

    if plate_txt:
        dashboard_state["latest_plate"] = plate_txt
        check_access(det_type, det_cat)
    else:
        dashboard_state["latest_plate"] = "No Plate Detected"
        dashboard_state["vehicle_type"]     = det_type
        dashboard_state["vehicle_category"] = det_cat

    with frame_lock:
        global latest_frame, frame_id
        latest_frame = resized
        frame_id += 1


# ─────────────────────────────────────────────────────────────────────────────
# Auth: session + RBAC decorators
# ─────────────────────────────────────────────────────────────────────────────
# Two decorators wrap protected routes:
#   • login_required  — any logged-in account
#   • admin_required  — login + role == 'Administrator' (case-insensitive)
# For /api/* routes a missing session returns JSON 401 so the frontend can
# react cleanly. For HTML routes it redirects to /login.
def _is_api(path):
    return path.startswith('/api/')

def login_required(fn):
    @wraps(fn)
    def _wrapped(*args, **kwargs):
        if not session.get('user_id'):
            if _is_api(request.path):
                return jsonify({"error": "login_required"}), 401
            return redirect(url_for('login_page'))
        return fn(*args, **kwargs)
    return _wrapped

def admin_required(fn):
    @wraps(fn)
    def _wrapped(*args, **kwargs):
        if not session.get('user_id'):
            if _is_api(request.path):
                return jsonify({"error": "login_required"}), 401
            return redirect(url_for('login_page'))
        role = (session.get('user_role') or '').strip().lower()
        if role != 'administrator':
            if _is_api(request.path):
                return jsonify({"error": "admin_required",
                                "message": "Administrator role required"}), 403
            return redirect(url_for('login_page'))
        return fn(*args, **kwargs)
    return _wrapped


# ─────────────────────────────────────────────────────────────────────────────
# Flask Routes
# ─────────────────────────────────────────────────────────────────────────────
@app.route('/')
def index():
    return render_template('index.html')


# ── Login page + session API ────────────────────────────────────────────────
@app.route('/login')
def login_page():
    return render_template('login.html')

@app.route('/api/login', methods=['POST'])
def api_login():
    d = request.json or {}
    username = (d.get('username') or '').strip()
    password = d.get('password') or ''
    if not username or not password:
        return jsonify({"error": "Username and password are required"}), 400
    user = Account.query.filter(db.func.lower(Account.name) == username.lower()).first()
    if not user or not user.check_password(password):
        return jsonify({"error": "Invalid credentials"}), 401
    session['user_id']   = user.id
    session['user_name'] = user.name
    session['user_role'] = user.role or ''
    AuditEvent.log(f"Login: {user.name}", area='Auth')
    return jsonify({"ok": True, "user": {
        "id": user.id, "name": user.name, "role": user.role or "",
    }})

@app.route('/api/logout', methods=['POST'])
def api_logout():
    name = session.get('user_name')
    session.clear()
    if name:
        AuditEvent.log(f"Logout: {name}", area='Auth')
    return jsonify({"ok": True})

@app.route('/api/me')
def api_me():
    if not session.get('user_id'):
        return jsonify({"logged_in": False})
    return jsonify({
        "logged_in": True,
        "id":   session.get('user_id'),
        "name": session.get('user_name'),
        "role": session.get('user_role') or '',
    })

# 1×1 transparent PNG — used in CLOUD_MODE where there is no camera frame.
# The HTML <img id="anpr-stream"> stays valid (no broken-image icon) and the
# JS doesn't have to special-case the cloud build.
_CLOUD_PIXEL_PNG = (b'\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00'
                    b'\x00\x00\x01\x08\x06\x00\x00\x00\x1f\x15\xc4\x89\x00\x00'
                    b'\x00\rIDATx\x9cc\xfc\xcf\xc0P\x0f\x00\x05\x01\x01\x00'
                    b'\xa5\xf6E\x84\x00\x00\x00\x00IEND\xaeB`\x82')

@app.route('/video_feed')
def video_feed():
    if CLOUD_MODE:
        return Response(_CLOUD_PIXEL_PNG, mimetype='image/png')
    return Response(gen_frames(),
                    mimetype='multipart/x-mixed-replace; boundary=frame')

@app.route('/api/latest_frame.jpg')
def get_latest_frame():
    if CLOUD_MODE:
        return Response(_CLOUD_PIXEL_PNG, mimetype='image/png')
    with frame_lock:
        jpeg_b = latest_jpeg
    if jpeg_b is not None:
        return Response(jpeg_b, mimetype='image/jpeg')
    blank = np.zeros((450, 800, 3), np.uint8)
    cv2.putText(blank, "Connecting...", (240, 225),
                cv2.FONT_HERSHEY_SIMPLEX, 1, (0,200,255), 2)
    _, buf = cv2.imencode('.jpg', blank)
    return Response(buf.tobytes(), mimetype='image/jpeg')

@app.route('/api/state')
def get_state():
    return jsonify(dashboard_state)

@app.route('/api/whitelist', methods=['GET', 'POST'])
@login_required
def handle_whitelist():
    if request.method == 'POST':
        data = request.json
        from dateutil.relativedelta import relativedelta
        months     = int(data.get('months', 1))
        valid_until = datetime.now() + relativedelta(months=+months)
        rfid_tag_c  = data.get('rfid_tag', '').strip().upper() or None
        plate_c     = clean_plate_number(data.get('number_plate', ''))
        owner_name  = data.get('owner_name', '')
        vtype       = data.get('vehicle_type', 'Car')

        if rfid_tag_c:
            for other in Whitelist.query.filter(
                (db.func.upper(Whitelist.rfid_tag) == rfid_tag_c) &
                (db.func.upper(Whitelist.number_plate) != plate_c.upper())
            ).all():
                other.rfid_tag = None

        existing = Whitelist.query.filter(
            db.func.upper(Whitelist.number_plate) == plate_c.upper()).first()
        if existing:
            existing.rfid_tag      = rfid_tag_c
            existing.owner_name    = owner_name
            existing.vehicle_type  = vtype
            existing.valid_until   = valid_until
        else:
            db.session.add(Whitelist(
                rfid_tag=rfid_tag_c, number_plate=plate_c,
                owner_name=owner_name, vehicle_type=vtype,
                valid_until=valid_until))
        try:
            db.session.commit()
            return jsonify({"status": "success"})
        except Exception as e:
            db.session.rollback()
            return jsonify({"status": "error", "message": str(e)}), 400

    return jsonify([e.to_dict() for e in Whitelist.query.all()])

@app.route('/api/logs', methods=['GET'])
def get_logs():
    """Recent access logs. Enriches each row with the current whitelist
    employee details (department, contact, owner_name, plate) by joining
    on rfid_tag / number_plate — so logs created before we started
    snapshotting these fields still display employee info in Reports."""
    try:
        try:
            limit = min(int(request.args.get('limit', 200)), 1000)
        except ValueError:
            limit = 200
        logs = AccessLog.query.order_by(AccessLog.timestamp.desc()).limit(limit).all()

        # Build single-pass lookup tables instead of N+1 queries
        wl_by_tag   = {}
        wl_by_plate = {}
        for w in Whitelist.query.all():
            if w.rfid_tag:
                wl_by_tag[w.rfid_tag.upper()] = w
            if w.number_plate:
                wl_by_plate[w.number_plate.upper()] = w

        out = []
        for log in logs:
            d = log.to_dict()
            # Lookup matching whitelist row (tag first, then plate)
            wl = None
            tag   = (log.rfid_tag     or '').strip().upper()
            plate = (log.number_plate or '').strip().upper()
            if tag and tag != 'N/A':
                wl = wl_by_tag.get(tag)
            if not wl and plate and plate != 'N/A':
                wl = wl_by_plate.get(plate)
            if wl:
                # Only fill empty fields — preserve snapshot if we had one
                if not d.get('department'):
                    d['department'] = wl.department or ''
                if not d.get('contact_number'):
                    d['contact_number'] = wl.contact_number or ''
                if d.get('owner_name') in ('N/A', '', None):
                    d['owner_name'] = wl.owner_name or 'N/A'
                if d.get('number_plate') in ('N/A', '', None):
                    d['number_plate'] = wl.number_plate or 'N/A'
                if d.get('vehicle_type') in ('N/A', '', None):
                    d['vehicle_type'] = wl.vehicle_type or 'N/A'
            out.append(d)
        return jsonify(out)
    except Exception as e:
        return jsonify({"status": "error", "message": str(e)}), 400

@app.route('/api/config', methods=['GET', 'POST'])
@admin_required
def handle_config():
    if request.method == 'POST':
        data = request.json
        source = data.get('camera_source', '').strip()
        if not source:
            return jsonify({"status": "error", "message": "Source cannot be empty"}), 400
        
        save_camera_config(source)
        if active_stream:
            active_stream.change_source(source)
        return jsonify({"status": "success", "camera_source": source})
    
    source = load_camera_config()
    return jsonify({"camera_source": source})

@app.route('/api/test_image', methods=['POST'])
@admin_required
def test_image():
    if CLOUD_MODE:
        return jsonify({"status": "error", "message": "Disabled in cloud mode (no ANPR pipeline)"}), 503
    global freeze_feed
    data = request.json
    path = data.get('path', '').strip().strip('\'"')
    if not path:
        return jsonify({"status": "error", "message": "No path provided"}), 400
    if not os.path.exists(path):
        return jsonify({"status": "error", "message": f"File not found: {path}"}), 400
    frame = cv2.imread(path)
    if frame is None:
        return jsonify({"status": "error", "message": "Could not read image file"}), 400
    freeze_feed = True
    process_static_frame(frame)
    return jsonify({"status": "success"})

@app.route('/api/resume_feed', methods=['POST'])
@admin_required
def resume_feed():
    global freeze_feed
    freeze_feed = False
    return jsonify({"status": "success"})

# ── Saved-plate gallery endpoints (ReolinkANPR pattern) ──────────────────────
@app.route('/api/recent_detections')
def api_recent_detections():
    """Return the most recent committed plates with image filenames."""
    with recent_detections_lock:
        return jsonify(list(recent_detections))

@app.route('/image/<path:filename>')
def serve_detection_image(filename):
    """Serve a saved plate-detection JPEG by filename (path-safe)."""
    from flask import send_from_directory, abort
    safe = os.path.basename(filename)
    if not safe.lower().endswith('.jpg'):
        abort(404)
    return send_from_directory(DETECTIONS_DIR, safe)

# ─────────────────────────────────────────────────────────────────────────────
# Employee Activation (desktop SRK-F206 + /activate page)
# ─────────────────────────────────────────────────────────────────────────────
@app.route('/activate')
def activate_page():
    return render_template('activate.html')

@app.route('/api/desktop_reader/status')
def api_desktop_reader_status():
    """Live status of the desktop SRK-F206 + most-recent unconsumed tag."""
    return jsonify({
        "status":           desktop_rfid.status,
        "port":             desktop_rfid.port,
        "baudrate":         desktop_rfid.baudrate,
        "active_protocol":  desktop_rfid.active_protocol,
        "latest_tag":       desktop_rfid.peek_latest_tag(),
    })

@app.route('/api/desktop_reader/raw_dump')
def api_desktop_reader_raw_dump():
    """Last 512 bytes received from the reader (hex). Use for protocol debugging
    when the parser isn't yielding tags — `curl http://localhost:5002/api/desktop_reader/raw_dump`
    after placing a tag on the reader and check whether anything is coming through."""
    return jsonify({"hex": desktop_rfid.get_raw_dump(512)})

@app.route('/api/desktop_reader/ports')
def api_desktop_reader_ports():
    if CLOUD_MODE:
        return jsonify([])
    return jsonify(list_available_ports())

@app.route('/api/desktop_reader/configure', methods=['POST'])
@admin_required
def api_desktop_reader_configure():
    if CLOUD_MODE:
        return jsonify({"status": "error", "message": "No COM ports in cloud mode"}), 503
    data = request.json or {}
    port = (data.get('port') or '').strip()
    baud = int(data.get('baudrate') or 115200)
    if not port:
        return jsonify({"status": "error", "message": "port required"}), 400
    desktop_rfid.configure(port, baud)
    return jsonify({"status": "ok", "port": port, "baudrate": baud})

@app.route('/api/desktop_reader/clear', methods=['POST'])
@admin_required
def api_desktop_reader_clear():
    desktop_rfid.clear_latest_tag()
    return jsonify({"status": "ok"})

@app.route('/api/employees', methods=['GET', 'POST'])
@login_required
def api_employees():
    """Employee enrollment endpoint. POST activates a tag with employee info;
    GET lists all activated employees (whitelist rows with department set)."""
    if request.method == 'POST':
        data = request.json or {}
        emp_name      = (data.get('employee_name') or '').strip()
        department    = (data.get('department') or '').strip()
        contact       = (data.get('contact_number') or '').strip()
        rfid_tag      = (data.get('rfid_tag') or '').strip().upper()
        plate_in      = (data.get('number_plate') or '').strip()
        vehicle_type  = (data.get('vehicle_type') or 'Car').strip()
        try:
            months = int(data.get('activation_months', 12))
        except (TypeError, ValueError):
            months = 12
        if months < 1 or months > 60:
            months = 12

        if not emp_name:
            return jsonify({"status": "error", "message": "Employee name is required"}), 400
        if not department:
            return jsonify({"status": "error", "message": "Department is required"}), 400
        if not contact:
            return jsonify({"status": "error", "message": "Contact number is required"}), 400
        if not rfid_tag:
            return jsonify({"status": "error", "message": "Scan a tag with the SRK-F206 first"}), 400
        if not plate_in:
            return jsonify({"status": "error", "message": "Vehicle plate is required"}), 400

        plate_c = clean_plate_number(plate_in)
        if not plate_c:
            return jsonify({"status": "error",
                            "message": "Vehicle plate format is invalid"}), 400

        # ── Payment gate (added 2026-05-27) ───────────────────────────────
        # Whitelist activation requires a recorded UPI payment. UHF tag check
        # above already guarantees a scanned tag is present. Payment fields
        # are validated client- and server-side so the row never lands in the
        # DB without them, and a third party can audit who paid what.
        payment_method = (data.get('payment_method') or '').strip()
        upi_id         = (data.get('upi_id') or '').strip()
        transaction_id = (data.get('transaction_id') or '').strip()
        try:
            payment_amount = int(data.get('payment_amount', 0) or 0)
        except (TypeError, ValueError):
            payment_amount = 0

        ALLOWED_METHODS = {'Cash', 'PhonePe', 'Paytm', 'Google Pay', 'BHIM',
                           'Amazon Pay', 'Other UPI'}
        # Methods that REQUIRE a UPI ID + provider transaction ID. Cash is
        # excluded — there is no digital reference to capture.
        UPI_METHODS = {'PhonePe', 'Paytm', 'Google Pay', 'BHIM',
                       'Amazon Pay', 'Other UPI'}
        # UPI VPA spec: <handle>@<provider>, handle 2-256 chars alphanumeric/._-,
        # provider 2-64 chars starting with a letter. e.g. 9876543210@ybl
        UPI_RE = re.compile(r'^[a-zA-Z0-9._\-]{2,256}@[a-zA-Z][a-zA-Z0-9.\-]{1,64}$')
        # Transaction ID: provider-issued reference. PhonePe T2..., Paytm digits,
        # GPay ABCD..., etc. — accept any 8-30 char alphanumeric.
        TXN_RE = re.compile(r'^[A-Za-z0-9]{8,30}$')

        if payment_method not in ALLOWED_METHODS:
            return jsonify({"status": "error",
                            "message": "Select a valid payment method "
                                       "(Cash / PhonePe / Paytm / Google Pay / "
                                       "BHIM / Amazon Pay / Other UPI)"}), 400
        if payment_amount <= 0:
            return jsonify({"status": "error",
                            "message": "Payment amount must be greater than 0"}), 400

        if payment_method in UPI_METHODS:
            # Digital payments must have a valid UPI VPA + a unique
            # provider-issued transaction reference. Both are saved so
            # finance can reconcile against the provider's statement.
            if not UPI_RE.match(upi_id):
                return jsonify({"status": "error",
                                "message": "UPI ID must look like 'name@provider' "
                                           "(e.g. 9876543210@ybl)"}), 400
            if not TXN_RE.match(transaction_id):
                return jsonify({"status": "error",
                                "message": "Transaction ID must be 8-30 "
                                           "alphanumeric characters"}), 400
        else:
            # Cash: no UPI handle, no provider transaction. Clear any value
            # the client may have sent so the DB stays clean.
            upi_id         = None
            transaction_id = None

        now = datetime.now()
        from dateutil.relativedelta import relativedelta
        valid_until = now + relativedelta(months=+months)

        # Upsert by tag (a re-scanned tag refreshes/extends the same employee).
        existing = Whitelist.query.filter(
            db.func.upper(Whitelist.rfid_tag) == rfid_tag).first()
        if existing:
            existing.owner_name        = emp_name
            existing.department        = department
            existing.contact_number    = contact
            existing.vehicle_type      = vehicle_type
            existing.activated_at      = now
            existing.activation_months = months
            existing.valid_until       = valid_until
            existing.payment_method    = payment_method
            existing.upi_id            = upi_id
            existing.transaction_id    = transaction_id
            existing.payment_amount    = payment_amount
            existing.paid_at           = now
            # only overwrite plate if a real one was provided this time
            if plate_in:
                existing.number_plate  = plate_c
            row = existing
            action = "renewed"
        else:
            # If the plate is in use by a different row, reject — uniqueness needed.
            plate_clash = Whitelist.query.filter(
                db.func.upper(Whitelist.number_plate) == plate_c.upper()).first()
            if plate_clash:
                return jsonify({"status": "error",
                                "message": f"Plate {plate_c} is already enrolled"}), 400
            # Block duplicate UPI transaction IDs: a single provider txn
            # reference can only enroll one employee. Catches accidental
            # re-use and basic fraud. Cash payments have transaction_id=NULL
            # so the check is skipped — many Cash rows can legitimately
            # share "no transaction id".
            if transaction_id:
                txn_clash = Whitelist.query.filter(
                    Whitelist.transaction_id == transaction_id).first()
                if txn_clash:
                    return jsonify({"status": "error",
                                    "message": f"Transaction ID {transaction_id} "
                                               f"already used for another enrollment"}), 400
            row = Whitelist(
                rfid_tag         = rfid_tag,
                number_plate     = plate_c,
                owner_name       = emp_name,
                department       = department,
                contact_number   = contact,
                vehicle_type     = vehicle_type,
                activated_at     = now,
                activation_months= months,
                valid_until      = valid_until,
                payment_method   = payment_method,
                upi_id           = upi_id,
                transaction_id   = transaction_id,
                payment_amount   = payment_amount,
                paid_at          = now,
            )
            db.session.add(row)
            action = "activated"

        try:
            db.session.commit()
            # Clear the buffered tag so the next scan starts clean.
            desktop_rfid.clear_latest_tag()
            print(f"[ACTIVATE] {action}: {emp_name} ({department}) tag={rfid_tag} "
                  f"plate={plate_c} valid_until={valid_until.date()}")
            return jsonify({"status": "success", "action": action,
                            "employee": row.to_dict()})
        except Exception as e:
            db.session.rollback()
            return jsonify({"status": "error", "message": str(e)}), 400

    # GET — list employees (rows with a department populated)
    rows = (Whitelist.query
            .filter(Whitelist.department.isnot(None))
            .order_by(Whitelist.activated_at.desc().nullslast())
            .all())
    return jsonify([r.to_dict() for r in rows])


@app.route('/api/employees/renew', methods=['POST'])
@login_required
def api_employee_renew():
    """Renew (extend validity) for an existing employee. Requires:
      - rfid_tag: the existing tag to renew
      - confirm_name: must match the saved owner_name (case-insensitive)
      - months: new activation period (1-60)
    Eligibility: renewal is only allowed when the existing record is
    within 1 day of expiry OR already past expiry. Earlier renewals are
    blocked so operators can't keep extending validity indefinitely."""
    from dateutil.relativedelta import relativedelta
    data = request.json or {}
    tag         = (data.get('rfid_tag')     or '').strip().upper()
    confirm     = (data.get('confirm_name') or '').strip()
    try:
        months  = int(data.get('months', 12))
    except (TypeError, ValueError):
        months  = 12
    if not (1 <= months <= 60):
        months = 12
    if not tag:
        return jsonify({"status": "error", "message": "Tag is required"}), 400
    if not confirm:
        return jsonify({"status": "error", "message": "Confirm the employee name to proceed"}), 400

    row = Whitelist.query.filter(db.func.upper(Whitelist.rfid_tag) == tag).first()
    if not row:
        return jsonify({"status": "error",
                        "message": f"No employee found for tag {tag}"}), 404

    # Name verification (case-insensitive, trimmed)
    if (row.owner_name or '').strip().lower() != confirm.lower():
        return jsonify({"status": "error",
                        "message": "Name does not match the saved employee. "
                                   "Renewal blocked."}), 403

    # Eligibility window: allow only if (valid_until - now) <= 1 day
    now = datetime.now()
    seconds_left = (row.valid_until - now).total_seconds() if row.valid_until else -1
    days_left    = seconds_left / 86400.0
    if days_left > 1:
        return jsonify({"status": "error",
                        "message": f"Renewal not yet allowed. {int(days_left)} day(s) "
                                   f"remain on the current validity — renewal opens "
                                   f"1 day before expiry."}), 400

    # Perform renewal: extend from NOW (not from the old valid_until, since
    # the user explicitly wants to renew here-and-now and we want a clean
    # window — typical for parking subscriptions).
    new_valid = now + relativedelta(months=+months)
    row.valid_until       = new_valid
    row.activated_at      = now
    row.activation_months = months
    try:
        db.session.commit()
        AuditEvent.log(
            f"Renewed: {row.owner_name} ({tag[-8:]}) — {months} months → valid until {new_valid.date()}",
            area='Admin')
        # Release the one-shot lock so the next employee tag can be scanned
        desktop_rfid.clear_latest_tag()
        print(f"[RENEW] {row.owner_name} extended {months}mo → {new_valid.date()}")
        return jsonify({"status": "success", "employee": row.to_dict()})
    except Exception as e:
        db.session.rollback()
        return jsonify({"status": "error", "message": str(e)}), 400


@app.route('/api/employees/by_tag/<tag>', methods=['GET'])
def api_employee_by_tag(tag):
    """Lookup a previously-activated employee by RFID tag. The activate page
    calls this the instant the SRK-F206 emits a tag so the form auto-fills
    with the saved details (renewal flow)."""
    tag = (tag or '').strip().upper()
    if not tag:
        return jsonify({"found": False}), 404
    row = Whitelist.query.filter(
        db.func.upper(Whitelist.rfid_tag) == tag).first()
    if not row:
        return jsonify({"found": False, "rfid_tag": tag}), 404
    return jsonify({"found": True, "employee": row.to_dict()})


# ─────────────────────────────────────────────────────────────────────────────
# VAY ParkOps: Tariffs / Entry / Exit / Transactions / Settings / Metrics / Audit
# ─────────────────────────────────────────────────────────────────────────────

DEFAULT_TARIFFS = [
    {"vehicle_type": "Car",  "model": "Hourly", "rate": 40, "daily_cap": 240, "lost_ticket": 300},
    {"vehicle_type": "Bike", "model": "Hourly", "rate": 20, "daily_cap": 120, "lost_ticket": 150},
]

def seed_defaults():
    """Insert default tariffs + base settings if the tables are empty.
    Also runs a one-shot UTC→local-time backfill for rows created before
    we switched datetime.utcnow → datetime.now."""
    if Tariff.query.count() == 0:
        for t in DEFAULT_TARIFFS:
            db.session.add(Tariff(**t))
        db.session.commit()
        print(f"[DB] seeded {len(DEFAULT_TARIFFS)} default tariffs")
    # One-shot purge of legacy Truck/EV/Bus tariff rows — system now only
    # supports Car + Bike. Guarded by a setting so it runs once.
    if Setting.get('purge_vehicle_types_v1') != 'done':
        deleted = (Tariff.query
                   .filter(Tariff.vehicle_type.in_(['Truck', 'EV', 'Bus']))
                   .delete(synchronize_session=False))
        if deleted:
            db.session.commit()
            print(f"[DB] purged {deleted} legacy Truck/EV/Bus tariff rows")
        Setting.set('purge_vehicle_types_v1', 'done')
    if Setting.get('capacity') is None:
        Setting.set('capacity', '120')
    if Setting.get('backup_schedule') is None:
        Setting.set('backup_schedule', 'Daily at 02:00')
    # Default zone tagged on auto-entries from ANPR / UHF gate detections.
    # Operator can change it via the Devices tab.
    if Setting.get('default_entry_zone') is None:
        Setting.set('default_entry_zone', 'GMR Cargo Staff Parking')

    # ── Seed initial admin account ───────────────────────────────────────────
    # Fires whenever NO account has a usable password_hash. Covers:
    #   * fresh install (zero accounts)
    #   * migration case where accounts exist from before the auth feature
    #     shipped (rows with password_hash = NULL — none of them can log in)
    # Reads INITIAL_ADMIN_USER / INITIAL_ADMIN_PASSWORD env vars (override on
    # Render). Defaults to admin/admin with a console warning.
    has_login_capable_account = (
        Account.query.filter(Account.password_hash.isnot(None)).count() > 0
    )
    if not has_login_capable_account:
        # Make sure the "Administrator" role exists so the admin_required
        # decorator can recognise it.
        if not Role.query.filter(db.func.lower(Role.name) == 'administrator').first():
            db.session.add(Role(name='Administrator',
                                description='Full system access (seeded on first boot)'))
            db.session.commit()
        admin_user = os.environ.get('INITIAL_ADMIN_USER', 'admin').strip() or 'admin'
        admin_pass = os.environ.get('INITIAL_ADMIN_PASSWORD', 'admin').strip() or 'admin'
        # Reuse an existing row with the same name (e.g. one created from the
        # CRUD UI before passwords were a thing) instead of duplicating it.
        existing = Account.query.filter(
            db.func.lower(Account.name) == admin_user.lower()).first()
        if existing:
            existing.role = 'Administrator'
            existing.set_password(admin_pass)
            action = 'updated'
        else:
            a = Account(name=admin_user, nickname='Initial Admin', role='Administrator')
            a.set_password(admin_pass)
            db.session.add(a)
            action = 'seeded'
        db.session.commit()
        AuditEvent.log(f"Initial admin {action}: {admin_user}", area='System')
        if admin_pass == 'admin':
            print("[SECURITY] WARNING: initial admin password is the default 'admin'. "
                  "Log in and change it immediately, or set INITIAL_ADMIN_PASSWORD "
                  "env var before first boot.")
        else:
            print(f"[OK] Initial admin {action}: {admin_user}")

    # One-shot retag: collapse all legacy multi-zone values to the single
    # configured zone ('GMR Cargo Staff Parking'). Runs once, guarded by a
    # setting. Old zones like 'Auto Gate', 'Basement A', etc. become one
    # consistent value so Reports → Zone-wise Performance shows real traffic.
    if Setting.get('single_zone_migration_v1') != 'done':
        target = 'GMR Cargo Staff Parking'
        # Force-set the active default in case it was a legacy value
        Setting.set('default_entry_zone', target)
        updated = (ParkingTransaction.query
                   .filter(ParkingTransaction.zone != target)
                   .update({ParkingTransaction.zone: target},
                            synchronize_session=False))
        if updated:
            db.session.commit()
            print(f"[DB] single-zone migration: retagged {updated} transactions → '{target}'")
        Setting.set('single_zone_migration_v1', 'done')

    # One-time UTC→local shift for legacy rows (everything stored before we
    # switched to datetime.now() was in UTC; the to_dict() serializer treats
    # naive datetimes as local, so historical rows render with a tz offset).
    if Setting.get('time_migration_v1') != 'done':
        # Compute local offset from UTC (e.g. +5:30 for IST). Use a sample
        # naive `now` and an aware UTC `now` to derive the offset.
        from datetime import timezone as _tz
        local_now = datetime.now()
        utc_now   = datetime.now(_tz.utc).replace(tzinfo=None)
        offset = local_now - utc_now    # timedelta, e.g. 5h30m
        if abs(offset.total_seconds()) >= 60:   # only shift if non-trivial offset
            shifted = 0
            for tx in ParkingTransaction.query.all():
                if tx.entry_at: tx.entry_at = tx.entry_at + offset; shifted += 1
                if tx.exit_at:  tx.exit_at  = tx.exit_at  + offset
            for al in AccessLog.query.all():
                if al.timestamp: al.timestamp = al.timestamp + offset; shifted += 1
            for ae in AuditEvent.query.all():
                if ae.timestamp: ae.timestamp = ae.timestamp + offset; shifted += 1
            # NOTE: Whitelist.created_at/activated_at/valid_until and Tariff.created_at
            # are NOT shifted — valid_until in particular is a date-only display.
            db.session.commit()
            print(f"[DB] time-migration: shifted {shifted} legacy rows by {offset} (UTC → local)")
        Setting.set('time_migration_v1', 'done')


# ── Tariffs ──────────────────────────────────────────────────────────────────
@app.route('/api/tariffs', methods=['GET', 'POST'])
@login_required
def api_tariffs():
    if request.method == 'POST':
        data = request.json or {}
        vt = (data.get('vehicle_type') or '').strip() or f"Custom {Tariff.query.count() + 1}"
        existing = Tariff.query.filter(db.func.upper(Tariff.vehicle_type) == vt.upper()).first()
        try:
            rate      = int(data.get('rate', 50))
            daily_cap = int(data.get('daily_cap', 250))
            lost      = int(data.get('lost', 250))
        except (TypeError, ValueError):
            return jsonify({"status": "error", "message": "rate/daily_cap/lost must be integers"}), 400
        model = (data.get('model') or 'Hourly').strip() or 'Hourly'
        if existing:
            existing.model = model; existing.rate = rate
            existing.daily_cap = daily_cap; existing.lost_ticket = lost
            action = 'updated'
        else:
            db.session.add(Tariff(vehicle_type=vt, model=model, rate=rate,
                                    daily_cap=daily_cap, lost_ticket=lost))
            action = 'added'
        db.session.commit()
        AuditEvent.log(f"Tariff {action} for {vt}", area='Admin')
        return jsonify({"status": "ok", "action": action})
    rows = Tariff.query.order_by(Tariff.id.asc()).all()
    return jsonify([r.to_dict() for r in rows])


@app.route('/api/tariffs/<int:tid>', methods=['DELETE'])
@login_required
def api_tariff_delete(tid):
    row = Tariff.query.get(tid)
    if not row:
        return jsonify({"status": "error", "message": "not found"}), 404
    name = row.vehicle_type
    db.session.delete(row); db.session.commit()
    AuditEvent.log(f"Tariff removed: {name}", area='Admin')
    return jsonify({"status": "ok"})


# ── Active parking transactions (Entry / Exit / Current Vehicles) ────────────
@app.route('/api/active_vehicles')
def api_active_vehicles():
    rows = (ParkingTransaction.query
            .filter(ParkingTransaction.exit_at.is_(None))
            .order_by(ParkingTransaction.entry_at.desc())
            .all())
    return jsonify([r.to_dict() for r in rows])


@app.route('/api/transactions')
def api_transactions():
    """Closed transactions (used by Reports). Limit to last 500 by default."""
    try:
        limit = min(int(request.args.get('limit', 500)), 5000)
    except ValueError:
        limit = 500
    rows = (ParkingTransaction.query
            .filter(ParkingTransaction.exit_at.isnot(None))
            .order_by(ParkingTransaction.exit_at.desc())
            .limit(limit).all())
    return jsonify([r.to_dict() for r in rows])


@app.route('/api/entries', methods=['POST'])
@login_required
def api_entry_create():
    data = request.json or {}
    veh = (data.get('vehicle') or '').strip().upper()
    if not veh:
        return jsonify({"status": "error", "message": "vehicle required"}), 400

    # Capacity check
    capacity = int(Setting.get('capacity', '120'))
    active = ParkingTransaction.query.filter(ParkingTransaction.exit_at.is_(None)).count()
    if active >= capacity:
        return jsonify({"status": "error",
                        "message": f"Parking is full ({active}/{capacity}). Entry refused."}), 400

    # Reject if same vehicle is already inside
    if ParkingTransaction.query.filter(
            ParkingTransaction.vehicle == veh,
            ParkingTransaction.exit_at.is_(None)).first():
        return jsonify({"status": "error",
                        "message": f"{veh} is already inside the lot."}), 400

    row = ParkingTransaction(
        vehicle      = veh,
        vehicle_type = (data.get('type')     or 'Car').strip(),
        mode         = (data.get('mode')     or 'RFID/UHF').strip(),
        identity     = (data.get('identity') or '').strip().upper() or None,
        zone         = (data.get('zone')     or 'Basement A').strip(),
        owner_name   = (data.get('emp_name') or data.get('owner') or '').strip() or None,
        is_vip       = bool(data.get('vip')),
        is_staff     = bool(data.get('staff')),
    )
    db.session.add(row); db.session.commit()
    AuditEvent.log(f"Entry registered for {veh} via {row.mode}", area='Entry')
    return jsonify({"status": "ok", "transaction": row.to_dict()})


def _compute_bill(tx: ParkingTransaction, lost: bool):
    """Compute parking bill using the active Tariff for this vehicle type."""
    tariff = Tariff.query.filter(db.func.upper(Tariff.vehicle_type) ==
                                  (tx.vehicle_type or '').upper()).first()
    if not tariff:
        tariff = Tariff.query.first()                # fallback to whatever exists
    if not tariff:
        # No tariffs configured at all
        return {"hours": 0, "parking": 0, "lost": 0, "total": 0,
                "tariff": {"type": "Default", "model": "—", "rate": 0}}

    now = datetime.now()
    delta = max(0, (now - tx.entry_at).total_seconds())
    hours = max(1, int(-(-delta // 3600)))           # ceil to hours, min 1
    parking = min(hours * tariff.rate, tariff.daily_cap)
    lost_charge = tariff.lost_ticket if lost else 0
    # VIP / staff park for free
    total = 0 if (tx.is_vip or tx.is_staff) else (parking + lost_charge)
    return {
        "hours": hours, "parking": parking, "lost": lost_charge, "total": total,
        "tariff": tariff.to_dict(),
    }


@app.route('/api/exits', methods=['POST'])
@login_required
def api_exit_close():
    """Strict exit: must match an ACTIVE transaction by EXACT plate or EXACT
    tag (not partial contains) AND optionally by zone. Wrong plate/tag = 404.
    No payment processing — this is an internal employee parking system."""
    data  = request.json or {}
    q     = (data.get('query') or '').strip().upper()
    zone  = (data.get('zone')  or '').strip()
    if not q:
        return jsonify({"status": "error", "message": "Plate or tag is required"}), 400

    # Exact match only — partial substring matches are a security hole here:
    # 'ABC' would close any plate containing 'ABC'. Require full equality.
    base_q = ParkingTransaction.query.filter(ParkingTransaction.exit_at.is_(None))
    tx = (base_q.filter(or_(db.func.upper(ParkingTransaction.vehicle)  == q,
                             db.func.upper(ParkingTransaction.identity) == q))
                .order_by(ParkingTransaction.entry_at.desc()).first())
    if not tx:
        # Diagnose WHY: look for a recently-closed transaction OR a whitelist
        # entry — that lets us return a much more useful error than "no match"
        last_closed = (ParkingTransaction.query
                       .filter(ParkingTransaction.exit_at.isnot(None))
                       .filter(or_(db.func.upper(ParkingTransaction.vehicle)  == q,
                                    db.func.upper(ParkingTransaction.identity) == q))
                       .order_by(ParkingTransaction.exit_at.desc()).first())
        wl = Whitelist.query.filter(
            or_(db.func.upper(Whitelist.rfid_tag)     == q,
                db.func.upper(Whitelist.number_plate) == q)).first()
        if last_closed:
            exit_t = last_closed.exit_at.strftime('%H:%M:%S on %Y-%m-%d')
            return jsonify({
                "status":  "error",
                "code":    "ALREADY_EXITED",
                "message": (f"'{q}' was already exited at {exit_t}"
                            f" (owner: {last_closed.owner_name or '—'}, "
                            f"zone: {last_closed.zone}). To re-enter, scan the tag at the gate.")
            }), 409
        elif wl:
            return jsonify({
                "status":  "error",
                "code":    "NEVER_ENTERED",
                "message": (f"'{q}' belongs to {wl.owner_name} ({wl.department or '—'}) "
                            f"but no active parking session exists. "
                            f"Scan the tag at the gate to enter first.")
            }), 404
        else:
            return jsonify({
                "status":  "error",
                "code":    "NOT_WHITELISTED",
                "message": (f"'{q}' is not registered. Activate this tag in the "
                            f"Admin tab before it can enter or exit.")
            }), 404

    # If operator picked a zone, it must match the entry zone (so they can't
    # mistakenly close a vehicle parked elsewhere).
    if zone and tx.zone and zone.strip().lower() != tx.zone.strip().lower():
        return jsonify({"status": "error",
                        "message": f"Zone mismatch — '{q}' is parked in '{tx.zone}', not '{zone}'."}), 400

    # Compute parking duration only (no bill — there is no payment here)
    now = datetime.now()
    elapsed = max(0, (now - tx.entry_at).total_seconds())
    hours = max(1, int(-(-elapsed // 3600)))   # ceil, min 1
    minutes = max(0, int(elapsed // 60))

    tx.exit_at        = now
    tx.payment_method = None
    tx.total_amount   = 0
    tx.lost_ticket    = False
    db.session.commit()
    AuditEvent.log(
        f"Exit closed for {tx.vehicle} (parked {hours}h in {tx.zone or 'unknown zone'})",
        area='Exit')
    return jsonify({
        "status":      "ok",
        "transaction": tx.to_dict(),
        "duration":    {"hours": hours, "minutes": minutes, "elapsed_seconds": int(elapsed)},
    })


# ── Settings (capacity, backup schedule) ─────────────────────────────────────
@app.route('/api/settings', methods=['GET', 'POST'])
@admin_required
def api_settings():
    # Basic facility settings + Entry/Exit settings share the key/value Setting
    # store. The UI splits them into two pages (Basic Settings, Entry/Exit
    # Settings) but they all persist here.
    SETTING_KEYS = ('capacity', 'backup_schedule', 'default_entry_zone',
                    'entry_grace_minutes', 'exit_grace_minutes',
                    'auto_open_barrier', 'rescan_cooldown_seconds')
    if request.method == 'POST':
        data = request.json or {}
        for key in SETTING_KEYS:
            if key in data:
                Setting.set(key, data[key])
        AuditEvent.log("Facility settings updated", area='Admin')
        return jsonify({"status": "ok"})
    return jsonify({
        "capacity":                int(Setting.get('capacity', '120')),
        "backup_schedule":         Setting.get('backup_schedule', 'Daily at 02:00'),
        "default_entry_zone":      Setting.get('default_entry_zone', 'Auto Gate'),
        "entry_grace_minutes":     int(Setting.get('entry_grace_minutes', '5')),
        "exit_grace_minutes":      int(Setting.get('exit_grace_minutes', '10')),
        "auto_open_barrier":       Setting.get('auto_open_barrier', '1'),
        "rescan_cooldown_seconds": int(Setting.get('rescan_cooldown_seconds', '30')),
    })


# ── Dashboard metrics ────────────────────────────────────────────────────────
@app.route('/api/dashboard_metrics')
def api_dashboard_metrics():
    capacity = int(Setting.get('capacity', '120'))
    occupied = ParkingTransaction.query.filter(ParkingTransaction.exit_at.is_(None)).count()
    today_start = datetime.now().replace(hour=0, minute=0, second=0, microsecond=0)
    today_revenue = (db.session.query(db.func.coalesce(db.func.sum(
                        ParkingTransaction.total_amount), 0))
                     .filter(ParkingTransaction.exit_at >= today_start).scalar() or 0)

    # Active devices: count whichever of (SRK-F206, network gate reader, camera) are healthy
    active_devices = 0
    if (desktop_rfid.status or '').lower().startswith('connected'): active_devices += 1
    if (rfid.status         or '').lower() == 'connected':         active_devices += 1
    try:
        if active_stream and active_stream.cap and active_stream.cap.isOpened(): active_devices += 1
    except Exception:
        pass

    return jsonify({
        "capacity":        capacity,
        "occupied":        occupied,
        "available":       max(0, capacity - occupied),
        "today_revenue":   int(today_revenue),
        "active_devices":  active_devices,
    })


# ── Audit trail ──────────────────────────────────────────────────────────────
@app.route('/api/audit')
@admin_required
def api_audit():
    try:
        limit = min(int(request.args.get('limit', 50)), 500)
    except ValueError:
        limit = 50
    rows = (AuditEvent.query.order_by(AuditEvent.timestamp.desc())
            .limit(limit).all())
    return jsonify([r.to_dict() for r in rows])


# ── Per-device entry/exit activity ───────────────────────────────────────────
@app.route('/api/devices_activity')
def api_devices_activity():
    """Per-device traffic stats. Each entry/exit is attributed to the device
    that produced it (via ParkingTransaction.mode):
      - RFID/UHF       → Network Gate UHF Reader
      - ANPR           → ANPR Camera (Gate A)
      - Manual Ticket  → operator manual entry
      - QR Code        → QR scanner (not currently wired)
    Returns today's totals and last-7-day counts for each device."""
    today_start = datetime.now().replace(hour=0, minute=0, second=0, microsecond=0)
    week_start  = today_start - timedelta(days=6)
    out = {}
    # Discover modes seen in active + recent transactions
    modes = {row[0] for row in db.session.query(ParkingTransaction.mode).distinct().all() if row[0]}
    # Always surface these even if no data yet
    modes |= {'RFID/UHF', 'ANPR', 'Manual Ticket'}
    for mode in modes:
        entries_today = ParkingTransaction.query.filter(
            ParkingTransaction.mode == mode,
            ParkingTransaction.entry_at >= today_start).count()
        exits_today = ParkingTransaction.query.filter(
            ParkingTransaction.mode == mode,
            ParkingTransaction.exit_at >= today_start).count()
        active_now = ParkingTransaction.query.filter(
            ParkingTransaction.mode == mode,
            ParkingTransaction.exit_at.is_(None)).count()
        entries_week = ParkingTransaction.query.filter(
            ParkingTransaction.mode == mode,
            ParkingTransaction.entry_at >= week_start).count()
        # Most recent activity (entry or exit) for the "last seen" label
        last_entry = (ParkingTransaction.query
                      .filter(ParkingTransaction.mode == mode)
                      .order_by(ParkingTransaction.entry_at.desc())
                      .first())
        last_at = last_entry.entry_at if last_entry else None
        out[mode] = {
            "entries_today":  entries_today,
            "exits_today":    exits_today,
            "active_now":     active_now,
            "entries_7days":  entries_week,
            "last_activity":  last_at.strftime("%Y-%m-%d %H:%M:%S") if last_at else None,
        }
    return jsonify(out)


# ── Devices (real-time hardware status) ──────────────────────────────────────
@app.route('/api/devices')
def api_devices():
    """Replaces the demo device list. Returns ONLY actually-known devices."""
    devices = []

    # SRK-F206 desktop reader
    srk_status = desktop_rfid.status or 'Unknown'
    devices.append({
        "name":     "SRK-F206 Desktop UHF Reader",
        "type":     "RFID/UHF",
        "status":   "Online" if srk_status.lower().startswith('connected') else srk_status,
        "lastSeen": "Just now" if desktop_rfid.peek_latest_tag() else "Idle",
    })
    # Network gate reader
    gate_status = rfid.status or 'Unknown'
    devices.append({
        "name":     "Network Gate UHF Reader",
        "type":     "RFID/UHF",
        "status":   "Online" if gate_status.lower() == 'connected' else gate_status,
        "lastSeen": "Just now",
    })
    # ANPR Camera
    cam_up = False
    try:
        cam_up = bool(active_stream and active_stream.cap and active_stream.cap.isOpened())
    except Exception:
        pass
    devices.append({
        "name":     "ANPR Camera (Gate A)",
        "type":     "Camera",
        "status":   "Online" if cam_up else "Offline",
        "lastSeen": "Streaming" if cam_up else "—",
    })
    return jsonify(devices)


# ── Blacklist (banned plates / tags) ─────────────────────────────────────────
@app.route('/api/blacklist', methods=['GET', 'POST'])
@login_required
def api_blacklist():
    if request.method == 'POST':
        data = request.json or {}
        plate = (data.get('number_plate') or '').strip().upper() or None
        tag   = (data.get('rfid_tag')     or '').strip().upper() or None
        if not plate and not tag:
            return jsonify({"status": "error", "message": "plate or tag required"}), 400
        if plate:
            plate = clean_plate_number(plate)
        # Avoid dup rows for same plate+tag combo
        existing = Blacklist.query.filter(
            ((Blacklist.number_plate == plate) if plate else (Blacklist.number_plate.is_(None))) &
            ((Blacklist.rfid_tag == tag)       if tag   else (Blacklist.rfid_tag.is_(None)))
        ).first()
        if existing:
            existing.reason   = (data.get('reason') or existing.reason or '').strip()
            existing.added_by = (data.get('added_by') or existing.added_by or '').strip() or None
        else:
            db.session.add(Blacklist(
                number_plate=plate, rfid_tag=tag,
                reason=(data.get('reason') or '').strip(),
                added_by=(data.get('added_by') or '').strip() or None,
            ))
        db.session.commit()
        AuditEvent.log(f"Blacklist add: {plate or tag}", area='Admin')
        return jsonify({"status": "ok"})
    return jsonify([b.to_dict()
                    for b in Blacklist.query.order_by(Blacklist.created_at.desc()).all()])


@app.route('/api/blacklist/<int:bid>', methods=['DELETE'])
@login_required
def api_blacklist_delete(bid):
    row = Blacklist.query.get(bid)
    if not row:
        return jsonify({"status": "error", "message": "not found"}), 404
    label = row.number_plate or row.rfid_tag or f"id={bid}"
    db.session.delete(row)
    db.session.commit()
    AuditEvent.log(f"Blacklist remove: {label}", area='Admin')
    return jsonify({"status": "ok"})


# ── Orders (derived ledger, WeParking parity) ────────────────────────────────
# Orders are NOT a separate table — they're derived on the fly from the two
# things that actually take money:
#   • each closed ParkingTransaction  -> "Temporary parking fee" order
#   • each Whitelist activation payment -> "memberPurchase" order
# This gives a real, live order list without duplicating data.
@app.route('/api/orders')
def api_orders():
    orders = []
    txns = (ParkingTransaction.query
            .filter(ParkingTransaction.exit_at.isnot(None))
            .order_by(ParkingTransaction.exit_at.desc())
            .limit(500).all())
    for t in txns:
        orders.append({
            "order_no":   f"PK{t.id:08d}",
            "type":       "Temporary parking fee",
            "plate":      t.vehicle or "—",
            "amount":     t.total_amount or 0,
            "payment":    t.payment_method or "—",
            "created_at": t.exit_at.strftime("%Y-%m-%d %H:%M:%S") if t.exit_at else "",
            "admission":  t.entry_at.strftime("%Y-%m-%d %H:%M:%S") if t.entry_at else "—",
            "status":     "Paid" if (t.total_amount or 0) > 0 else "Free",
        })
    members = (Whitelist.query
               .filter(Whitelist.paid_at.isnot(None))
               .order_by(Whitelist.paid_at.desc()).all())
    for w in members:
        orders.append({
            "order_no":   f"MB{w.id:08d}",
            "type":       "memberPurchase",
            "plate":      w.number_plate or "—",
            "amount":     w.payment_amount or 0,
            "payment":    w.payment_method or "—",
            "created_at": w.paid_at.strftime("%Y-%m-%d %H:%M:%S") if w.paid_at else "",
            "admission":  "—",
            "status":     "Paid",
        })
    # Newest first across both kinds.
    orders.sort(key=lambda o: o["created_at"], reverse=True)
    return jsonify(orders)


# ── Yards (parking lots) ─────────────────────────────────────────────────────
@app.route('/api/yards', methods=['GET', 'POST'])
@admin_required
def api_yards():
    if request.method == 'POST':
        data = request.json or {}
        name = (data.get('name') or '').strip()
        if not name:
            return jsonify({"status": "error", "message": "Yard name is required"}), 400
        try:
            capacity = max(0, int(data.get('capacity', 0) or 0))
        except (TypeError, ValueError):
            capacity = 0
        if Yard.query.filter(db.func.lower(Yard.name) == name.lower()).first():
            return jsonify({"status": "error", "message": f"Yard '{name}' already exists"}), 400
        db.session.add(Yard(name=name, capacity=capacity,
                            location=(data.get('location') or '').strip() or None,
                            region=(data.get('region') or '').strip() or None))
        db.session.commit()
        AuditEvent.log(f"Yard added: {name}", area='Admin')
        return jsonify({"status": "ok"})
    return jsonify([y.to_dict()
                    for y in Yard.query.order_by(Yard.name).all()])


@app.route('/api/yards/<int:yid>', methods=['DELETE'])
@admin_required
def api_yards_delete(yid):
    row = Yard.query.get(yid)
    if not row:
        return jsonify({"status": "error", "message": "not found"}), 404
    name = row.name
    db.session.delete(row)
    db.session.commit()
    AuditEvent.log(f"Yard removed: {name}", area='Admin')
    return jsonify({"status": "ok"})


# ── Regions (group of yards) ─────────────────────────────────────────────────
@app.route('/api/regions', methods=['GET', 'POST'])
@admin_required
def api_regions():
    if request.method == 'POST':
        data = request.json or {}
        name = (data.get('name') or '').strip()
        if not name:
            return jsonify({"status": "error", "message": "Region name is required"}), 400
        if Region.query.filter(db.func.lower(Region.name) == name.lower()).first():
            return jsonify({"status": "error", "message": f"Region '{name}' already exists"}), 400
        db.session.add(Region(name=name,
                              description=(data.get('description') or '').strip() or None))
        db.session.commit()
        AuditEvent.log(f"Region added: {name}", area='Admin')
        return jsonify({"status": "ok"})
    return jsonify([r.to_dict()
                    for r in Region.query.order_by(Region.name).all()])


@app.route('/api/regions/<int:rid>', methods=['DELETE'])
@admin_required
def api_regions_delete(rid):
    row = Region.query.get(rid)
    if not row:
        return jsonify({"status": "error", "message": "not found"}), 404
    name = row.name
    db.session.delete(row)
    db.session.commit()
    AuditEvent.log(f"Region removed: {name}", area='Admin')
    return jsonify({"status": "ok"})


# ── System Management: Accounts ──────────────────────────────────────────────
@app.route('/api/accounts', methods=['GET', 'POST'])
@admin_required
def api_accounts():
    if request.method == 'POST':
        data = request.json or {}
        name = (data.get('name') or '').strip()
        if not name:
            return jsonify({"status": "error", "message": "Account name is required"}), 400
        if Account.query.filter(db.func.lower(Account.name) == name.lower()).first():
            return jsonify({"status": "error", "message": f"Account '{name}' already exists"}), 400
        # Optional password on create — if either field is present, both must
        # be present and match. Allowing creation without a password lets an
        # admin set it later via PUT (useful for bulk import scenarios).
        pwd  = data.get('password')
        pwd2 = data.get('password_confirm')
        if pwd or pwd2:
            if (pwd or '') != (pwd2 or ''):
                return jsonify({"status": "error",
                                "message": "Passwords do not match"}), 400
            if len(pwd or '') < 4:
                return jsonify({"status": "error",
                                "message": "Password must be at least 4 characters"}), 400
        acc = Account(name=name,
                      nickname=(data.get('nickname') or '').strip() or None,
                      contact=(data.get('contact') or '').strip() or None,
                      role=(data.get('role') or '').strip() or None)
        if pwd:
            acc.set_password(pwd)
        db.session.add(acc)
        db.session.commit()
        AuditEvent.log(f"Account added: {name}", area='System')
        return jsonify({"status": "ok"})
    return jsonify([a.to_dict() for a in Account.query.order_by(Account.name).all()])


@app.route('/api/accounts/<int:aid>', methods=['DELETE'])
@admin_required
def api_accounts_delete(aid):
    row = Account.query.get(aid)
    if not row:
        return jsonify({"status": "error", "message": "not found"}), 404
    db.session.delete(row); db.session.commit()
    AuditEvent.log(f"Account removed: {row.name}", area='System')
    return jsonify({"status": "ok"})


# ── System Management: Roles ─────────────────────────────────────────────────
@app.route('/api/roles', methods=['GET', 'POST'])
@admin_required
def api_roles():
    if request.method == 'POST':
        data = request.json or {}
        name = (data.get('name') or '').strip()
        if not name:
            return jsonify({"status": "error", "message": "Role name is required"}), 400
        if Role.query.filter(db.func.lower(Role.name) == name.lower()).first():
            return jsonify({"status": "error", "message": f"Role '{name}' already exists"}), 400
        db.session.add(Role(name=name,
                            description=(data.get('description') or '').strip() or None))
        db.session.commit()
        AuditEvent.log(f"Role added: {name}", area='System')
        return jsonify({"status": "ok"})
    return jsonify([r.to_dict() for r in Role.query.order_by(Role.name).all()])


@app.route('/api/roles/<int:rid>', methods=['DELETE'])
@admin_required
def api_roles_delete(rid):
    row = Role.query.get(rid)
    if not row:
        return jsonify({"status": "error", "message": "not found"}), 404
    db.session.delete(row); db.session.commit()
    AuditEvent.log(f"Role removed: {row.name}", area='System')
    return jsonify({"status": "ok"})


# ── System Management: Dictionary ────────────────────────────────────────────
@app.route('/api/dictionary', methods=['GET', 'POST'])
@admin_required
def api_dictionary():
    if request.method == 'POST':
        data = request.json or {}
        category = (data.get('category') or '').strip()
        key      = (data.get('key') or '').strip()
        if not category or not key:
            return jsonify({"status": "error", "message": "Category and key are required"}), 400
        db.session.add(DictionaryEntry(category=category, dict_key=key,
                                       dict_value=(data.get('value') or '').strip() or None))
        db.session.commit()
        AuditEvent.log(f"Dictionary entry added: {category}/{key}", area='System')
        return jsonify({"status": "ok"})
    return jsonify([d.to_dict()
                    for d in DictionaryEntry.query.order_by(
                        DictionaryEntry.category, DictionaryEntry.dict_key).all()])


@app.route('/api/dictionary/<int:did>', methods=['DELETE'])
@admin_required
def api_dictionary_delete(did):
    row = DictionaryEntry.query.get(did)
    if not row:
        return jsonify({"status": "error", "message": "not found"}), 404
    db.session.delete(row); db.session.commit()
    AuditEvent.log(f"Dictionary entry removed: {row.category}/{row.dict_key}", area='System')
    return jsonify({"status": "ok"})


# ── System Management: LCD screens (entry/exit displays) ─────────────────────
@app.route('/api/lcd', methods=['GET', 'POST'])
@admin_required
def api_lcd():
    if request.method == 'POST':
        data = request.json or {}
        name = (data.get('name') or '').strip()
        if not name:
            return jsonify({"status": "error", "message": "Screen name is required"}), 400
        db.session.add(LCDScreen(
            name=name,
            location=(data.get('location') or '').strip() or None,
            message=(data.get('message') or '').strip() or None,
            is_active=bool(data.get('is_active', True)),
        ))
        db.session.commit()
        AuditEvent.log(f"LCD added: {name}", area='System')
        return jsonify({"status": "ok"})
    return jsonify([s.to_dict() for s in LCDScreen.query.order_by(LCDScreen.name).all()])


@app.route('/api/lcd/<int:sid>', methods=['PUT'])
@admin_required
def api_lcd_update(sid):
    row = LCDScreen.query.get(sid)
    if not row:
        return jsonify({"status": "error", "message": "not found"}), 404
    d = request.json or {}
    if 'name' in d:
        nm = (d.get('name') or '').strip()
        if not nm: return jsonify({"status": "error", "message": "Screen name required"}), 400
        row.name = nm
    if 'location'  in d: row.location  = (d.get('location') or '').strip() or None
    if 'message'   in d: row.message   = (d.get('message') or '').strip() or None
    if 'is_active' in d: row.is_active = bool(d.get('is_active'))
    db.session.commit()
    AuditEvent.log(f"LCD updated: {row.name}", area='System')
    return jsonify({"status": "ok", "lcd": row.to_dict()})


@app.route('/api/lcd/<int:sid>', methods=['DELETE'])
@admin_required
def api_lcd_delete(sid):
    row = LCDScreen.query.get(sid)
    if not row:
        return jsonify({"status": "error", "message": "not found"}), 404
    db.session.delete(row); db.session.commit()
    AuditEvent.log(f"LCD removed: {row.name}", area='System')
    return jsonify({"status": "ok"})


# ── System Management: Menu visibility per role ──────────────────────────────
@app.route('/api/menu_permissions', methods=['GET', 'POST'])
@login_required
def api_menu_perms():
    if request.method == 'POST':
        # GET is allowed for any logged-in user so the sidebar can self-filter,
        # but writes must come from an admin. Inline check instead of stacking
        # decorators because the GET branch is intentionally not admin-gated.
        role_cur = (session.get('user_role') or '').strip().lower()
        if role_cur != 'administrator':
            return jsonify({"error": "admin_required",
                            "message": "Administrator role required"}), 403
        d = request.json or {}
        role = (d.get('role_name') or '').strip()
        menu = (d.get('menu_key') or '').strip()
        if not role or not menu:
            return jsonify({"status": "error", "message": "Role and menu are required"}), 400
        existing = MenuPermission.query.filter(
            MenuPermission.role_name == role,
            MenuPermission.menu_key  == menu).first()
        if existing:
            existing.allowed = bool(d.get('allowed', True))
        else:
            db.session.add(MenuPermission(role_name=role, menu_key=menu,
                                          allowed=bool(d.get('allowed', True))))
        db.session.commit()
        AuditEvent.log(f"Menu perm set: {role}/{menu}", area='System')
        return jsonify({"status": "ok"})
    return jsonify([m.to_dict() for m in MenuPermission.query
                    .order_by(MenuPermission.role_name, MenuPermission.menu_key).all()])


@app.route('/api/menu_permissions/<int:mid>', methods=['DELETE'])
@admin_required
def api_menu_perms_delete(mid):
    row = MenuPermission.query.get(mid)
    if not row:
        return jsonify({"status": "error", "message": "not found"}), 404
    db.session.delete(row); db.session.commit()
    AuditEvent.log(f"Menu perm removed: {row.role_name}/{row.menu_key}", area='System')
    return jsonify({"status": "ok"})


# ── System Management: Role × Section permission grants ─────────────────────
@app.route('/api/role_permissions', methods=['GET', 'POST'])
@admin_required
def api_role_perms():
    if request.method == 'POST':
        d = request.json or {}
        role = (d.get('role_name') or '').strip()
        sec  = (d.get('section_key') or '').strip()
        act  = (d.get('action') or 'read').strip().lower()
        if not role or not sec:
            return jsonify({"status": "error", "message": "Role and section are required"}), 400
        if act not in ('read', 'write', 'delete'):
            return jsonify({"status": "error", "message": "Action must be read/write/delete"}), 400
        existing = RolePermission.query.filter(
            RolePermission.role_name   == role,
            RolePermission.section_key == sec,
            RolePermission.action      == act).first()
        if existing:
            existing.allowed = bool(d.get('allowed', True))
        else:
            db.session.add(RolePermission(role_name=role, section_key=sec, action=act,
                                          allowed=bool(d.get('allowed', True))))
        db.session.commit()
        AuditEvent.log(f"Role perm set: {role}/{sec}/{act}", area='System')
        return jsonify({"status": "ok"})
    return jsonify([r.to_dict() for r in RolePermission.query
                    .order_by(RolePermission.role_name, RolePermission.section_key, RolePermission.action).all()])


@app.route('/api/role_permissions/<int:rid>', methods=['DELETE'])
@admin_required
def api_role_perms_delete(rid):
    row = RolePermission.query.get(rid)
    if not row:
        return jsonify({"status": "error", "message": "not found"}), 404
    db.session.delete(row); db.session.commit()
    AuditEvent.log(f"Role perm removed: {row.role_name}/{row.section_key}/{row.action}", area='System')
    return jsonify({"status": "ok"})


# ── Edit (PUT) endpoints for the CRUD tables ─────────────────────────────────
# Each updates only the fields present in the body, then returns the row.
@app.route('/api/accounts/<int:aid>', methods=['PUT'])
@admin_required
def api_accounts_update(aid):
    row = Account.query.get(aid)
    if not row:
        return jsonify({"status": "error", "message": "not found"}), 404
    d = request.json or {}
    if 'name' in d:
        nm = (d.get('name') or '').strip()
        if not nm:
            return jsonify({"status": "error", "message": "Account name is required"}), 400
        row.name = nm
    if 'nickname' in d: row.nickname = (d.get('nickname') or '').strip() or None
    if 'contact'  in d: row.contact  = (d.get('contact')  or '').strip() or None
    if 'role'     in d: row.role     = (d.get('role')     or '').strip() or None
    # Password change support — same validation rules as the Add form.
    pwd  = d.get('password')
    pwd2 = d.get('password_confirm')
    if pwd or pwd2:
        if (pwd or '') != (pwd2 or ''):
            return jsonify({"status": "error",
                            "message": "Passwords do not match"}), 400
        if len(pwd or '') < 4:
            return jsonify({"status": "error",
                            "message": "Password must be at least 4 characters"}), 400
        row.set_password(pwd)
        AuditEvent.log(f"Account password changed: {row.name}", area='Auth')
    db.session.commit()
    AuditEvent.log(f"Account updated: {row.name}", area='System')
    return jsonify({"status": "ok", "account": row.to_dict()})


@app.route('/api/roles/<int:rid>', methods=['PUT'])
@admin_required
def api_roles_update(rid):
    row = Role.query.get(rid)
    if not row:
        return jsonify({"status": "error", "message": "not found"}), 404
    d = request.json or {}
    if 'name' in d:
        nm = (d.get('name') or '').strip()
        if not nm:
            return jsonify({"status": "error", "message": "Role name is required"}), 400
        row.name = nm
    if 'description' in d: row.description = (d.get('description') or '').strip() or None
    db.session.commit()
    AuditEvent.log(f"Role updated: {row.name}", area='System')
    return jsonify({"status": "ok", "role": row.to_dict()})


@app.route('/api/dictionary/<int:did>', methods=['PUT'])
@admin_required
def api_dictionary_update(did):
    row = DictionaryEntry.query.get(did)
    if not row:
        return jsonify({"status": "error", "message": "not found"}), 404
    d = request.json or {}
    if 'category' in d:
        cat = (d.get('category') or '').strip()
        if not cat:
            return jsonify({"status": "error", "message": "Category is required"}), 400
        row.category = cat
    if 'key' in d:
        k = (d.get('key') or '').strip()
        if not k:
            return jsonify({"status": "error", "message": "Key is required"}), 400
        row.dict_key = k
    if 'value' in d: row.dict_value = (d.get('value') or '').strip() or None
    db.session.commit()
    AuditEvent.log(f"Dictionary updated: {row.category}/{row.dict_key}", area='System')
    return jsonify({"status": "ok", "entry": row.to_dict()})


@app.route('/api/yards/<int:yid>', methods=['PUT'])
@admin_required
def api_yards_update(yid):
    row = Yard.query.get(yid)
    if not row:
        return jsonify({"status": "error", "message": "not found"}), 404
    d = request.json or {}
    if 'name' in d:
        nm = (d.get('name') or '').strip()
        if not nm:
            return jsonify({"status": "error", "message": "Yard name is required"}), 400
        row.name = nm
    if 'capacity' in d:
        try:
            row.capacity = max(0, int(d.get('capacity', 0) or 0))
        except (TypeError, ValueError):
            pass
    if 'location' in d: row.location = (d.get('location') or '').strip() or None
    if 'region'   in d: row.region   = (d.get('region')   or '').strip() or None
    db.session.commit()
    AuditEvent.log(f"Yard updated: {row.name}", area='Admin')
    return jsonify({"status": "ok", "yard": row.to_dict()})


@app.route('/api/regions/<int:rid>', methods=['PUT'])
@admin_required
def api_regions_update(rid):
    row = Region.query.get(rid)
    if not row:
        return jsonify({"status": "error", "message": "not found"}), 404
    d = request.json or {}
    if 'name' in d:
        nm = (d.get('name') or '').strip()
        if not nm:
            return jsonify({"status": "error", "message": "Region name is required"}), 400
        row.name = nm
    if 'description' in d: row.description = (d.get('description') or '').strip() or None
    db.session.commit()
    AuditEvent.log(f"Region updated: {row.name}", area='Admin')
    return jsonify({"status": "ok", "region": row.to_dict()})


# ── QR codes for visitor / member passes ─────────────────────────────────────
# Encodes the pass details as JSON inside the QR. Operators can scan at the
# gate to verify. The qrcode library is optional — endpoints return 503 if
# it isn't installed (e.g. on a local dev env that hasn't pip-installed it).
try:
    import qrcode as _qrcode
    from io import BytesIO as _QrBytesIO
    _QR_AVAILABLE = True
except ImportError:
    _QR_AVAILABLE = False

# Monthly PDF report (reportlab). Same try-import pattern.
try:
    from io import BytesIO as _PdfBytesIO
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.styles import getSampleStyleSheet
    from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle
    from reportlab.lib import colors as _rl_colors
    from reportlab.lib.units import cm as _rl_cm
    _PDF_AVAILABLE = True
except ImportError:
    _PDF_AVAILABLE = False


@app.route('/api/reports/monthly_pdf')
def api_monthly_pdf():
    if not _PDF_AVAILABLE:
        return jsonify({"status": "error",
                        "message": "PDF support not installed (reportlab missing)"}), 503

    # Parse ?month=YYYY-MM, default to current month.
    month_q = (request.args.get('month') or '').strip()
    try:
        if month_q:
            y, m = map(int, month_q.split('-'))
        else:
            now = datetime.now(); y, m = now.year, now.month
    except Exception:
        now = datetime.now(); y, m = now.year, now.month
    start = datetime(y, m, 1)
    end   = datetime(y + 1, 1, 1) if m == 12 else datetime(y, m + 1, 1)

    parking_total = ParkingTransaction.query.filter(
        ParkingTransaction.entry_at >= start, ParkingTransaction.entry_at < end).count()
    exited = ParkingTransaction.query.filter(
        ParkingTransaction.exit_at >= start, ParkingTransaction.exit_at < end).count()
    revenue = db.session.query(
        db.func.coalesce(db.func.sum(ParkingTransaction.total_amount), 0)
    ).filter(ParkingTransaction.exit_at >= start,
             ParkingTransaction.exit_at <  end).scalar() or 0
    member_revenue = db.session.query(
        db.func.coalesce(db.func.sum(Whitelist.payment_amount), 0)
    ).filter(Whitelist.paid_at >= start, Whitelist.paid_at < end).scalar() or 0

    # Daily entries/exits across the month.
    daily = [['Date', 'Entries', 'Exits']]
    cur = start
    while cur < end:
        nxt = cur + timedelta(days=1)
        e = ParkingTransaction.query.filter(
            ParkingTransaction.entry_at >= cur, ParkingTransaction.entry_at < nxt).count()
        x = ParkingTransaction.query.filter(
            ParkingTransaction.exit_at >= cur, ParkingTransaction.exit_at < nxt).count()
        daily.append([cur.strftime('%Y-%m-%d'), str(e), str(x)])
        cur = nxt

    buf = _PdfBytesIO()
    doc = SimpleDocTemplate(buf, pagesize=A4,
                            leftMargin=2 * _rl_cm, rightMargin=2 * _rl_cm,
                            topMargin=1.5 * _rl_cm, bottomMargin=1.5 * _rl_cm)
    styles = getSampleStyleSheet()
    elems = [
        Paragraph('<b>VayAccess Systems · Monthly Report</b>', styles['Title']),
        Paragraph(f'Period: {start.strftime("%B %Y")}', styles['Heading3']),
        Spacer(1, 12),
    ]
    summary = [
        ['Metric', 'Value'],
        ['Total parking transactions', str(parking_total)],
        ['Vehicles exited',            str(exited)],
        ['Temporary parking revenue',  f'Rs {int(revenue):,}'],
        ['Member purchase revenue',    f'Rs {int(member_revenue):,}'],
        ['Total revenue',              f'Rs {int(revenue + member_revenue):,}'],
    ]
    t1 = Table(summary, colWidths=[8 * _rl_cm, 5 * _rl_cm])
    t1.setStyle(TableStyle([
        ('BACKGROUND',  (0, 0), (-1, 0),  _rl_colors.HexColor('#1f73d4')),
        ('TEXTCOLOR',   (0, 0), (-1, 0),  _rl_colors.white),
        ('FONTNAME',    (0, 0), (-1, 0),  'Helvetica-Bold'),
        ('GRID',        (0, 0), (-1, -1), 0.5, _rl_colors.HexColor('#e5e9ef')),
        ('FONTSIZE',    (0, 0), (-1, -1), 10),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 6),
        ('TOPPADDING',    (0, 0), (-1, -1), 6),
    ]))
    elems.append(t1)
    elems.append(Spacer(1, 18))
    elems.append(Paragraph('<b>Daily Entries / Exits</b>', styles['Heading3']))
    t2 = Table(daily, colWidths=[5 * _rl_cm, 4 * _rl_cm, 4 * _rl_cm])
    t2.setStyle(TableStyle([
        ('BACKGROUND',     (0, 0), (-1, 0),  _rl_colors.HexColor('#1f73d4')),
        ('TEXTCOLOR',      (0, 0), (-1, 0),  _rl_colors.white),
        ('FONTNAME',       (0, 0), (-1, 0),  'Helvetica-Bold'),
        ('GRID',           (0, 0), (-1, -1), 0.5, _rl_colors.HexColor('#e5e9ef')),
        ('ROWBACKGROUNDS', (0, 1), (-1, -1), [_rl_colors.white, _rl_colors.HexColor('#f4f7fa')]),
        ('FONTSIZE',       (0, 0), (-1, -1), 9),
    ]))
    elems.append(t2)
    doc.build(elems)

    return Response(buf.getvalue(), mimetype='application/pdf', headers={
        'Content-Disposition': f'attachment; filename="VayAccess-Report-{start.strftime("%Y-%m")}.pdf"',
        'Cache-Control': 'no-store',
    })


def _make_qr_png(payload):
    """Generate a PNG of the QR encoding the given payload (str or dict)."""
    text = payload if isinstance(payload, str) else json.dumps(payload, separators=(',', ':'))
    img = _qrcode.make(text, box_size=10, border=2)
    buf = _QrBytesIO()
    img.save(buf, format='PNG')
    return buf.getvalue()


# Token signing for pass-verification URLs.
# Token format: <kind><id>-<sig>  where kind ∈ {v,m} and sig is the first 8
# hex chars of HMAC-SHA256(secret, kind+id). Prevents trivial enumeration by
# requiring the URL to be issued by us. Override the secret via PASS_SECRET
# env var on Render (recommended in production).
import hmac as _hmac
import hashlib as _hashlib

def _pass_secret():
    return os.environ.get('PASS_SECRET',
                          'vayaccess-default-pass-secret-2026-change-me').encode()

def _make_pass_token(kind, row_id):
    base = f"{kind}{row_id}"
    sig  = _hmac.new(_pass_secret(), base.encode(), _hashlib.sha256).hexdigest()[:8]
    return f"{base}-{sig}"

def _verify_pass_token(token):
    """Return (kind, id) tuple if token is valid, else None."""
    if not token or '-' not in token:
        return None
    base, sig = token.rsplit('-', 1)
    if not base or len(base) < 2:
        return None
    expected = _hmac.new(_pass_secret(), base.encode(), _hashlib.sha256).hexdigest()[:8]
    if not _hmac.compare_digest(sig, expected):
        return None
    kind, rest = base[0], base[1:]
    if kind not in ('v', 'm'):
        return None
    try:
        return (kind, int(rest))
    except ValueError:
        return None

def _build_pass_url(token):
    # Use the request's host so QR works on any deployment domain (local /
    # Render / a custom domain) without configuration.
    return f"{request.host_url.rstrip('/')}/v/{token}"


@app.route('/api/visitors/<int:vid>/qr')
def api_visitor_qr(vid):
    if not _QR_AVAILABLE:
        return jsonify({"status": "error",
                        "message": "QR support not installed (qrcode lib missing)"}), 503
    v = Visitor.query.get(vid)
    if not v:
        return jsonify({"status": "error", "message": "not found"}), 404
    # QR now encodes the verification URL — phone cameras open it directly
    # and the operator sees a clean VALID/EXPIRED page.
    url = _build_pass_url(_make_pass_token('v', v.id))
    png = _make_qr_png(url)
    return Response(png, mimetype='image/png',
                    headers={'Cache-Control': 'no-store'})


# Tiny URL accessor used by the WhatsApp share button on each row.
@app.route('/api/visitors/<int:vid>/pass_url')
def api_visitor_pass_url(vid):
    v = Visitor.query.get(vid)
    if not v:
        return jsonify({"status": "error", "message": "not found"}), 404
    return jsonify({"url": _build_pass_url(_make_pass_token('v', v.id))})


@app.route('/api/employees/<int:eid>/pass_url')
def api_employee_pass_url(eid):
    w = Whitelist.query.get(eid)
    if not w:
        return jsonify({"status": "error", "message": "not found"}), 404
    return jsonify({"url": _build_pass_url(_make_pass_token('m', w.id))})


# ── Bulk CSV import for Visitors + Members ───────────────────────────────────
# Accepts an array of row dicts (parsed client-side from a CSV file). Each row
# becomes a new Visitor / Whitelist entry. Returns counts of imported / skipped.
@app.route('/api/bulk_import/visitors', methods=['POST'])
@admin_required
def api_bulk_import_visitors():
    rows = (request.json or {}).get('rows') or []
    ok = err = 0
    now = datetime.now()
    for r in rows:
        name = (r.get('name') or r.get('Name') or '').strip()
        if not name:
            err += 1; continue
        # Optional valid_from/valid_to from CSV; otherwise default to now + 8h.
        try:
            start_at = datetime.strptime(r['valid_from'], '%Y-%m-%d %H:%M') if r.get('valid_from') else now
        except Exception:
            start_at = now
        try:
            end_at = datetime.strptime(r['valid_to'], '%Y-%m-%d %H:%M') if r.get('valid_to') else (now + timedelta(hours=8))
        except Exception:
            end_at = now + timedelta(hours=8)
        try:
            db.session.add(Visitor(
                name=name,
                number_plate=(r.get('number_plate') or r.get('plate') or r.get('Plate') or '').strip().upper() or None,
                contact=(r.get('contact') or r.get('Contact') or '').strip() or None,
                purpose=(r.get('purpose') or r.get('Purpose') or '').strip() or None,
                host_employee=(r.get('host_employee') or r.get('host') or r.get('Host') or '').strip() or None,
                start_at=start_at,
                end_at=end_at,
            ))
            ok += 1
        except Exception:
            err += 1
    db.session.commit()
    AuditEvent.log(f"Bulk imported {ok} visitor(s) ({err} skipped)", area='Admin')
    return jsonify({"status": "ok", "imported": ok, "skipped": err})


@app.route('/api/bulk_import/members', methods=['POST'])
@admin_required
def api_bulk_import_members():
    """Bulk-create Whitelist rows. Each row needs at minimum: owner_name + plate.
    Payment / activation defaults are set so the rows pass the existing
    not-null constraints; operator can edit specifics after import."""
    rows = (request.json or {}).get('rows') or []
    ok = err = 0
    from dateutil.relativedelta import relativedelta
    now = datetime.now()
    for r in rows:
        name  = (r.get('owner_name') or r.get('name') or r.get('Name') or '').strip()
        plate = (r.get('number_plate') or r.get('plate') or r.get('Plate') or '').strip().upper()
        if not name or not plate:
            err += 1; continue
        try:
            months = int(r.get('activation_months') or r.get('months') or 12)
        except Exception:
            months = 12
        try:
            db.session.add(Whitelist(
                owner_name=name,
                number_plate=plate,
                rfid_tag=(r.get('rfid_tag') or r.get('tag') or '').strip().upper() or None,
                department=(r.get('department') or r.get('Department') or '').strip() or None,
                contact_number=(r.get('contact_number') or r.get('contact') or '').strip() or None,
                vehicle_type=(r.get('vehicle_type') or r.get('type') or 'Car').strip() or 'Car',
                activated_at=now,
                activation_months=months,
                valid_until=now + relativedelta(months=+months),
                payment_method='Bulk Import',
                payment_amount=int(r.get('payment_amount') or r.get('amount') or 0),
            ))
            ok += 1
        except Exception:
            err += 1
    db.session.commit()
    AuditEvent.log(f"Bulk imported {ok} member(s) ({err} skipped)", area='Admin')
    return jsonify({"status": "ok", "imported": ok, "skipped": err})


@app.route('/api/employees/<int:eid>/qr')
def api_employee_qr(eid):
    if not _QR_AVAILABLE:
        return jsonify({"status": "error",
                        "message": "QR support not installed (qrcode lib missing)"}), 503
    w = Whitelist.query.get(eid)
    if not w:
        return jsonify({"status": "error", "message": "not found"}), 404
    url = _build_pass_url(_make_pass_token('m', w.id))
    png = _make_qr_png(url)
    return Response(png, mimetype='image/png',
                    headers={'Cache-Control': 'no-store'})


# ── Pass verification page (opens when QR is scanned) ────────────────────────
@app.route('/v/<token>')
def pass_verify(token):
    parsed = _verify_pass_token(token)
    now    = datetime.now()
    ctx    = {"now": now.strftime("%Y-%m-%d %H:%M:%S"), "error": None, "pass_": None}

    if not parsed:
        ctx["error"] = "Invalid or tampered pass code. This QR did not originate from VayAccess."
        return render_template('pass_verify.html', **ctx), 404

    kind, row_id = parsed
    if kind == 'v':
        row = Visitor.query.get(row_id)
        if not row:
            ctx["error"] = "Visitor pass not found."
            return render_template('pass_verify.html', **ctx), 404
        is_valid = bool(row.start_at and row.end_at and row.start_at <= now <= row.end_at)
        ctx["pass_"] = {
            "type":       "Visitor",
            "name":       row.name or "—",
            "plate":      row.number_plate or "",
            "subline":    f"Host: {row.host_employee or '—'} · Contact: {row.contact or '—'}",
            "purpose":    row.purpose or "",
            "valid_from": row.start_at.strftime("%Y-%m-%d %H:%M") if row.start_at else "—",
            "valid_to":   row.end_at.strftime("%Y-%m-%d %H:%M")   if row.end_at   else "—",
            "is_valid":   is_valid,
            "status":     "VALID" if is_valid else "NOT VALID",
            "sub":        ("Pass is currently active — admit entry"
                           if is_valid else
                           "Pass is outside its validity window — DO NOT ADMIT"),
        }
    else:   # 'm' = member
        row = Whitelist.query.get(row_id)
        if not row:
            ctx["error"] = "Member pass not found."
            return render_template('pass_verify.html', **ctx), 404
        # Member is valid if valid_until is today or later.
        is_valid = bool(row.valid_until and row.valid_until >= now)
        # Recent gate scans for this member (member mobile self-service feature).
        recent_q = AccessLog.query
        if row.rfid_tag and row.number_plate:
            recent_q = recent_q.filter(
                (AccessLog.rfid_tag == row.rfid_tag) |
                (AccessLog.number_plate == row.number_plate))
        elif row.rfid_tag:
            recent_q = recent_q.filter(AccessLog.rfid_tag == row.rfid_tag)
        elif row.number_plate:
            recent_q = recent_q.filter(AccessLog.number_plate == row.number_plate)
        else:
            recent_q = None
        recent = []
        if recent_q is not None:
            for r in recent_q.order_by(AccessLog.timestamp.desc()).limit(5).all():
                recent.append({
                    "when":   r.timestamp.strftime("%Y-%m-%d %H:%M:%S") if r.timestamp else "—",
                    "status": r.status or "—",
                    "ok":     bool(r.status and "grant" in r.status.lower()),
                })
        ctx["pass_"] = {
            "type":       "Member",
            "name":       row.owner_name or "—",
            "plate":      row.number_plate or "",
            "subline":    f"Dept: {row.department or '—'} · Tag: {row.rfid_tag or '—'}",
            "purpose":    "",
            "valid_from": row.activated_at.strftime("%Y-%m-%d %H:%M") if row.activated_at else "—",
            "valid_to":   row.valid_until.strftime("%Y-%m-%d")        if row.valid_until  else "—",
            "is_valid":   is_valid,
            "status":     "VALID" if is_valid else "EXPIRED",
            "sub":        ("Active member — admit entry"
                           if is_valid else
                           "Membership has expired — DO NOT ADMIT"),
            "recent":     recent,
        }
    return render_template('pass_verify.html', **ctx)


# ── Home Page summary (PDF page 5 layout) ────────────────────────────────────
# Powers the 4 gradient metric cards + grouped entry/exit bar chart + the
# Income Statistics donut. Aggregated over the last 8 days so the daily bars
# match the PDF.
@app.route('/api/home_summary')
def api_home_summary():
    from datetime import date, timedelta as _td

    parking_total = ParkingTransaction.query.count()
    member_total  = Whitelist.query.filter(Whitelist.department.isnot(None)).count()
    # 3 hardware devices reported by /api/devices on-site (SRK, gate reader, cam).
    device_total  = 3
    # Orders = closed parking txns + paid member activations (same definition as /api/orders).
    order_total   = (ParkingTransaction.query.filter(ParkingTransaction.exit_at.isnot(None)).count()
                     + Whitelist.query.filter(Whitelist.paid_at.isnot(None)).count())

    today  = date.today()
    daily  = []
    for i in range(7, -1, -1):
        d     = today - _td(days=i)
        start = datetime(d.year, d.month, d.day)
        end   = start + _td(days=1)
        entries = ParkingTransaction.query.filter(
            ParkingTransaction.entry_at >= start,
            ParkingTransaction.entry_at <  end).count()
        exits   = ParkingTransaction.query.filter(
            ParkingTransaction.exit_at  >= start,
            ParkingTransaction.exit_at  <  end).count()
        daily.append({"date": d.strftime("%Y-%m-%d"),
                      "entries": entries, "exits": exits})

    temporary_income = db.session.query(
        db.func.coalesce(db.func.sum(ParkingTransaction.total_amount), 0)
    ).filter(ParkingTransaction.exit_at.isnot(None)).scalar() or 0
    member_income = db.session.query(
        db.func.coalesce(db.func.sum(Whitelist.payment_amount), 0)
    ).filter(Whitelist.paid_at.isnot(None)).scalar() or 0

    return jsonify({
        "parking_total": parking_total,
        "member_total":  member_total,
        "device_total":  device_total,
        "order_total":   order_total,
        "daily":         daily,
        "income": {"temporary": int(temporary_income),
                   "member":    int(member_income)},
    })


@app.route('/api/visitors/<int:vid>', methods=['PUT'])
@login_required
def api_visitors_update(vid):
    row = Visitor.query.get(vid)
    if not row:
        return jsonify({"status": "error", "message": "not found"}), 404
    d = request.json or {}
    if 'name' in d:
        nm = (d.get('name') or '').strip()
        if not nm:
            return jsonify({"status": "error", "message": "Visitor name is required"}), 400
        row.name = nm
    if 'number_plate'  in d: row.number_plate  = (d.get('number_plate') or '').strip().upper() or None
    if 'contact'       in d: row.contact       = (d.get('contact') or '').strip() or None
    if 'purpose'       in d: row.purpose       = (d.get('purpose') or '').strip() or None
    if 'host_employee' in d: row.host_employee = (d.get('host_employee') or '').strip() or None
    db.session.commit()
    AuditEvent.log(f"Visitor updated: {row.name}", area='Admin')
    return jsonify({"status": "ok", "visitor": row.to_dict()})


# ── Visitors (time-bound temporary access) ───────────────────────────────────
@app.route('/api/visitors', methods=['GET', 'POST'])
@login_required
def api_visitors():
    if request.method == 'POST':
        data = request.json or {}
        name  = (data.get('name') or '').strip()
        plate = clean_plate_number(data.get('number_plate') or '')
        if not name or not plate:
            return jsonify({"status": "error", "message": "name and plate required"}), 400
        # Accept ISO ('YYYY-MM-DDTHH:MM') or 'YYYY-MM-DD HH:MM' for start/end.
        def _parse(s, default=None):
            if not s:
                return default
            s = s.strip().replace('T', ' ')
            for fmt in ('%Y-%m-%d %H:%M', '%Y-%m-%d %H:%M:%S', '%Y-%m-%d'):
                try:
                    return datetime.strptime(s, fmt)
                except ValueError:
                    continue
            return default
        start_at = _parse(data.get('start_at'), datetime.now())
        end_at   = _parse(data.get('end_at'),   datetime.now() + timedelta(hours=8))
        if end_at <= start_at:
            return jsonify({"status": "error", "message": "end_at must be after start_at"}), 400
        v = Visitor(
            name=name,
            number_plate=plate,
            rfid_tag=(data.get('rfid_tag') or '').strip().upper() or None,
            purpose=(data.get('purpose') or '').strip() or None,
            contact=(data.get('contact') or '').strip() or None,
            host_employee=(data.get('host_employee') or '').strip() or None,
            start_at=start_at,
            end_at=end_at,
        )
        db.session.add(v)
        db.session.commit()
        AuditEvent.log(f"Visitor pass: {name} ({plate}) until {end_at.strftime('%Y-%m-%d %H:%M')}", area='Admin')
        return jsonify({"status": "ok", "visitor": v.to_dict()})
    return jsonify([v.to_dict()
                    for v in Visitor.query.order_by(Visitor.start_at.desc()).all()])


@app.route('/api/visitors/<int:vid>', methods=['DELETE'])
@login_required
def api_visitors_delete(vid):
    row = Visitor.query.get(vid)
    if not row:
        return jsonify({"status": "error", "message": "not found"}), 404
    label = f"{row.name} ({row.number_plate})"
    db.session.delete(row)
    db.session.commit()
    AuditEvent.log(f"Visitor pass removed: {label}", area='Admin')
    return jsonify({"status": "ok"})


# ── Entry-time-rule windows ──────────────────────────────────────────────────
@app.route('/api/entry_windows', methods=['GET', 'POST'])
@admin_required
def api_entry_windows():
    """GET returns the configured blocked windows ('HH:MM-HH:MM,HH:MM-HH:MM').
    POST {'windows': '...'} replaces them. Empty string disables blocking."""
    if request.method == 'POST':
        data = request.json or {}
        val  = (data.get('windows') or '').strip()
        # Light validation — ignore malformed segments, keep the rest
        clean_parts = []
        for seg in val.split(','):
            seg = seg.strip()
            if not seg:
                continue
            if re.match(r'^\d{1,2}:\d{2}-\d{1,2}:\d{2}$', seg):
                clean_parts.append(seg)
        Setting.set('entry_blocked_windows', ','.join(clean_parts))
        AuditEvent.log(f"Entry windows updated: {','.join(clean_parts) or '(none)'}", area='Admin')
        return jsonify({"status": "ok", "windows": ','.join(clean_parts)})
    return jsonify({"windows": Setting.get('entry_blocked_windows', '') or ''})


# ── Long-parked alerts ───────────────────────────────────────────────────────
@app.route('/api/long_parked')
def api_long_parked():
    """Returns active vehicles whose dwell time exceeds Setting 'max_dwell_hours'
    (default 12). UI banner uses this to flag stranded/forgotten vehicles."""
    try:
        max_h = float(Setting.get('max_dwell_hours', '12') or 12)
    except ValueError:
        max_h = 12.0
    cutoff = datetime.now() - timedelta(hours=max_h)
    rows = (ParkingTransaction.query
            .filter(ParkingTransaction.exit_at.is_(None))
            .filter(ParkingTransaction.entry_at <= cutoff)
            .order_by(ParkingTransaction.entry_at.asc()).all())
    now = datetime.now()
    out = []
    for tx in rows:
        elapsed = (now - tx.entry_at).total_seconds()
        out.append({
            **tx.to_dict(),
            "elapsed_hours":   round(elapsed / 3600, 1),
            "threshold_hours": max_h,
        })
    return jsonify({"threshold_hours": max_h, "vehicles": out})


# ── UHF hourly entry/exit lists (Reports) ────────────────────────────────────
@app.route('/api/uhf_hourly')
def api_uhf_hourly():
    """Returns hourly UHF (RFID/UHF) entry + exit lists for the selected date.
    The data is sourced from ParkingTransaction rows (mode='RFID/UHF') —
    so "the db" already holds it; this endpoint just buckets by hour for
    the Reports view.

    Query params:
      date=YYYY-MM-DD   (default: today)
    """
    date_str = (request.args.get('date') or '').strip()
    try:
        day = (datetime.strptime(date_str, '%Y-%m-%d') if date_str
               else datetime.now()).date()
    except ValueError:
        day = datetime.now().date()
    day_start = datetime.combine(day, datetime.min.time())
    day_end   = day_start + timedelta(days=1)

    entries = (ParkingTransaction.query
               .filter(ParkingTransaction.mode == 'RFID/UHF')
               .filter(ParkingTransaction.entry_at >= day_start,
                       ParkingTransaction.entry_at <  day_end)
               .order_by(ParkingTransaction.entry_at.asc()).all())
    exits = (ParkingTransaction.query
             .filter(ParkingTransaction.mode == 'RFID/UHF')
             .filter(ParkingTransaction.exit_at  >= day_start,
                     ParkingTransaction.exit_at  <  day_end)
             .order_by(ParkingTransaction.exit_at.asc()).all())

    hours = [{"hour": h,
              "label": f"{h:02d}:00–{(h+1)%24:02d}:00",
              "entries": [], "exits": []} for h in range(24)]

    def _item(tx, ts, kind):
        return {
            "id":           tx.id,
            "time":         ts.strftime("%H:%M:%S"),
            "vehicle":      tx.vehicle,
            "owner":        tx.owner_name or "",
            "vehicle_type": tx.vehicle_type,
            "identity":     tx.identity or "",
            "zone":         tx.zone or "",
        }

    for tx in entries:
        hours[tx.entry_at.hour]["entries"].append(_item(tx, tx.entry_at, 'in'))
    for tx in exits:
        hours[tx.exit_at.hour]["exits"].append(_item(tx, tx.exit_at, 'out'))

    return jsonify({
        "date":           day.strftime('%Y-%m-%d'),
        "entries_total":  len(entries),
        "exits_total":    len(exits),
        "hours":          hours,
    })


# ─────────────────────────────────────────────────────────────────────────────
# Boot — shared between dev (`python app.py`) and WSGI (`waitress-serve app:app`)
# ─────────────────────────────────────────────────────────────────────────────
def _boot():
    """Run DB migrations + start hardware threads. Idempotent.
    Called once at module import so WSGI servers (waitress / gunicorn) that
    `import app; app.app` get the same setup as `python app.py`."""
    with app.app_context():
        db.create_all()
        migrate_schema(db.engine)
        seed_defaults()

    if CLOUD_MODE:
        print("[CLOUD] Skipping rfid/camera/worker threads — admin+reports API only")
        return

    rfid.start()
    desktop_rfid.start()
    threading.Thread(target=rfid_monitor,  daemon=True).start()
    threading.Thread(target=camera_loop,   daemon=True).start()
    threading.Thread(target=worker_thread, daemon=True).start()

_boot()


if __name__ == '__main__':
    # PORT is honored so the same entry works on Render/Fly/Koyeb (which set $PORT).
    port = int(os.environ.get('PORT', 5002))
    print(f"[INFO] VayAccess Systems starting on http://0.0.0.0:{port}  (CLOUD_MODE={CLOUD_MODE})")
    app.run(host='0.0.0.0', port=port, threaded=True, debug=False)
