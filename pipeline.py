"""Image pipeline for the sticker studio.

Two modes:
  demo     copy the bundled sample assets, no API key needed
  dashscope call DashScope qwen-image-3.0 and post-process the result

The DashScope adapter follows the same request shape as the dsh-image-gen plugin:
POST {endpoint}/services/aigc/multimodal-generation/generation
"""

from __future__ import annotations

import base64
import io
import json
import math
import os
import time
import urllib.error
import urllib.request
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont

DASHSCOPE_ENDPOINT = os.environ.get("DASHSCOPE_ENDPOINT", "https://dashscope.aliyuncs.com/api/v1").rstrip("/")
DASHSCOPE_MODEL = os.environ.get("DASHSCOPE_MODEL", "qwen-image-3.0")
DASHSCOPE_KEY = os.environ.get("DASHSCOPE_API_KEY", "").strip()
IMAGE_PROVIDER = os.environ.get("IMAGE_PROVIDER", "demo").strip().lower()

GIF_SIZE = 240
GIF_FRAMES = 16
GIF_MS = 120
GIF_MAX_BYTES = 500 * 1024

CALL_LOGGER = None


def configure(provider=None, model=None, endpoint=None, api_key=None):
    """Apply runtime settings without restarting the server."""
    global IMAGE_PROVIDER, DASHSCOPE_MODEL, DASHSCOPE_ENDPOINT, DASHSCOPE_KEY
    if provider:
        IMAGE_PROVIDER = provider.strip().lower()
    if model:
        DASHSCOPE_MODEL = model.strip()
    if endpoint:
        DASHSCOPE_ENDPOINT = endpoint.strip().rstrip("/")
    if api_key is not None:
        DASHSCOPE_KEY = api_key.strip()


def set_call_logger(callback):
    """Register a callback that receives one event per real provider call."""
    global CALL_LOGGER
    CALL_LOGGER = callback


def _log_call(context, status, started, input_images, output_images, error=None):
    if CALL_LOGGER is None:
        return
    event = dict(context or {})
    event.update(
        {
            "model": DASHSCOPE_MODEL,
            "status": status,
            "started_at": time.strftime("%Y-%m-%dT%H:%M:%S%z", time.localtime(started)),
            "finished_at": time.strftime("%Y-%m-%dT%H:%M:%S%z", time.localtime()),
            "duration_ms": int((time.time() - started) * 1000),
            "input_images": input_images,
            "output_images": output_images,
            "error": (error or "")[:300],
        }
    )
    try:
        CALL_LOGGER(event)
    except Exception:
        pass



# ---------------------------------------------------------------------------
# background removal
# ---------------------------------------------------------------------------

def detach_background(image: Image.Image, stroke_px: int = 8, min_area: int = 6,
                      bg_floor: int = 195, sat_max: int = 10) -> Image.Image:
    """Remove a light, low-saturation background and grow a white sticker edge."""
    rgb = np.array(image.convert("RGB"))
    mn = rgb.min(2)
    mx = rgb.max(2)
    candidate = ((mn >= bg_floor) & ((mx - mn) <= sat_max)).astype(np.uint8)
    count, labels, stats, _ = cv2.connectedComponentsWithStats(candidate, 8)
    border = set(labels[0, :].tolist()) | set(labels[-1, :].tolist())
    border |= set(labels[:, 0].tolist()) | set(labels[:, -1].tolist())
    bg = np.isin(labels, list(border)) & (candidate > 0)
    alpha = np.where(bg, 0, 255).astype(np.uint8)

    count2, labels2, stats2, _ = cv2.connectedComponentsWithStats((alpha > 0).astype(np.uint8), 8)
    for i in range(1, count2):
        if stats2[i, cv2.CC_STAT_AREA] < min_area:
            alpha[labels2 == i] = 0

    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (stroke_px * 2 + 1, stroke_px * 2 + 1))
    grown = cv2.dilate(alpha, kernel)
    out = np.zeros((rgb.shape[0], rgb.shape[1], 4), np.uint8)
    out[..., :3] = 255
    out[..., 3] = grown
    mask = alpha > 0
    out[..., :3][mask] = rgb[mask]
    out[..., 3][mask] = 255
    return Image.fromarray(out, "RGBA")


# ---------------------------------------------------------------------------
# sheet -> 16 frames -> GIF
# ---------------------------------------------------------------------------

def sheet_to_gif(sheet_path: Path, gif_path: Path, frame_ms: int = GIF_MS,
                 max_bytes: int = GIF_MAX_BYTES) -> dict:
    sheet = Image.open(sheet_path).convert("RGBA")
    cell = sheet.width // 4
    frames = []
    for y in range(4):
        for x in range(4):
            frame = sheet.crop((x * cell, y * cell, (x + 1) * cell, (y + 1) * cell))
            frames.append(frame.resize((GIF_SIZE, GIF_SIZE), Image.LANCZOS))

    def encode(frames_in, ms):
        flat = []
        for frame in frames_in:
            base = Image.new("RGBA", frame.size, "white")
            base.alpha_composite(frame)
            flat.append(base.convert("RGB"))
        strip = Image.new("RGB", (GIF_SIZE * len(flat), GIF_SIZE))
        for i, frame in enumerate(flat):
            strip.paste(frame, (i * GIF_SIZE, 0))
        palette = strip.quantize(colors=127, method=Image.MEDIANCUT, dither=Image.Dither.NONE)
        quantized = []
        for frame, rgb in zip(frames_in, flat):
            q = rgb.quantize(palette=palette, dither=Image.Dither.NONE)
            alpha_mask = frame.getchannel("A").point(lambda a: 255 if a < 128 else 0)
            q.paste(127, (0, 0), alpha_mask)
            quantized.append(q)
        quantized[0].save(
            gif_path,
            save_all=True,
            append_images=quantized[1:],
            duration=ms,
            loop=0,
            optimize=False,
            disposal=2,
            transparency=127,
        )

    for source in (frames, frames[::2]):
        for ms in (frame_ms, frame_ms * 2):
            encode(source, ms)
            if gif_path.stat().st_size <= max_bytes:
                return {"frames": len(source), "ms": ms, "bytes": gif_path.stat().st_size}
    return {"frames": len(frames), "ms": frame_ms, "bytes": gif_path.stat().st_size}


# ---------------------------------------------------------------------------
# DashScope
# ---------------------------------------------------------------------------

class DashScopeError(RuntimeError):
    pass


def _data_url(path: Path) -> str:
    suffix = path.suffix.lower()
    mime = {
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".webp": "image/webp",
    }.get(suffix, "image/png")
    data = base64.b64encode(path.read_bytes()).decode("ascii")
    return f"data:{mime};base64,{data}"


def _post_json(body: dict, timeout: int = 300) -> dict:
    if not DASHSCOPE_KEY:
        raise DashScopeError("DASHSCOPE_API_KEY is not set; switch IMAGE_PROVIDER=demo or provide a key")
    request = urllib.request.Request(
        f"{DASHSCOPE_ENDPOINT}/services/aigc/multimodal-generation/generation",
        data=json.dumps(body).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {DASHSCOPE_KEY}",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        body_text = exc.read().decode("utf-8", "replace")[:800]
        body_text = body_text.replace(DASHSCOPE_KEY, "[redacted]") if DASHSCOPE_KEY else body_text
        raise DashScopeError(f"DashScope HTTP {exc.code}: {body_text}") from exc
    except urllib.error.URLError as exc:
        raise DashScopeError(f"DashScope connection failed: {exc.reason}") from exc


def _download(url: str, target: Path, timeout: int = 300) -> Path:
    request = urllib.request.Request(url, headers={"User-Agent": "sticker-studio/1.0"})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        target.write_bytes(response.read())
    return target


def _extract_image_url(payload: dict) -> str | None:
    contents = payload.get("output", {}).get("choices", [{}])[0].get("message", {}).get("content", [])
    if not isinstance(contents, list):
        return None
    for item in contents:
        if not isinstance(item, dict):
            continue
        for key in ("image", "image_url", "url"):
            value = item.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()
    return None


def generate_image(prompt: str, target: Path, reference: Path | None = None,
                   size: str = "1024*1024", timeout: int = 300,
                   context: dict | None = None) -> Path:
    """Generate (or edit with a reference image) one image."""
    started = time.time()
    input_images = 1 if reference is not None else 0
    try:
        if reference is not None:
            content = [{"image": _data_url(reference)}, {"text": prompt}]
        else:
            content = [{"text": prompt}]
        payload = _post_json({
            "model": DASHSCOPE_MODEL,
            "input": {"messages": [{"role": "user", "content": content}]},
            "parameters": {
                "size": size,
                "watermark": False,
                "prompt_extend": True,
            },
        }, timeout=timeout)
        url = _extract_image_url(payload)
        if not url:
            message = payload.get("message") or payload.get("code") or json.dumps(payload)[:400]
            raise DashScopeError(f"DashScope returned no image: {message}")
        result = _download(url, target, timeout=timeout)
        _log_call(context, "success", started, input_images, 1)
        return result
    except Exception as exc:
        _log_call(context, "failed", started, input_images, 0, str(exc))
        raise


# ---------------------------------------------------------------------------
# real pipeline
# ---------------------------------------------------------------------------

class CharacterQualityError(RuntimeError):
    pass


def alpha_coverage(image: Image.Image) -> float:
    alpha = np.array(image.convert("RGBA"))[..., 3]
    return float((alpha > 16).mean())


def grabcut_foreground(image: Image.Image) -> Image.Image:
    """Fallback cutout for a centered subject on a non-white background."""
    rgb = np.array(image.convert("RGB"))
    h, w = rgb.shape[:2]
    mask = np.zeros((h, w), np.uint8)
    pad_x, pad_y = max(1, w // 20), max(1, h // 20)
    rect = (pad_x, pad_y, max(2, w - pad_x * 2), max(2, h - pad_y * 2))
    bgd = np.zeros((1, 65), np.float64)
    fgd = np.zeros((1, 65), np.float64)
    cv2.grabCut(rgb, mask, rect, bgd, fgd, 5, cv2.GC_INIT_WITH_RECT)
    alpha = np.where((mask == 0) | (mask == 2), 0, 255).astype(np.uint8)
    n, labels, stats, _ = cv2.connectedComponentsWithStats((alpha > 0).astype(np.uint8), 8)
    if n > 1:
        largest = 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))
        alpha[labels != largest] = 0
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (13, 13))
    grown = cv2.dilate(alpha, kernel)
    out = np.zeros((h, w, 4), np.uint8)
    out[..., :3] = 255
    out[..., 3] = grown
    keep = alpha > 0
    out[..., :3][keep] = rgb[keep]
    out[..., 3][keep] = 255
    return Image.fromarray(out, "RGBA")


def remove_background(image: Image.Image) -> Image.Image:
    cut = detach_background(image)
    coverage = alpha_coverage(cut)
    if 0.02 < coverage < 0.97:
        return cut
    try:
        fallback = grabcut_foreground(image)
        if 0.02 < alpha_coverage(fallback) < 0.97:
            return fallback
    except Exception:
        pass
    return cut


def finalize_character(image: Image.Image, size: int = 1024, margin: float = 0.07) -> Image.Image:
    """Trim, center and fit the character on a square transparent canvas."""
    rgba = image.convert("RGBA")
    bbox = rgba.getbbox()
    if bbox is None:
        raise CharacterQualityError("角色图为空，没有得到透明人物")
    crop = rgba.crop(bbox)
    side = max(1, int(max(crop.width, crop.height) * (1 + margin * 2)))
    canvas = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    canvas.alpha_composite(crop, ((side - crop.width) // 2, (side - crop.height) // 2))
    return canvas.resize((size, size), Image.LANCZOS)


def character_quality(image: Image.Image) -> dict:
    rgba = image.convert("RGBA")
    coverage = alpha_coverage(rgba)
    bbox = rgba.getbbox()
    ok = bool(bbox) and 0.02 < coverage < 0.95
    return {
        "ok": ok,
        "coverage": round(coverage, 4),
        "size": list(rgba.size),
        "bbox": list(bbox) if bbox else None,
    }


CHARACTER_PROMPT = (
    "Turn the subject of this photo into an original, heavily stylized cute cartoon sticker character: "
    "cute cartoon, thick clean dark outlines, flat colors, warm 1990s Chinese retro palette. "
    "Keep the identifying features of the person. It must clearly read as a drawing, never photorealistic. "
    "Front-facing full body, centered, head to toe, plain uniform pure white (#FFFFFF) background, "
    "no shadow, no floor, no props, no text, no border."
)

ASSET_PROMPTS = {
    "cover": (
        "Use the character in the reference image exactly. Clean front-facing half-body portrait, "
        "centered, filling the frame, friendly expression, truly transparent background, "
        "no text, no white outline, no border, no watermark."
    ),
    "icon": (
        "Use the character in the reference image exactly. Only the head, front-facing, centered, "
        "filling the frame, simple and bold so it reads at very small size, truly transparent background, "
        "no text, no border, no watermark."
    ),
    "banner": (
        "Use the character in the reference image exactly. A rich, lively wide scene that tells a tiny story "
        "about this character, bright saturated colorful background, absolutely no text, letters, logos, "
        "watermarks or signatures."
    ),
    "reward_guide": (
        "Use the character in the reference image exactly. The character cutely asks for a little tip, "
        "holding out both hands, bright saturated colorful background, absolutely no text, letters, logos, "
        "QR codes, watermarks or signatures."
    ),
    "reward_thanks": (
        "Use the character in the reference image exactly. The character bows and blows hearts to say thank you, "
        "bright saturated colorful background, absolutely no text, letters, logos, QR codes, watermarks or signatures."
    ),
}


def generate_character(photo_path: Path, out_dir: Path, context: dict | None = None,
                       strict: bool = False) -> Path:
    raw = out_dir / "character_raw.png"
    clean = out_dir / "character.png"
    ctx = dict(context or {})
    ctx.setdefault("kind", "character")
    generate_image(CHARACTER_PROMPT, raw, reference=photo_path, context=ctx)
    cut = remove_background(Image.open(raw))
    final = finalize_character(cut)
    quality = character_quality(final)
    final.save(clean)
    if strict and not quality["ok"]:
        raise CharacterQualityError(
            f"透明角色质检失败：coverage={quality['coverage']} bbox={quality['bbox']}"
        )
    return clean


def generate_sticker(character_path: Path, prompt: str, out_dir: Path, index: int,
                     context: dict | None = None) -> Path:
    sheet_raw = out_dir / f"sheet-{index:02d}.png"
    sheet_clean = out_dir / f"sheet-{index:02d}-clean.png"
    gif_path = out_dir / "files" / f"{index:02d}.gif"
    gif_path.parent.mkdir(parents=True, exist_ok=True)
    ctx = dict(context or {})
    ctx.setdefault("kind", "sticker")
    ctx["index"] = index
    generate_image(prompt, sheet_raw, reference=character_path, context=ctx)
    detach_background(Image.open(sheet_raw)).save(sheet_clean)
    sheet_to_gif(sheet_clean, gif_path)
    return gif_path


def _caption_font(size: int):
    candidates = [
        "C:/Windows/Fonts/msyhbd.ttc",
        "C:/Windows/Fonts/msyh.ttc",
        "C:/Windows/Fonts/simhei.ttf",
        "/System/Library/Fonts/PingFang.ttc",
        "/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc",
    ]
    for path in candidates:
        if os.path.exists(path):
            try:
                return ImageFont.truetype(path, size)
            except Exception:
                continue
    return ImageFont.load_default()


def _draw_heart(draw, x, y, size, color):
    draw.ellipse((x - size, y - size, x, y), fill=color)
    draw.ellipse((x, y - size, x + size, y), fill=color)
    draw.polygon([(x - size, y - size // 3), (x + size, y - size // 3), (x, y + size)], fill=color)


def _draw_sparkle(draw, x, y, size, color):
    draw.line((x - size, y, x + size, y), fill=color, width=3)
    draw.line((x, y - size, x, y + size), fill=color, width=3)


def _encode_frames(frames, target: Path, duration: int = 120):
    size = frames[0].width
    strip = Image.new("RGB", (size * len(frames), size), "white")
    for i, frame in enumerate(frames):
        base = Image.new("RGBA", frame.size, "white")
        base.alpha_composite(frame)
        strip.paste(base.convert("RGB"), (i * size, 0))
    palette = strip.quantize(colors=255, method=Image.MEDIANCUT, dither=Image.Dither.NONE)
    out = []
    for frame in frames:
        base = Image.new("RGBA", frame.size, "white")
        base.alpha_composite(frame)
        q = base.convert("RGB").quantize(palette=palette, dither=Image.Dither.NONE)
        mask = frame.getchannel("A").point(lambda a: 255 if a < 128 else 0)
        q.paste(255, (0, 0), mask)
        out.append(q)
    out[0].save(
        target,
        save_all=True,
        append_images=out[1:],
        duration=duration,
        loop=0,
        optimize=False,
        disposal=2,
        transparency=255,
    )
    return target


def render_kiosk_gif(character_path: Path, action: dict, target: Path,
                     frames: int = 16, duration: int = 120) -> Path:
    """Fast, deterministic motion GIF for the photo booth.

    One API call creates the 1024 transparent character; this renderer turns it
    into a loopable sticker in under a second, instead of another slow 4x4 call.
    """
    character = Image.open(character_path).convert("RGBA")
    character = character.resize((int(1024 * 0.86), int(1024 * 0.86)), Image.LANCZOS)
    word = str(action.get("word") or action.get("caption") or "表情")
    action_id = str(action.get("id") or "receive")
    font = _caption_font(62)
    small_font = _caption_font(44)
    result = []
    target.parent.mkdir(parents=True, exist_ok=True)

    for i in range(frames):
        phase = 2 * math.pi * i / frames
        dx = dy = angle = 0.0
        scale = 1.0
        if action_id in ("receive", "ok"):
            dy = -10 * math.sin(phase * 2)
            scale = 1 + 0.015 * math.sin(phase * 2)
        elif action_id == "thanks":
            angle = 4.5 * math.sin(phase)
            dy = 5 * math.sin(phase)
        elif action_id == "love":
            dx = 9 * math.sin(phase)
            angle = 2.5 * math.sin(phase)
        elif action_id == "night":
            angle = -3.5 * math.sin(phase)
            dy = 4 * math.sin(phase)
        elif action_id == "laugh":
            dx = 8 * math.sin(phase * 4)
            angle = 1.6 * math.sin(phase * 4)
        else:
            dy = -6 * math.sin(phase)

        frame = character
        if scale != 1.0:
            frame = frame.resize((int(frame.width * scale), int(frame.height * scale)), Image.LANCZOS)
        if angle:
            frame = frame.rotate(angle, resample=Image.BICUBIC, expand=False)
        canvas = Image.new("RGBA", (1024, 1024), (0, 0, 0, 0))
        x = (1024 - frame.width) // 2 + int(dx)
        y = (1024 - frame.height) // 2 - 24 + int(dy)
        canvas.alpha_composite(frame, (x, y))

        overlay = Image.new("RGBA", (1024, 1024), (0, 0, 0, 0))
        draw = ImageDraw.Draw(overlay)
        if action_id == "love":
            for k in range(4):
                hx = 210 + k * 190 + int(18 * math.sin(phase + k))
                hy = 620 - ((i * 13 + k * 40) % 300)
                _draw_heart(draw, hx, hy, 16 + k * 2, (200, 69, 45, 220))
        elif action_id in ("receive", "thanks"):
            for k in range(5):
                sx = 150 + k * 170
                sy = 180 + int(24 * math.sin(phase * 2 + k))
                _draw_sparkle(draw, sx, sy, 9, (212, 164, 72, 220))
        elif action_id == "night":
            for k in range(3):
                draw.text((760 + k * 42, 170 - ((i * 8 + k * 30) % 180)), "Z",
                          font=small_font, fill=(47, 93, 120, 220))
        elif action_id == "laugh":
            for k in range(2):
                draw.ellipse((250 + k * 470, 330, 262 + k * 470, 348), fill=(47, 93, 120, 180))

        draw.text((512, 950), word, font=font, anchor="mm",
                  fill=(36, 28, 21, 255), stroke_width=5, stroke_fill=(255, 255, 255, 255))
        canvas = Image.alpha_composite(canvas, overlay)
        result.append(canvas.resize((240, 240), Image.LANCZOS))

    return _encode_frames(result, target, duration=duration)


def generate_assets(character_path: Path, out_dir: Path, context: dict | None = None) -> dict:
    files = out_dir / "files"
    files.mkdir(parents=True, exist_ok=True)
    raw = out_dir / "assets"
    raw.mkdir(parents=True, exist_ok=True)
    result = {}
    for name, prompt in ASSET_PROMPTS.items():
        target = raw / f"{name}.png"
        ctx = dict(context or {})
        ctx.setdefault("kind", "asset")
        ctx["asset"] = name
        generate_image(prompt, target, reference=character_path, context=ctx)
        image = Image.open(target)
        if name in ("cover", "icon"):
            image = detach_background(image)
        if name == "icon":
            image = image.resize((50, 50), Image.LANCZOS)
        elif name == "cover":
            image = image.resize((240, 240), Image.LANCZOS)
        elif name == "banner":
            image = image.convert("RGB").resize((750, 400), Image.LANCZOS)
        elif name == "reward_guide":
            image = image.convert("RGB").resize((750, 560), Image.LANCZOS)
        elif name == "reward_thanks":
            image = image.convert("RGB").resize((750, 750), Image.LANCZOS)
        target_png = files / {
            "cover": "封面图.png",
            "icon": "聊天面板图标.png",
            "banner": "详情页横幅.png",
            "reward_guide": "赞赏引导图.png",
            "reward_thanks": "赞赏致谢图.png",
        }[name]
        image.save(target_png)
        result[name] = str(target_png)
    return result


def provider_status() -> dict:
    return {
        "provider": IMAGE_PROVIDER,
        "model": DASHSCOPE_MODEL,
        "keyConfigured": bool(DASHSCOPE_KEY),
    }
