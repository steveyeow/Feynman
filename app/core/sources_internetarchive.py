"""Internet Archive content source — massive OCR'd full text.

The catch-all full-text source: archive.org has millions of digitized texts
(public-domain + older scans) across languages that Gutenberg and Wikisource
miss. The trade-off is NOISE — a loose title search over millions of items
easily returns the wrong book, and indexing the wrong text into an agent is
worse than no text. So matching is STRICT (mirrors Gutenberg): a hard author
gate when an author is given, a high title-token threshold, exact-title for
short titles, and downloads-desc ordering so the canonical edition wins.

Pipeline: advancedsearch (title + mediatype:texts, downloads desc) → client-side
strict gate → metadata → the item's ``*_djvu.txt`` OCR file. Never raises.

API: ``fetch_internetarchive_content(title, author) -> str`` (cleaned OCR text
or "" on no confident match). Entry point for ``sources.fetch_book_content``.
"""
from __future__ import annotations

import logging
import re

import httpx

log = logging.getLogger(__name__)

_TIMEOUT = 30
_UA = "FeynmanBot/1.0 (+https://feynman.wiki)"
_MAX_TEXT_BYTES = 1_500_000
# An IA hit should be a real book; below this we treat it as a miss and fall
# through (a stray pamphlet / catalog card / bad OCR derivative).
_MIN_USEFUL_CHARS = 2000
_STOP = {"the", "and", "for", "with", "from", "about", "into", "upon", "of", "a", "an"}


def _norm(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", (s or "").lower()).strip()


def _surname(name: str) -> str:
    name = re.sub(r"\s*\([^)]*\)\s*", "", name or "")
    head = name.split(",")[0] if "," in name else (name.split()[-1] if name.split() else name)
    return _norm(head)


def _search_ia(title: str, author: str) -> str | None:
    """Best IA item identifier for (title, author), or None. Strict: hard
    author-surname gate, high title-token overlap, exact-title for short
    titles; among survivors the most-downloaded (canonical) edition wins."""
    tokens = [t for t in _norm(title).split() if len(t) >= 3 and t not in _STOP]
    if not tokens:
        return None
    params = [
        ("q", f"title:({' '.join(tokens)}) AND mediatype:texts"),
        ("rows", "20"),
        ("output", "json"),
        ("sort[]", "downloads desc"),
        ("fl[]", "identifier"), ("fl[]", "title"), ("fl[]", "creator"),
        ("fl[]", "language"), ("fl[]", "downloads"),
    ]
    try:
        with httpx.Client(timeout=_TIMEOUT, headers={"User-Agent": _UA}, follow_redirects=True) as c:
            r = c.get("https://archive.org/advancedsearch.php", params=params)
        if r.status_code >= 400:
            return None
        docs = r.json().get("response", {}).get("docs", [])
    except Exception as exc:
        log.debug("IA search %r: %s", title, exc)
        return None

    asur = _surname(author) if author else ""
    nq = _norm(title)
    # Short / author-less titles need an exact title match (same precision guard
    # as Gutenberg) — 'Quiet', 'Game' would otherwise grab any item containing
    # the word out of millions.
    require_exact = len(tokens) <= 1 or (not asur and len(tokens) <= 2)

    best: str | None = None
    best_dl = -1
    qset = set(tokens)
    for d in docs:
        bt = _norm(str(d.get("title", "")))
        if require_exact:
            if bt != nq:
                continue
        else:
            # BIDIRECTIONAL match: most query tokens must be present AND the
            # candidate must not be drowned in extra significant tokens (a much
            # longer title = a different/bigger work). One-directional overlap
            # let "TED Talk: The Universe as a Laboratory" grab a 1.5MB unrelated
            # item and "Les Troyens" a 621KB one — the Jaccard guard rejects both.
            bset = {t for t in bt.split() if len(t) >= 3 and t not in _STOP}
            if not bset:
                continue
            present = len(qset & bset) / len(qset)
            jaccard = len(qset & bset) / len(qset | bset)
            if present < 0.8 or jaccard < 0.5:
                continue
        cre = d.get("creator", "")
        cre = cre if isinstance(cre, str) else " ".join(cre or [])
        if asur and asur not in _surname(cre) and asur not in _norm(cre):
            continue  # hard author gate
        dl = int(d.get("downloads") or 0)
        if dl > best_dl:
            best_dl, best = dl, d.get("identifier")
    return best


def _clean_ocr(text: str) -> str:
    if not text:
        return ""
    text = text.replace("\f", "\n")  # form-feed page breaks
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def _fetch_ia_text(identifier: str) -> str:
    """Download the item's OCR full text (``*_djvu.txt``, or a Text-format
    ``.txt`` derivative). Empty string on any failure."""
    try:
        with httpx.Client(timeout=_TIMEOUT, headers={"User-Agent": _UA}, follow_redirects=True) as c:
            m = c.get(f"https://archive.org/metadata/{identifier}")
            if m.status_code >= 400:
                return ""
            files = m.json().get("files", []) or []
            name = next((f["name"] for f in files if str(f.get("name", "")).endswith("_djvu.txt")), None)
            if not name:
                name = next((f["name"] for f in files
                             if f.get("format") == "Text" and str(f.get("name", "")).endswith(".txt")), None)
            if not name:
                return ""
            r = c.get(f"https://archive.org/download/{identifier}/{name}")
            if r.status_code >= 400 or len(r.content) < 500:
                return ""
            return r.content[:_MAX_TEXT_BYTES].decode("utf-8", errors="replace")
    except Exception as exc:
        log.debug("IA fetch %s: %s", identifier, exc)
        return ""


def fetch_internetarchive_content(title: str, author: str = "") -> str:
    """Orchestrator. Returns cleaned OCR full text from Internet Archive for a
    confidently-matched item, or "" if no strict match. Entry point for
    ``sources.fetch_book_content``."""
    ident = _search_ia(title, author)
    if not ident:
        return ""
    text = _clean_ocr(_fetch_ia_text(ident))
    if len(text) < _MIN_USEFUL_CHARS:
        return ""
    log.info("Internet Archive hit for %r → %s, %d chars", title, ident, len(text))
    return text
