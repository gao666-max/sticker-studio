#!/usr/bin/env python3
"""Local device agent for the photo booth.

Why a separate process:
  browsers cannot reliably drive serial ports, cash acceptors, card readers or
  printer SDKs. The kiosk page talks to this agent on 127.0.0.1; the agent owns
  the hardware. The same /event protocol works for keyboard, serial, HID or a
  test panel.

Real hardware adapters are intentionally stubs today. Wire them in
`broadcast_event`, `handle_print` and `handle_payment`.
"""
from __future__ import annotations

import json
import queue
import re
import threading
import time
import uuid
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HOST = "127.0.0.1"
PORT = 8788
ROOT = Path(__file__).resolve().parent
EVENT_CLIENTS: list[queue.Queue] = []
CLIENTS_LOCK = threading.Lock()
PRINT_JOBS: dict[str, dict] = {}
PAYMENTS: dict[str, dict] = {}


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def broadcast_event(payload: dict) -> int:
    """Fan a hardware event out to every connected kiosk page."""
    sent = 0
    with CLIENTS_LOCK:
        clients = list(EVENT_CLIENTS)
    for client in clients:
        try:
            client.put_nowait(payload)
            sent += 1
        except queue.Full:
            pass
    return sent


def cors(handler):
    handler.send_header("Access-Control-Allow-Origin", "*")
    handler.send_header("Access-Control-Allow-Headers", "Content-Type")
    handler.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")


def json_response(handler, payload, status=200):
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Content-Length", str(len(data)))
    cors(handler)
    handler.end_headers()
    handler.wfile.write(data)


class Handler(BaseHTTPRequestHandler):
    server_version = "StickerBoothDevice/0.1"

    def log_message(self, fmt, *args):
        print(f"[device] {self.address_string()} {fmt % args}", flush=True)

    def do_OPTIONS(self):
        self.send_response(204)
        cors(self)
        self.end_headers()

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path == "/health":
            json_response(self, {
                "ok": True,
                "service": "sticker-booth-device",
                "host": HOST,
                "port": PORT,
                "time": now(),
                "clients": len(EVENT_CLIENTS),
                "capabilities": {
                    "events": True,
                    "print": "stub",
                    "payment": "stub",
                    "serial": False,
                    "printer": False,
                },
            })
            return
        if path == "/events":
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream; charset=utf-8")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Connection", "keep-alive")
            cors(self)
            self.end_headers()
            client: queue.Queue = queue.Queue(maxsize=50)
            with CLIENTS_LOCK:
                EVENT_CLIENTS.append(client)
            try:
                self.wfile.write(b": connected\n\n")
                self.wfile.flush()
                while True:
                    try:
                        payload = client.get(timeout=15)
                        body = f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"
                    except queue.Empty:
                        body = ": heartbeat\n\n"
                    self.wfile.write(body.encode("utf-8"))
                    self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError):
                pass
            finally:
                with CLIENTS_LOCK:
                    if client in EVENT_CLIENTS:
                        EVENT_CLIENTS.remove(client)
            return
        match = re.match(r"^/print/([A-Za-z0-9_]+)$", path)
        if match:
            job = PRINT_JOBS.get(match.group(1))
            if not job:
                json_response(self, {"error": "job not found"}, 404)
                return
            # Stub: a real printer adapter updates this after the printer acks.
            if job["status"] == "queued" and time.time() - job["createdTs"] > 1:
                job["status"] = "printed"
                job["finishedAt"] = now()
            json_response(self, job)
            return
        match = re.match(r"^/payment/([A-Za-z0-9_]+)$", path)
        if match:
            payment = PAYMENTS.get(match.group(1))
            if not payment:
                json_response(self, {"error": "payment not found"}, 404)
                return
            json_response(self, payment)
            return
        json_response(self, {
            "service": "sticker-booth-device",
            "endpoints": ["/health", "/events", "/event", "/print", "/payment/intent", "/payment/{id}"],
        })

    def read_json(self):
        length = int(self.headers.get("Content-Length", "0") or 0)
        raw = self.rfile.read(length) if length else b"{}"
        return json.loads(raw.decode("utf-8"))

    def do_POST(self):
        path = self.path.split("?", 1)[0]
        try:
            payload = self.read_json()
        except Exception:
            json_response(self, {"error": "invalid json"}, 400)
            return

        if path == "/event":
            action = str(payload.get("action") or "")
            if action not in ("shutter", "confirm", "rotate", "ready"):
                json_response(self, {"error": "action must be shutter, confirm, rotate or ready"}, 400)
                return
            event = {
                "type": "kiosk-hardware",
                "action": action,
                "delta": int(payload.get("delta") or 1),
                "source": str(payload.get("source") or "api"),
                "at": now(),
            }
            sent = broadcast_event(event)
            json_response(self, {"ok": True, "sent": sent, "event": event}, 202)
            return

        if path == "/print":
            session_id = str(payload.get("sessionId") or "").strip()
            image_url = str(payload.get("imageUrl") or "").strip()
            copies = max(1, min(10, int(payload.get("copies") or 1)))
            if not session_id:
                json_response(self, {"error": "sessionId is required"}, 400)
                return
            job_id = "pr_" + uuid.uuid4().hex[:10]
            job = {
                "id": job_id,
                "sessionId": session_id,
                "imageUrl": image_url,
                "copies": copies,
                "status": "queued",
                "createdAt": now(),
                "createdTs": time.time(),
            }
            PRINT_JOBS[job_id] = job
            # TODO(Friday): replace this with the printer SDK / Windows driver.
            # Example: printer.print_file(download(image_url), copies)
            print(f"[device] print queued {job_id} session={session_id} copies={copies}", flush=True)
            json_response(self, job, 202)
            return

        if path == "/payment/intent":
            amount = int(payload.get("amount") or 0)
            if amount <= 0:
                json_response(self, {"error": "amount is required"}, 400)
                return
            payment_id = "pay_" + uuid.uuid4().hex[:10]
            payment = {
                "id": payment_id,
                "amount": amount,
                "status": "pending",
                "qrText": f"sticker-demo://pay/{payment_id}",
                "createdAt": now(),
            }
            PAYMENTS[payment_id] = payment
            # TODO(Friday): create a real Alipay/WeChat payment intent here and
            # return the gateway QR text. The kiosk should poll this id.
            json_response(self, payment, 201)
            return

        match = re.match(r"^/payment/([A-Za-z0-9_]+)/mock-paid$", path)
        if match:
            payment = PAYMENTS.get(match.group(1))
            if not payment:
                json_response(self, {"error": "payment not found"}, 404)
                return
            payment["status"] = "paid"
            payment["paidAt"] = now()
            json_response(self, payment)
            return

        if path == "/shutdown":
            json_response(self, {"ok": True})
            threading.Thread(target=self.server.shutdown, daemon=True).start()
            return

        json_response(self, {"error": "not found"}, 404)


def main():
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"sticker booth device agent: http://{HOST}:{PORT}")
    print("test page: http://127.0.0.1:8787/hardware.html")
    print("Ctrl+C to stop.")
    with server:
        server.serve_forever()


if __name__ == "__main__":
    main()
