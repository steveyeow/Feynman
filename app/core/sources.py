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


def fetch_book_content(title: str, author: str = "") -> str:
    """Orchestrator: try Gutenberg (full text) → Open Library (metadata)
    → Google Books (metadata) → Wikipedia (summary) → return best result.

    Gutenberg comes FIRST because it's the only source that can return
    full primary text. For any pre-1928 work in the public-domain canon
    this means RAG actually has the book to retrieve from, instead of
    just metadata. Modern in-copyright books fall through to the
    existing metadata sources (which is the best we can legally get
    via free APIs)."""
    # Local import — sources_gutenberg pulls in httpx and we want this
    # module to stay importable even in environments that have stripped
    # the optional source.
    try:
        from .sources_gutenberg import fetch_gutenberg_content
        gb_text = fetch_gutenberg_content(title, author)
    except Exception as exc:
        log.warning("Gutenberg lookup failed for %r: %s", title, exc)
        gb_text = ""

    if gb_text and len(gb_text) > 2000:
        # Got real full text. Prepend a small header so chunk[0] still
        # carries the title/author for downstream attribution. Also
        # supplement with the metadata block from Open Library so RAG
        # has both primary content AND structured context (subjects,
        # categories).
        header = f"Title: {title}" + (f" by {author}" if author else "") + "\n\n"
        meta = fetch_open_library_text(title, author)
        if meta:
            header += "--- Metadata ---\n\n" + meta + "\n\n--- Text ---\n\n"
        return header + gb_text

    # Fallback chain — metadata-only (modern books)
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
