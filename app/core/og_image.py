"""Generate Open Graph / Twitter Card images for books and minds."""
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

MIND_COLORS = [
    (66, 133, 133), (133, 94, 66), (94, 66, 133),
    (66, 94, 133), (133, 66, 94), (66, 133, 94),
    (120, 100, 80), (80, 120, 100), (100, 80, 120),
]


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

    # Book cover fills most of the card height, centered horizontally
    cover_h = H - 40
    cover_w = int(cover_h * 0.7)
    spine_w = 20
    cover_x = (W - spine_w - cover_w) // 2
    cover_y = (H - cover_h) // 2

    # Shadow
    for i in range(10):
        c = max(0, 18 - i * 2)
        draw.rectangle(
            [(cover_x + spine_w + i + 4, cover_y + i + 4),
             (cover_x + spine_w + cover_w + i + 4, cover_y + cover_h + i + 2)],
            fill=(c, c, c),
        )

    # Spine
    draw.rectangle(
        [(cover_x, cover_y), (cover_x + spine_w, cover_y + cover_h)],
        fill=SPINE,
    )
    draw.line(
        [(cover_x + spine_w, cover_y), (cover_x + spine_w, cover_y + cover_h)],
        fill=SPINE_HL, width=1,
    )

    # Cover face
    fl = cover_x + spine_w + 1
    fr = cover_x + spine_w + cover_w
    draw.rectangle([(fl, cover_y), (fr, cover_y + cover_h)], fill=COVER_BG)
    draw.rectangle([(fl, cover_y), (fr, cover_y + cover_h)], outline=RULE, width=1)

    fcx = fl + (fr - fl) // 2
    pad = 36
    tl = fl + pad
    tr = fr - pad
    tw = tr - tl

    # Fonts
    ft_title = _font("Georgia-Bold.ttf", 28)
    ft_sub = _font("Georgia-Regular.ttf", 14)
    ft_author = _font("Georgia-Regular.ttf", 13)
    ft_imprint = _font("Georgia-Regular.ttf", 10)

    # Top accent band
    draw.rectangle([(tl + 10, cover_y + 28), (tr - 10, cover_y + 31)], fill=ACCENT)

    # Title — centered vertically in upper zone
    title_lines = _wrap(title, ft_title, tw, draw)[:5]
    title_lh = 38
    total_th = len(title_lines) * title_lh

    zone_top = cover_y + 56
    zone_bot = cover_y + cover_h - 140
    ty = zone_top + (zone_bot - zone_top - total_th) // 2
    ty = max(ty, zone_top)

    for i, ln in enumerate(title_lines):
        _text_centered(draw, ty + i * title_lh, ln, ft_title, TEXT_DARK, tl, tr)
    cur_y = ty + len(title_lines) * title_lh

    # Subtitle
    if subtitle:
        cur_y += 10
        sub_lines = _wrap(subtitle, ft_sub, tw - 10, draw)[:2]
        for i, ln in enumerate(sub_lines):
            _text_centered(draw, cur_y + i * 22, ln, ft_sub, TEXT_MID, tl, tr)

    # Bottom rule + author
    bot_y = cover_y + cover_h - 76
    draw.line([(tl + 24, bot_y), (tr - 24, bot_y)], fill=RULE, width=1)
    if author:
        _text_centered(draw, bot_y + 12, author, ft_author, TEXT_MID, tl, tr)

    # Feynman imprint
    imp_y = cover_y + cover_h - 28
    _draw_feynman_mark(draw, fcx - 22, imp_y - 1, 0.38, TEXT_LIGHT)
    ibbox = draw.textbbox((0, 0), "FEYNMAN", font=ft_imprint)
    draw.text((fcx - 10, imp_y - (ibbox[3] - ibbox[1]) // 2 - 1),
              "FEYNMAN", fill=TEXT_LIGHT, font=ft_imprint)

    buf = io.BytesIO()
    img.save(buf, format="PNG", optimize=True)
    return buf.getvalue()


def _mind_initials(name: str) -> str:
    parts = name.split()
    if len(parts) >= 2:
        return (parts[0][0] + parts[-1][0]).upper()
    return name[:2].upper() if name else "?"


def _mind_color(name: str) -> tuple[int, int, int]:
    h = sum(ord(c) for c in name)
    return MIND_COLORS[h % len(MIND_COLORS)]


def generate_mind_og_image(
    name: str,
    domain: str = "",
    era: str = "",
    bio: str = "",
) -> bytes:
    """Generate an OG image for a mind — initials avatar with name and tagline."""
    img = Image.new("RGB", (W, H), BG)
    draw = ImageDraw.Draw(img)

    ft_name = _font("Georgia-Bold.ttf", 36)
    ft_tag = _font("Georgia-Regular.ttf", 18)
    ft_imprint = _font("Georgia-Regular.ttf", 12)

    color = _mind_color(name)
    initials = _mind_initials(name)
    radius = 64
    cx, cy_avatar = W // 2, 190
    draw.ellipse(
        [(cx - radius, cy_avatar - radius), (cx + radius, cy_avatar + radius)],
        fill=color,
    )
    ft_init = _font("Georgia-Bold.ttf", 52)
    ibbox = draw.textbbox((0, 0), initials, font=ft_init)
    iw = ibbox[2] - ibbox[0]
    ih = ibbox[3] - ibbox[1]
    draw.text(
        (cx - iw // 2, cy_avatar - ih // 2 - ibbox[1]),
        initials, fill=(255, 255, 255), font=ft_init,
    )

    name_y = cy_avatar + radius + 28
    _text_centered(draw, name_y, name, ft_name, COVER_BG, 100, W - 100)

    tagline = ""
    if era and domain:
        tagline = f"{era} · {domain}"
    elif domain:
        tagline = domain
    elif era:
        tagline = era
    if tagline:
        tag_lines = _wrap(tagline, ft_tag, W - 240, draw)[:2]
        ty = name_y + 50
        for ln in tag_lines:
            _text_centered(draw, ty, ln, ft_tag, TEXT_LIGHT, 120, W - 120)
            ty += 28

    imp_y = H - 40
    _draw_feynman_mark(draw, W // 2 - 30, imp_y, 0.4, TEXT_LIGHT)
    ft_mark = _font("Georgia-Regular.ttf", 11)
    mbbox = draw.textbbox((0, 0), "FEYNMAN  GREAT MINDS", font=ft_mark)
    mw = mbbox[2] - mbbox[0]
    draw.text(
        (W // 2 - mw // 2 + 8, imp_y - (mbbox[3] - mbbox[1]) // 2),
        "FEYNMAN  GREAT MINDS", fill=TEXT_LIGHT, font=ft_mark,
    )

    buf = io.BytesIO()
    img.save(buf, format="PNG", optimize=True)
    return buf.getvalue()
