"""SEO/GEO rendering helpers for per-entity landing pages.

Centralizes the content-composition and structured-data work that used to live
inline in main.py's book_page / mind_page handlers. Keeping it here means:

  * Handlers stay small and focused on routing/caching/auth.
  * Tests can exercise the rendered content without spinning up FastAPI.
  * Future Phase 3+ work (URL slugs, compound /q/ and /on/ pages) reuses
    the same composition primitives instead of growing a second copy.

Design rules:
  * Every helper takes already-loaded data and returns escaped HTML or
    JSON-serializable dicts. No DB calls, no LLM calls, no I/O.
  * All user-controllable strings are html-escaped at the boundary.
  * Sections gracefully return "" when their input is empty — callers can
    join the list without worrying about gaps.
"""
from __future__ import annotations

import json
import re
from html import escape as _esc
from typing import Any, Iterable


# ─── Slug generation (Phase 3 prep — used now for compound URL anchors,
#     promoted to canonical URLs once the redirect path is built) ─────

_SLUG_NON_ALNUM = re.compile(r"[^a-z0-9]+")
_SLUG_TRIM = re.compile(r"^-+|-+$")


def slugify(text: str, max_len: int = 80) -> str:
    """Convert a title or name into a URL-safe kebab-case slug. Deterministic
    and ASCII-only — non-Latin scripts collapse to dashes, which is acceptable
    because the canonical URL still carries a UUID suffix for disambiguation.

    Examples:
        "How to Win Friends and Influence People" -> "how-to-win-friends-and-influence-people"
        "Karl Marx"                                -> "karl-marx"
        ""                                         -> "untitled"
    """
    if not text:
        return "untitled"
    s = text.lower().strip()
    # Drop diacritics by best-effort ASCII fold (without pulling in unicodedata
    # for one call site we keep it simple — non-ASCII just becomes dashes)
    s = s.encode("ascii", "ignore").decode("ascii")
    s = _SLUG_NON_ALNUM.sub("-", s)
    s = _SLUG_TRIM.sub("", s)
    if not s:
        return "untitled"
    if len(s) > max_len:
        s = s[:max_len].rsplit("-", 1)[0] or s[:max_len]
    return s


# ─── JSON-LD schema builders ──────────────────────────────────────────

def breadcrumb_jsonld(items: list[tuple[str, str]]) -> dict[str, Any]:
    """BreadcrumbList schema. `items` is [(name, absolute_url), ...] in
    crumb order (root first, current page last)."""
    return {
        "@context": "https://schema.org",
        "@type": "BreadcrumbList",
        "itemListElement": [
            {
                "@type": "ListItem",
                "position": i + 1,
                "name": name,
                "item": url,
            }
            for i, (name, url) in enumerate(items)
        ],
    }


def faq_jsonld(qa_pairs: list[tuple[str, str]]) -> dict[str, Any]:
    """FAQPage schema. `qa_pairs` is [(question, answer), ...].

    Google requires real answer text — empty answers (which we use as
    placeholders linking to chat) are still acceptable per spec as long
    as the answer string is non-empty. We always include a deflection
    answer that nudges to chat with the book."""
    return {
        "@context": "https://schema.org",
        "@type": "FAQPage",
        "mainEntity": [
            {
                "@type": "Question",
                "name": q,
                "acceptedAnswer": {"@type": "Answer", "text": a},
            }
            for q, a in qa_pairs
        ],
    }


def book_jsonld(
    *,
    title: str,
    description: str,
    author: str,
    url: str,
    image: str,
    word_count: int | None,
    chapters: list[dict[str, Any]] | None,
    site_url: str,
) -> dict[str, Any]:
    """Schema.org/Book — corrected to omit `numberOfPages` (we don't have
    physical pages; previous code mis-mapped chapter count here). Chapter
    structure goes in `hasPart` where it belongs."""
    out: dict[str, Any] = {
        "@context": "https://schema.org",
        "@type": "Book",
        "name": title,
        "description": description,
        "url": url,
        "image": image,
        "publisher": {"@type": "Organization", "name": "Feynman", "url": site_url},
    }
    if author:
        out["author"] = {"@type": "Person", "name": author}
    if word_count:
        out["wordCount"] = word_count
    if chapters:
        out["hasPart"] = [
            {"@type": "Chapter", "name": c.get("title", ""), "position": i + 1}
            for i, c in enumerate(chapters)
        ]
    return out


# Hardcoded Wikipedia/Wikidata URLs for the most-trafficked named minds.
# Populating `sameAs` is the single biggest signal we can send Google's
# Knowledge Graph that "our Karl Marx page is THE Karl Marx" — without it
# the page floats as an entity-of-unknown-identity. Curated by hand because
# heuristic name→Wikipedia lookup occasionally picks the wrong "John Smith".
#
# Add a row here as a mind crosses our top-traffic threshold; the lookup
# is case-insensitive by mind name. The full schema also accepts Wikidata
# (https://www.wikidata.org/wiki/Q…) and we include both where possible
# because Wikidata is the LLM-friendly canonical identifier.
FAMOUS_MIND_SAMEAS: dict[str, list[str]] = {
    "karl marx": [
        "https://en.wikipedia.org/wiki/Karl_Marx",
        "https://www.wikidata.org/wiki/Q9061",
    ],
    "friedrich engels": [
        "https://en.wikipedia.org/wiki/Friedrich_Engels",
        "https://www.wikidata.org/wiki/Q33760",
    ],
    "adam smith": [
        "https://en.wikipedia.org/wiki/Adam_Smith",
        "https://www.wikidata.org/wiki/Q9381",
    ],
    "john maynard keynes": [
        "https://en.wikipedia.org/wiki/John_Maynard_Keynes",
        "https://www.wikidata.org/wiki/Q9317",
    ],
    "richard feynman": [
        "https://en.wikipedia.org/wiki/Richard_Feynman",
        "https://www.wikidata.org/wiki/Q39246",
    ],
    "albert einstein": [
        "https://en.wikipedia.org/wiki/Albert_Einstein",
        "https://www.wikidata.org/wiki/Q937",
    ],
    "isaac newton": [
        "https://en.wikipedia.org/wiki/Isaac_Newton",
        "https://www.wikidata.org/wiki/Q935",
    ],
    "charles darwin": [
        "https://en.wikipedia.org/wiki/Charles_Darwin",
        "https://www.wikidata.org/wiki/Q1035",
    ],
    "sigmund freud": [
        "https://en.wikipedia.org/wiki/Sigmund_Freud",
        "https://www.wikidata.org/wiki/Q9215",
    ],
    "carl jung": [
        "https://en.wikipedia.org/wiki/Carl_Jung",
        "https://www.wikidata.org/wiki/Q41532",
    ],
    "friedrich nietzsche": [
        "https://en.wikipedia.org/wiki/Friedrich_Nietzsche",
        "https://www.wikidata.org/wiki/Q1141",
    ],
    "aristotle": [
        "https://en.wikipedia.org/wiki/Aristotle",
        "https://www.wikidata.org/wiki/Q868",
    ],
    "plato": [
        "https://en.wikipedia.org/wiki/Plato",
        "https://www.wikidata.org/wiki/Q859",
    ],
    "socrates": [
        "https://en.wikipedia.org/wiki/Socrates",
        "https://www.wikidata.org/wiki/Q913",
    ],
    "confucius": [
        "https://en.wikipedia.org/wiki/Confucius",
        "https://www.wikidata.org/wiki/Q4604",
    ],
    "immanuel kant": [
        "https://en.wikipedia.org/wiki/Immanuel_Kant",
        "https://www.wikidata.org/wiki/Q9312",
    ],
    "g.w.f. hegel": [
        "https://en.wikipedia.org/wiki/Georg_Wilhelm_Friedrich_Hegel",
        "https://www.wikidata.org/wiki/Q9235",
    ],
    "warren buffett": [
        "https://en.wikipedia.org/wiki/Warren_Buffett",
        "https://www.wikidata.org/wiki/Q47213",
    ],
    "charlie munger": [
        "https://en.wikipedia.org/wiki/Charlie_Munger",
        "https://www.wikidata.org/wiki/Q1066368",
    ],
    "peter drucker": [
        "https://en.wikipedia.org/wiki/Peter_Drucker",
        "https://www.wikidata.org/wiki/Q57139",
    ],
    "carl sagan": [
        "https://en.wikipedia.org/wiki/Carl_Sagan",
        "https://www.wikidata.org/wiki/Q34943",
    ],
    "stephen hawking": [
        "https://en.wikipedia.org/wiki/Stephen_Hawking",
        "https://www.wikidata.org/wiki/Q17714",
    ],
    "marie curie": [
        "https://en.wikipedia.org/wiki/Marie_Curie",
        "https://www.wikidata.org/wiki/Q7186",
    ],
    "nikola tesla": [
        "https://en.wikipedia.org/wiki/Nikola_Tesla",
        "https://www.wikidata.org/wiki/Q9036",
    ],
}


def lookup_same_as(mind_name: str) -> list[str] | None:
    """Return curated authoritative URLs for a famous mind, or None."""
    if not mind_name:
        return None
    return FAMOUS_MIND_SAMEAS.get(mind_name.strip().lower())


def person_jsonld(
    *,
    name: str,
    description: str,
    domain: str,
    url: str,
    image: str,
    same_as: list[str] | None = None,
) -> dict[str, Any]:
    out: dict[str, Any] = {
        "@context": "https://schema.org",
        "@type": "Person",
        "name": name,
        "description": description,
        "url": url,
        "image": image,
    }
    if domain:
        out["knowsAbout"] = [d.strip() for d in domain.split(",") if d.strip()] or domain
    if same_as:
        out["sameAs"] = same_as
    return out


def jsonld_script(payload: dict[str, Any]) -> str:
    """Wrap a JSON-LD dict into a <script> tag, dropping null leaves so
    schema validators don't choke on `numberOfPages: null` etc."""
    cleaned = _drop_nulls(payload)
    return f'<script type="application/ld+json">{json.dumps(cleaned, ensure_ascii=False)}</script>'


def _drop_nulls(obj: Any) -> Any:
    if isinstance(obj, dict):
        return {k: _drop_nulls(v) for k, v in obj.items() if v not in (None, "", [])}
    if isinstance(obj, list):
        return [_drop_nulls(x) for x in obj]
    return obj


# ─── Book page section builders ───────────────────────────────────────

def render_book_about(subtitle: str, author: str) -> str:
    """Top-of-page 1-2 sentence summary. The subtitle (from outline) is the
    best signal we have for what the book is *about* in the author's own
    framing."""
    if not subtitle and not author:
        return ""
    parts = []
    if subtitle:
        parts.append(f'<p class="book-about">{_esc(subtitle)}</p>')
    return "\n".join(parts)


def render_stats(total_words: int, chapter_count: int) -> str:
    if not total_words and not chapter_count:
        return ""
    bits = []
    if total_words:
        bits.append(f"{total_words:,} words")
        bits.append(f"~{max(1, total_words // 250)} min read")
    if chapter_count:
        bits.append(f"{chapter_count} chapters")
    return f'<p class="book-stats">{" · ".join(_esc(b) for b in bits)}</p>'


def render_toc(chapters: list[dict[str, Any]]) -> str:
    if not chapters:
        return ""
    items = "".join(f"<li>{_esc(c.get('title', ''))}</li>" for c in chapters if c.get("title"))
    if not items:
        return ""
    return f'<section><h2>Table of Contents</h2><ol class="toc">{items}</ol></section>'


def render_sample_passages(chunks: list[dict[str, Any]], count: int = 3, max_chars: int = 800) -> str:
    """Render the first `count` chunks verbatim as "What this book covers".

    These are real content from the book — Google rewards original text, and
    LLMs get something concrete to cite. Default ``max_chars=800`` gives ~130
    words per blockquote × 3 ≈ 400 words of unique on-page text, which is the
    bulk of the SEO weight on a book page."""
    if not chunks:
        return ""
    samples = chunks[:count]
    items = []
    for c in samples:
        text = (c.get("text") or "").strip()
        if not text:
            continue
        if len(text) > max_chars:
            text = text[:max_chars].rsplit(" ", 1)[0] + "…"
        items.append(f"<blockquote>{_esc(text)}</blockquote>")
    if not items:
        return ""
    return f'<section><h2>From the book</h2>{"".join(items)}</section>'


def render_popular_questions(questions: list[str], chat_url: str) -> str:
    """Render the auto-generated study questions as a visible FAQ-style
    list. Companion FAQPage JSON-LD is emitted separately via faq_jsonld."""
    if not questions:
        return ""
    items = "".join(
        f'<li><a href="{_esc(chat_url)}">{_esc(q)}</a></li>'
        for q in questions
        if q
    )
    if not items:
        return ""
    return (
        '<section><h2>Popular questions readers ask</h2>'
        f'<ul class="popular-questions">{items}</ul></section>'
    )


def render_minds_for_book(minds: list[dict[str, Any]], site_url: str) -> str:
    """Cross-links from /book/{id} → /mind/{id}. The single biggest
    internal-link source we have."""
    if not minds:
        return ""
    items = "".join(
        f'<li><a href="{_esc(site_url)}/mind/{_esc(m["id"])}">{_esc(m.get("name", ""))}</a>'
        f'{(" — " + _esc(m["domain"])) if m.get("domain") else ""}</li>'
        for m in minds
    )
    return (
        '<section><h2>Great minds who discuss this book</h2>'
        f'<ul class="related-minds">{items}</ul></section>'
    )


# ─── Mind page section builders ───────────────────────────────────────

def render_mind_bio(bio: str) -> str:
    if not bio:
        return ""
    return f'<section><h2>About</h2><p>{_esc(bio)}</p></section>'


def render_mind_thinking_style(thinking_style: str) -> str:
    if not thinking_style:
        return ""
    return (
        f'<section><h2>How they think</h2>'
        f'<p>{_esc(thinking_style)}</p></section>'
    )


def render_mind_phrases(phrases: list[str], limit: int = 6) -> str:
    """Render typical_phrases as a quote-card list. These are GEO gold —
    LLMs love distinctive, attributable short text."""
    if not phrases:
        return ""
    items = "".join(
        f'<li><q>{_esc(p)}</q></li>' for p in phrases[:limit] if p
    )
    if not items:
        return ""
    return (
        '<section><h2>Characteristic phrases</h2>'
        f'<ul class="characteristic-phrases">{items}</ul></section>'
    )


def render_mind_persona_excerpt(persona: str, max_chars: int = 900) -> str:
    """Render a condensed snippet of the persona as 'Core approach'. The
    full persona is often 1500+ chars of system-prompt-style description
    not suited to public display, so we take an excerpt. 900 chars ≈ 150
    words — substantial enough to register as real content, short enough
    to read in 30 seconds."""
    if not persona:
        return ""
    p = persona.strip()
    if len(p) > max_chars:
        p = p[:max_chars].rsplit(" ", 1)[0] + "…"
    return (
        '<section><h2>Core approach</h2>'
        f'<p>{_esc(p)}</p></section>'
    )


def render_mind_works(works: list[str], linked_books: list[dict[str, Any]], site_url: str) -> str:
    """Notable Works — link to /book/{id} where mind_works maps the title to
    one of our agents, otherwise plain text. Matching is by case-insensitive
    title substring to handle minor variations (subtitles, edition suffixes)."""
    if not works:
        return ""
    link_index = {
        (b.get("name") or "").lower(): b["id"]
        for b in (linked_books or [])
        if b.get("id")
    }
    items = []
    for w in works[:20]:
        if not w:
            continue
        wl = w.lower()
        match_id = link_index.get(wl)
        if not match_id:
            for n, bid in link_index.items():
                if n and (n in wl or wl in n):
                    match_id = bid
                    break
        if match_id:
            items.append(f'<li><a href="{_esc(site_url)}/book/{_esc(match_id)}">{_esc(w)}</a></li>')
        else:
            items.append(f'<li>{_esc(w)}</li>')
    if not items:
        return ""
    return f'<section><h2>Notable works</h2><ul class="works">{"".join(items)}</ul></section>'


def render_books_for_mind(books: list[dict[str, Any]], site_url: str) -> str:
    """Cross-links to books in this mind's corpus that aren't already covered
    by Notable Works (the works list comes from the mind persona; mind_works
    can include additional reference material). Skipped if empty."""
    if not books:
        return ""
    items = "".join(
        f'<li><a href="{_esc(site_url)}/book/{_esc(b["id"])}">{_esc(b.get("name", ""))}</a>'
        f'{(" — by " + _esc(b["author"])) if b.get("author") else ""}</li>'
        for b in books
    )
    return (
        '<section><h2>Books in this mind\'s library</h2>'
        f'<ul class="related-books">{items}</ul></section>'
    )


def render_related_minds(minds: list[dict[str, Any]], site_url: str) -> str:
    if not minds:
        return ""
    items = "".join(
        f'<li><a href="{_esc(site_url)}/mind/{_esc(m["id"])}">{_esc(m.get("name", ""))}</a>'
        f'{(" — " + _esc(m["era"])) if m.get("era") else ""}</li>'
        for m in minds
    )
    return (
        '<section><h2>Related minds</h2>'
        f'<ul class="related-minds">{items}</ul></section>'
    )


# ─── Word/structure counters (used by tests to enforce density floors) ─

_TAG_RE = re.compile(r"<[^>]+>")
_SCRIPT_RE = re.compile(r"<script[^>]*>.*?</script>", re.S | re.I)
_STYLE_RE = re.compile(r"<style[^>]*>.*?</style>", re.S | re.I)
_WHITESPACE_RE = re.compile(r"\s+")


def visible_word_count(html: str) -> int:
    """Count visible words in an HTML document — the same metric our SEO
    diagnostic uses. Strips scripts, styles, and tags. Useful for tests
    that assert a content-density floor."""
    stripped = _SCRIPT_RE.sub("", html)
    stripped = _STYLE_RE.sub("", stripped)
    text = _TAG_RE.sub(" ", stripped)
    text = _WHITESPACE_RE.sub(" ", text).strip()
    return len(text.split()) if text else 0
