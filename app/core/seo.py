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
    in_language: str = "en",
    date_published: str = "",
    date_modified: str = "",
) -> dict[str, Any]:
    """Schema.org/Book — corrected to omit `numberOfPages` (we don't have
    physical pages; previous code mis-mapped chapter count here). Chapter
    structure goes in `hasPart` where it belongs.

    Date fields are ISO-8601 strings. Empty values are dropped by
    ``jsonld_script``. ``inLanguage`` defaults to ``"en"`` since our
    corpus is overwhelmingly English; pass an explicit code (e.g. ``"zh"``)
    for non-English entities once we detect them."""
    out: dict[str, Any] = {
        "@context": "https://schema.org",
        "@type": "Book",
        "name": title,
        "description": description,
        "url": url,
        "image": image,
        "inLanguage": in_language,
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
    if date_published:
        out["datePublished"] = date_published
    if date_modified:
        out["dateModified"] = date_modified
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
    date_modified: str = "",
) -> dict[str, Any]:
    """Schema.org/Person. ``dateModified`` lets Google know how fresh
    the page is — particularly useful for mind pages where new books
    and discussions get attached over time."""
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
    if date_modified:
        out["dateModified"] = date_modified
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

def render_book_empty_state(title: str, author: str) -> str:
    """Render the "not indexed yet" notice for catalog-stub books.

    Roughly 575 of 932 catalog books in production are stubs with 1-4
    metadata chunks but no full text — Gutenberg can't serve them
    (modern in-copyright) and no user has uploaded a copy. The SSR
    detail page for those books otherwise degrades to just <h1>Title</h1>
    + author + topic link + chat CTA, which looks empty enough that
    visitors (per user screenshot review on 2026-05-27) wonder if the
    page is broken. This section gives the page a meaningful body
    explaining the state, while letting the page's bottom CTA matrix
    handle the actual Chat button (no duplicate CTAs)."""
    author_phrase = f' by {_esc(author)}' if author else ''
    return (
        '<section class="empty-state">'
        f'<p class="empty-state-headline">Full text isn\'t indexed yet for '
        f'<em>{_esc(title)}</em>{author_phrase}.</p>'
        '<p>This title sits in our catalog but its primary text wasn\'t '
        'available from public-domain sources (Project Gutenberg, '
        'OpenLibrary, etc.) and no reader has uploaded a copy. You can '
        'still chat with Feynman about it — the AI draws on general '
        'knowledge and the book\'s metadata even when the book passages '
        'aren\'t available for retrieval.</p>'
        '</section>'
    )


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


def render_popular_questions(
    questions: list[str],
    fallback_url: str,
    *,
    book_id: str = "",
    site_url: str = "",
) -> str:
    """Render the auto-generated study questions as a visible FAQ-style
    list. Companion FAQPage JSON-LD is emitted separately via faq_jsonld.

    When ``book_id`` and ``site_url`` are provided, each question links to
    its own compound /book/{id}/q/{slug} page (the SEO play — every
    question becomes a discoverable long-tail URL). Otherwise all
    questions link to ``fallback_url`` (typically the book's chat URL).
    """
    if not questions:
        return ""
    items_html: list[str] = []
    for q in questions:
        if not q:
            continue
        if book_id and site_url:
            href = f"{site_url}/book/{book_id}/q/{slugify(q)}"
        else:
            href = fallback_url
        items_html.append(f'<li><a href="{_esc(href)}">{_esc(q)}</a></li>')
    if not items_html:
        return ""
    return (
        '<section><h2>Popular questions readers ask</h2>'
        f'<ul class="popular-questions">{"".join(items_html)}</ul></section>'
    )


def render_related_books(books: list[dict[str, Any]], site_url: str) -> str:
    """Other books readers may want next. Same-topic and same-author
    matches surfaced together. Phase 5 — closes the book↔book half of
    the internal linking graph."""
    if not books:
        return ""
    items = []
    for b in books:
        if not b.get("id") or not b.get("name"):
            continue
        author = f' — {_esc(b["author"])}' if b.get("author") else ""
        items.append(
            f'<li><a href="{_esc(site_url)}/book/{_esc(b["id"])}">{_esc(b["name"])}</a>{author}</li>'
        )
    if not items:
        return ""
    return (
        '<section><h2>Related books</h2>'
        f'<ul class="related-books">{"".join(items)}</ul></section>'
    )


def render_topic_link_back(topic: str, site_url: str) -> str:
    """A single "← back to topic" link on entity pages whose meta.category
    matches one of the canonical topics. Closes the book→topic-hub edge,
    pushing PageRank up the tree."""
    if not topic:
        return ""
    slug = slugify(topic)
    if not slug:
        return ""
    return (
        f'<p class="topic-link-back">More on '
        f'<a href="{_esc(site_url)}/topic/{slug}">{_esc(topic)}</a></p>'
    )


def render_explore_footer(
    items: list[dict[str, str]],
    site_url: str,
    label: str = "Explore further",
) -> str:
    """Bottom-of-page neighborhood link cluster — 3-5 cross-links to
    adjacent entities. Mirrors the spec's Phase 5 "footer Explore"
    requirement: gives readers a path forward after the CTA and gives
    crawlers an extra signal of entity neighborhood.

    Each item is a ``{"label", "href"}`` dict. The href can be a full
    URL or a path; full URL is preferred so JSON-LD-style crawlers
    that don't resolve relative paths still follow."""
    if not items:
        return ""
    anchors = []
    for it in items[:5]:
        href = (it.get("href") or "").strip()
        text = (it.get("label") or "").strip()
        if not href or not text:
            continue
        # Convert bare paths to absolute URLs against site_url
        if href.startswith("/") and site_url:
            href = site_url.rstrip("/") + href
        anchors.append(f'<a href="{_esc(href)}">{_esc(text)}</a>')
    if not anchors:
        return ""
    return (
        '<footer class="explore-footer">'
        f'<small>{_esc(label)}: '
        f'{" · ".join(anchors)}'
        '</small></footer>'
    )


def render_mind_recent_themes(themes: list[dict[str, Any]]) -> str:
    """Community-emergent informational block on the mind landing page.

    Renders themes the mind has actually been chatted about (pulled from
    ``db.list_mind_recent_topics``). Distinct from ``render_topic_links_for_mind``
    in two important ways:

      * Source — those come from a fixed ``TOPIC_TAGS`` list × ``mind.domain``
        string matching (static, curated). These come from real chat
        aggregations (dynamic, community-emergent).
      * URL footprint — those drive indexable ``/mind/{id}/on/{topic-slug}``
        compound pages. These have NO links because the topics are open-ended
        and not constrained to our curated topic set. Expanding URL space
        based on free-form chat themes would invite Google's auto-generated
        content penalties; we keep this as descriptive content only.

    Renders nothing if ``themes`` is empty so the section gracefully
    no-ops for new minds with no chat activity yet.
    """
    if not themes:
        return ""
    items = []
    for t in themes[:8]:
        topic = (t.get("topic") or "").strip()
        n = int(t.get("count") or 0)
        if not topic:
            continue
        count_badge = f' <span class="theme-count">×{n}</span>' if n > 1 else ""
        items.append(
            f'<li class="theme">{_esc(topic)}{count_badge}</li>'
        )
    if not items:
        return ""
    return (
        '<section class="mind-recent-themes">'
        '<h2>Recent themes in conversations</h2>'
        '<p class="themes-intro">Topics readers have actually been '
        'discussing with this mind on Feynman, aggregated across '
        'sessions. Updates as new conversations happen.</p>'
        '<ul class="themes-list">'
        f'{"".join(items)}'
        '</ul>'
        '</section>'
    )


def render_topic_links_for_mind(matching_topics: list[str], site_url: str) -> str:
    """Render a row of links to relevant topic hubs from a mind's page.
    ``matching_topics`` is a pre-filtered list — caller decides which
    topics this mind belongs to (typically via qa.is_mind_topic_relevant).
    """
    if not matching_topics:
        return ""
    items = []
    for t in matching_topics[:5]:
        slug = slugify(t)
        if not slug:
            continue
        items.append(
            f'<a href="{_esc(site_url)}/topic/{slug}">{_esc(t)}</a>'
        )
    if not items:
        return ""
    return (
        '<p class="topic-links">Explore the topics this mind discusses: '
        f'{" · ".join(items)}</p>'
    )


def render_minds_for_book(
    minds: list[dict[str, Any]],
    site_url: str,
    activity: dict[str, dict[str, Any]] | None = None,
) -> str:
    """Cross-links from /book/{id} → /mind/{id}. The single biggest
    internal-link source we have.

    Curated layer: ``minds`` comes from ``db.list_minds_for_agent``
    (mind_works table — set at mind creation time).

    Activity layer (optional): ``activity`` is a dict keyed by
    LOWERCASE mind name → {count, last_seen}, sourced from
    ``db.list_minds_active_for_agent`` (real chat sessions where this
    book was in context AND the mind authored at least one response).
    When present, minds with measurable activity get an inline badge.
    Curated minds with no activity render unchanged — the badge is a
    pure additive signal, not a filter."""
    if not minds:
        return ""
    activity = activity or {}
    items_html = []
    for m in minds:
        name = m.get("name", "")
        domain = m.get("domain", "")
        badge = ""
        if activity:
            act = activity.get(name.lower())
            if act and act.get("count", 0) > 0:
                n = act["count"]
                # "12 chats" / "1 chat" — count is distinct sessions
                label = "chat" if n == 1 else "chats"
                badge = (
                    f' <span class="activity-badge" title="Active in real reader '
                    f'conversations about this book">● active in {n} {label}</span>'
                )
        items_html.append(
            f'<li><a href="{_esc(site_url)}/mind/{_esc(m["id"])}">{_esc(name)}</a>'
            f'{(" — " + _esc(domain)) if domain else ""}'
            f'{badge}</li>'
        )
    return (
        '<section><h2>Great minds who discuss this book</h2>'
        f'<ul class="related-minds">{"".join(items_html)}</ul></section>'
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


# ─── Live AI Output Indexing — Phase 8 ──────────────────────────────
#
# Render layer for /book/{id}/insights and /mind/{id}/dialogues. The
# insights themselves come from app/core/insights.py (already PII-
# sanitized) — we just frame, label, and structure them for crawl.

def render_live_content_link(
    entity_name: str, kind: str, target_url: str, count: int = 0,
) -> str:
    """Surface the entity's Type-4 live-content page (``/insights`` for
    books, ``/dialogues`` for minds) from the parent landing page. Without
    this, the landing page never advertises that the Type-4 surface exists
    — crawlers traverse from sitemap only, and human visitors have no path
    to the live-content page from a book's or mind's main entry.

    The link is rendered regardless of ``count`` so the page is always
    discoverable. When ``count > 0`` a small badge advertises real activity;
    when zero, the empty-state on the target page itself invites the visitor
    to seed it via a chat. ``kind`` is ``"insights"`` (book) or
    ``"dialogues"`` (mind) — pure copy variation, same structure."""
    if kind == "insights":
        title = f"AI insights about {entity_name}"
        sub = ("Accumulated AI commentary on this book, drawn from real "
               "reader chat sessions and updated as more readers engage.")
    else:
        title = f"Recent dialogues with {entity_name}"
        sub = ("AI responses from real chat sessions with this mind agent, "
               "aggregated and refreshed as new conversations happen.")
    count_badge = (
        f' <span class="count-badge">{count}</span>' if count > 0 else ""
    )
    return (
        '<section class="live-content-link">'
        f'<h2><a href="{_esc(target_url)}">{_esc(title)} →</a>{count_badge}</h2>'
        f'<p>{_esc(sub)}</p>'
        '</section>'
    )


def render_insight_cards(insights: list[dict[str, Any]], max_chars: int = 900) -> str:
    """Render the sanitized AI commentaries as a stack of cards. Each
    is labelled as AI synthesis to be transparent about authorship."""
    if not insights:
        return ""
    items = []
    for i in insights:
        text = (i.get("text") or "").strip()
        if not text:
            continue
        if len(text) > max_chars:
            text = text[:max_chars].rsplit(" ", 1)[0] + "…"
        # Preserve paragraph breaks the LLM emitted
        paragraphs = [p.strip() for p in text.split("\n\n") if p.strip()]
        body = "".join(f"<p>{_esc(p)}</p>" for p in paragraphs) or f"<p>{_esc(text)}</p>"
        items.append(f'<article class="insight-card">{body}</article>')
    if not items:
        return ""
    return (
        '<section class="insights">'
        f'{"".join(items)}'
        '<p class="insights-attribution"><small>Synthesized from AI agent '
        'responses across reader conversations. AI output only; user '
        'questions are never published.</small></p>'
        '</section>'
    )


def render_insights_empty_state(entity_name: str, chat_url: str) -> str:
    """Shown when an entity has no publishable AI insights yet (new
    book, low chat volume). Better than 404 — it gives the page a
    meaningful body. No duplicate CTA here; the page's bottom CTA
    section already carries the "Chat with X" button, so a second
    "Start a chat →" inside this empty state was redundant (caught
    in screenshot review on 2026-05-27)."""
    return (
        '<section class="insights-empty">'
        f'<p>No AI insights have accumulated yet for {_esc(entity_name)}. '
        'Start a chat below and your conversation will help shape this '
        '<em>insights</em> page — the AI\'s responses get aggregated here '
        '(your questions stay private).</p>'
        '</section>'
    )


def insights_article_jsonld(
    *,
    headline: str,
    description: str,
    url: str,
    about_url: str,
    about_type: str,        # "Book" or "Person"
    about_name: str,
    site_url: str,
    date_modified: str = "",
    insight_count: int = 0,
) -> dict[str, Any]:
    """Schema.org/Article describing the aggregated insights page.

    Author is intentionally the platform (Feynman) — not the book or
    mind — because the page is our synthesis of AI agent output, not a
    direct work by the entity. ``about`` ties it back to the entity so
    LLMs can resolve the topical relationship cleanly."""
    out: dict[str, Any] = {
        "@context": "https://schema.org",
        "@type": "Article",
        "headline": headline,
        "description": description,
        "url": url,
        "author": {
            "@type": "Organization",
            "name": "Feynman",
            "url": site_url,
        },
        "publisher": {
            "@type": "Organization",
            "name": "Feynman",
            "url": site_url,
        },
        "about": {
            "@type": about_type,
            "name": about_name,
            "url": about_url,
        },
    }
    if date_modified:
        out["dateModified"] = date_modified
    if insight_count:
        # Custom property; LLMs that parse Article schema use this as
        # a freshness / depth signal.
        out["wordCount"] = insight_count * 150  # rough estimate, ~150 words/card
    return out


# ─── Mind-on-topic compound-page helpers (Phase 4B) ──────────────────
#
# /mind/{mind_id}/on/{topic_slug} renders an imagined-perspective essay
# of how this mind would think about this topic. Relevance is pre-filtered
# in qa.is_mind_topic_relevant — non-relevant pairs 404 rather than
# generate slop. Each rendered page is labelled as imagined dialogue to
# avoid misrepresenting historical figures.


def render_mind_on_topic_essay(essay: str, mind_name: str, topic: str) -> str:
    """Render the imagined essay with an explicit disclosure label."""
    if not essay:
        return ""
    paragraphs = [p.strip() for p in essay.split("\n\n") if p.strip()]
    if not paragraphs:
        return ""
    body = "".join(f"<p>{_esc(p)}</p>" for p in paragraphs)
    return (
        '<section class="mind-essay">'
        f'<h2>How {_esc(mind_name)} might approach {_esc(topic)}</h2>'
        f'{body}'
        '<p class="essay-attribution"><small>Imagined perspective — '
        f'an AI synthesis grounded in {_esc(mind_name)}\'s recorded ideas '
        'and methods, not a quote.</small></p>'
        '</section>'
    )


def mind_essay_jsonld(
    *,
    mind_name: str,
    topic: str,
    essay: str,
    url: str,
    mind_url: str,
    image: str = "",
) -> dict[str, Any]:
    """Schema.org/Article. We mark the author as an Organization (Feynman)
    rather than the mind itself — the essay is an imagined perspective
    we authored, not something the mind actually wrote. Including the
    mind as the about-entity preserves topical clarity."""
    out: dict[str, Any] = {
        "@context": "https://schema.org",
        "@type": "Article",
        "headline": f"How {mind_name} might approach {topic}",
        "description": (essay[:200].rsplit(" ", 1)[0] + "…") if len(essay) > 200 else essay,
        "url": url,
        "author": {"@type": "Organization", "name": "Feynman", "url": mind_url.split("/mind/")[0]},
        "about": {"@type": "Person", "name": mind_name, "url": mind_url},
        "publisher": {
            "@type": "Organization",
            "name": "Feynman",
            "url": mind_url.split("/mind/")[0],
        },
    }
    if image:
        out["image"] = image
    return out


# ─── Book Q&A compound-page helpers (Phase 4A) ───────────────────────
#
# Each indexed book has up to 5 popular questions in the `questions`
# table. We expose each as its own URL `/book/{id}/q/{slug}`. The slug
# is derived from the question text via slugify, so URLs are stable as
# long as the question text doesn't change.

def find_question_by_slug(questions: list[str], slug: str) -> str | None:
    """Match a URL slug back to the original question text. Linear scan —
    questions per book is bounded to ~5, no need for an index."""
    if not questions or not slug:
        return None
    target = slug.strip().lower()
    for q in questions:
        if slugify(q) == target:
            return q
    return None


def render_qa_answer(answer: str) -> str:
    """Render the synthesized LLM answer as a labelled section. We label
    it explicitly because the answer is AI-generated grounded synthesis —
    transparency about authorship is required by Google's helpful-content
    guidance and avoids misleading citations downstream."""
    if not answer:
        return ""
    # Preserve paragraph breaks the LLM emitted; escape everything else.
    paragraphs = [p.strip() for p in answer.split("\n\n") if p.strip()]
    if not paragraphs:
        return ""
    body = "".join(f"<p>{_esc(p)}</p>" for p in paragraphs)
    return (
        '<section class="qa-answer"><h2>Synthesized answer</h2>'
        f'{body}'
        '<p class="qa-attribution"><small>Synthesized from the book passages '
        'below. Chat with the book on Feynman for follow-up.</small></p>'
        '</section>'
    )


def render_qa_passages(passages: list[dict[str, Any]], max_chars: int = 600) -> str:
    """Render the supporting RAG passages with chapter attribution.
    Even when LLM synthesis fails or is disabled, this section alone
    gives the page real content — Google sees ~5 substantial blockquotes
    of original book text grouped under the question."""
    if not passages:
        return ""
    items = []
    for p in passages:
        text = (p.get("text") or "").strip()
        if not text:
            continue
        if len(text) > max_chars:
            text = text[:max_chars].rsplit(" ", 1)[0] + "…"
        attr = ""
        idx = p.get("chunk_index")
        if idx is not None:
            attr = f'<footer><small>Passage [{int(idx) + 1}]</small></footer>'
        items.append(f"<blockquote>{_esc(text)}{attr}</blockquote>")
    if not items:
        return ""
    return (
        '<section class="qa-passages"><h2>From the book</h2>'
        f'{"".join(items)}</section>'
    )


def render_sibling_questions(
    siblings: list[str],
    book_id: str,
    site_url: str,
    current_question: str = "",
) -> str:
    """Cross-link to the book's other Q&A pages. Skip the current
    question (would be a self-link)."""
    if not siblings:
        return ""
    items = []
    current_slug = slugify(current_question) if current_question else ""
    for q in siblings:
        if not q:
            continue
        slug = slugify(q)
        if slug == current_slug:
            continue
        items.append(
            f'<li><a href="{_esc(site_url)}/book/{_esc(book_id)}/q/{_esc(slug)}">'
            f'{_esc(q)}</a></li>'
        )
    if not items:
        return ""
    return (
        '<section><h2>More questions about this book</h2>'
        f'<ul class="sibling-questions">{"".join(items)}</ul></section>'
    )


def qa_page_jsonld(
    *,
    question: str,
    answer: str,
    url: str,
    book_title: str,
    book_url: str,
    site_url: str = "",
    date_created: str = "",
) -> dict[str, Any]:
    """Schema.org/QAPage. Required fields per Google's rich-result spec
    (https://developers.google.com/search/docs/appearance/structured-data/qapage):

    Question (required):
      * ``name`` — short summary
      * ``text`` — full question text  ← was missing in v1, caused
        "1 invalid item" in GSC URL Inspection
      * ``answerCount`` — integer count of answers  ← was missing in v1
      * ``acceptedAnswer`` OR ``suggestedAnswer``

    Answer (required):
      * ``text``
      * ``url`` (when answer is on a different URL, optional otherwise)

    Recommended fields we also include for richer eligibility:
      * ``author`` on both Question and Answer (Organization = Feynman)
      * ``dateCreated`` when available
      * ``upvoteCount`` on Answer (0 default — Google accepts 0)
    """
    answer_text = (answer or "").strip()
    if not answer_text:
        answer_text = (
            f"Open Feynman to chat with the book \"{book_title}\" and explore "
            f"the answer in depth: {book_url}"
        )

    author = {
        "@type": "Organization",
        "name": "Feynman",
    }
    if site_url:
        author["url"] = site_url

    question_obj: dict[str, Any] = {
        "@type": "Question",
        "name": question,           # short summary (same as text for our case)
        "text": question,           # FULL question text — required by Google
        "answerCount": 1,           # required — we always have one synthesized answer
        "upvoteCount": 0,
        "url": url,
        "author": author,
        "acceptedAnswer": {
            "@type": "Answer",
            "text": answer_text,
            "upvoteCount": 0,
            "url": url,
            "author": author,
        },
    }
    if date_created:
        question_obj["dateCreated"] = date_created
        question_obj["acceptedAnswer"]["dateCreated"] = date_created

    return {
        "@context": "https://schema.org",
        "@type": "QAPage",
        "mainEntity": question_obj,
    }


# ─── Topic slug / lookup helpers (Phase 4C — topic hub pages) ────────
#
# Topics are a fixed list (`TOPIC_TAGS` in app/core/catalog.py). They're
# referenced by name everywhere internally but exposed externally as
# kebab-case slugs in URLs (/topic/computer-science). These helpers do
# the bidirectional mapping so handlers don't have to repeat the logic.

def build_topic_slug_index(topic_tags: list[str]) -> dict[str, str]:
    """Returns {slug: original_topic_name} so URL handlers can resolve
    /topic/{slug} back to the canonical name to use for DB lookups."""
    return {slugify(t): t for t in topic_tags if t}


def topic_slug(topic: str) -> str:
    """Slug for a given topic name. Stable across runs (slugify is
    deterministic) so URLs don't change."""
    return slugify(topic)


# ─── Topic hub page renderer (Phase 4C) ──────────────────────────────

def render_topic_books(books: list[dict[str, Any]], site_url: str) -> str:
    """List the books tagged with this topic. Each is a cross-link to
    /book/{id} so the topic hub becomes an entry-point page that pushes
    PageRank down to entity pages."""
    if not books:
        return ""
    items = []
    for b in books:
        if not b.get("id") or not b.get("name"):
            continue
        author = f' — {_esc(b["author"])}' if b.get("author") else ""
        items.append(
            f'<li><a href="{_esc(site_url)}/book/{_esc(b["id"])}">{_esc(b["name"])}</a>{author}</li>'
        )
    if not items:
        return ""
    return (
        '<section><h2>Books in this topic</h2>'
        f'<ul class="topic-books">{"".join(items)}</ul></section>'
    )


def render_topic_minds(minds: list[dict[str, Any]], site_url: str) -> str:
    if not minds:
        return ""
    items = []
    for m in minds:
        if not m.get("id") or not m.get("name"):
            continue
        era = f' — {_esc(m["era"])}' if m.get("era") else ""
        items.append(
            f'<li><a href="{_esc(site_url)}/mind/{_esc(m["id"])}">{_esc(m["name"])}</a>{era}</li>'
        )
    if not items:
        return ""
    return (
        '<section><h2>Great minds on this topic</h2>'
        f'<ul class="topic-minds">{"".join(items)}</ul></section>'
    )


def render_topic_intro(topic: str, book_count: int, mind_count: int) -> str:
    """Top-of-page intro paragraph. Generated from counts, not LLM —
    Google rewards concise factual lead paragraphs that match the H1."""
    if not topic:
        return ""
    parts = []
    if book_count > 0:
        parts.append(f"{book_count} {'book' if book_count == 1 else 'books'}")
    if mind_count > 0:
        parts.append(f"{mind_count} great {'mind' if mind_count == 1 else 'minds'}")
    if not parts:
        intro = (
            f"Explore {_esc(topic)} on Feynman — chat with the best books "
            f"and great thinkers shaping this field."
        )
    else:
        and_clause = " and ".join(parts)
        intro = (
            f"{and_clause} on {_esc(topic)} curated for chat and exploration "
            f"on Feynman — read the canon, ask the questions you actually have, "
            f"and discuss with the thinkers who shaped the field."
        )
    return f'<p class="topic-intro">{intro}</p>'


def collection_jsonld(
    *,
    name: str,
    description: str,
    url: str,
    items: list[dict[str, str]],
    site_url: str,
) -> dict[str, Any]:
    """Schema.org/CollectionPage with embedded ItemList — the right shape
    for a topic hub. ``items`` is a list of {name, url} dicts."""
    return {
        "@context": "https://schema.org",
        "@type": "CollectionPage",
        "name": name,
        "description": description,
        "url": url,
        "isPartOf": {
            "@type": "WebSite",
            "name": "Feynman",
            "url": site_url,
        },
        "mainEntity": {
            "@type": "ItemList",
            "numberOfItems": len(items),
            "itemListElement": [
                {
                    "@type": "ListItem",
                    "position": i + 1,
                    "url": item["url"],
                    "name": item["name"],
                }
                for i, item in enumerate(items)
            ],
        },
    }


# ─── Capability detection + CTA matrix (Phase 3a) ───────────────────
#
# Not every "book" in our catalog supports every action. Specifically:
#   * AI-written books with full chapters → read + chat + preview
#   * Uploads / URL imports with substantial chunks → read + chat
#   * Catalog stubs (discovered titles with no fetched content) → chat only
#   * Books mid-write or partially indexed → preview + chat (not read)
#
# Before this code, every /book/{id} blindly redirected to /#/read/{id}.
# Catalog books rendered an empty reader, users bounced, Google noticed.
# These helpers feed the capability-aware CTA matrix on the landing page.

# Below this word count, "Read this book" is misleading — that much text
# is really only useful as a preview or as RAG fuel for chat. 500 words is
# roughly two pages of a real book; pages with less are stubs.
_READ_MIN_WORDS = 500


def detect_capabilities(agent: dict[str, Any] | None, book: dict[str, Any] | None) -> dict[str, bool]:
    """Decide which CTAs this entity legitimately supports.

    Inputs:
      * agent — the row from `agents` (always required; the landing page
        wouldn't have been hit without it).
      * book — the row from `ai_books` for the agent, or None if this isn't
        an AI-written book.

    Returns a dict with three bools: ``read``, ``preview``, ``chat``. The
    caller turns these into rendered buttons via ``render_cta_matrix``.
    """
    if not agent:
        return {"read": False, "preview": False, "chat": False}
    status = (agent.get("status") or "").lower()
    if status in ("failed", "cancelled", "error"):
        return {"read": False, "preview": False, "chat": False}

    total_words = 0
    chapter_count = 0
    book_status = ""
    if book:
        total_words = int(book.get("total_words") or 0)
        book_status = (book.get("status") or "").lower()
        outline = book.get("outline")
        if isinstance(outline, dict):
            chapter_count = len(outline.get("chapters") or [])

    agent_type = (agent.get("type") or "").lower()

    # Read: has enough body text AND the body is structured enough to read
    # straight through. Uploads/URLs without chapter structure can still be
    # "read" because their chunks reassemble into linear prose.
    can_read = total_words >= _READ_MIN_WORDS and (
        chapter_count > 0 or agent_type in ("upload", "url")
    )

    # Preview: there's *something* to look at but it's not a full read.
    # Books mid-write count as preview-able even if chapter structure is
    # incomplete — the partial outline is itself useful.
    can_preview = (
        (0 < total_words < _READ_MIN_WORDS)
        or (book_status == "writing" and chapter_count > 0)
    )
    # If we can read, we can preview (read implies preview). Keep them
    # mutually distinct in the rendered CTA though — see render_cta_matrix.

    # Chat: virtually always available. Catalog stubs chat via RAG over the
    # title + web-fetched sources + LLM knowledge. Only fully-failed entities
    # are chat-incapable.
    can_chat = True

    return {"read": can_read, "preview": can_preview, "chat": can_chat}


def render_cta_matrix(
    caps: dict[str, bool],
    *,
    entity_id: str,
    entity_name: str,
    base: str,
) -> str:
    """Render the action buttons matching detected capabilities.

    All book buttons resolve to ``/#/read/{id}`` — that's the SPA route
    that opens the book reader, which carries the chat interface in its
    sidebar. **Do not use ``/#/chat/{id}`` for books**: that hash route
    is a chat-session-id route in the SPA (not a book route), so passing
    a book id there lands the user in an empty/wrong chat session
    (this was the bug shipped in Phase 3a and fixed here).

    When ``read`` is available we still render BOTH Read and Chat buttons
    even though they resolve to the same URL — distinct anchor text
    ("Read X" vs "Chat about X") doubles internal-link signal diversity
    for SEO and clarifies user intent at the page level.
    """
    if not (caps.get("read") or caps.get("preview") or caps.get("chat")):
        return ""

    buttons: list[str] = []
    name = _esc(entity_name or "this book")
    eid = _esc(entity_id)
    # The single canonical entry point for any book action. Reader UI
    # handles all three capability states (full book, preview, chat-only).
    book_url = f"{_esc(base)}/#/read/{eid}"

    if caps.get("read"):
        buttons.append(
            f'<a class="cta-btn cta-read" href="{book_url}">Read {name}</a>'
        )
    elif caps.get("preview"):
        buttons.append(
            f'<a class="cta-btn cta-preview" href="{book_url}">Preview {name}</a>'
        )

    if caps.get("chat"):
        buttons.append(
            f'<a class="cta-btn cta-chat" href="{book_url}">Chat about {name}</a>'
        )

    return f'<p class="cta-row">{" ".join(buttons)}</p>'


# ─── Referer-based redirect gating ────────────────────────────────────
#
# In-product clicks (Referer: feynman.wiki/…) preserve the old "redirect
# straight to reader" flow so the product UX is unchanged. Search results,
# share links, and direct visits (no Referer, or Referer from another
# origin) get the landing page and decide for themselves what to do —
# fixing the "Google sends user to empty reader → user bounces" bug.

def is_internal_referer(referer: str, site_url: str) -> bool:
    """True if the request came from our own site. Used to decide whether
    to JS-redirect humans straight to the SPA action (preserving in-product
    flow) or to stop on the landing page (preserving search/share UX).

    Missing referer is treated as external. The cost of false-negative
    (an in-product visitor accidentally landing) is small — they click
    one button. The cost of false-positive (an external visitor getting
    redirected to an empty reader) is the SEO bounce-rate bug we're fixing."""
    if not referer or not site_url:
        return False
    site_host = site_url.rstrip("/").split("://", 1)[-1].split("/", 1)[0].lower()
    referer_host = referer.split("://", 1)[-1].split("/", 1)[0].lower()
    return bool(site_host) and referer_host == site_host


# ─── Landing-page chrome (header + footer + CSS) ──────────────────────
#
# Shared across every SSR landing page so the visual treatment is
# consistent (book, mind, topic, /q/, /on/, /insights, /dialogues,
# /discussions). CSS lives in app/static/seo-landing.css; helpers below
# emit the `<link>`, the brand header, and the site footer.
#
# Why a separate stylesheet (vs inline): one file, browser-cached on
# first hit, no re-download per page. ~5KB compressed.

LANDING_CSS_PATH = "/static/seo-landing.css"


def landing_css_link() -> str:
    """The single ``<link>`` tag every SSR landing page should put in
    its ``<head>``. Versioned via a query param so changes invalidate
    the browser cache deterministically."""
    return f'<link rel="stylesheet" href="{LANDING_CSS_PATH}?v=1">'


def render_landing_header(site_url: str, is_authenticated: bool = False) -> str:
    """Top brand header. Same shape across all SSR detail pages so the
    page is recognizable whether the visitor arrived from Google, a
    share link, or by clicking "View details" inside the SPA.

    Auth-aware CTA, resolved CLIENT-SIDE. ``is_authenticated`` is kept
    for signature compatibility but no longer gates the markup, because
    server-side auth can't work here:

      1. These pages are edge-cached (``s-maxage`` of a day), so one HTML
         is served to every visitor — we can't vary it per user.
      2. The Supabase session token lives in localStorage and is only
         attached to the SPA's ``fetch`` calls; a top-level browser
         navigation to ``/book/{id}`` carries no Authorization header, so
         ``request.state.user_id`` is always unset here.

    Instead we render BOTH CTAs and let a tiny inline script decide. The
    script runs synchronously as the first child of <header> — before the
    CTA <a> elements are even parsed — and sets ``html[data-feynman-auth]``
    when a non-expired Supabase session is found in localStorage. The CSS
    in seo-landing.css then shows the soft "Back to app →" CTA and hides
    the loud "Open Feynman →" one. Because the attribute is set before the
    CTAs paint, the swap is flicker-free; crawlers (no JS) keep the
    conversion CTA. Logo, nav links, and wordmark are identical in both
    states so chrome stays visually stable.
    """
    # Dependency-free session probe. Scans for the supabase-js storage key
    # (sb-<ref>-auth-token) so it survives a project-ref change; tolerates
    # both the v2 (top-level) and older (currentSession) value shapes and
    # honors the token's expiry.
    auth_script = (
        '<script>'
        '(function(){try{'
        'for(var i=0;i<localStorage.length;i++){'
        'var k=localStorage.key(i);'
        "if(!k||k.slice(0,3)!=='sb-'||k.indexOf('-auth-token')<0)continue;"
        'var r=localStorage.getItem(k);if(!r)continue;'
        # Current supabase-js@2 stores plain JSON; a future build could
        # base64-prefix it. Decode that case, but let any failure fall
        # through to JSON.parse's catch (graceful anon fallback).
        "if(r.indexOf('base64-')===0){try{r=atob(r.slice(7))}catch(e){}}"
        'var o;try{o=JSON.parse(r)}catch(e){continue}'
        'var s=o&&(o.access_token?o:o.currentSession);'
        'if(s&&s.access_token){'
        'var t=(s.expires_at||0)*1000;'
        'if(!t||t>Date.now()){'
        # Flag auth synchronously so the CSS swap is flicker-free, then fill
        # the account chip with the user's name/avatar once it's parsed.
        "document.documentElement.setAttribute('data-feynman-auth','1');"
        'var u=s.user||{},m=u.user_metadata||{};'
        "var nm=m.full_name||m.name||(u.email?u.email.split('@')[0]:'')||'Account';"
        "var pic=m.avatar_url||m.picture||'';"
        'var ap=function(){'
        "var ne=document.querySelector('.feynman-account-name');if(ne)ne.textContent=nm;"
        "var av=document.querySelector('.feynman-account-avatar');"
        'if(av){if(pic){av.textContent=\'\';av.style.backgroundImage=\'url("\'+pic+\'")\';}else{av.textContent=(nm.charAt(0)||\'?\').toUpperCase();}}'
        '};'
        "if(document.readyState!=='loading')ap();else document.addEventListener('DOMContentLoaded',ap);"
        '}'
        'break;}}}catch(e){}})();'
        '</script>'
    )
    s = _esc(site_url)
    # Same mark as the product app sidebar (app/static/index.html) so the
    # brand is identical across SEO pages and the app — one logo, no drift.
    brand = (
        f'<a class="feynman-brand" href="{s}/" aria-label="Feynman">'
        '<svg class="feynman-brand-icon" width="20" height="20" viewBox="0 0 64 64" fill="none" aria-hidden="true">'
        '<line x1="8" y1="58" x2="32" y2="30" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>'
        '<line x1="56" y1="58" x2="32" y2="30" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>'
        '<circle cx="32" cy="30" r="3.5" fill="currentColor"/>'
        '<path d="M32,30 C26,24 38,18 32,12 C26,6 38,0 32,-4" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>'
        '</svg>'
        '<span class="feynman-brand-name">Feynman</span>'
        '</a>'
    )

    def _nav(href: str, label: str, paths: str) -> str:
        return (
            f'<a class="feynman-nav-link" href="{_esc(href)}">'
            '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" '
            'stroke-width="2" stroke-linecap="round" stroke-linejoin="round">'
            f'{paths}</svg><span class="feynman-nav-label">{label}</span></a>'
        )

    nav = (
        _nav(f'{site_url}/', 'New Chat',
             '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>')
        + _nav(f'{site_url}/#/chats', 'Chats',
               '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>')
        + _nav(f'{site_url}/#/library', 'Library',
               '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/>'
               '<path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>')
        + _nav(f'{site_url}/#/minds', 'Great Minds',
               '<circle cx="6" cy="6" r="2.5"/><circle cx="18" cy="8" r="2.5"/>'
               '<circle cx="8" cy="18" r="2.5"/><circle cx="18" cy="18" r="2"/>'
               '<line x1="8.2" y1="7.2" x2="15.8" y2="7.2"/><line x1="7" y1="8.3" x2="7.5" y2="15.5"/>'
               '<line x1="10.2" y1="17.2" x2="16" y2="17.8"/><line x1="16.5" y1="10.3" x2="17.5" y2="16"/>')
    )

    # Account slot — a button that opens an up-pull menu (like the app's
    # sidebar profile), not a navigation. Anonymous shows "Sign in"; the
    # hydration script swaps in the user's name/avatar + flips the menu items
    # when a session exists. Sign-out clears the localStorage session.
    account = (
        '<div class="feynman-account-wrap">'
        '<button class="feynman-account" onclick="__fsbMenu(event)" title="Account" aria-haspopup="true">'
        '<span class="feynman-account-avatar" aria-hidden="true">'
        '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" '
        'stroke-width="2" stroke-linecap="round" stroke-linejoin="round">'
        '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>'
        '</span>'
        '<span class="feynman-account-name">Sign in</span>'
        '<svg class="feynman-account-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" '
        'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>'
        '</button>'
        '<div class="feynman-account-menu" role="menu">'
        f'<a class="feynman-account-menu-item menu-anon" href="{s}/#/login">Sign in →</a>'
        f'<a class="feynman-account-menu-item menu-auth" href="{s}/#/">Open app →</a>'
        '<button class="feynman-account-menu-item menu-auth" onclick="__fsbSignout(event)">Sign out</button>'
        '</div>'
        '</div>'
    )

    # Sidebar interactions (collapse toggle + profile menu + sign-out),
    # replicating the app sidebar's behaviors for these server-rendered pages.
    # Content pages auto-collapse by default (more reading room); the user's
    # choice persists. Runs early so the collapsed width applies before paint.
    sb_script = (
        '<script>'
        '(function(){try{var d=document.documentElement;'
        "if(localStorage.getItem('feynman-sb')!=='expanded')d.classList.add('feynman-sb-collapsed');"
        "window.__fsbToggle=function(e){e&&e.stopPropagation();var c=d.classList.toggle('feynman-sb-collapsed');"
        "localStorage.setItem('feynman-sb',c?'collapsed':'expanded');};"
        "window.__fsbMenu=function(e){e&&e.stopPropagation();var m=document.querySelector('.feynman-account-menu');if(m)m.classList.toggle('open');};"
        "window.__fsbSignout=function(e){e&&e.stopPropagation();try{for(var i=localStorage.length-1;i>=0;i--){var k=localStorage.key(i);"
        "if(k&&k.slice(0,3)==='sb-'&&k.indexOf('-auth-token')>=0)localStorage.removeItem(k);}}catch(_){}location.href='/';};"
        "document.addEventListener('click',function(){var m=document.querySelector('.feynman-account-menu.open');if(m)m.classList.remove('open');});"
        '}catch(e){}})();'
        '</script>'
    )
    toggle_btn = (
        '<button class="feynman-sb-toggle" onclick="__fsbToggle(event)" title="Toggle sidebar" aria-label="Toggle sidebar">'
        '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" '
        'stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="9" y1="3" x2="9" y2="21"/></svg>'
        '</button>'
    )

    # The SAME left sidebar as the product app + the public Library, so every
    # public surface shares one chrome. position:fixed with a body padding
    # offset (seo-landing.css) keeps page content a direct child of <body>, so
    # existing content styles are untouched. SSR for crawlers; account hydrates.
    return (
        '<aside class="feynman-sidebar">'
        f'{auth_script}'
        f'{sb_script}'
        f'<div class="feynman-sidebar-header">{brand}{toggle_btn}</div>'
        f'<nav class="feynman-sidebar-nav">{nav}</nav>'
        '<div class="feynman-sidebar-spacer"></div>'
        f'<div class="feynman-sidebar-bottom">{account}</div>'
        '</aside>'
    )


def render_site_footer(site_url: str) -> str:
    """Small footer at the absolute bottom of every landing page.
    Different from the Explore footer (which lists neighbor entities) —
    this is site-wide chrome: brand mark, legal links, repo link."""
    return (
        '<footer class="feynman-site-footer">'
        f'<span>© Feynman — an interactive knowledge network</span>'
        '<span>'
        f'<a href="{_esc(site_url)}/terms">Terms</a> · '
        f'<a href="{_esc(site_url)}/privacy">Privacy</a> · '
        '<a href="https://github.com/steveyeow/feynman">GitHub</a>'
        '</span>'
        '</footer>'
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
