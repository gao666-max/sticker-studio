#!/usr/bin/env python3
"""Smoke test for the booth software. No AI spend, no destructive changes."""
from __future__ import annotations

import json
import sys
import time
import urllib.error
import urllib.request

APP = "http://127.0.0.1:8787"
AGENT = "http://127.0.0.1:8788"
FAILS = []


def call(base, path, payload=None, token=None, method=None):
    headers = {"Content-Type": "application/json"}
    if token:
        headers["X-Booth-Token"] = token
    data = json.dumps(payload).encode() if payload is not None else None
    request = urllib.request.Request(
        base + path,
        data=data,
        headers=headers,
        method=method or ("POST" if payload is not None else "GET"),
    )
    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            return response.status, json.loads(response.read())
    except urllib.error.HTTPError as exc:
        return exc.code, json.loads(exc.read() or b"{}")


def check(name, condition, detail=""):
    mark = "PASS" if condition else "FAIL"
    print(f"[{mark}] {name}" + (f" · {detail}" if detail else ""))
    if not condition:
        FAILS.append(name)


def main():
    status, health = call(APP, "/api/health")
    check("backend health", status == 200 and health.get("ok"), health.get("provider", ""))

    status, _ = call(APP, "/api/kiosk/sessions?limit=1")
    check("booth session list requires PIN", status == 401, f"HTTP {status}")

    status, login = call(APP, "/api/booth/login", {"pin": "2468"})
    token = login.get("token") if status == 200 else ""
    check("operator PIN login", bool(token), f"HTTP {status}")

    status, sessions = call(APP, "/api/kiosk/sessions?limit=5", token=token)
    check("booth session list with token", status == 200 and "stats" in sessions, f"HTTP {status}")

    status, settings = call(APP, "/api/settings")
    booth = settings.get("booth", {})
    check("booth settings has device", bool(booth.get("deviceId")) and "effectiveBaseUrl" in booth)

    status, agent_health = call(AGENT, "/health")
    check("device agent health", status == 200 and agent_health.get("ok"))

    status, event = call(AGENT, "/event", {"action": "rotate", "delta": 1, "source": "smoke"})
    check("device event accepted", status == 202 and event.get("ok"))

    status, job = call(AGENT, "/print", {"sessionId": "smoke", "copies": 1})
    check("print accepted", status == 202 and job.get("id"), job.get("status", ""))
    if job.get("id"):
        time.sleep(1.2)
        status, updated = call(AGENT, f"/print/{job['id']}")
        check("print reaches printed", status == 200 and updated.get("status") == "printed", updated.get("status", ""))

    status, payment = call(AGENT, "/payment/intent", {"amount": 1990})
    check("payment intent created", status == 201 and payment.get("id"), payment.get("status", ""))
    if payment.get("id"):
        status, paid = call(AGENT, f"/payment/{payment['id']}/mock-paid", {})
        check("payment mock paid", status == 200 and paid.get("status") == "paid", paid.get("status", ""))

    status, _ = call(AGENT, "/printer/status", {"status": "no_paper", "message": "smoke test"})
    check("printer no-paper reported", status == 200)
    status, failed_job = call(AGENT, "/print", {"sessionId": "smoke-no-paper", "copies": 1})
    check("print fails when no paper", status == 202 and failed_job.get("status") == "failed", failed_job.get("error", ""))
    status, alerts = call(AGENT, "/alerts")
    check("printer alert visible", status == 200 and alerts.get("count", 0) > 0, str(alerts.get("count")))
    status, cleared = call(AGENT, "/alerts/clear", {})
    check("printer alert cleared", status == 200 and cleared.get("cleared", 0) > 0)
    status, _ = call(AGENT, "/printer/status", {"status": "ok"})
    check("printer restored", status == 200)

    print()
    if FAILS:
        print(f"{len(FAILS)} failed: " + ", ".join(FAILS))
        return 1
    print("all smoke checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
