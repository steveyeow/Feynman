from __future__ import annotations

import logging

import httpx
from urllib.parse import quote, quote_plus

log = logging.getLogger(__name__)


def fetch_wikipedia_summary(topic: str, lang: str = "zh") -> str:
    topic = topic.strip()
    if not topic:
        return ""
    url = f"https://{lang}.wikipedia.org/api/rest_v1/page/summary/{quote(topic)}"
    with httpx.Client(timeout=30) as client:
        resp = client.get(url)
    if resp.status_code >= 400:
        return ""
    data = resp.json()
    return (data.get("extract") or "").strip()


def fetch_open_library_text(title: str, author: str = "") -> str:
    """Search Open Library for a book and return its description/first sentence."""
    try:
        params = f"title={quote_plus(title)}"
        if author:
            params += f"&author={quote_plus(author)}"
        url = f"https://openlibrary.org/search.json?{params}&limit=3"
        with httpx.Client(timeout=30) as client:
            resp = client.get(url)
        if resp.status_code >= 400:
            return ""
        data = resp.json()
        docs = data.get("docs", [])
        if not docs:
            return ""

        # Collect useful text from the best match
        doc = docs[0]
        parts = []
        if doc.get("title"):
            author_str = ", ".join(doc.get("author_name", [])[:3])
            parts.append(f"Title: {doc['title']}" + (f" by {author_str}" if author_str else ""))
        if doc.get("first_sentence"):
            sentences = doc["first_sentence"]
            if isinstance(sentences, list):
                parts.append("First sentence: " + sentences[0])
            elif isinstance(sentences, str):
                parts.append("First sentence: " + sentences)
        if doc.get("subject"):
            parts.append("Subjects: " + ", ".join(doc["subject"][:15]))

        # Try to get the book description from the work
        work_key = doc.get("key")
        if work_key:
            work_url = f"https://openlibrary.org{work_key}.json"
            with httpx.Client(timeout=15) as client:
                wresp = client.get(work_url)
            if wresp.status_code < 400:
                work = wresp.json()
                desc = work.get("description")
                if isinstance(desc, dict):
                    desc = desc.get("value", "")
                if desc:
                    parts.append(f"Description: {desc}")

        return "\n\n".join(parts)
    except Exception as exc:
        log.warning("Open Library fetch failed: %s", exc)
        return ""


def fetch_google_books_info(title: str, author: str = "") -> str:
    """Search Google Books API (free, no key) for book info."""
    try:
        q = title
        if author:
            q += f"+inauthor:{author}"
        url = f"https://www.googleapis.com/books/v1/volumes?q={quote_plus(q)}&maxResults=3"
        with httpx.Client(timeout=30) as client:
            resp = client.get(url)
        if resp.status_code >= 400:
            return ""
        data = resp.json()
        items = data.get("items", [])
        if not items:
            return ""

        vol = items[0].get("volumeInfo", {})
        parts = []
        if vol.get("title"):
            authors = ", ".join(vol.get("authors", []))
            parts.append(f"Title: {vol['title']}" + (f" by {authors}" if authors else ""))
        if vol.get("description"):
            parts.append(f"Description: {vol['description']}")
        if vol.get("categories"):
            parts.append("Categories: " + ", ".join(vol["categories"]))
        if vol.get("pageCount"):
            parts.append(f"Pages: {vol['pageCount']}")
        snippet = (
            items[0].get("searchInfo", {}).get("textSnippet", "")
        )
        if snippet:
            parts.append(f"Snippet: {snippet}")

        return "\n\n".join(parts)
    except Exception as exc:
        log.warning("Google Books fetch failed: %s", exc)
        return ""


def _wrap_fulltext(title: str, author: str, body: str) -> str:
    """Prepend a title/author header (so chunk[0] carries attribution) + an
    Open Library metadata block (subjects/categories give RAG structured
    context alongside the primary text)."""
    header = f"Title: {title}" + (f" by {author}" if author else "") + "\n\n"
    meta = fetch_open_library_text(title, author)
    if meta:
        header += "--- Metadata ---\n\n" + meta + "\n\n--- Text ---\n\n"
    return header + body


def fetch_book_content(title: str, author: str = "") -> str:
    """Orchestrator: try FULL-TEXT sources (Gutenberg + Wikisource, ordered by
    the title's language) → METADATA sources (Open Library → Google Books →
    Wikipedia). Full text means RAG has the actual book to retrieve from;
    modern in-copyright books fall through to metadata (the best free APIs
    allow).

    - **Gutenberg** — English public-domain canon, clean (boilerplate-stripped).
    - **Wikisource** — ~70 languages incl. CJK + many works Gutenberg lacks, so
      it LEADS for non-English titles and BACKS UP Gutenberg for English.

    Adding a source = a new ``(name, fn)`` in the chain below (Internet Archive,
    arXiv, … are the planned next entries). Each fn is `(title, author) -> text`
    and must never raise (local import keeps the module importable if an
    optional source is stripped)."""
    def _gutenberg(t: str, a: str) -> str:
        from .sources_gutenberg import fetch_gutenberg_content
        return fetch_gutenberg_content(t, a)

    def _wikisource(t: str, a: str) -> str:
        from .sources_wikisource import fetch_wikisource_content
        return fetch_wikisource_content(t, a)

    def _internet_archive(t: str, a: str) -> str:
        from .sources_internetarchive import fetch_internetarchive_content
        return fetch_internetarchive_content(t, a)

    def _arxiv(t: str, a: str) -> str:
        from .sources_arxiv import fetch_arxiv_content
        return fetch_arxiv_content(t, a)

    try:
        from .sources_wikisource import _detect_lang
        lang = _detect_lang(title)
    except Exception:
        lang = "en"

    # Precise canon first (Gutenberg/Wikisource, ordered by language), then the
    # Internet Archive catch-all (strict-gated, huge OCR corpus), then arXiv
    # (only matches real preprints). First substantial hit (>2000 chars) wins.
    canon = (
        [("gutenberg", _gutenberg), ("wikisource", _wikisource)]
        if lang == "en"
        else [("wikisource", _wikisource), ("gutenberg", _gutenberg)]
    )
    chain = canon + [("internet_archive", _internet_archive), ("arxiv", _arxiv)]
    for name, fn in chain:
        try:
            body = fn(title, author)
        except Exception as exc:
            log.warning("%s lookup failed for %r: %s", name, title, exc)
            continue
        if body and len(body) > 2000:
            log.info("Full text for %r from %s (%d chars, lang=%s)", title, name, len(body), lang)
            return _wrap_fulltext(title, author, body)

    # Fallback chain — metadata-only (modern / unmatched books)
    text = fetch_open_library_text(title, author)
    if text and len(text) > 100:
        gb = fetch_google_books_info(title, author)
        if gb:
            text += "\n\n--- Google Books ---\n\n" + gb
        return text

    text = fetch_google_books_info(title, author)
    if text and len(text) > 50:
        return text

    wiki = fetch_wikipedia_summary(title, lang="en")
    if wiki:
        return f"Title: {title}" + (f" by {author}" if author else "") + f"\n\nWikipedia: {wiki}"

    return ""
