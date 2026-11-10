"""Shared helpers: .env loading, HTTP, logging. Standard library only."""
import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
DATA.mkdir(exist_ok=True)
UA = "cash-engine/1.0 (+lead pipeline)"


def load_env(path=ROOT / ".env"):
    """Minimal .env loader. Real environment variables win (GitHub Actions secrets)."""
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        v = v.strip().strip('"').strip("'")
        os.environ.setdefault(k.strip(), v)


def env(key, default=""):
    v = (os.environ.get(key) or "").strip()
    return v if v else default  # empty (e.g. unset GitHub variable) falls back to the default


def env_int(key, default):
    try:
        return int(env(key, str(default)))
    except ValueError:
        return default


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, file=sys.stderr, flush=True)


def http(method, url, data=None, headers=None, timeout=30):
    """Returns (status, body_bytes, headers, final_url). Raises only on network errors."""
    h = {"User-Agent": UA, **(headers or {})}
    body = None
    if data is not None:
        if isinstance(data, (dict, list)):
            body = json.dumps(data).encode()
            h.setdefault("Content-Type", "application/json")
        elif isinstance(data, str):
            body = data.encode()
        else:
            body = data
    req = urllib.request.Request(url, data=body, headers=h, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read(), dict(r.headers), r.geturl()
    except urllib.error.HTTPError as e:
        return e.code, e.read() if e.fp else b"", dict(e.headers or {}), url


def http_json(method, url, data=None, headers=None, timeout=30):
    status, body, _, _ = http(method, url, data, headers, timeout)
    try:
        return status, json.loads(body.decode("utf-8") or "null")
    except (ValueError, UnicodeDecodeError):
        return status, {"_raw": body[:500].decode("utf-8", "replace")}
