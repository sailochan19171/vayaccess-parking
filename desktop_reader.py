"""Desktop UHF reader driver (USB-CDC serial).

Supports two common protocol families used by generic Chinese UHF desktop
readers (Chafon-compat, IDT-IoT). On startup the driver pokes both protocols;
whichever one responds wins. A passive-listen fallback also exists in case
the reader is already in auto-push mode.

Protocols probed (in order):
  1. Chafon-style: `A0 <LEN> <ADDR> <CMD> ... <CRC16>`  — inventory cmd 0x80
  2. IDT-IoT:      `AA AA FF <LEN> <CMD> ... <CRC16>`   — inventory cmd 0xC8

Raw bytes received from the port are also kept in a ring buffer for the
/api/desktop_reader/raw_dump diagnostic endpoint so we can see exactly what
the reader is sending and adapt the parser if needed.

This module is safe to import even when no reader is plugged in; .start()
will retry connection in the background and `status` reflects current state.
"""
import threading
import time
import collections

try:
    import serial
    from serial.tools import list_ports
    PYSERIAL_OK = True
except ImportError:
    PYSERIAL_OK = False


def crc_ccitt(data: bytes) -> int:
    """CCITT-CRC16 (poly 0x1021, init 0xFFFF) — used by IDT-IoT frames."""
    crc = 0xFFFF
    for b in data:
        crc ^= (b << 8)
        for _ in range(8):
            if crc & 0x8000:
                crc = ((crc << 1) ^ 0x1021) & 0xFFFF
            else:
                crc = (crc << 1) & 0xFFFF
    return crc


def crc16_chafon(data: bytes) -> int:
    """CRC16 used by Chafon-protocol readers (poly 0x8408, init 0xFFFF, LSB-first).
    Returned as little-endian int — sent CRC_LO then CRC_HI on the wire."""
    crc = 0xFFFF
    for b in data:
        crc ^= b
        for _ in range(8):
            if crc & 1:
                crc = (crc >> 1) ^ 0x8408
            else:
                crc >>= 1
    return crc & 0xFFFF


# ── IDT-IoT framing (same as the network gate reader) ────────────────────────
def _build_idt_cmd(cmd: int, data_bytes: bytes = b"") -> bytes:
    length = 1 + 1 + len(data_bytes) + 2
    frame = bytearray([0xAA, 0xAA, 0xFF, length, cmd])
    frame.extend(data_bytes)
    c = crc_ccitt(frame)
    frame.append(c >> 8)
    frame.append(c & 0xFF)
    return bytes(frame)


# ── Chafon framing: A0 <LEN> <ADDR> <CMD> [<DATA>] <CRC_LO> <CRC_HI> ─────────
def _build_chafon_cmd(cmd: int, data_bytes: bytes = b"", addr: int = 0xFF) -> bytes:
    body = bytearray([0xA0])
    length = 1 + 1 + 1 + len(data_bytes) + 2   # ADDR + CMD + DATA + CRC16
    body.append(length)
    body.append(addr)
    body.append(cmd)
    body.extend(data_bytes)
    c = crc16_chafon(bytes(body))
    body.append(c & 0xFF)
    body.append((c >> 8) & 0xFF)
    return bytes(body)


# IDT commands (legacy network-reader protocol)
CMD_IDT_SET_POWER          = _build_idt_cmd(0x3B, b"\x00\x0B\xB8")   # 30 dBm
CMD_IDT_SINGLE_INVENTORY   = _build_idt_cmd(0xC8, b"\x00")

# Chafon commands. 0x80 = "ISO18000-6C Inventory" (Single tag identifier).
# Address byte 0xFF = broadcast (works on any single-reader bus).
CMD_CHAFON_INVENTORY       = _build_chafon_cmd(0x80, b"")


# ── CCS / Hopeland framing: BB <TYPE> <CMD> <LEN_HI> <LEN_LO> [<DATA>] <CHK> 7E ──
def _build_ccs_cmd(cmd: int, data_bytes: bytes = b"") -> bytes:
    body = bytearray([0xBB, 0x00, cmd])
    body.append((len(data_bytes) >> 8) & 0xFF)
    body.append(len(data_bytes) & 0xFF)
    body.extend(data_bytes)
    chk = 0
    for b in body[1:]:           # checksum: sum of bytes from TYPE to end-of-data, mod 256
        chk = (chk + b) & 0xFF
    body.append(chk)
    body.append(0x7E)
    return bytes(body)


# CCS commands
CMD_CCS_GET_INFO       = _build_ccs_cmd(0x03)   # "Get reader hardware version" — safe handshake
CMD_CCS_SINGLE_POLL    = _build_ccs_cmd(0x22)   # ISO18000-6C single-poll inventory
CMD_CCS_MULTIPLE_POLL  = _build_ccs_cmd(0x27, b"\x22\x27\x10")  # continuous poll (10x default)
CMD_CCS_STOP_POLL      = _build_ccs_cmd(0x28)


def list_available_ports():
    """Return [{'device': 'COM3', 'description': '...'}] for the UI's port picker."""
    if not PYSERIAL_OK:
        return []
    out = []
    for p in list_ports.comports():
        out.append({"device": p.device, "description": p.description or ""})
    return out


class DesktopReader:
    """Thread-managed SRK-F206 driver. start() launches a daemon that
    auto-connects, polls inventory, and exposes the latest scanned EPC."""

    # Common SRK-F206 vendor/product strings — used for auto-detect when no
    # COM port is configured. (We just match on the description containing
    # one of these tokens. False matches are harmless — a wrong COM port just
    # won't respond to our IDT commands and reconnect.)
    AUTODETECT_HINTS = ("CP210", "CH340", "FTDI", "USB-SERIAL", "Silicon Labs",
                        "SRK", "UHF", "Reader")

    def __init__(self, port: str = None, baudrate: int = 115200,
                  one_shot_mode: bool = True):
        self.port      = port           # explicit COM port or None for autodetect
        self.baudrate  = baudrate
        self.is_running = False
        self.latest_tag = None
        self.last_seen_at = 0.0
        self.ser = None
        self.status = "Disconnected"
        self.active_protocol = None     # last-detected protocol (display only:
                                         # 'rf52' | 'ccs' | 'chafon' | 'idt')
        # One-shot mode: once latest_tag is held, ignore further reads from
        # the hardware (it auto-broadcasts in a loop). User must click Clear
        # to release the lock and accept the next tag. This is the enrollment
        # UX — one scan, freeze, deliberate clear, next scan.
        self.one_shot_mode = one_shot_mode
        # Ring buffer of recently-received raw bytes (capped, for diagnostics)
        self.raw_buffer = collections.deque(maxlen=2048)
        self._lock = threading.Lock()

    def configure(self, port: str, baudrate: int = 115200):
        """Change port at runtime; the worker loop will reconnect."""
        with self._lock:
            self.port = port
            self.baudrate = baudrate
            if self.ser:
                try:
                    self.ser.close()
                except Exception:
                    pass
                self.ser = None

    def start(self):
        if self.is_running:
            return
        if not PYSERIAL_OK:
            self.status = "pyserial not installed"
            print("[SRK-F206] pyserial missing — desktop reader disabled")
            return
        self.is_running = True
        threading.Thread(target=self._listen, daemon=True).start()

    def _autodetect_port(self):
        """Pick the first COM port whose description hints at a USB-serial dongle.
        Returns the device name or None."""
        ports = list_ports.comports()
        if not ports:
            return None
        for p in ports:
            desc = (p.description or "").upper()
            if any(h.upper() in desc for h in self.AUTODETECT_HINTS):
                return p.device
        # No hint matched — fall back to the first available port
        return ports[0].device

    def _listen(self):
        while self.is_running:
            with self._lock:
                want_port = self.port
            try:
                if not want_port:
                    want_port = self._autodetect_port()
                if not want_port:
                    self.status = "No COM port found"
                    time.sleep(5)
                    continue

                self.status = f"Connecting {want_port}"
                print(f"[Reader] opening {want_port} @ {self.baudrate}")
                ser = serial.Serial(want_port, self.baudrate, timeout=0.3,
                                    write_timeout=1.0,
                                    bytesize=serial.EIGHTBITS,
                                    parity=serial.PARITY_NONE,
                                    stopbits=serial.STOPBITS_ONE)
                # Many Chinese USB-serial dongles (CH340/CP210x) need DTR+RTS
                # asserted high to enable the RS232 transceiver. Without this
                # the writes succeed in the kernel buffer but never reach the
                # reader — which is exactly the "zero bytes back" symptom.
                try:
                    ser.dtr = True
                    ser.rts = True
                except Exception:
                    pass
                with self._lock:
                    self.ser = ser
                self.status = f"Connected {want_port}"
                print(f"[Reader] connected on {want_port} (DTR/RTS asserted)")

                # Clear any boot banner
                try:
                    time.sleep(0.2)
                    ser.reset_input_buffer()
                except Exception:
                    pass

                # ── Protocol auto-probe ──────────────────────────────────────
                # Rotate through known protocols. Whichever one yields bytes
                # within a few writes wins.
                #   ccs    — BB...7E framing (Hopeland/CCS family, matches the
                #            "Work Parameter / Transfer Parameter / Ext Function /
                #            Write Tag" vendor app layout)
                #   chafon — A0...CRC16 framing
                #   idt    — AA AA FF... framing (same as the network gate reader)
                probe_order  = ['ccs', 'chafon', 'idt']
                probe_cmds   = {
                    'ccs':    [CMD_CCS_GET_INFO, CMD_CCS_MULTIPLE_POLL],
                    'chafon': [CMD_CHAFON_INVENTORY],
                    'idt':    [CMD_IDT_SINGLE_INVENTORY],
                }
                # NOTE: this particular reader (firmware 3.3.5, Type:3) actually
                # auto-streams tag frames with preamble 0x52 0x46 ("RF") in
                # response to CCS get-info — see _parse_rf52. The CCS get-info
                # command is enough to wake it up; the RF parser handles the
                # response stream regardless of which probe is "active".
                #
                # Separation of concerns:
                #   probe_protocol  — which command set we're currently SENDING
                #                     (rotates if no bytes come back)
                #   active_protocol — what was last DETECTED on the wire
                #                     (display only; can be 'rf52' which is
                #                     receive-only and never a probe)
                probe_protocol = probe_order[0]
                buffer = bytearray()
                idle_polls = 0
                cmd_rotator = 0
                while self.is_running:
                    cmds = probe_cmds[probe_protocol]
                    cmd_to_send = cmds[cmd_rotator % len(cmds)]
                    cmd_rotator += 1
                    try:
                        ser.write(cmd_to_send)
                        ser.flush()
                    except Exception as w_err:
                        print(f"[Reader] write failed: {w_err}")
                        break

                    try:
                        chunk = ser.read(512)
                    except Exception as r_err:
                        print(f"[Reader] read failed: {r_err}")
                        break

                    if chunk:
                        buffer.extend(chunk)
                        for b in chunk:
                            self.raw_buffer.append(b)
                        idle_polls = 0
                    else:
                        idle_polls += 1
                        # Silent for ~3 seconds? Rotate to next probe protocol.
                        if idle_polls >= 15:
                            probe_idx = (probe_order.index(probe_protocol) + 1) % len(probe_order)
                            probe_protocol = probe_order[probe_idx]
                            cmd_rotator = 0
                            print(f"[Reader] no response — probing {probe_protocol}")
                            idle_polls = 0
                        if idle_polls > 5:
                            time.sleep(0.05)

                    # Parse with all four parsers. Each uses a distinct preamble
                    # (52 46 / BB / A0 / AA AA) so they don't fight over bytes.
                    # RF52 is this reader's actual format — see _parse_rf52 docs.
                    self._parse_rf52(buffer)
                    self._parse_ccs(buffer)
                    self._parse_chafon(buffer)
                    self._parse_idt(buffer)

                    time.sleep(0.2)

            except serial.SerialException as e:
                self.status = f"Port error: {e}"
                print(f"[SRK-F206] serial error: {e} — retrying in 4s")
                time.sleep(4)
            except Exception as e:
                self.status = f"Error: {e}"
                print(f"[SRK-F206] unexpected error: {e} — retrying in 4s")
                time.sleep(4)
            finally:
                with self._lock:
                    if self.ser:
                        try:
                            self.ser.close()
                        except Exception:
                            pass
                        self.ser = None

    def _commit_epc(self, epc_hex: str, protocol: str):
        if not epc_hex:
            return
        epc_hex = epc_hex.upper()
        # Sanity: EPCs are at least 8 hex chars (32-bit short EPC, rare) up to
        # 24 (96-bit standard EPC) or higher. Reject obvious garbage.
        if len(epc_hex) < 8 or len(epc_hex) > 64:
            return
        # One-shot lock: if we're already holding a tag and one_shot_mode is on,
        # silently drop further reads. The hardware keeps broadcasting in a loop
        # but the UI sees one tag held until the operator presses Clear.
        if self.one_shot_mode and self.latest_tag:
            return
        self.latest_tag = epc_hex
        self.last_seen_at = time.time()
        if self.active_protocol != protocol:
            self.active_protocol = protocol
            print(f"[Reader] protocol locked: {protocol}")
        print(f"[Reader] tag ({protocol}): {epc_hex}")

    def _parse_rf52(self, buffer: bytearray):
        """Pull tag frames from the 'RF52' proprietary protocol used by the
        firmware-3.3.5 / Type:3 desktop reader (window title "UHF RFID Test
        Demo V1.1.4"). Observed frame layout, 28 bytes for a standard 96-bit EPC:

            52 46  02 00 00 80 00 13  50 11 01 <LEN>  <EPC...>  05 01 <CHK_LO> <CHK_HI>
            └──┬──┘ └──────┬─────────┘ └────┬────┘    └─┬──────┘  └────────┬────────────┘
            preamble    constant hdr     tag-info   EPC bytes      trailer + RSSI/counter

        <LEN> at offset 11 is the EPC byte length (0x0C = 12 bytes for 96-bit).
        We don't trust a CRC here — same EPC arrives with different trailer
        bytes each frame — but the preamble + length + plausible EPC bytes
        give us a reliable parse.
        """
        while True:
            idx = buffer.find(b"\x52\x46")
            if idx == -1:
                # No preamble; drop everything but the last byte (it might be
                # the 0x52 of a half-arrived frame).
                if len(buffer) > 64:
                    del buffer[:-1]
                return
            if idx > 0:
                del buffer[:idx]
            if len(buffer) < 12:                # need at least up to <LEN>
                return
            epc_len = buffer[11]
            # Sanity: EPC lengths in the wild are 4 (32-bit), 8 (64-bit),
            # 12 (96-bit, standard), or 16 (128-bit). Anything else = bogus
            # frame, advance past this preamble and re-scan.
            if epc_len not in (4, 8, 12, 16):
                del buffer[:2]
                continue
            total = 12 + epc_len + 4            # header(12) + EPC(epc_len) + trailer(4)
            if len(buffer) < total:
                return
            frame = bytes(buffer[:total])
            del buffer[:total]
            # Validate trailer starts with 0x05 0x01 (constant across all observed
            # frames). If not, this preamble was a false hit inside another frame's
            # payload — skip and re-scan.
            if frame[12 + epc_len] != 0x05 or frame[12 + epc_len + 1] != 0x01:
                continue
            epc = frame[12: 12 + epc_len].hex()
            self._commit_epc(epc, 'rf52')

    def _parse_ccs(self, buffer: bytearray):
        """Pull `BB <TYPE> <CMD> <LEN_HI> <LEN_LO> <DATA> <CHK> 7E` frames.
        Tag-notification responses typically come on cmd 0x22 (single-poll
        response) or 0x27 (multiple-poll real-time notification)."""
        while True:
            idx = buffer.find(b"\xBB")
            if idx == -1:
                return
            if idx > 0:
                del buffer[:idx]
            if len(buffer) < 7:                  # minimum frame: BB TYPE CMD L L CHK 7E
                return
            data_len = (buffer[3] << 8) | buffer[4]
            total = 2 + 3 + data_len + 1 + 1     # BB + (TYPE+CMD+LEN) + DATA + CHK + 7E
            if total > 1024:                     # sanity bail
                del buffer[:1]
                continue
            if len(buffer) < total:
                return
            frame = bytes(buffer[:total])
            del buffer[:total]
            if frame[-1] != 0x7E:                # bad trailer — desync
                continue
            # Verify checksum (sum of bytes from TYPE through end-of-DATA)
            chk_calc = 0
            for b in frame[1: -2]:
                chk_calc = (chk_calc + b) & 0xFF
            if chk_calc != frame[-2]:
                continue
            cmd = frame[2]
            payload = frame[5:-2]
            # Tag-notification payload for cmd 0x22 / 0x27:
            #   <RSSI(1)> <PC(2)> <EPC(N)> <CRC(2)>     ← classic CCS layout
            # Drop RSSI + PC (first 3) and CRC (last 2); what's left is the EPC.
            if cmd in (0x22, 0x27) and len(payload) >= 7:
                epc_bytes = payload[3:-2]
                if 4 <= len(epc_bytes) <= 32:
                    self._commit_epc(epc_bytes.hex(), 'ccs')

    def _parse_chafon(self, buffer: bytearray):
        """Pull A0-framed responses from buffer. Mutates `buffer` in place,
        consuming bytes as frames are extracted."""
        while True:
            idx = buffer.find(b"\xA0")
            if idx == -1:
                # No preamble in sight — but don't drop too much, the byte
                # we want might arrive next read.
                if len(buffer) > 64 and not buffer[:].count(0xAA):
                    del buffer[:-2]
                return
            if idx > 0:
                del buffer[:idx]
            if len(buffer) < 2:
                return
            length = buffer[1]                  # bytes after the length byte
            total = 2 + length                  # 0xA0 + length byte + length bytes
            if total < 5 or total > 200:        # sanity
                del buffer[:1]
                continue
            if len(buffer) < total:
                return
            frame = bytes(buffer[:total])
            del buffer[:total]
            body = frame[:-2]
            crc_recv = frame[-2] | (frame[-1] << 8)
            if crc16_chafon(body) != crc_recv:
                continue
            cmd = frame[3]
            payload = frame[4:-2]               # everything between CMD and CRC
            # Status byte handling: for ISO18000-6C Inventory (0x80) responses,
            # the typical layout is: <STATUS> <NUM> <DATA_LEN> <PC(2)> <EPC(N)> <CRC(2)> <ANT> <COUNT>
            if cmd == 0x80 and len(payload) >= 5:
                status = payload[0]
                # 0x00 = success with tags; many docs use 0x01 = "no tag"
                if status not in (0x00, 0x01) and status not in (0x03,):
                    continue
                if status in (0x01,):
                    continue
                # num_tags follows, then per-tag: data_len + PC(2) + EPC + CRC(2)
                cursor = 1
                num_tags = payload[cursor] if cursor < len(payload) else 0
                cursor += 1
                tags_found = 0
                while tags_found < num_tags and cursor < len(payload):
                    data_len = payload[cursor]; cursor += 1
                    if data_len < 4 or cursor + data_len > len(payload):
                        break
                    # PC=2, EPC=data_len-4, CRC=2  (data_len includes everything but itself)
                    if data_len >= 4:
                        epc_bytes = payload[cursor + 2: cursor + data_len - 2]
                        self._commit_epc(epc_bytes.hex(), 'chafon')
                    cursor += data_len
                    tags_found += 1
            elif cmd == 0x81:
                # 0x81 = "Real-time Inventory" — used in continuous/active mode.
                # Payload: <ADDR> <STATUS> <ANT> <DATA_LEN> <PC(2)> <EPC...> <RSSI>
                if len(payload) >= 6:
                    data_len = payload[3]
                    if data_len >= 4 and 4 + data_len <= len(payload):
                        epc_bytes = payload[6: 4 + data_len]
                        self._commit_epc(epc_bytes.hex(), 'chafon')

    def _parse_idt(self, buffer: bytearray):
        """Pull AA-AA-FF framed responses (the IDT protocol)."""
        while True:
            idx = buffer.find(b"\xAA\xAA")
            if idx == -1:
                return
            if idx > 0:
                del buffer[:idx]
            if len(buffer) < 4:
                return
            length = buffer[3]
            total_len = 3 + length
            if total_len < 6 or total_len > 200:
                del buffer[:1]
                continue
            if len(buffer) < total_len:
                return
            frame = bytes(buffer[:total_len])
            del buffer[:total_len]
            body = frame[:-2]
            actual_crc = (frame[-2] << 8) | frame[-1]
            if crc_ccitt(body) != actual_crc:
                continue
            cmd = frame[4]
            payload = frame[5:-2]
            status_b = payload[1] if len(payload) >= 2 else 0xFF
            if status_b == 0x15:
                continue
            if cmd == 0xC8 and status_b == 0x00 and len(payload) >= 5:
                pc = (payload[3] << 8) | payload[4]
                epc_len = (pc >> 11) * 2
                if 2 <= epc_len <= 32 and len(payload) >= 5 + epc_len:
                    epc = payload[5: 5 + epc_len].hex()
                    self._commit_epc(epc, 'idt')

    def get_raw_dump(self, max_bytes: int = 512) -> str:
        """Return the last N bytes received from the reader as hex, for diagnostics."""
        snapshot = list(self.raw_buffer)[-max_bytes:]
        return bytes(snapshot).hex().upper()

    def peek_latest_tag(self, max_age_s: float = 30.0):
        """Return latest scanned tag if seen within max_age_s, without clearing it.
        UI polls this; it stays visible for max_age_s so a slow operator can still
        click 'Save'. Cleared by clear_latest_tag() once enrollment is submitted."""
        if self.latest_tag and (time.time() - self.last_seen_at) <= max_age_s:
            return self.latest_tag
        return None

    def clear_latest_tag(self):
        self.latest_tag = None
        self.last_seen_at = 0.0

    def stop(self):
        self.is_running = False
        with self._lock:
            if self.ser:
                try:
                    self.ser.close()
                except Exception:
                    pass
