"""Firebase Cloud Messaging (FCM) sender — HTTP v1 API.

Sends push notifications that survive app-kill. Wired into parking_core via
`register_push_sink` (see app.py `_boot`). Entirely OPTIONAL and self-disabling:
if the two env vars below are not set, `is_configured()` is False and nothing
is registered, so the app runs exactly as before.

Config (env vars — never commit these):
  FCM_PROJECT_ID            your Firebase project id, e.g. "vayaccess-parking"
  FCM_SERVICE_ACCOUNT_JSON  the full service-account JSON (paste as one value)

Dependencies (in requirements-cloud.txt): google-auth, requests. Imported
LAZILY inside functions so a deploy without them (and without config) never
fails at import.
"""
import os
import json
import time
import threading

_lock = threading.Lock()
_token_cache = {'tok': None, 'exp': 0.0}


def _cfg():
    return (os.environ.get('FCM_PROJECT_ID', '').strip(),
            os.environ.get('FCM_SERVICE_ACCOUNT_JSON', '').strip())


def is_configured():
    proj, sa = _cfg()
    return bool(proj and sa)


def _access_token():
    """OAuth2 access token for the FCM scope, cached until ~1 min before expiry."""
    with _lock:
        now = time.time()
        if _token_cache['tok'] and _token_cache['exp'] - 60 > now:
            return _token_cache['tok']
        from google.oauth2 import service_account          # lazy
        from google.auth.transport.requests import Request  # lazy
        _, sa_json = _cfg()
        info = json.loads(sa_json)
        creds = service_account.Credentials.from_service_account_info(
            info, scopes=['https://www.googleapis.com/auth/firebase.messaging'])
        creds.refresh(Request())
        _token_cache['tok'] = creds.token
        _token_cache['exp'] = creds.expiry.timestamp() if creds.expiry else (now + 3000)
        return creds.token


def send(token, title, body, data=None):
    """Send one push to one device token.
    Returns (ok: bool, error: str|None). error == 'unregistered' means the
    token is dead and the caller should delete it."""
    if not is_configured():
        return False, 'not_configured'
    import requests  # lazy
    proj, _ = _cfg()
    try:
        at = _access_token()
    except Exception as e:  # bad/missing service account
        return False, 'auth_error:%s' % e
    payload = {
        "message": {
            "token": token,
            "notification": {"title": title, "body": body},
            "data": {str(k): str(v) for k, v in (data or {}).items()},
            "android": {"priority": "high",
                        "notification": {"channel_id": "vay_parking", "sound": "default"}},
            "apns": {"payload": {"aps": {"sound": "default"}}},
        }
    }
    try:
        r = requests.post(
            "https://fcm.googleapis.com/v1/projects/%s/messages:send" % proj,
            headers={"Authorization": "Bearer " + at, "Content-Type": "application/json"},
            data=json.dumps(payload), timeout=10)
    except Exception as e:
        return False, 'network:%s' % e
    if r.status_code == 200:
        return True, None
    try:
        status = (r.json().get('error', {}) or {}).get('status', '')
    except Exception:
        status = ''
    if r.status_code == 404 or status in ('NOT_FOUND', 'UNREGISTERED', 'INVALID_ARGUMENT'):
        return False, 'unregistered'
    return False, 'error:%d' % r.status_code
