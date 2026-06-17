"""arXiv content source — full text of scientific preprints via ar5iv HTML.

Niche + LAST in the full-text chain: only matches actual arXiv papers (1991+
preprints, mostly physics/math/CS/quant-bio). It will NOT help pre-arXiv works
(old Nobel lectures, books, historical papers) — those fall through. It fires
only when a catalog title confidently matches an arXiv paper title, so it's
safe to try for everything that misses the earlier sources.

Pipeline: arXiv Atom API (title search, HTTPS — http returns empty) → confident
title match → ar5iv rendered HTML (full paper) → strip; abstract as a thin
fallback. Never raises.

API: ``fetch_arxiv_content(title, author) -> str``.
"""
from __future__ import annotations

import html
import logging
import re

import httpx

log = logging.getLogger(__name__)

_TIMEOUT = 30
_UA = "Mozilla/5.0 (compatible; FeynmanBot/1.0; +https://feynman.wiki)"
_MAX_TEXT_BYTES = 1_500_000
_MIN_USEFUL_CHARS = 1500


def _norm(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", (s or "").lower()).strip()


def _overlap(a: str, b: str) -> float:
    sa, sb = set(a.split()), set(b.split())
    if not sa or not sb:
        return 0.0
    return len(sa & sb) / len(sa | sb)


def _search_arxiv(title: str) -> tuple[str, str] | None:
    """Return (arxiv_id, abstract) for a confident title match, else None.
    Papers have specific titles, so we require near-equality — avoids matching
    a paper that merely shares a topical word with the catalog title."""
    q = (title or "").strip()
    if len(q) < 6:
        return None
    try:
        with httpx.Client(timeout=_TIMEOUT, headers={"User-Agent": _UA}, follow_redirects=True) as c:
            r = c.get("https://export.arxiv.org/api/query",
                      params={"search_query": f'ti:"{q}"', "max_results": "5"})
        if r.status_code >= 400:
            return None
        feed = r.text
    except Exception as exc:
        log.debug("arxiv search %r: %s", title, exc)
        return None

    nq = _norm(title)
    for entry in re.findall(r"<entry>(.*?)</entry>", feed, flags=re.S):
        tm = re.search(r"<title>(.*?)</title>", entry, flags=re.S)
        idm = re.search(r"<id>https?://arxiv\.org/abs/([^<]+)</id>", entry)
        if not tm or not idm:
            continue
        et = _norm(html.unescape(tm.group(1)))
        if et == nq or nq in et or et in nq or _overlap(nq, et) >= 0.8:
            abs_m = re.search(r"<summary>(.*?)</summary>", entry, flags=re.S)
            abstract = html.unescape(abs_m.group(1)).strip() if abs_m else ""
            return idm.group(1), re.sub(r"\s+", " ", abstract)
    return None


def _strip_html(h: str) -> str:
    h = re.sub(r"<(script|style|math|svg|table|head|nav)[^>]*>.*?</\1>", " ", h, flags=re.S | re.I)
    return re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", h))).strip()


def _fetch_ar5iv(arxiv_id: str) -> str:
    """ar5iv rendered HTML for the paper → plain text. ar5iv uses the bare id
    (no version suffix)."""
    bare = re.sub(r"v\d+$", "", arxiv_id)
    for url in (f"https://ar5iv.labs.arxiv.org/html/{bare}",
                f"https://ar5iv.org/html/{bare}"):
        try:
            with httpx.Client(timeout=_TIMEOUT, headers={"User-Agent": _UA}, follow_redirects=True) as c:
                r = c.get(url)
            if r.status_code < 400 and len(r.text) > 4000:
                return _strip_html(r.text)[:_MAX_TEXT_BYTES]
        except Exception as exc:
            log.debug("ar5iv %s: %s", url, exc)
            continue
    return ""


def fetch_arxiv_content(title: str, author: str = "") -> str:
    """Orchestrator. Full text of a confidently-matched arXiv paper (ar5iv),
    or the abstract if ar5iv is unavailable, or "" on no match."""
    hit = _search_arxiv(title)
    if not hit:
        return ""
    arxiv_id, abstract = hit
    body = _fetch_ar5iv(arxiv_id)
    if len(body) >= _MIN_USEFUL_CHARS:
        log.info("arXiv hit for %r → %s (ar5iv full text, %d chars)", title, arxiv_id, len(body))
        return body
    # ar5iv unavailable — the abstract is still real, attributable content.
    if len(abstract) >= 200:
        log.info("arXiv hit for %r → %s (abstract only, %d chars)", title, arxiv_id, len(abstract))
        return f"Title: {title}\n\nAbstract: {abstract}"
    return ""
