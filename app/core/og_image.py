"""Generate Open Graph / Twitter Card images styled as book covers."""
from __future__ import annotations

import io
import math
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

_FONTS_DIR = Path(__file__).resolve().parent.parent / "static" / "fonts"

W, H = 1200, 630

# Book-cover palette
COVER_BG = (42, 40, 38)
INNER_BG = (250, 246, 240)
SPINE_COLOR = (90, 75, 62)
ACCENT = (139, 109, 82)
GOLD = (185, 160, 120)
TEXT_DARK = (29, 29, 31)
TEXT_MID = (100, 90, 80)
TEXT_LIGHT = (155, 145, 132)
RULE_COLOR = (200, 188, 172)


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
                    region_left: int = 0, region_right: int = W) -> int:
    bbox = draw.textbbox((0, 0), text, font=font)
    tw = bbox[2] - bbox[0]
    cx = region_left + (region_right - region_left - tw) // 2
    draw.text((cx, y), text, fill=fill, font=font)
    return bbox[3] - bbox[1]


def _draw_ornament(draw: ImageDraw.ImageDraw, cx: int, cy: int, width: int, color):
    """Small decorative diamond + line ornament."""
    hw = width // 2
    draw.line([(cx - hw, cy), (cx - 8, cy)], fill=color, width=1)
    draw.line([(cx + 8, cy), (cx + hw, cy)], fill=color, width=1)
    d = 4
    draw.polygon([(cx, cy - d), (cx + d, cy), (cx, cy + d), (cx - d, cy)], fill=color)


def _draw_logo(draw: ImageDraw.ImageDraw, cx: int, cy: int, s: float, color):
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
) -> bytes:
    img = Image.new("RGB", (W, H), COVER_BG)
    draw = ImageDraw.Draw(img)

    # --- Book spine on the left edge ---
    spine_w = 28
    draw.rectangle([(0, 0), (spine_w, H)], fill=SPINE_COLOR)
    # Spine highlight
    draw.line([(spine_w - 1, 0), (spine_w - 1, H)], fill=GOLD, width=1)

    # --- Inner cover area ---
    margin = 12
    inner_l = spine_w + margin
    inner_t = margin
    inner_r = W - margin
    inner_b = H - margin
    draw.rectangle([(inner_l, inner_t), (inner_r, inner_b)], fill=INNER_BG)

    # Subtle inner border
    draw.rectangle([(inner_l, inner_t), (inner_r, inner_b)], outline=RULE_COLOR, width=1)

    content_l = inner_l + 60
    content_r = inner_r - 60
    content_w = content_r - content_l
    cover_cx = inner_l + (inner_r - inner_l) // 2

    # --- Fonts ---
    ft = _font("Georgia-Bold.ttf", 52)
    fs = _font("Georgia-Regular.ttf", 20)
    fm = _font("Arial-Regular.ttf", 14)
    fi = _font("Georgia-Regular.ttf", 12)
    fa = _font("Georgia-Regular.ttf", 16)

    # --- Top accent band ---
    band_y = inner_t + 36
    band_h = 3
    draw.rectangle([(content_l + 40, band_y), (content_r - 40, band_y + band_h)], fill=ACCENT)

    # --- Title (hero element) ---
    title_lines = _wrap(title, ft, content_w, draw)[:3]
    line_h = 68
    total_title_h = len(title_lines) * line_h

    # Vertically center the title block in the upper 60% of the inner area
    title_zone_top = inner_t + 70
    title_zone_bot = inner_b - 180
    title_start_y = title_zone_top + (title_zone_bot - title_zone_top - total_title_h) // 2
    title_start_y = max(title_start_y, title_zone_top)

    for i, ln in enumerate(title_lines):
        _text_centered(draw, title_start_y + i * line_h, ln, ft, TEXT_DARK,
                        content_l, content_r)
    cur_y = title_start_y + len(title_lines) * line_h

    # --- Subtitle ---
    if subtitle:
        cur_y += 10
        sub_lines = _wrap(subtitle, fs, content_w - 80, draw)[:2]
        for i, ln in enumerate(sub_lines):
            _text_centered(draw, cur_y + i * 30, ln, fs, TEXT_MID,
                            content_l, content_r)
        cur_y += len(sub_lines) * 30

    # --- Ornament separator ---
    cur_y += 20
    _draw_ornament(draw, cover_cx, cur_y, 120, GOLD)

    # --- Meta line (chapters + words) ---
    parts = []
    if chapter_count:
        parts.append(f"{chapter_count} chapters")
    if total_words:
        parts.append(f"{total_words:,} words")
    if parts:
        cur_y += 22
        _text_centered(draw, cur_y, "  \u00b7  ".join(parts), fm, TEXT_LIGHT,
                        content_l, content_r)

    # --- Bottom section: accent line + byline + publisher ---
    bot_rule_y = inner_b - 100
    draw.line([(content_l + 80, bot_rule_y), (content_r - 80, bot_rule_y)],
              fill=RULE_COLOR, width=1)

    # "Written by AI" byline
    byline_y = bot_rule_y + 14
    _text_centered(draw, byline_y, "Written by AI", fa, TEXT_MID,
                    content_l, content_r)

    # Feynman publisher imprint: logo + text on the same line
    imprint_y = inner_b - 38
    imprint_text = "FEYNMAN"
    ibbox = draw.textbbox((0, 0), imprint_text, font=fi)
    iw = ibbox[2] - ibbox[0]
    ih = ibbox[3] - ibbox[1]
    logo_s = 0.55
    logo_total_w = 36 * logo_s
    gap = 6
    group_w = logo_total_w + gap + iw
    group_x = cover_cx - group_w // 2
    _draw_logo(draw, int(group_x + logo_total_w // 2), imprint_y - 4, logo_s, TEXT_LIGHT)
    draw.text((int(group_x + logo_total_w + gap), imprint_y - ih // 2), imprint_text,
              fill=TEXT_LIGHT, font=fi)

    buf = io.BytesIO()
    img.save(buf, format="PNG", optimize=True)
    return buf.getvalue()
