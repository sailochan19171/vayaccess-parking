import re

def clean_plate_number(plate_text):
    """Clean the OCR text and validate/autocorrect Indian number plate formats."""
    if not plate_text:
        return ""
        
    # Remove any non-alphanumeric characters and convert to uppercase
    cleaned = re.sub(r'[^A-Z0-9]', '', plate_text.upper())
    
    if len(cleaned) < 3 or len(cleaned) > 12:
        return ""
        
    # Letter-to-digit and digit-to-letter maps for OCR confusion correction
    l_to_d = {'O': '0', 'D': '0', 'I': '1', 'L': '1', 'T': '1', 'J': '1', 'Z': '2', 'R': '2', 'E': '3', 'A': '4', 'H': '4', 'S': '5', 'G': '6', 'B': '8', 'P': '9', 'Q': '9'}
    d_to_l = {'0': 'O', '1': 'I', '2': 'Z', '3': 'E', '4': 'A', '5': 'S', '6': 'G', '7': 'T', '8': 'B', '9': 'P'}
    
    chars = list(cleaned)
    n = len(chars)
    
    # Autocorrect Indian Plate Formats (e.g. MH12AB1234, DL4CAF4567, MH12A1234)
    # Most Indian plates start with 2 state letters (e.g., MH, DL, KA)
    if n >= 7:
        # Correct State Code (first 2 chars should be letters)
        for i in range(2):
            if chars[i].isdigit() and chars[i] in d_to_l:
                chars[i] = d_to_l[chars[i]]
                
        # Correct RTO Code (next 2 chars should be digits)
        # Note: sometimes RTO is 1 digit (e.g. DL-3), but usually 2 digits (e.g. DL-03).
        # We check chars[2] and chars[3]
        for i in range(2, 4):
            if i < n:
                if chars[i].isalpha() and chars[i] in l_to_d:
                    chars[i] = l_to_d[chars[i]]
                
        # For plates of length 10 (Format: AA 00 AA 0000 - e.g. MH12AB1234)
        if n == 10:
            # Chars 4 and 5 should be letters
            for i in range(4, 6):
                if chars[i].isdigit() and chars[i] in d_to_l:
                    chars[i] = d_to_l[chars[i]]
            # Chars 6 to 9 should be digits
            for i in range(6, 10):
                if chars[i].isalpha() and chars[i] in l_to_d:
                    chars[i] = l_to_d[chars[i]]
                    
        # For plates of length 9 (Format: AA 00 A 0000 - e.g. MH12A1234)
        elif n == 9:
            # Char 4 should be letter
            if chars[4].isdigit() and chars[4] in d_to_l:
                chars[4] = d_to_l[chars[4]]
            # Chars 5 to 8 should be digits
            for i in range(5, 9):
                if chars[i].isalpha() and chars[i] in l_to_d:
                    chars[i] = l_to_d[chars[i]]
                    
        # For plates of length 8 (Format: AA 00 0000 - e.g. MH121234 or AA 00 AA 000)
        elif n == 8:
            # If chars 4 and 5 are digits, it's likely AA 00 0000. If letters, AA 00 AA 00.
            # Let's try to see if chars 4 and 5 are mostly letters or digits.
            if chars[4].isdigit() and chars[5].isdigit():
                for i in range(4, 8):
                    if chars[i].isalpha() and chars[i] in l_to_d:
                        chars[i] = l_to_d[chars[i]]
            elif chars[4].isalpha() and chars[5].isalpha():
                for i in range(4, 6):
                    if chars[i].isdigit() and chars[i] in d_to_l:
                        chars[i] = d_to_l[chars[i]]
                for i in range(6, 8):
                    if chars[i].isalpha() and chars[i] in l_to_d:
                        chars[i] = l_to_d[chars[i]]
                        
    corrected = "".join(chars)
    
    # Strip leading zero if followed by a letter (likely OCR artifact)
    if len(corrected) > 1 and corrected[0] == '0' and corrected[1].isalpha():
        corrected = corrected[1:]
    
    # Final check: Reject obviously bad patterns (like all digits or all letters)
    if corrected.isdigit() or corrected.isalpha():
        if len(corrected) > 6:  # Let short plates like "DL" (if any) or whatever be, but reject long pure numbers/letters
            return ""
            
    # Quick regex validation check for Indian plate structure
    # Standard format: State(2 letters) + District(2 digits) + Series(1-2 letters) + Number(4 digits)
    # Or State(2 letters) + District(2 digits) + Number(4 digits)
    # Or State(2 letters) + District(2 digits) + Series(3 letters) + Number(4 digits) (e.g. for defense/etc)
    # Let's write a loose but helpful pattern match:
    # Must contain at least some letters and some digits
    has_letter = any(c.isalpha() for c in corrected)
    has_digit = any(c.isdigit() for c in corrected)
    if not (has_letter and has_digit):
        return ""
        
    return corrected

def fetch_vehicle_details(plate_number):
    """
    Simulates an API call to a vehicle registration database (like Vahan).
    In a real scenario, this would make an HTTP request using 'requests'.
    """
    print(f"[API] Searching database for plate: {plate_number}...")
    
    # Clean the input to match database formatting
    plate = clean_plate_number(plate_number)
    
    # Mock Database
    mock_db = {
        "MH12AB1234": {
            "owner": "Rajesh Kumar",
            "vehicle": "Honda City ZX",
            "registration_date": "12-Oct-2020",
            "insurance_valid_till": "11-Oct-2026",
            "status": "Active"
        },
        "KA01XYZ999": {
            "owner": "Priya Sharma",
            "vehicle": "Maruti Suzuki Swift",
            "registration_date": "05-Jan-2018",
            "insurance_valid_till": "Expired",
            "status": "Active"
        },
        "DL4CAF4567": {
            "owner": "Amit Singh",
            "vehicle": "Hyundai Creta",
            "registration_date": "22-Mar-2022",
            "insurance_valid_till": "21-Mar-2025",
            "status": "Active"
        }
    }
    
    # Optional: If you want any detected plate to return a dummy result for testing
    # we can uncomment the below code. For now, it will return Unknown if not in DB.
    
    if plate in mock_db:
        return mock_db[plate]
    else:
        # Generic response for testing purposes when showing an unknown plate
        return {
            "owner": "Unknown (Mock Data)",
            "vehicle": "Generic Vehicle",
            "registration_date": "01-Jan-2020",
            "insurance_valid_till": "Valid",
            "status": "Unverified"
        }
