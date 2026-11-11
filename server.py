"""Sticker Studio backend.

A small, dependency-light service that serves the front-end and runs a real
generation queue:

  demo       copy bundled sample assets, no API key needed
  dashscope  call DashScope qwen-image-3.0, then detach / slice / GIF

Endpoints
  GET  /api/health
  GET  /api/orders
  POST /api/orders
  POST /api/orders/<id>/generate
  GET  /api/orders/<id>
  POST /api/orders/<id>/review
  GET  /api/orders/<id>/zip
  GET  /api/orders/<id>/files/<name>
"""

from __future__ import annotations

import base64
import io
import json
import os
import queue
import re
import sqlite3
import threading
import time
import urllib.parse
import uuid
import webbrowser
import zipfile
from datetime import date, datetime, timedelta, timezone
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent


def load_env_file():
    """Load a local .env without adding a dependency. Real env vars win."""
    env_path = BASE_DIR / ".env"
    if not env_path.exists():
        return
    for raw in env_path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value


load_env_file()


def load_local_dsh_credential():
    """Optional local bridge: reuse the DSH DashScope key when no env key is set.

    This writes nothing and prints nothing. Disable with USE_DSH_CREDENTIALS=0
    before deploying anywhere.
    """
    if os.environ.get("DASHSCOPE_API_KEY", "").strip():
        return
    if os.environ.get("USE_DSH_CREDENTIALS", "0") != "1":
        return
    credential_path = Path(
        os.environ.get("DSH_CREDENTIALS_FILE", str(Path.home() / ".dsh" / ".credentials.yaml"))
    )
    if not credential_path.exists():
        return
    try:
        import yaml

        data = yaml.safe_load(credential_path.read_text(encoding="utf-8")) or {}
        key = (data.get("refs") or {}).get("DASHSCOPE_API_KEY")
        if isinstance(key, str) and key.strip():
            os.environ["DASHSCOPE_API_KEY"] = key.strip()
    except Exception:
        return


load_local_dsh_credential()

import pipeline  # noqa: E402  (env must be loaded first)

ROOT = BASE_DIR
DATA = ROOT / "data"
ORDERS = DATA / "orders"
DB_PATH = DATA / "studio.db"
DEMO_ASSETS = ROOT / "assets"

DEMO_MAP = {
    "receive": "gif-01.gif",
    "ok": "gif-02.gif",
    "wait": "gif-03.gif",
    "laugh": "gif-04.gif",
    "speechless": "gif-05.gif",
    "thanks": "gif-06.gif",
    "night": "gif-07.gif",
    "tea": "gif-08.gif",
    "love": "love-smooth.gif",
    "help": "ask.gif",
}
DELIVER_MAP = {
    "icon": ("assets/deliver/icon.png", "聊天面板图标.png"),
    "cover": ("assets/deliver/cover.png", "封面图.png"),
    "banner": ("assets/deliver/banner.png", "详情页横幅.png"),
    "reward_guide": ("assets/deliver/reward-guide.png", "赞赏引导图.png"),
    "reward_thanks": ("assets/deliver/reward-thanks.png", "赞赏致谢图.png"),
}

# Official qwen-image-3.0 list price, USD per image.
# https://www.alibabacloud.com/help/zh/model-studio/qwen-image-3-0
PRICE_INPUT_USD = float(os.environ.get("DASHSCOPE_PRICE_INPUT_USD", "0.00275"))
PRICE_OUTPUT_USD = float(os.environ.get("DASHSCOPE_PRICE_OUTPUT_USD", "0.024754"))
USD_TO_CNY = float(os.environ.get("USD_TO_CNY", "7.1"))

SETTINGS_PATH = DATA / "settings.json"
CONTENT_STYLES = {"cute", "soft", "bold"}
CAPTION_TONES = {"short", "warm", "playful"}


def _safe_float(value, fallback):
    try:
        number = float(value)
    except (TypeError, ValueError):
        return fallback
    return number if number > 0 else fallback


def _read_settings_file():
    if not SETTINGS_PATH.exists():
        return {}
    try:
        data = json.loads(SETTINGS_PATH.read_text(encoding="utf-8"))
    except Exception:
        return {}
    return data if isinstance(data, dict) else {}


def load_settings():
    """Load settings from data/settings.json, then env, then the local DSH key."""
    saved = _read_settings_file()
    file_has_key = "apiKey" in saved
    if file_has_key:
        key = str(saved.get("apiKey") or "")
        key_source = "settings" if key else "none"
    else:
        key = os.environ.get("DASHSCOPE_API_KEY", "") or pipeline.DASHSCOPE_KEY
        key_source = "env" if key else "none"

    provider = str(saved.get("provider") or os.environ.get("IMAGE_PROVIDER") or "demo").lower()
    if provider not in ("demo", "dashscope"):
        provider = "demo"
    style = str(saved.get("contentStyle") or "cute")
    if style not in CONTENT_STYLES:
        style = "cute"
    tone = str(saved.get("captionTone") or "short")
    if tone not in CAPTION_TONES:
        tone = "short"

    return {
        "provider": provider,
        "model": str(saved.get("model") or os.environ.get("DASHSCOPE_MODEL") or "qwen-image-3.0"),
        "endpoint": str(saved.get("endpoint") or os.environ.get("DASHSCOPE_ENDPOINT") or "https://dashscope.aliyuncs.com/api/v1"),
        "apiKey": key,
        "keySource": key_source,
        "priceInputUsd": _safe_float(saved.get("priceInputUsd"), PRICE_INPUT_USD),
        "priceOutputUsd": _safe_float(saved.get("priceOutputUsd"), PRICE_OUTPUT_USD),
        "usdToCny": _safe_float(saved.get("usdToCny"), USD_TO_CNY),
        "contentStyle": style,
        "captionTone": tone,
        "promptExtra": str(saved.get("promptExtra") or "")[:500],
    }


def apply_settings(settings):
    global PRICE_INPUT_USD, PRICE_OUTPUT_USD, USD_TO_CNY
    pipeline.configure(
        provider=settings["provider"],
        model=settings["model"],
        endpoint=settings["endpoint"],
        api_key=settings["apiKey"],
    )
    PRICE_INPUT_USD = settings["priceInputUsd"]
    PRICE_OUTPUT_USD = settings["priceOutputUsd"]
    USD_TO_CNY = settings["usdToCny"]
    return settings


def public_settings(settings):
    return {
        "provider": settings["provider"],
        "model": settings["model"],
        "endpoint": settings["endpoint"],
        "keyConfigured": bool(settings["apiKey"]),
        "keySource": settings["keySource"],
        "prices": {
            "inputUsd": settings["priceInputUsd"],
            "outputUsd": settings["priceOutputUsd"],
            "usdToCny": settings["usdToCny"],
        },
        "content": {
            "style": settings["contentStyle"],
            "tone": settings["captionTone"],
            "extra": settings["promptExtra"],
        },
    }


def save_settings(payload):
    current = load_settings()
    provider = str(payload.get("provider", current["provider"])).lower()
    if provider not in ("demo", "dashscope"):
        raise ValueError("provider must be demo or dashscope")

    model = str(payload.get("model", current["model"])).strip()
    endpoint = str(payload.get("endpoint", current["endpoint"])).strip().rstrip("/")
    if not model:
        raise ValueError("model is required")
    if not endpoint.startswith(("http://", "https://")):
        raise ValueError("endpoint must be an http(s) URL")

    style = str(payload.get("contentStyle", current["contentStyle"]))
    if style not in CONTENT_STYLES:
        raise ValueError("unknown content style")
    tone = str(payload.get("captionTone", current["captionTone"]))
    if tone not in CAPTION_TONES:
        raise ValueError("unknown caption tone")

    input_price = _safe_float(payload.get("priceInputUsd"), current["priceInputUsd"])
    output_price = _safe_float(payload.get("priceOutputUsd"), current["priceOutputUsd"])
    rate = _safe_float(payload.get("usdToCny"), current["usdToCny"])

    if payload.get("clearKey"):
        api_key = ""
        key_written = True
    else:
        new_key = str(payload.get("apiKey", "")).strip()
        api_key = new_key or current["apiKey"]
        key_written = bool(new_key)

    effective = {
        "provider": provider,
        "model": model,
        "endpoint": endpoint,
        "apiKey": api_key,
        "keySource": "none" if payload.get("clearKey") else ("settings" if key_written else current["keySource"]),
        "priceInputUsd": input_price,
        "priceOutputUsd": output_price,
        "usdToCny": rate,
        "contentStyle": style,
        "captionTone": tone,
        "promptExtra": str(payload.get("promptExtra", current["promptExtra"]))[:500],
    }

    file_data = {
        "provider": provider,
        "model": model,
        "endpoint": endpoint,
        "priceInputUsd": input_price,
        "priceOutputUsd": output_price,
        "usdToCny": rate,
        "contentStyle": style,
        "captionTone": tone,
        "promptExtra": effective["promptExtra"],
    }
    if payload.get("clearKey"):
        file_data["apiKey"] = ""
    elif key_written:
        file_data["apiKey"] = api_key
    elif "apiKey" in _read_settings_file():
        file_data["apiKey"] = current["apiKey"]

    DATA.mkdir(parents=True, exist_ok=True)
    tmp = SETTINGS_PATH.with_suffix(".tmp")
    tmp.write_text(json.dumps(file_data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    tmp.replace(SETTINGS_PATH)
    apply_settings(effective)
    return effective

JOB_QUEUE: "queue.Queue[str]" = queue.Queue()
DB_LOCK = threading.Lock()


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def db():
    conn = sqlite3.connect(DB_PATH, timeout=30)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    DATA.mkdir(parents=True, exist_ok=True)
    ORDERS.mkdir(parents=True, exist_ok=True)
    with db() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS orders (
                id TEXT PRIMARY KEY,
                status TEXT NOT NULL,
                pack_json TEXT NOT NULL,
                character_path TEXT,
                provider TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS items (
                order_id TEXT NOT NULL,
                state_id TEXT NOT NULL,
                position INTEGER NOT NULL,
                word TEXT NOT NULL,
                caption TEXT NOT NULL,
                action TEXT NOT NULL,
                prompt TEXT NOT NULL,
                status TEXT NOT NULL,
                gif_path TEXT,
                error TEXT,
                demo INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (order_id, state_id)
            );
            CREATE TABLE IF NOT EXISTS api_calls (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                order_id TEXT,
                kind TEXT NOT NULL,
                asset TEXT,
                state_id TEXT,
                item_index INTEGER,
                model TEXT NOT NULL,
                status TEXT NOT NULL,
                started_at TEXT NOT NULL,
                finished_at TEXT,
                duration_ms INTEGER NOT NULL DEFAULT 0,
                input_images INTEGER NOT NULL DEFAULT 0,
                output_images INTEGER NOT NULL DEFAULT 0,
                cost_usd REAL NOT NULL DEFAULT 0,
                cost_cny REAL NOT NULL DEFAULT 0,
                error TEXT
            );
            """
        )


def save_character(data_url: str | None, order_dir: Path) -> str | None:
    if not data_url:
        return None
    match = re.match(r"^data:image/(png|jpe?g|webp);base64,(.+)$", data_url, re.S)
    if not match:
        return None
    ext = "jpg" if match.group(1) in ("jpeg", "jpg") else match.group(1)
    target = order_dir / f"character.{ext}"
    try:
        target.write_bytes(base64.b64decode(match.group(2)))
    except Exception:
        return None
    return str(target)


def create_order(payload: dict) -> dict:
    order_id = "ord_" + uuid.uuid4().hex[:10]
    order_dir = ORDERS / order_id
    order_dir.mkdir(parents=True, exist_ok=True)
    character_path = save_character(payload.get("character"), order_dir)
    pack = payload.get("pack") or {}
    states = payload.get("states") or []
    stamp = now()
    with db() as conn:
        conn.execute(
            "INSERT INTO orders (id, status, pack_json, character_path, provider, created_at, updated_at) VALUES (?,?,?,?,?,?,?)",
            (order_id, "queued", json.dumps(pack, ensure_ascii=False), character_path, pipeline.IMAGE_PROVIDER, stamp, stamp),
        )
        for index, state in enumerate(states):
            conn.execute(
                "INSERT INTO items (order_id, state_id, position, word, caption, action, prompt, status, demo) VALUES (?,?,?,?,?,?,?,?,?)",
                (
                    order_id,
                    str(state.get("id") or f"item-{index}"),
                    index,
                    str(state.get("word") or "表情"),
                    str(state.get("caption") or state.get("word") or "表情"),
                    str(state.get("action") or ""),
                    str(state.get("prompt") or ""),
                    "queued",
                    1 if pipeline.IMAGE_PROVIDER == "demo" else 0,
                ),
            )
    return get_order(order_id)


def get_order(order_id: str) -> dict | None:
    with db() as conn:
        order = conn.execute("SELECT * FROM orders WHERE id = ?", (order_id,)).fetchone()
        if not order:
            return None
        items = conn.execute(
            "SELECT * FROM items WHERE order_id = ? ORDER BY position ASC", (order_id,)
        ).fetchall()

    order_dir = ORDERS / order_id
    files_dir = order_dir / "files"
    out_items = []
    for item in items:
        gif_path = item["gif_path"]
        out_items.append(
            {
                "id": item["state_id"],
                "position": item["position"],
                "word": item["word"],
                "caption": item["caption"],
                "action": item["action"],
                "prompt": item["prompt"],
                "status": item["status"],
                "error": item["error"],
                "demo": bool(item["demo"]),
                "gif_url": f"/api/orders/{order_id}/files/{Path(gif_path).name}" if gif_path else None,
            }
        )

    assets = {}
    for name in ("icon", "cover", "banner", "reward_guide", "reward_thanks"):
        filename = DELIVER_MAP[name][1]
        if (files_dir / filename).exists():
            assets[name] = f"/api/orders/{order_id}/files/{urllib.parse.quote(filename)}"

    return {
        "id": order["id"],
        "status": order["status"],
        "provider": order["provider"],
        "pack": json.loads(order["pack_json"]),
        "character": bool(order["character_path"]),
        "created_at": order["created_at"],
        "updated_at": order["updated_at"],
        "items": out_items,
        "assets": assets,
    }


def update_item(order_id: str, state_id: str, **fields):
    if not fields:
        return
    keys = ", ".join(f"{key} = ?" for key in fields)
    values = list(fields.values()) + [order_id, state_id]
    with db() as conn:
        conn.execute(f"UPDATE items SET {keys} WHERE order_id = ? AND state_id = ?", values)


def update_order(order_id: str, status: str):
    with db() as conn:
        conn.execute(
            "UPDATE orders SET status = ?, updated_at = ? WHERE id = ?",
            (status, now(), order_id),
        )


def record_api_call(event: dict):
    """Persist one real provider call and its list-price estimate."""
    input_images = int(event.get("input_images") or 0)
    output_images = int(event.get("output_images") or 0)
    success = event.get("status") == "success"
    cost_usd = (input_images * PRICE_INPUT_USD + output_images * PRICE_OUTPUT_USD) if success else 0.0
    cost_cny = cost_usd * USD_TO_CNY
    with db() as conn:
        conn.execute(
            """
            INSERT INTO api_calls
              (order_id, kind, asset, state_id, item_index, model, status,
               started_at, finished_at, duration_ms, input_images, output_images,
               cost_usd, cost_cny, error)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
            """,
            (
                event.get("order_id"),
                event.get("kind") or "unknown",
                event.get("asset"),
                event.get("state_id"),
                event.get("index"),
                event.get("model") or pipeline.DASHSCOPE_MODEL,
                event.get("status") or "failed",
                event.get("started_at") or now(),
                event.get("finished_at"),
                int(event.get("duration_ms") or 0),
                input_images,
                output_images,
                cost_usd,
                cost_cny,
                event.get("error"),
            ),
        )


def _sum_row(row) -> dict:
    return {
        "calls": int(row["calls"] or 0),
        "success": int(row["success"] or 0),
        "failed": int(row["failed"] or 0),
        "costUsd": round(float(row["cost_usd"] or 0), 4),
        "costCny": round(float(row["cost_cny"] or 0), 2),
    }


def usage_summary() -> dict:
    today = date.today()
    today_key = today.isoformat()
    month_key = today.strftime("%Y-%m")
    with db() as conn:
        def one(where="", args=()):
            row = conn.execute(
                f"""
                SELECT COUNT(*) AS calls,
                       SUM(CASE WHEN status='success' THEN 1 ELSE 0 END) AS success,
                       SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed,
                       SUM(cost_usd) AS cost_usd,
                       SUM(cost_cny) AS cost_cny
                FROM api_calls {where}
                """,
                args,
            ).fetchone()
            return _sum_row(row)

        totals = one()
        today_stats = one("WHERE substr(started_at,1,10) = ?", (today_key,))
        month_stats = one("WHERE substr(started_at,1,7) = ?", (month_key,))

        by_day_rows = conn.execute(
            """
            SELECT substr(started_at,1,10) AS day,
                   COUNT(*) AS calls,
                   SUM(cost_cny) AS cost_cny
            FROM api_calls
            WHERE substr(started_at,1,10) >= ?
            GROUP BY day ORDER BY day ASC
            """,
            ((today - timedelta(days=13)).isoformat(),),
        ).fetchall()
        by_day_map = {row["day"]: row for row in by_day_rows}
        by_day = []
        for offset in range(13, -1, -1):
            day = (today - timedelta(days=offset)).isoformat()
            row = by_day_map.get(day)
            by_day.append(
                {
                    "date": day,
                    "calls": int(row["calls"] or 0) if row else 0,
                    "costCny": round(float(row["cost_cny"] or 0), 2) if row else 0.0,
                }
            )

        by_kind_rows = conn.execute(
            """
            SELECT kind, COUNT(*) AS calls, SUM(cost_cny) AS cost_cny
            FROM api_calls GROUP BY kind ORDER BY calls DESC
            """
        ).fetchall()
        by_kind = [
            {
                "kind": row["kind"],
                "calls": int(row["calls"] or 0),
                "costCny": round(float(row["cost_cny"] or 0), 2),
            }
            for row in by_kind_rows
        ]

        recent_rows = conn.execute(
            """
            SELECT order_id, kind, asset, state_id, model, status, started_at,
                   duration_ms, cost_cny, error
            FROM api_calls ORDER BY id DESC LIMIT 20
            """
        ).fetchall()
        recent = [
            {
                "orderId": row["order_id"],
                "kind": row["kind"],
                "asset": row["asset"],
                "stateId": row["state_id"],
                "model": row["model"],
                "status": row["status"],
                "startedAt": row["started_at"],
                "durationMs": int(row["duration_ms"] or 0),
                "costCny": round(float(row["cost_cny"] or 0), 2),
                "error": row["error"],
            }
            for row in recent_rows
        ]

        order_count = conn.execute("SELECT COUNT(*) AS n FROM orders").fetchone()["n"]
        done_items = conn.execute("SELECT COUNT(*) AS n FROM items WHERE status='done'").fetchone()["n"]

    return {
        "provider": pipeline.IMAGE_PROVIDER,
        "model": pipeline.DASHSCOPE_MODEL,
        "currency": "CNY",
        "price": {
            "inputUsd": PRICE_INPUT_USD,
            "outputUsd": PRICE_OUTPUT_USD,
            "usdToCny": USD_TO_CNY,
        },
        "totals": totals,
        "today": today_stats,
        "month": month_stats,
        "byDay": by_day,
        "byKind": by_kind,
        "recent": recent,
        "orders": {"total": int(order_count or 0), "doneItems": int(done_items or 0)},
    }


def copy_demo_assets(order_dir: Path):
    files = order_dir / "files"
    files.mkdir(parents=True, exist_ok=True)
    for source, filename in DELIVER_MAP.values():
        src = ROOT / source
        if src.exists():
            (files / filename).write_bytes(src.read_bytes())


def process_order(order_id: str):
    order = get_order(order_id)
    if not order:
        return
    order_dir = ORDERS / order_id
    files = order_dir / "files"
    files.mkdir(parents=True, exist_ok=True)
    update_order(order_id, "generating")

    try:
        if pipeline.IMAGE_PROVIDER == "demo":
            copy_demo_assets(order_dir)
            for index, item in enumerate(order["items"]):
                update_item(order_id, item["id"], status="generating", error=None)
                time.sleep(0.55)
                demo_file = DEMO_MAP.get(item["id"])
                if demo_file:
                    source = DEMO_ASSETS / demo_file
                    target = files / f"{index + 1:02d}.gif"
                    if source.exists():
                        target.write_bytes(source.read_bytes())
                        update_item(
                            order_id,
                            item["id"],
                            status="review",
                            gif_path=f"files/{target.name}",
                            demo=1,
                        )
                    else:
                        update_item(order_id, item["id"], status="failed", error="demo asset missing")
                else:
                    update_item(
                        order_id,
                        item["id"],
                        status="failed",
                        error="demo 模式没有这张素材，接入 DashScope 后可真实生成",
                    )
        else:
            if not pipeline.DASHSCOPE_KEY:
                for item in order["items"]:
                    update_item(
                        order_id,
                        item["id"],
                        status="failed",
                        error="DASHSCOPE_API_KEY 未配置",
                    )
                update_order(order_id, "failed")
                return
            character_file = None
            if order["character"]:
                candidates = list(order_dir.glob("character.*"))
                if candidates:
                    character_file = candidates[0]
            if character_file is None:
                for item in order["items"]:
                    update_item(order_id, item["id"], status="failed", error="没有客户角色图")
                update_order(order_id, "failed")
                return

            character = pipeline.generate_character(
                character_file, order_dir, context={"order_id": order_id}
            )
            pipeline.generate_assets(
                character, order_dir, context={"order_id": order_id}
            )

            for index, item in enumerate(order["items"]):
                update_item(order_id, item["id"], status="generating", error=None)
                try:
                    gif = pipeline.generate_sticker(
                        character,
                        item["prompt"],
                        order_dir,
                        index + 1,
                        context={"order_id": order_id, "state_id": item["id"]},
                    )
                    update_item(
                        order_id,
                        item["id"],
                        status="review",
                        gif_path=f"files/{gif.name}",
                        demo=0,
                    )
                except Exception as exc:
                    update_item(order_id, item["id"], status="failed", error=str(exc)[:300])

        latest = get_order(order_id)
        statuses = [item["status"] for item in latest["items"]]
        if any(status == "review" for status in statuses):
            update_order(order_id, "review")
        elif statuses and all(status == "failed" for status in statuses):
            update_order(order_id, "failed")
        else:
            update_order(order_id, "review")
    except Exception as exc:
        latest = get_order(order_id)
        if latest:
            for item in latest["items"]:
                if item["status"] in ("queued", "generating"):
                    update_item(order_id, item["id"], status="failed", error=str(exc)[:300])
        update_order(order_id, "failed")


def worker():
    while True:
        order_id = JOB_QUEUE.get()
        try:
            process_order(order_id)
        except Exception:
            update_order(order_id, "failed")
        finally:
            JOB_QUEUE.task_done()


def build_listing(order: dict) -> str:
    pack = order.get("pack") or {}
    done = [item for item in order["items"] if item["status"] == "done"]
    lines = [
        f"# {pack.get('name', '表情包')} 上架文案",
        "",
        f"- 表情名称：{pack.get('name', '')}",
        f"- 表情介绍：{pack.get('intro', '')}",
        f"- 版权信息：{pack.get('copyright', '')}",
        f"- 赞赏引导语：{pack.get('reward', '')}",
        "",
        "| 序号 | 含义词 |",
        "|---|---|",
    ]
    for index, item in enumerate(done):
        lines.append(f"| {index + 1:02d} | {item['word']} |")
    return "\n".join(lines) + "\n"


def build_pack_json(order: dict) -> str:
    pack = order.get("pack") or {}
    done = [item for item in order["items"] if item["status"] == "done"]
    return json.dumps(
        {
            "name": pack.get("name", ""),
            "intro": pack.get("intro", ""),
            "copyright": pack.get("copyright", ""),
            "reward_line": pack.get("reward", ""),
            "character": "character.png",
            "style": "cute cartoon, thick clean dark outlines, flat colors, warm retro palette",
            "frame_ms": 120,
            "background": "transparent",
            "stickers": [
                {"word": item["word"], "caption": item["caption"], "action": item["action"]}
                for item in done
            ],
        },
        ensure_ascii=False,
        indent=2,
    ) + "\n"


def build_zip(order: dict) -> bytes:
    order_dir = ORDERS / order["id"]
    done = [item for item in order["items"] if item["status"] == "done" and item["gif_url"]]
    if not done:
        raise ValueError("没有已完成的 GIF")
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as zf:
        for index, item in enumerate(done):
            path = order_dir / "files" / Path(item["gif_url"]).name
            if path.exists():
                zf.write(path, f"表情图/{index + 1:02d}.gif")
        for _, filename in DELIVER_MAP.values():
            path = order_dir / "files" / filename
            if path.exists():
                zf.write(path, filename)
        zf.writestr("上架文案.md", build_listing(order))
        zf.writestr("pack.json", build_pack_json(order))
    return buffer.getvalue()


class Handler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, fmt, *args):
        print(f"[studio] {self.address_string()} {fmt % args}")

    def send_json(self, payload, status=200):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def read_json(self):
        length = int(self.headers.get("Content-Length", "0") or 0)
        body = self.rfile.read(length) if length else b"{}"
        return json.loads(body.decode("utf-8"))

    def do_GET(self):
        path = urllib.parse.urlparse(self.path).path
        if path == "/api/health":
            status = pipeline.provider_status()
            self.send_json({"ok": True, **status})
            return
        if path == "/api/usage":
            self.send_json(usage_summary())
            return
        if path == "/api/settings":
            self.send_json(public_settings(load_settings()))
            return
        if path == "/api/orders":
            with db() as conn:
                rows = conn.execute("SELECT id FROM orders ORDER BY created_at DESC LIMIT 50").fetchall()
            self.send_json({"orders": [get_order(row["id"]) for row in rows]})
            return
        match = re.match(r"^/api/orders/([^/]+)$", path)
        if match:
            order = get_order(match.group(1))
            if not order:
                self.send_json({"error": "order not found"}, 404)
                return
            self.send_json(order)
            return
        match = re.match(r"^/api/orders/([^/]+)/zip$", path)
        if match:
            order = get_order(match.group(1))
            if not order:
                self.send_json({"error": "order not found"}, 404)
                return
            try:
                data = build_zip(order)
            except ValueError as exc:
                self.send_json({"error": str(exc)}, 400)
                return
            self.send_response(200)
            self.send_header("Content-Type", "application/zip")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Content-Disposition", 'attachment; filename="sticker-pack.zip"')
            self.end_headers()
            self.wfile.write(data)
            return
        match = re.match(r"^/api/orders/([^/]+)/files/(.+)$", path)
        if match:
            order_id = match.group(1)
            name = Path(urllib.parse.unquote(match.group(2))).name
            target = ORDERS / order_id / "files" / name
            if not target.exists():
                self.send_json({"error": "file not found"}, 404)
                return
            data = target.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", self.guess_type(target.name))
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
        super().do_GET()

    def do_POST(self):
        path = urllib.parse.urlparse(self.path).path
        try:
            payload = self.read_json()
        except Exception:
            self.send_json({"error": "invalid json"}, 400)
            return

        if path == "/api/orders":
            order = create_order(payload)
            self.send_json(order, 201)
            return
        if path == "/api/settings":
            try:
                settings = save_settings(payload)
            except ValueError as exc:
                self.send_json({"error": str(exc)}, 400)
                return
            self.send_json(public_settings(settings))
            return
        match = re.match(r"^/api/orders/([^/]+)/generate$", path)
        if match:
            order = get_order(match.group(1))
            if not order:
                self.send_json({"error": "order not found"}, 404)
                return
            update_order(order["id"], "queued")
            JOB_QUEUE.put(order["id"])
            self.send_json(get_order(order["id"]), 202)
            return
        match = re.match(r"^/api/orders/([^/]+)/review$", path)
        if match:
            order = get_order(match.group(1))
            if not order:
                self.send_json({"error": "order not found"}, 404)
                return
            for entry in payload.get("items", []):
                state_id = entry.get("id")
                status = entry.get("status")
                if state_id and status in ("done", "failed", "review"):
                    update_item(order["id"], state_id, status=status)
            latest = get_order(order["id"])
            if latest and latest["items"] and all(item["status"] == "done" for item in latest["items"]):
                update_order(order["id"], "done")
            else:
                update_order(order["id"], "review")
            self.send_json(get_order(order["id"]))
            return
        self.send_json({"error": "not found"}, 404)


def main():
    init_db()
    apply_settings(load_settings())
    pipeline.set_call_logger(record_api_call)
    thread = threading.Thread(target=worker, daemon=True)
    thread.start()

    server = None
    port = 8787
    for candidate in range(8787, 8800):
        try:
            server = ThreadingHTTPServer(("127.0.0.1", candidate), partial(Handler, directory=str(ROOT)))
            port = candidate
            break
        except OSError:
            continue
    if server is None:
        raise SystemExit("端口 8787-8799 都被占用")

    url = f"http://127.0.0.1:{port}/"
    print(f"旗袍表情工坊 backend: {url}")
    print(f"provider: {pipeline.IMAGE_PROVIDER} | model: {pipeline.DASHSCOPE_MODEL} | key: {'yes' if pipeline.DASHSCOPE_KEY else 'no'}")
    print("按 Ctrl+C 停止。")
    if os.environ.get("STUDIO_NO_BROWSER") != "1":
        try:
            webbrowser.open(url)
        except Exception:
            pass
    with server:
        server.serve_forever()


if __name__ == "__main__":
    main()
