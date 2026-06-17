"""Wikisource content source — multi-language full text.

Gutenberg (``sources_gutenberg``) is English-centric and pre-1928; it leaves
non-English and many niche public-domain works as zero-chunk stubs. Wikisource
covers ~70 languages (huge for Chinese/Japanese/etc.) and many texts Gutenberg
lacks, so it's the highest-value addition to the full-text chain.

Structure quirks this handles (validated on 辋川集 / 輞川集):
  - A work page is often a TABLE OF CONTENTS whose sections are SUBPAGES
    (``Work/Section``); the body lives on the subpages, not the work page.
  - Subpages frequently REDIRECT to a canonical page (``輞川集 (王維)/鹿柴`` →
    ``鹿柴 (王維)``).
  - Text is commonly TRANSCLUDED from the ``Page:`` namespace (ProofreadPage),
    so the plaintext ``extracts`` API returns empty. We use the rendered-HTML
    ``parse`` API (``redirects=1`` follows redirects, transclusions are expanded)
    and strip the markup.

Disambiguation: many works exist in several author-versions (``輞川集 (王維)`` vs
``輞川集 (裴迪)``). We score candidates by Han-character overlap with the caller's
author (robust to simplified↔traditional: 王维∩王維 = {王}), so the right
version wins even across the variant.

All HTTP calls have timeouts and never raise — failures return "" so the
upstream ``fetch_book_content`` fallback chain takes over.

API
---
- ``fetch_wikisource_content(title, author)`` -> cleaned full text or "".
  This is what ``sources.fetch_book_content`` calls.
"""
from __future__ import annotations

import html
import logging
import re

import httpx

log = logging.getLogger(__name__)

_TIMEOUT = 25
_UA = "FeynmanBot/1.0 (+https://feynman.wiki)"
# Same per-book ceiling as Gutenberg — embedding cost grows linearly.
_MAX_TEXT_BYTES = 1_500_000
# A real work should clear this after markup-strip; below it we treat the
# fetch as a miss and fall through (a bare TOC / disambiguation page).
_MIN_USEFUL_CHARS = 400


def _detect_lang(title: str) -> str:
    """Pick the Wikisource subdomain from the title's script. Covers the
    languages our catalog actually carries non-English works in; everything
    else falls to English (en.wikisource also hosts translations)."""
    def has(lo: int, hi: int) -> bool:
        return any(lo <= ord(c) <= hi for c in title)
    if has(0x3040, 0x30FF):
        return "ja"  # hiragana / katakana (check before Han — JA uses Han too)
    if has(0xAC00, 0xD7A3):
        return "ko"  # hangul
    if has(0x0400, 0x04FF):
        return "ru"  # cyrillic
    if has(0x4E00, 0x9FFF):
        return "zh"  # CJK Han
    return "en"


def _clean_title(title: str) -> str:
    """Drop a trailing romanization/qualifier parenthetical so the search
    query is the native title: '辋川集 (Wangchuan Ji)' -> '辋川集'."""
    t = re.sub(r"\s*[\(（][^)）]*[\)）]\s*$", "", title or "").strip()
    return t or (title or "").strip()


def _han(s: str) -> set[str]:
    return {c for c in (s or "") if 0x4E00 <= ord(c) <= 0x9FFF}


def _norm(s: str) -> str:
    return re.sub(r"[^a-z0-9一-鿿]+", "", (s or "").lower())


def _api(lang: str, params: dict) -> dict | None:
    url = f"https://{lang}.wikisource.org/w/api.php"
    try:
        with httpx.Client(timeout=_TIMEOUT, headers={"User-Agent": _UA}, follow_redirects=True) as c:
            r = c.get(url, params={**params, "format": "json"})
        if r.status_code >= 400:
            return None
        return r.json()
    except Exception as exc:
        log.debug("wikisource api (%s): %s", lang, exc)
        return None


def _strip_html(h: str) -> str:
    if not h:
        return ""
    # Drop non-content blocks (refs, figure tables) + Wikisource chrome: the
    # per-section [edit] spans and the header/sister-projects nav.
    h = re.sub(r"<(script|style|sup|table|head)[^>]*>.*?</\1>", " ", h, flags=re.S | re.I)
    h = re.sub(r'<span[^>]*class="[^"]*mw-editsection[^"]*"[^>]*>.*?</span>', " ", h, flags=re.S | re.I)
    h = re.sub(r"<[^>]+>", " ", h)
    t = re.sub(r"\s+", " ", html.unescape(h)).strip()
    # Residual section-edit markers + the standard header/sister-projects line.
    t = re.sub(r"\[\s*(编辑|編輯|edit)\s*\]", " ", t)
    t = re.sub(r"\bsister projects\s*:.*?Wikidata item\b", " ", t, flags=re.I)
    return re.sub(r"\s+", " ", t).strip()


def _page_text(lang: str, title: str) -> str:
    """Rendered plain text of ONE page — follows redirects and expands
    ProofreadPage transclusions (which the plaintext extractor misses)."""
    d = _api(lang, {
        "action": "parse", "page": title, "prop": "text",
        "redirects": 1, "disablelimitreport": 1,
    })
    node = ((d or {}).get("parse", {}) or {}).get("text", "")
    if isinstance(node, dict):
        node = node.get("*", "")
    return _strip_html(node or "")


def _subpages(lang: str, work: str) -> list[str]:
    """All mainspace subpages of a work (``Work/...``), in title order."""
    d = _api(lang, {
        "action": "query", "generator": "allpages",
        "gapprefix": work + "/", "gapnamespace": 0, "gaplimit": 200,
    })
    pages = ((d or {}).get("query", {}) or {}).get("pages", {})
    titles = [p["title"] for p in pages.values() if p.get("title")]
    titles.sort()
    return titles


def search_wikisource(title: str, author: str, lang: str) -> str | None:
    """Find the best WORK page for (title, author) on the given Wikisource.

    Candidates include both the search hits AND the parent-before-'/' of any
    subpage hit (a work split into subpages surfaces its sections, not its
    cover, in search). Scored by: query-title match, author Han-overlap (or
    Latin-substring), preferring a real work page over a lone subpage."""
    q = _clean_title(title)
    if not q:
        return None
    d = _api(lang, {
        "action": "query", "list": "search", "srsearch": q,
        "srnamespace": 0, "srlimit": 15,
    })
    hits = ((d or {}).get("query", {}) or {}).get("search", [])
    if not hits:
        return None

    qn = _norm(q)
    a_han = _han(author)
    a_lat = re.sub(r"[^a-z]+", "", (author or "").lower())

    # Candidate works: each hit, plus the parent of any subpage hit.
    cands: dict[str, int] = {}
    for h in hits:
        t = h.get("title", "")
        if not t:
            continue
        cands[t] = cands.get(t, 0)
        if "/" in t:
            parent = t.rsplit("/", 1)[0]
            cands[parent] = cands.get(parent, 0) + 1  # +1 per subpage seen

    def score(t: str) -> float:
        s = 0.0
        tn = _norm(t)
        if qn and qn in tn:
            s += 2.0
        if "/" not in t:
            s += 1.5  # a work page, not a stray subpage
        # "Has subpages" marks a real work, but CAP it low so it can't override
        # the author signal — two author-versions (王維 vs 裴迪) have ~equal
        # subpage counts, so author must be the disambiguator, not volume.
        s += 0.3 * min(cands[t], 3)
        # Author match — the PRIMARY disambiguator. Han-char overlap is robust
        # to simplified↔traditional (王维∩王維={王}); Latin-substring for western.
        paren = re.search(r"[\(（]([^)）]*)[\)）]", t)
        ptxt = paren.group(1) if paren else ""
        if a_han:
            s += 3.0 * len(a_han & _han(ptxt))
        elif a_lat and a_lat in re.sub(r"[^a-z]+", "", t.lower()):
            s += 3.0
        s -= 0.002 * len(t)  # tie-break toward the shorter (canonical) title
        return s

    best = max(cands, key=score)
    return best if score(best) > 0 else hits[0]["title"]


def fetch_wikisource_text(lang: str, work: str) -> str:
    """Full text of a work: the work page itself plus all its subpages
    (each rendered, redirects followed), concatenated. Handles both the
    single-page-prose and the TOC-of-subpages shapes."""
    parts: list[str] = []
    seen: set[str] = set()

    main = _page_text(lang, work)
    if len(main) >= _MIN_USEFUL_CHARS:
        parts.append(main)
        seen.add(_norm(main)[:200])

    total = sum(len(p) for p in parts)
    for sub in _subpages(lang, work):
        if total >= _MAX_TEXT_BYTES:
            break
        txt = _page_text(lang, sub)
        if not txt:
            continue
        key = _norm(txt)[:200]
        if key in seen:  # subpage redirects to a page we already have
            continue
        seen.add(key)
        parts.append(txt)
        total += len(txt)

    body = "\n\n".join(parts).strip()
    return body[:_MAX_TEXT_BYTES]


def fetch_wikisource_content(title: str, author: str = "") -> str:
    """Orchestrator. Returns cleaned full text from Wikisource for a matched
    work, or "" if no usable match. Entry point for ``fetch_book_content``."""
    lang = _detect_lang(title)
    work = search_wikisource(title, author, lang)
    if not work:
        return ""
    body = fetch_wikisource_text(lang, work)
    if len(body) < _MIN_USEFUL_CHARS:
        return ""
    log.info("Wikisource hit for %r → %s:%r, %d chars", title, lang, work, len(body))
    return body
