"""Project Gutenberg content source — Phase 9 of the SEO/GEO plan.

This module is what lets Feynman actually deliver on the three core
products (chat-with-books, great-minds-join, chat-with-mind) for the
class of books that matter most to those products: the public-domain
canon. Without it, ~99% of our catalog is metadata stubs (audit
2026-05-26: 8 of 920 books had real full-text content).

Architecture
------------
We deliberately do NOT use the third-party Gutendex API. It was
unresponsive during integration testing (curl + httpx both timed out
at 30s) and being a community-run intermediary, it's a single point
of failure. Instead:

  1. **Catalog**: download Gutenberg's own canonical CSV catalog
     (`pg_catalog.csv`, ~3MB, 12,000+ books, refreshed by Gutenberg
     daily). Cached in /tmp on first use, kept in-memory for the
     function lifetime.
  2. **Search**: local scoring against the in-memory catalog — no
     network round-trip, no rate limit, no dependency on third
     parties. Fast (~1ms per query).
  3. **Fetch**: direct GET against `gutenberg.org/ebooks/{id}.txt.utf-8`.
     Gutenberg's primary domain has been online and fast (5s for the
     94KB Communist Manifesto in production tests).

What it unlocks
---------------
For any catalog title that matches a Gutenberg book,
``fetch_book_content`` returns the **full text** instead of a back-
cover blurb. Concretely this unlocks the works of essentially every
pre-1928 thinker in our Great Minds roster: Marx, Smith, Darwin,
Aristotle, Plato, Nietzsche, Kant, Hume, Locke, Hobbes, Mill, Freud,
Tolstoy, Dostoevsky, Twain, Austen, Confucius, Lao Tzu — about
12,000+ public-domain books in the searchable catalog.

What it does NOT add
--------------------
Modern in-copyright books. Gutenberg is strictly public-domain. Those
fall through to the existing metadata fallback chain (OpenLibrary,
Google Books, Wikipedia).

API
---
- ``search_gutenberg(title, author)`` -> best matching catalog row or None.
- ``fetch_gutenberg_text(book_id)`` -> raw downloaded text.
- ``strip_gutenberg_boilerplate(text)`` -> body between START/END markers.
- ``fetch_gutenberg_content(title, author)`` -> orchestrator. Returns
  cleaned full text or empty string. This is the entry point called
  by ``sources.fetch_book_content``.

All HTTP calls have explicit timeouts and never raise — failures
return empty strings so the upstream fallback chain takes over.
"""
from __future__ import annotations

import csv
import io
import logging
import os
import re
import threading
import time
from typing import Any

import httpx

log = logging.getLogger(__name__)


_CATALOG_URL = "https://www.gutenberg.org/cache/epub/feeds/pg_catalog.csv"
_CATALOG_CACHE_PATH = "/tmp/gutenberg_catalog.csv"
# Catalog is refreshed by Gutenberg roughly daily; we re-download once
# a week to keep things fresh without hammering their CDN.
_CATALOG_MAX_AGE_S = 7 * 24 * 3600

# Cap on individual book size. Das Kapital Vol I is ~1.5MB, War and
# Peace is ~3.5MB. The indexer chunker handles arbitrary input but
# embedding cost grows linearly. 1.5MB ≈ 250K words ≈ 1500 chunks ≈
# reasonable per-book budget.
_MAX_TEXT_BYTES = 1_500_000

# Gutenberg's marker lines bracket the actual book content. Everything
# before START is metadata + licence preamble; everything after END is
# the ~20KB full Gutenberg licence (we definitely don't want it in RAG).
_START_RE = re.compile(r"^\*\*\*\s*START OF (?:THE|THIS) PROJECT GUTENBERG.*?\*\*\*", re.MULTILINE | re.IGNORECASE)
_END_RE = re.compile(r"^\*\*\*\s*END OF (?:THE|THIS) PROJECT GUTENBERG.*?\*\*\*", re.MULTILINE | re.IGNORECASE)

# In-memory catalog cache (process-lifetime). Loaded lazily on first
# query. Lock guards against concurrent first-call races.
_CATALOG: list[dict[str, Any]] | None = None
_CATALOG_LOCK = threading.Lock()


def _normalize_for_match(s: str) -> str:
    """Lowercase, drop non-alnum, collapse whitespace — for loose title
    and author equivalence checks."""
    return re.sub(r"[^a-z0-9]+", " ", (s or "").lower()).strip()


def _author_surname(name: str) -> str:
    """Gutenberg returns authors as 'Last, First (yyyy-yyyy)'. The
    surname is the strongest match signal because OpenLibrary / catalog
    data often gives 'First Last'. Return lowercased surname."""
    if not name:
        return ""
    # Strip parenthetical date range if present
    name = re.sub(r"\s*\([^)]*\)\s*$", "", name).strip()
    # If 'Last, First' format → take the part before the comma
    if "," in name:
        head = name.split(",", 1)[0].strip()
    else:
        # 'First Last' → take last word
        parts = name.split()
        head = parts[-1] if parts else name
    return _normalize_for_match(head)


def _download_catalog() -> str:
    """Fetch the canonical Gutenberg catalog CSV, with on-disk cache
    in /tmp. Returns the CSV body as a string. Empty string on failure
    (caller will then return None searches and the metadata fallback
    chain takes over)."""
    # Use the disk cache if recent enough
    try:
        st = os.stat(_CATALOG_CACHE_PATH)
        if time.time() - st.st_mtime < _CATALOG_MAX_AGE_S and st.st_size > 100_000:
            with open(_CATALOG_CACHE_PATH, "r", encoding="utf-8", errors="replace") as f:
                return f.read()
    except FileNotFoundError:
        pass
    except Exception as exc:
        log.warning("Catalog cache read failed: %s", exc)

    try:
        with httpx.Client(timeout=60, follow_redirects=True) as client:
            resp = client.get(_CATALOG_URL)
        if resp.status_code >= 400:
            log.warning("Gutenberg catalog fetch -> %d", resp.status_code)
            return ""
        body = resp.text
        # Best-effort write to cache; failures are non-fatal
        try:
            with open(_CATALOG_CACHE_PATH, "w", encoding="utf-8") as f:
                f.write(body)
        except Exception as exc:
            log.warning("Catalog cache write failed: %s", exc)
        return body
    except Exception as exc:
        log.warning("Catalog fetch error: %s", exc)
        return ""


def _parse_catalog(body: str) -> list[dict[str, Any]]:
    """Parse the catalog CSV into a list of {id, title, authors,
    language, subjects, type} dicts. Filters to 'Text' type (skip
    audio, sound). Authors is a list of strings."""
    out: list[dict[str, Any]] = []
    if not body:
        return out
    reader = csv.DictReader(io.StringIO(body))
    for row in reader:
        if (row.get("Type") or "").strip() != "Text":
            continue
        try:
            bid = int((row.get("Text#") or "").strip())
        except (ValueError, TypeError):
            continue
        title = (row.get("Title") or "").strip()
        if not title:
            continue
        authors_raw = (row.get("Authors") or "").strip()
        # Gutenberg uses '; ' between multiple authors
        authors = [a.strip() for a in authors_raw.split(";") if a.strip()]
        out.append({
            "id": bid,
            "title": title,
            "authors": authors,
            "language": (row.get("Language") or "").strip(),
            "subjects": (row.get("Subjects") or "").strip(),
        })
    return out


def _get_catalog() -> list[dict[str, Any]]:
    """Return the in-memory catalog, loading it lazily on first call."""
    global _CATALOG
    if _CATALOG is not None:
        return _CATALOG
    with _CATALOG_LOCK:
        if _CATALOG is not None:
            return _CATALOG
        body = _download_catalog()
        parsed = _parse_catalog(body)
        log.info("Loaded Gutenberg catalog: %d Text-type books", len(parsed))
        _CATALOG = parsed
        return _CATALOG


def search_gutenberg(title: str, author: str = "") -> dict[str, Any] | None:
    """Find the best matching book in the local catalog.

    Matching priority:
      1. Fraction of significant query-title tokens present in book
         title (skip stopwords like 'the', 'of', 'and').
      2. If ``author`` provided, prefer hits whose author list contains
         a matching surname.
      3. Among ties, prefer English text + lower book_id (earlier IDs
         tend to be the canonical popular editions).

    Returns the catalog row dict or None if no acceptable match."""
    if not title:
        return None
    catalog = _get_catalog()
    if not catalog:
        return None

    title_tokens = [
        t for t in _normalize_for_match(title).split()
        if len(t) >= 3 and t not in {"the", "and", "for", "with", "from",
                                      "about", "into", "upon"}
    ]
    if not title_tokens:
        return None
    author_surname = _author_surname(author) if author else ""

    # When the agent title is just one meaningful word — either by
    # itself ('Game', 'Quiet') or because the rest is filler ('New Me'
    # → ['new']) — require EXACT normalized-title equality even when
    # an author is provided. Otherwise a junk agent ('New Me' by
    # 'Samuel Butler') token-matches an unrelated long title ('Ex Voto
    # ... New Jerusalem' by 'Butler, Samuel') and we re-index the
    # wrong book's text into our agent. The exact-title requirement
    # also covers the no-author short-title case.
    require_exact_title = (
        len(title_tokens) <= 1
        or ((not author_surname) and len(title_tokens) <= 2)
    )
    norm_query_title = _normalize_for_match(title)

    scored: list[tuple[float, int, dict[str, Any]]] = []
    for book in catalog:
        bt = _normalize_for_match(book["title"])
        if require_exact_title:
            if bt != norm_query_title:
                continue
            title_score = 1.0
        else:
            hits = sum(1 for tok in title_tokens if tok in bt)
            title_score = hits / len(title_tokens)
            if title_score < 0.6:
                continue

        # Strict author gate — if the caller provided an author, the
        # Gutenberg candidate MUST have at least one matching author
        # surname or we reject the candidate entirely. This is the
        # difference between a usable matcher and a noise factory:
        # 'Daybreak' by Nietzsche must not match 'Daybreak: A Romance
        # of an Old World' by Cowan just because the title token aligns.
        # When author is not provided, the exact-title check above
        # carries the precision instead.
        author_score = 0.0
        if author_surname:
            matched = False
            for a in book["authors"]:
                a_surname = _author_surname(a)
                if not a_surname:
                    continue
                if (author_surname == a_surname or
                        author_surname in a_surname or
                        a_surname in author_surname):
                    matched = True
                    break
            if not matched:
                continue  # hard-reject — different book by different author
            author_score = 1.0

        # English-language preference, lower id preference
        eng_bonus = 0.15 if "en" in book["language"].lower() else 0.0
        # negative book_id used as tiebreaker (lower id wins)
        scored.append((title_score + author_score + eng_bonus, -book["id"], book))

    if not scored:
        return None
    scored.sort(key=lambda x: (x[0], x[1]), reverse=True)
    return scored[0][2]


def fetch_gutenberg_text(book_id: int) -> str:
    """Download the raw text for a Gutenberg book via the primary
    domain (not the Gutendex intermediary). Tries the canonical URL
    pattern first, then a fallback for older books.

    Returns the body string (not yet stripped of Gutenberg boilerplate)
    or empty string on failure."""
    # Canonical pattern
    urls = [
        f"https://www.gutenberg.org/ebooks/{book_id}.txt.utf-8",
        f"https://www.gutenberg.org/cache/epub/{book_id}/pg{book_id}.txt",
        f"https://www.gutenberg.org/files/{book_id}/{book_id}-0.txt",
    ]
    for url in urls:
        try:
            with httpx.Client(timeout=45, follow_redirects=True) as client:
                resp = client.get(url)
            if resp.status_code < 400 and len(resp.content) > 500:
                body = resp.content[:_MAX_TEXT_BYTES]
                try:
                    return body.decode("utf-8", errors="replace")
                except Exception:
                    return body.decode("latin-1", errors="replace")
        except Exception as exc:
            log.debug("Gutenberg fetch %s: %s", url, exc)
            continue
    log.info("Gutenberg book %d had no fetchable plain-text URL", book_id)
    return ""


def strip_gutenberg_boilerplate(text: str) -> str:
    """Cut the Gutenberg header (everything before the START marker)
    and footer (everything after the END marker). If markers aren't
    found, return text unchanged — better to ship the whole file with
    some noise than to error out and lose the book entirely."""
    if not text:
        return ""
    start_match = _START_RE.search(text)
    end_match = _END_RE.search(text)
    s = start_match.end() if start_match else 0
    e = end_match.start() if end_match else len(text)
    if e <= s:
        return text
    return text[s:e].strip()


def fetch_gutenberg_content(title: str, author: str = "") -> str:
    """Orchestrator. Returns cleaned full text for a Gutenberg-matched
    book, or empty string if no match / fetch failed.

    This is what ``sources.fetch_book_content`` calls FIRST, before
    falling back to OpenLibrary / Google Books metadata. The payload
    format is just the cleaned text — no metadata wrapping — because
    chunk-level retrieval cares about the actual sentences, not the
    title (which is already on the agent row).
    """
    match = search_gutenberg(title, author)
    if not match:
        return ""
    bid = match["id"]
    raw = fetch_gutenberg_text(bid)
    if not raw:
        return ""
    body = strip_gutenberg_boilerplate(raw)
    if len(body) > _MAX_TEXT_BYTES:
        body = body[:_MAX_TEXT_BYTES]
    log.info(
        "Gutenberg hit for %r → book_id=%d, %d chars after cleanup",
        title, bid, len(body),
    )
    return body
