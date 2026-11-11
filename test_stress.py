#!/usr/bin/env python3
"""Demo-only sequential booth stress test. No AI spend.

Runs N customers through create -> character -> GIF -> delete, then restores
the provider that was active before the test.
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import time
import urllib.error
import urllib.request
from pathlib import Path

APP = os.environ.get("STUDIO_BASE", "http://127.0.0.1:8787")
PIN = os.environ.get("BOOTH_PIN", "2468")
HERE = Path(__file__).resolve().parent


def call(path, payload=None, token=None, method=None):
    headers = {"Content-Type": "application/json"}
    if token:
        headers["X-Booth-Token"] = token
    data = json.dumps(payload).encode() if payload is not None else None
    request = urllib.request.Request(
        APP + path,
        data=data,
        headers=headers,
        method=method or ("POST" if payload is not None else "GET"),
    )
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            return response.status, json.loads(response.read())
    except urllib.error.HTTPError as exc:
        return exc.code, json.loads(exc.read() or b"{}")


def wait_status(session_id, terminal, seconds=20):
    deadline = time.time() + seconds
    status = None
    while time.time() < deadline:
        _, session = call(f"/api/kiosk/sessions/{session_id}")
        status = session.get("status")
        if status in terminal:
            return status
        time.sleep(0.4)
    return status


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--count", type=int, default=5)
    args = parser.parse_args()

    _, login = call("/api/booth/login", {"pin": PIN})
    token = login.get("token")
    if not token:
        raise SystemExit("PIN login failed")

    _, settings = call("/api/settings")
    original_provider = settings.get("provider") or "dashscope"
    call("/api/settings", {"provider": "demo"}, token=token)

    photo = "data:image/webp;base64," + base64.b64encode((HERE / "assets" / "character.webp").read_bytes()).decode()
    sessions = []
    started = time.time()
    try:
        for index in range(1, max(1, args.count) + 1):
            begin = time.time()
            _, session = call("/api/kiosk/sessions", {"photo": photo, "portraitMode": "bust"})
            session_id = session["id"]
            sessions.append(session_id)
            character = wait_status(session_id, ("character_ready", "character_failed"))
            if character != "character_ready":
                print(f"[FAIL] {index}: character={character}")
                continue
            call(f"/api/kiosk/sessions/{session_id}/gif", {"action": {"id": "receive", "word": "收到"}})
            gif = wait_status(session_id, ("gif_ready", "gif_failed"))
            print(f"[{index}] {session_id} {character} -> {gif} · {time.time() - begin:.1f}s")
        elapsed = time.time() - started
        print(f"\n{len(sessions)} sessions in {elapsed:.1f}s · {elapsed / max(1, len(sessions)):.1f}s each")
    finally:
        for session_id in sessions:
            call(f"/api/kiosk/sessions/{session_id}", token=token, method="DELETE")
        call("/api/settings", {"provider": original_provider}, token=token)
        print("cleaned sessions, provider restored to", original_provider)


if __name__ == "__main__":
    main()
