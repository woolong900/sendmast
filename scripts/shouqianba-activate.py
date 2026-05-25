#!/usr/bin/env python3
"""One-shot 收钱吧 terminal activation.

Run this exactly once per environment (or whenever Shouqianba issues a new
activation code, e.g. when binding a real merchant after testing). It calls
`/terminal/activate` signed with the vendor key, prints `terminal_sn` and
`terminal_key` from the response — copy those into `.env.production` as
`SHOUQIANBA_TERMINAL_SN` / `SHOUQIANBA_TERMINAL_KEY`, then restart the API.

Usage:
    SHOUQIANBA_VENDOR_SN=...      \\
    SHOUQIANBA_VENDOR_KEY=...     \\
    SHOUQIANBA_APP_ID=...         \\
    SHOUQIANBA_ACTIVATION_CODE=... \\
    python3 scripts/shouqianba-activate.py [device-id]

`device-id` defaults to `sendmast-web-prod`. Pick a stable, unique-per-app-id
string — Shouqianba refuses re-activation under the same device_id, so if
you change it across environments (prod / staging) you'll get clean
separation.

Why isolated as a script (not part of the API): activation is permanent,
needs zero ambient context, and we never want to wire production to
self-activate at boot — a typo in vendor_sn / vendor_key would silently
re-activate against the wrong app, and the response is the only way to
recover the terminal_key. Keeping it manual is the safe default.
"""
import hashlib
import json
import os
import sys
import urllib.request

GATEWAY = os.environ.get("SHOUQIANBA_GATEWAY", "https://vsi-api.shouqianba.com")


def required(name: str) -> str:
    val = os.environ.get(name)
    if not val:
        sys.exit(f"missing env var: {name}")
    return val


vendor_sn = required("SHOUQIANBA_VENDOR_SN")
vendor_key = required("SHOUQIANBA_VENDOR_KEY")
app_id = required("SHOUQIANBA_APP_ID")
code = required("SHOUQIANBA_ACTIVATION_CODE")
device_id = sys.argv[1] if len(sys.argv) > 1 else "sendmast-web-prod"

body = json.dumps(
    {"app_id": app_id, "code": code, "device_id": device_id},
    separators=(",", ":"),
).encode("utf-8")
sign = hashlib.md5(body + vendor_key.encode("utf-8")).hexdigest()
req = urllib.request.Request(
    f"{GATEWAY}/terminal/activate",
    data=body,
    method="POST",
    headers={"Authorization": f"{vendor_sn} {sign}", "Content-Type": "application/json"},
)
with urllib.request.urlopen(req, timeout=15) as r:
    resp = json.loads(r.read().decode("utf-8"))

print(json.dumps(resp, ensure_ascii=False, indent=2))
biz = resp.get("biz_response") or {}
if resp.get("result_code") == "200" and biz.get("terminal_sn"):
    print()
    print("# Add these to .env.production, then `docker compose up -d api`:")
    print(f"SHOUQIANBA_TERMINAL_SN={biz['terminal_sn']}")
    print(f"SHOUQIANBA_TERMINAL_KEY={biz['terminal_key']}")
    sys.exit(0)
sys.exit(1)
