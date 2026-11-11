#!/usr/bin/env python3
"""Real-provider 20-session stress test.

Uses the polished demo master as input so no client photo is uploaded. It
measures character time, GIF time, failure rate, photo deletion and claim URL
availability. No server restart while this runs.
"""
from __future__ import annotations

import base64
import json
import os
import statistics
import time
import urllib.error
import urllib.request
from datetime import datetime
from pathlib import Path

APP = os.environ.get("STUDIO_BASE", "http://127.0.0.1:8787")
PIN = os.environ.get("BOOTH_PIN", "2468")
COUNT = int(os.environ.get("STRESS_COUNT", "20"))
HERE = Path(__file__).resolve().parent
STUDIO = HERE if (HERE / "assets").exists() else HERE.parent / "sticker-studio"
REPORT = HERE / "real20-report.json"
SOURCE = STUDIO / "assets" / "character_master.png"
ACTIONS = [
    {"id": "receive", "word": "收到"},
    {"id": "love", "word": "爱你"},
    {"id": "thanks", "word": "谢谢"},
    {"id": "ok", "word": "好的"},
    {"id": "night", "word": "晚安"},
    {"id": "laugh", "word": "哈哈哈"},
]


def call(path, payload=None, token=None, method=None, timeout=20):
    headers = {"Content-Type": "application/json"}
    if token:
        headers["X-Booth-Token"] = token
    data = json.dumps(payload, ensure_ascii=False).encode() if payload is not None else None
    request = urllib.request.Request(
        APP + path,
        data=data,
        headers=headers,
        method=method or ("POST" if payload is not None else "GET"),
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.status, json.loads(response.read())
    except urllib.error.HTTPError as exc:
        try:
            body = json.loads(exc.read())
        except Exception:
            body = {"error": f"HTTP {exc.code}"}
        return exc.code, body


def wait(session_id, statuses, timeout):
    started = time.time()
    status = None
    while time.time() - started < timeout:
        _, session = call(f"/api/kiosk/sessions/{session_id}")
        status = session.get("status")
        if status in statuses:
            return status, time.time() - started, session
        time.sleep(1.5)
    return status, time.time() - started, {}


def main():
    photo = "data:image/png;base64," + base64.b64encode(SOURCE.read_bytes()).decode()
    _, login = call("/api/booth/login", {"pin": PIN})
    token = login.get("token")
    if not token:
        raise SystemExit("PIN login failed")
    _, health = call("/api/health")
    if health.get("provider") != "dashscope":
        raise SystemExit(f"provider is {health.get('provider')}, expected dashscope")
    _, usage_before = call("/api/usage")

    runs = []
    started = time.time()
    for index in range(1, COUNT + 1):
        action = ACTIONS[(index - 1) % len(ACTIONS)]
        item = {
            "index": index,
            "action": action["id"],
            "startedAt": datetime.now().astimezone().isoformat(timespec="seconds"),
            "sessionId": None,
            "characterStatus": None,
            "characterSeconds": None,
            "gifStatus": None,
            "gifSeconds": None,
            "totalSeconds": None,
            "photoDeleted": None,
            "claimStatus": None,
            "error": None,
        }
        run_started = time.time()
        try:
            status, session = call("/api/kiosk/sessions", {"photo": photo, "portraitMode": "bust"}, timeout=30)
            if status != 201:
                raise RuntimeError(session.get("error") or f"create HTTP {status}")
            session_id = session["id"]
            item["sessionId"] = session_id
            print(f"[{index}/{COUNT}] {session_id} character queued", flush=True)

            char_status, char_seconds, _ = wait(session_id, ("character_ready", "character_failed"), 180)
            item["characterStatus"] = char_status
            item["characterSeconds"] = round(char_seconds, 1)
            print(f"[{index}/{COUNT}] character {char_status} {char_seconds:.1f}s", flush=True)
            if char_status != "character_ready":
                item["error"] = "character failed"
                raise RuntimeError("character failed")

            status, response = call(f"/api/kiosk/sessions/{session_id}/gif", {"action": action}, timeout=30)
            if status not in (202, 200):
                raise RuntimeError(response.get("error") or f"gif HTTP {status}")

            gif_status, gif_seconds, final = wait(session_id, ("gif_ready", "gif_failed"), 240)
            item["gifStatus"] = gif_status
            item["gifSeconds"] = round(gif_seconds, 1)
            print(f"[{index}/{COUNT}] gif {gif_status} {gif_seconds:.1f}s", flush=True)
            if gif_status != "gif_ready":
                item["error"] = "gif failed"
                raise RuntimeError("gif failed")

            item["totalSeconds"] = round(time.time() - run_started, 1)
            folder = STUDIO / "data" / "kiosk" / session_id
            item["photoDeleted"] = not any(folder.glob("photo.*"))
            claim_url = final.get("claim_url")
            if claim_url:
                try:
                    request = urllib.request.Request(claim_url, method="GET")
                    with urllib.request.urlopen(request, timeout=15) as response:
                        item["claimStatus"] = response.status
                except urllib.error.HTTPError as exc:
                    item["claimStatus"] = exc.code
                except Exception:
                    item["claimStatus"] = 0
            print(f"[{index}/{COUNT}] claim {item['claimStatus']} photoDeleted={item['photoDeleted']}", flush=True)
        except Exception as exc:
            item["error"] = str(exc)[:200]
            item["totalSeconds"] = round(time.time() - run_started, 1)
            print(f"[{index}/{COUNT}] FAILED {exc}", flush=True)
        finally:
            if item["sessionId"]:
                call(f"/api/kiosk/sessions/{item['sessionId']}", token=token, method="DELETE")
            runs.append(item)
            REPORT.parent.mkdir(parents=True, exist_ok=True)
            REPORT.write_text(json.dumps({"runs": runs}, ensure_ascii=False, indent=2), encoding="utf-8")

    _, usage_after = call("/api/usage")
    successful = [run for run in runs if run["gifStatus"] == "gif_ready"]
    char_times = [run["characterSeconds"] for run in successful if run.get("characterSeconds")]
    gif_times = [run["gifSeconds"] for run in successful if run.get("gifSeconds")]
    total_times = [run["totalSeconds"] for run in successful if run.get("totalSeconds")]
    report = {
        "generatedAt": datetime.now().astimezone().isoformat(timespec="seconds"),
        "provider": health.get("provider"),
        "model": health.get("model"),
        "input": str(SOURCE),
        "count": COUNT,
        "success": len(successful),
        "failure": COUNT - len(successful),
        "failureRate": round((COUNT - len(successful)) / COUNT, 3),
        "characterAvgSeconds": round(statistics.mean(char_times), 1) if char_times else None,
        "gifAvgSeconds": round(statistics.mean(gif_times), 1) if gif_times else None,
        "totalAvgSeconds": round(statistics.mean(total_times), 1) if total_times else None,
        "totalMaxSeconds": max(total_times) if total_times else None,
        "photoDeletedRate": round(sum(1 for run in successful if run.get("photoDeleted")) / max(1, len(successful)), 3),
        "claimOkRate": round(sum(1 for run in successful if run.get("claimStatus") == 200) / max(1, len(successful)), 3),
        "wallSeconds": round(time.time() - started, 1),
        "usageBefore": usage_before,
        "usageAfter": usage_after,
        "runs": runs,
    }
    REPORT.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print("\n" + json.dumps({key: report[key] for key in (
        "count", "success", "failure", "failureRate",
        "characterAvgSeconds", "gifAvgSeconds", "totalAvgSeconds",
        "totalMaxSeconds", "photoDeletedRate", "claimOkRate", "wallSeconds",
    )}, ensure_ascii=False, indent=2), flush=True)
    print(f"report: {REPORT}", flush=True)


if __name__ == "__main__":
    main()
