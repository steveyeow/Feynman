"""Generate Open Graph / Twitter Card images — book cover fills the card."""
from __future__ import annotations

import io
import math
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

_FONTS_DIR = Path(__file__).resolve().parent.parent / "static" / "fonts"

W, H = 1200, 630

BG = (24, 22, 20)

COVER_BG = (250, 246, 238)
SPINE = (70, 60, 50)
SPINE_HL = (185, 160, 120)
ACCENT = (139, 109, 82)
RULE = (200, 188, 172)
TEXT_DARK = (29, 29, 31)
TEXT_MID = (100, 90, 80)
TEXT_LIGHT = (145, 135, 122)
SIDE_MUTED = (110, 104, 94)


def _font(name: str, size: int) -> ImageFont.FreeTypeFont:
    path = _FONTS_DIR / name
    if path.exists():
        return ImageFont.truetype(str(path), size)
    return ImageFont.load_default(size)


def _wrap(text: str, font, max_w: int, draw: ImageDraw.ImageDraw) -> list[str]:
    words = text.split()
    lines: list[str] = []
    cur = ""
    for w in words:
        test = f"{cur} {w}".strip()
        if draw.textbbox((0, 0), test, font=font)[2] <= max_w:
            cur = test
        else:
            if cur:
                lines.append(cur)
            cur = w
    if cur:
        lines.append(cur)
    return lines or [text]


def _text_centered(draw: ImageDraw.ImageDraw, y: int, text: str, font, fill,
                    left: int, right: int) -> int:
    bbox = draw.textbbox((0, 0), text, font=font)
    tw = bbox[2] - bbox[0]
    th = bbox[3] - bbox[1]
    draw.text((left + (right - left - tw) // 2, y), text, fill=fill, font=font)
    return th


def _draw_feynman_mark(draw: ImageDraw.ImageDraw, cx: int, cy: int, s: float, color):
    lw = max(2, round(2.5 * s))
    draw.line([(cx - 18 * s, cy + 20 * s), (cx, cy)], fill=color, width=lw)
    draw.line([(cx + 18 * s, cy + 20 * s), (cx, cy)], fill=color, width=lw)
    r = 3 * s
    draw.ellipse([(cx - r, cy - r), (cx + r, cy + r)], fill=color)
    pts = []
    for i in range(14):
        t = i / 13.0
        y = cy - t * 22 * s
        x = cx + 4 * s * math.sin(t * math.pi * 3)
        pts.append((x, y))
    if len(pts) > 1:
        draw.line(pts, fill=color, width=lw)


def generate_og_image(
    title: str,
    subtitle: str = "",
    chapter_count: int = 0,
    total_words: int = 0,
    author: str = "",
) -> bytes:
    img = Image.new("RGB", (W, H), BG)
    draw = ImageDraw.Draw(img)

    # Book cover: full height, left-aligned
    cover_h = H
    cover_w = int(cover_h * 0.72)
    spine_w = 22

    # Shadow
    for i in range(12):
        c = max(0, 20 - i * 2)
        draw.rectangle(
            [(spine_w + cover_w + i + 2, i + 2),
             (spine_w + cover_w + i + 6, cover_h)],
            fill=(c, c, c),
        )

    # Spine
    draw.rectangle([(0, 0), (spine_w, cover_h)], fill=SPINE)
    draw.line([(spine_w, 0), (spine_w, cover_h)], fill=SPINE_HL, width=1)

    # Cover face
    fl = spine_w + 1
    fr = spine_w + cover_w
    draw.rectangle([(fl, 0), (fr, cover_h)], fill=COVER_BG)

    fcx = fl + (fr - fl) // 2
    pad = 40
    tl = fl + pad
    tr = fr - pad
    tw = tr - tl

    # Fonts
    ft_title = _font("Georgia-Bold.ttf", 36)
    ft_sub = _font("Georgia-Regular.ttf", 16)
    ft_author = _font("Georgia-Regular.ttf", 15)
    ft_imprint = _font("Georgia-Regular.ttf", 11)
    ft_brand = _font("Georgia-Regular.ttf", 14)

    # Top accent band
    draw.rectangle([(tl + 12, 32), (tr - 12, 35)], fill=ACCENT)

    # Title
    title_lines = _wrap(title, ft_title, tw, draw)[:5]
    title_lh = 48
    total_th = len(title_lines) * title_lh

    zone_top = 64
    zone_bot = cover_h - 160
    ty = zone_top + (zone_bot - zone_top - total_th) // 2
    ty = max(ty, zone_top)

    for i, ln in enumerate(title_lines):
        _text_centered(draw, ty + i * title_lh, ln, ft_title, TEXT_DARK, tl, tr)
    cur_y = ty + len(title_lines) * title_lh

    # Subtitle
    if subtitle:
        cur_y += 12
        sub_lines = _wrap(subtitle, ft_sub, tw - 16, draw)[:2]
        for i, ln in enumerate(sub_lines):
            _text_centered(draw, cur_y + i * 24, ln, ft_sub, TEXT_MID, tl, tr)

    # Bottom rule + author
    bot_y = cover_h - 88
    draw.line([(tl + 28, bot_y), (tr - 28, bot_y)], fill=RULE, width=1)
    if author:
        _text_centered(draw, bot_y + 14, author, ft_author, TEXT_MID, tl, tr)

    # Feynman imprint
    imp_y = cover_h - 32
    _draw_feynman_mark(draw, fcx - 24, imp_y - 1, 0.42, TEXT_LIGHT)
    ibbox = draw.textbbox((0, 0), "FEYNMAN", font=ft_imprint)
    draw.text((fcx - 10, imp_y - (ibbox[3] - ibbox[1]) // 2 - 1),
              "FEYNMAN", fill=TEXT_LIGHT, font=ft_imprint)

    # Right side: feynman.wiki brand only (X shows title/desc below the card)
    rx = fr + 48
    _draw_feynman_mark(draw, rx + 8, H // 2 - 6, 0.8, SIDE_MUTED)
    draw.text((rx + 24, H // 2 - 8), "feynman.wiki", fill=SIDE_MUTED, font=ft_brand)

    buf = io.BytesIO()
    img.save(buf, format="PNG", optimize=True)
    return buf.getvalue()
