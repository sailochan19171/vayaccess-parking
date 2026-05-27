import socket
import threading
import time
import binascii

def crc_ccitt(data):
    crc = 0xFFFF
    for b in data:
        crc ^= (b << 8)
        for _ in range(8):
            if crc & 0x8000:
                crc = ((crc << 1) ^ 0x1021) & 0xFFFF
            else:
                crc = (crc << 1) & 0xFFFF
    return crc

class RFIDReader:
    def __init__(self, ip='192.168.0.200', port=200):
        self.ip = ip
        self.port = port
        self.is_running = False
        self.latest_tag = None
        self.sock = None
        self.status = "Disconnected"

    def start(self):
        self.is_running = True
        threading.Thread(target=self._listen, daemon=True).start()

    def _listen(self):
        def build_cmd(cmd, data_bytes=b""):
            length = 1 + 1 + len(data_bytes) + 2
            frame = bytearray([0xAA, 0xAA, 0xFF, length, cmd])
            frame.extend(data_bytes)
            c = crc_ccitt(frame)
            frame.append(c >> 8)
            frame.append(c & 0xFF)
            return bytes(frame)

        # Build commands
        cmd_set_power = build_cmd(0x3B, b"\x00\x0B\xB8")     # Set power to 30 dBm (CMDL=00, Power=0BB8)
        cmd_get_ant = build_cmd(0x3F, b"\x01")               # Get antenna parameters (CMDL=01)
        cmd_single_inventory = build_cmd(0xC8, b"\x00")      # Single Tag Inventory (C8 00)
        
        while self.is_running:
            try:
                self.status = "Connecting"
                print(f"[RFID] Connecting to reader at {self.ip}:{self.port}...")
                self.sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
                self.sock.settimeout(2.0)
                self.sock.connect((self.ip, self.port))
                self.status = "Connected"
                print("[RFID] Connected successfully!")
                
                # Clear initial greeting
                try:
                    self.sock.recv(1024)
                except:
                    pass
                
                # Set RF power to 30 dBm
                print("[RFID] Setting RF Power to 30 dBm...")
                self.sock.send(cmd_set_power)
                try:
                    res = self.sock.recv(1024)
                    print(f"[RFID] Power Set Response: {res.hex().upper()}")
                except Exception as p_err:
                    print(f"[RFID] Failed to get response for setting power: {p_err}")
                
                # Query antenna parameters
                print("[RFID] Querying Antenna Parameters...")
                self.sock.send(cmd_get_ant)
                try:
                    res = self.sock.recv(1024)
                    print(f"[RFID] Antenna Parameters Response: {res.hex().upper()}")
                except Exception as ant_err:
                    print(f"[RFID] Failed to get response for antenna parameters: {ant_err}")
                
                buffer = bytearray()
                while self.is_running:
                    try:
                        # Send Single Tag Inventory C8 00
                        self.sock.send(cmd_single_inventory)
                        
                        # Wait for response
                        data = self.sock.recv(1024)
                        if not data:
                            self.status = "Disconnected"
                            print("[RFID] Connection closed by reader. Reconnecting...")
                            break
                        
                        buffer.extend(data)
                        
                        # Parse all complete frames from the buffer
                        while True:
                            idx = buffer.find(b"\xAA\xAA")
                            if idx == -1:
                                if len(buffer) > 0:
                                    buffer = buffer[-1:]
                                break
                            
                            # Remove garbage before preamble
                            if idx > 0:
                                buffer = buffer[idx:]
                                idx = 0
                                
                            # Check if we have length byte
                            if len(buffer) < 4:
                                break
                                
                            length = buffer[3]
                            total_len = 3 + length
                            
                            if len(buffer) < total_len:
                                break
                                
                            # Extract complete frame
                            frame = bytes(buffer[:total_len])
                            buffer = buffer[total_len:]
                            
                            if len(frame) >= 6:
                                msg = frame[:-2]
                                expected_crc = crc_ccitt(msg)
                                actual_crc = (frame[-2] << 8) | frame[-1]
                                
                                if expected_crc == actual_crc:
                                    cmd = frame[4]
                                    payload = frame[5:-2]
                                    
                                    # Status is payload[1] for C8 00 responses (payload[0] is CMDL 00)
                                    status = payload[1] if len(payload) >= 2 else 0xFF
                                    
                                    # Filter out standard Timeout / "No Tag" messages (0x15)
                                    if status != 0x15:
                                        print(f"[RFID DEBUG] Valid Frame: CMD={cmd:02X} Payload={payload.hex().upper()}")
                                        
                                        # Parse tag data from C8 00 success response
                                        # Format: CMDL(00) + Status(00) + RSSI(1B) + PC(2B) + EPC(Length defined as PC) + StoredCRC(2B) + ANT(1B)
                                        if cmd == 0xC8 and status == 0x00 and len(payload) >= 5:
                                            pc = (payload[3] << 8) | payload[4]
                                            epc_len = (pc >> 11) * 2
                                            if 2 <= epc_len <= 32 and len(payload) >= 5 + epc_len:
                                                epc = payload[5 : 5 + epc_len].hex().upper()
                                                self.latest_tag = epc
                                                print(f"[RFID] Tag Read Successfully: {epc}")
                                else:
                                    print(f"[RFID DEBUG] Invalid CRC on frame: {frame.hex().upper()}")
                                    
                        time.sleep(0.3)
                        
                    except socket.timeout:
                        pass
                    except Exception as e:
                        self.status = f"Read Error: {str(e)}"
                        print(f"[RFID] Read error: {e}")
                        break
                        
            except Exception as e:
                self.status = "Connection Failed"
                print(f"[RFID] Connection failed: {e}. Retrying in 5 seconds...")
                time.sleep(5)
            finally:
                if self.sock:
                    self.sock.close()

    def get_latest_tag(self):
        tag = self.latest_tag
        self.latest_tag = None # Clear it after reading
        return tag

    def stop(self):
        self.is_running = False
        if self.sock:
            self.sock.close()
