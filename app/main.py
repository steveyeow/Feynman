from __future__ import annotations

import json
import logging
import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any

import os

from fastapi import BackgroundTasks, FastAPI, File, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from .core import config
from .core.catalog import (
    DISCOVERY_BATCH_SIZE,
    DISCOVERY_INTERVAL,
    TOPIC_DISCOVER_COUNT,
    TOPIC_TAGS,
    VOTE_THRESHOLD,
)
from .core.db import (
    add_message,
    add_session_message,
    create_agent,
    create_catalog_agent,
    create_chat_session,
    create_vote,
    delete_agent,
    delete_chat_session,
    find_agent_by_name,
    find_existing_upload,
    find_mind_by_name,
    get_agent,
    get_chat_session,
    get_mind,
    init_db,
    list_agents,
    list_chat_sessions,
    list_messages,
    list_minds,
    list_questions,
    list_session_messages,
    list_user_interest_profile,
    list_votes,
    rename_agent,
    update_agent_meta,
    update_agent_status,
    update_chat_session,
    upvote,
    create_ai_book,
    get_ai_book,
    get_ai_book_by_agent,
    get_ai_book_status,
    get_chunks,
    get_chunks_text_only,
    list_ai_books,
    update_ai_book_outline,
    update_ai_book_status,
)
from .core.indexer import index_text
from .core.providers import GeminiProvider, ProviderError, chat_with_fallback, pick_provider
from .core.rag import build_context, retrieve, retrieve_cross_book
from .core.minds import (
    SEED_MINDS,
    create_mind_from_content,
    extract_and_save_memory,
    get_or_create_mind,
    mind_chat,
    panel_chat,
    suggest_minds_for_book,
    suggest_minds_for_topic,
)
from .core.skills import resolve_multi_agent, resolve_skills
from .core.sources import fetch_book_content, fetch_wikipedia_summary
from .core.text_utils import extract_text_from_file
from .core.url_fetch import fetch_url_as_book_text
from .core.ai_writer import (
    all_outline_chapters_have_content,
    generate_outline,
    refine_outline,
    write_full_book,
)

log = logging.getLogger(__name__)

_STALE_WRITING_SECONDS = 5 * 60

app = FastAPI(title=config.APP_TITLE)


@app.exception_handler(Exception)
async def _global_exception_handler(request: Request, exc: Exception):
    import traceback
    tb = traceback.format_exc()
    log.error("Unhandled exception on %s %s: %s\n%s", request.method, request.url.path, exc, tb)
    from fastapi.responses import JSONResponse
    return JSONResponse(
        status_code=500,
        content={"detail": f"Internal error: {type(exc).__name__}: {exc}"},
    )

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ─── Pro: Auth middleware (only when ENABLE_AUTH=true) ───
if os.getenv("ENABLE_AUTH"):
    from .pro.auth import AuthMiddleware
    app.add_middleware(AuthMiddleware)

# ─── Pro: Stripe routes ───
_has_stripe = bool(os.getenv("STRIPE_SECRET_KEY"))
if _has_stripe:
    from .pro.stripe import router as stripe_router
    app.include_router(stripe_router)

# ─── Pro: Subscription status (always available when auth is on) ───
if os.getenv("ENABLE_AUTH"):
    from .core.db import get_user as _get_user

    @app.get("/api/pro/subscription")
    async def get_subscription(request: Request):
        user_id = getattr(request.state, "user_id", None)
        if not user_id:
            raise HTTPException(status_code=401, detail="Authentication required")
        user = _get_user(user_id)
        if not user:
            return {"tier": "free", "subscription": None}
        sub_info = None
        if user.get("stripe_subscription_id") and _has_stripe:
            try:
                import stripe
                sub = stripe.Subscription.retrieve(user["stripe_subscription_id"])
                sub_info = {
                    "status": sub.status,
                    "current_period_end": sub.current_period_end,
                    "cancel_at_period_end": sub.cancel_at_period_end,
                }
            except Exception:
                pass
        return {
            "tier": user.get("tier", "free"),
            "email": user.get("email", ""),
            "subscription_status": user.get("subscription_status", "none"),
            "subscription_ended_at": user.get("subscription_ended_at"),
            "subscription": sub_info,
        }

# Quota helpers (no-op when auth is disabled)
def _check_quota(request: Request, action: str) -> None:
    if os.getenv("ENABLE_AUTH"):
        from .pro.quota import check_quota
        check_quota(request, action)

def _check_upload_limit(request: Request) -> None:
    if os.getenv("ENABLE_AUTH"):
        from .pro.quota import check_upload_limit
        check_upload_limit(request)

def _check_ai_book_quota(request: Request) -> None:
    if os.getenv("ENABLE_AUTH"):
        from .pro.quota import check_ai_book_quota
        check_ai_book_quota(request)

def _resolve_creator_name(user_id: str) -> str:
    """Resolve a human-readable creator name from a user_id (which may be a UUID)."""
    if not user_id or user_id == "anon":
        return ""
    if "@" in user_id:
        return user_id.split("@")[0]
    if os.getenv("ENABLE_AUTH"):
        from .core.db import get_user as _get_user_fn
        u = _get_user_fn(user_id)
        if u:
            email = u.get("email", "")
            return email.split("@")[0] if email else ""
    return ""

def _resolve_og_author(agent: dict | None, book: dict | None) -> str:
    """Return author display name for OG images and share pages."""
    if not agent:
        return ""
    meta = agent.get("meta") or {}
    if agent.get("type") == "ai_book" or meta.get("is_ai_generated"):
        creator = meta.get("creator_name", "")
        if not creator or creator == "User":
            uid = meta.get("creator_user_id") or agent.get("user_id") or ""
            creator = _resolve_creator_name(uid)
        return f"{creator} · AI" if creator else "AI"
    return meta.get("author") or agent.get("source") or ""

def _track_usage(request: Request, action: str, tokens: int = 0) -> None:
    if os.getenv("ENABLE_AUTH"):
        from .pro.quota import track_usage
        track_usage(request, action, tokens)

def _get_user_id(request: Request) -> str | None:
    return getattr(request.state, "user_id", None)

static_dir = Path(__file__).resolve().parent / "static"
app.mount("/static", StaticFiles(directory=static_dir), name="static")


_VERBOSE_CITE_RE = re.compile(
    r"\[(?:Google [\w\s]+?|Context|Source|Sources|Ref|Reference|Passage)\s*((?:\d+(?:\s*,\s*)?)+)\]"
)


def _normalize_citations(text: str) -> str:
    """Normalize verbose citations like [Context 1, 2] to clean [1, 2] format.
    Pure [1, 2] citations are kept as-is for frontend rendering."""
    def _replace(m):
        nums = m.group(1).strip()
        return f"[{nums}]"
    return _VERBOSE_CITE_RE.sub(_replace, text)


def _extract_cited_numbers(text: str) -> set[int]:
    """Extract all citation numbers from bracket groups like [1] or [2, 3, 4]."""
    cited: set[int] = set()
    for group in re.findall(r"\[([\d,\s]+)\]", text):
        for num in group.split(","):
            num = num.strip()
            if num.isdigit():
                cited.add(int(num))
    return cited


_SNIPPET_META_RE = re.compile(
    r"^(?:Title:\s*[^\n]*?\s*)?(?:Description:\s*)?", re.IGNORECASE
)


def _clean_snippet(text: str, max_len: int = 150) -> str:
    """Strip leading metadata labels (Title:/Description:) and truncate."""
    cleaned = _SNIPPET_META_RE.sub("", text).strip()
    if not cleaned:
        cleaned = text.strip()
    return cleaned[:max_len] + ("..." if len(cleaned) > max_len else "")


_TOKEN_MARKUP = 2  # Display multiplier for profit margin


def _usage_dict(result) -> dict[str, int]:
    """Extract token usage from ChatResult, apply display multiplier."""
    if result.usage:
        return {
            "input_tokens": result.usage.input_tokens * _TOKEN_MARKUP,
            "output_tokens": result.usage.output_tokens * _TOKEN_MARKUP,
            "total_tokens": result.usage.total_tokens * _TOKEN_MARKUP,
        }
    return {"input_tokens": 0, "output_tokens": 0, "total_tokens": 0}


class TopicAgentRequest(BaseModel):
    topic: str = Field(..., min_length=1)
    language: str = Field("en")
    use_wikipedia: bool = Field(True)


class UploadUrlRequest(BaseModel):
    url: str = Field(..., min_length=1, description="Public http(s) page to import as text")


class ChatRequest(BaseModel):
    message: str = Field(..., min_length=1)
    top_k: int | None = None


class BookContext(BaseModel):
    title: str
    author: str = ""


class HistoryMessage(BaseModel):
    role: str  # "user" or "assistant"
    content: str


class GlobalChatRequest(BaseModel):
    message: str = Field(..., min_length=1)
    top_k: int | None = None
    agent_ids: list[str] | None = None
    book_context: list[BookContext] | None = None
    history: list[HistoryMessage] | None = None


class VoteRequest(BaseModel):
    title: str = Field(..., min_length=1)


# ─── Background learning ───

_learning_lock: set[str] = set()  # agent_ids currently being learned


def _learn_agent(agent_id: str) -> None:
    """Background task: fetch content for a catalog agent, index it, set status ready."""
    if agent_id in _learning_lock:
        return
    _learning_lock.add(agent_id)
    try:
        agent = get_agent(agent_id)
        if not agent or agent["status"] not in ("catalog",):
            return

        update_agent_status(agent_id, "indexing")

        meta = agent.get("meta") or {}
        title = meta.get("title") or agent["name"]
        author = meta.get("author") or ""

        text = fetch_book_content(title, author)
        if not text:
            # No content found — revert to catalog so it can be tried again later
            update_agent_status(agent_id, "catalog")
            return

        index_meta = index_text(agent_id, text, update_status=False)
        from .core.db import sync_fts
        sync_fts(agent_id)
        # Merge skills info + index meta into existing meta
        skills = {"rag": True, "content_fetch": True}
        if config.GEMINI_API_KEY:
            skills["web_search"] = True
        skills["llm_knowledge"] = True

        merged = {**meta, **index_meta, "skills": skills}
        update_agent_status(agent_id, "ready", merged)
        log.info("Agent %s (%s) learned successfully", agent_id, title)
    except Exception as exc:
        log.error("Learning failed for agent %s: %s", agent_id, exc)
        update_agent_status(agent_id, "error", {"error": str(exc)})
    finally:
        _learning_lock.discard(agent_id)


# ─── Scheduled discovery ───

def _discover_books_for_topic(topic: str, count: int = TOPIC_DISCOVER_COUNT) -> tuple[list[dict[str, Any]], dict[str, int]]:
    """Use LLM to discover top books for a topic. Returns (books, usage)."""
    prompt = (
        f"Recommend exactly {count} must-read books on the topic \"{topic}\". "
        "Return a JSON array of objects with keys: title, author, description (one sentence). "
        "Only output the JSON array, no other text."
    )
    try:
        result, _ = chat_with_fallback(system="You are a book recommendation expert.", user=prompt)
        usage = _usage_dict(result)
        text = result.content.strip()
        # Strip markdown code fences if present
        if text.startswith("```"):
            text = re.sub(r"^```\w*\n?", "", text)
            text = re.sub(r"\n?```$", "", text)

        books_data = json.loads(text)
    except Exception as exc:
        log.warning("LLM discovery for topic '%s' failed: %s", topic, exc)
        raise

    results: list[dict[str, Any]] = []
    for entry in books_data[:count]:
        title = entry.get("title", "").strip()
        author = entry.get("author", "").strip()
        desc = entry.get("description", "").strip()
        if not title:
            continue
        agent_id = create_catalog_agent(
            title=title, author=author, category=topic, description=desc,
        )
        existing = find_agent_by_name(title)
        created = existing is not None and existing["id"] == agent_id
        results.append({"id": agent_id, "title": title, "author": author, "created": created})
        log.info("Discovered book: %s by %s [%s]", title, author, topic)
    return results, usage


def _background_discover(topic: str) -> None:
    """Background task: discover books for a topic and queue them for learning."""
    try:
        books, _ = _discover_books_for_topic(topic, count=4)
        for book in books:
            agent = get_agent(book["id"])
            if agent and agent["status"] == "catalog":
                _learn_agent(agent["id"])
    except Exception as exc:
        log.warning("Background discovery for '%s' failed: %s", topic, exc)


def _discover_books() -> None:
    """Scheduled discovery: pick underrepresented categories and discover new books via LLM."""
    try:
        agents = list_agents()
        # Count books per category
        cat_counts: dict[str, int] = {}
        for a in agents:
            cat = (a.get("meta") or {}).get("category", "")
            if cat:
                cat_counts[cat] = cat_counts.get(cat, 0) + 1

        if not cat_counts:
            return

        # Pick the category with fewest books
        sorted_cats = sorted(cat_counts.items(), key=lambda x: x[1])
        created = 0
        for cat, _ in sorted_cats:
            if created >= DISCOVERY_BATCH_SIZE:
                break
            new_books, _ = _discover_books_for_topic(cat, count=DISCOVERY_BATCH_SIZE - created)
            created += len(new_books)

        if created:
            log.info("Scheduled discovery: %d new books", created)
    except Exception as exc:
        log.warning("Scheduled discovery run failed: %s", exc)


_discovery_stop = threading.Event()


def _discovery_loop() -> None:
    """Daemon thread running periodic book discovery."""
    while not _discovery_stop.is_set():
        _discovery_stop.wait(DISCOVERY_INTERVAL)
        if _discovery_stop.is_set():
            break
        log.info("Running scheduled book discovery...")
        _discover_books()


# ─── LLM recommendation extraction ───

_BOOK_PATTERN = re.compile(
    r'["\u201c\u300a]([A-Z][\w\s:,\'-]{3,60})["\u201d\u300b]'
    r'(?:\s+by\s+([A-Z][A-Za-z.\s]{1,40}?)(?=[,;.\n\r!?]|\s+(?:for|and|or|is|was|to|in|on|at|the)\b|$))?',
)


def _extract_recommended_books(text: str) -> list[dict[str, str]]:
    """Parse LLM response for book title mentions and return new ones."""
    matches = _BOOK_PATTERN.findall(text)
    books: list[dict[str, str]] = []
    seen: set[str] = set()
    for title, author in matches:
        title = title.strip()
        if title.lower() in seen:
            continue
        seen.add(title.lower())
        books.append({"title": title, "author": author.strip()})
    return books


def _process_recommendations(text: str) -> None:
    """Create catalog agents for any books mentioned in LLM response that don't exist yet."""
    try:
        books = _extract_recommended_books(text)
        for book in books[:3]:  # limit to avoid spam
            existing = find_agent_by_name(book["title"])
            if not existing:
                create_catalog_agent(title=book["title"], author=book["author"])
                log.info("Auto-created agent from LLM recommendation: %s", book["title"])
    except Exception as exc:
        log.warning("Recommendation processing failed: %s", exc)


# ─── Startup ───

_SEED_BATCH_SIZE = int(os.getenv("SEED_BATCH_SIZE", "5"))


def _seed_minds_batch(batch_size: int = _SEED_BATCH_SIZE) -> int:
    """Seed up to `batch_size` missing minds sequentially. Returns count seeded."""
    pending = []
    for seed in SEED_MINDS:
        if find_mind_by_name(seed["name"]):
            continue
        pending.append(seed)
        if len(pending) >= batch_size:
            break

    if not pending:
        return 0

    log.info("Seeding batch of %d minds…", len(pending))
    seeded = 0
    for seed in pending:
        try:
            get_or_create_mind(seed["name"], era=seed["era"], domain=seed["domain"])
            seeded += 1
            log.info("Seeded mind: %s", seed["name"])
        except Exception as exc:
            log.warning("Failed to seed mind %s: %s", seed["name"], exc)

    return seeded


_IS_SERVERLESS = bool(os.getenv("VERCEL") or os.getenv("AWS_LAMBDA_FUNCTION_NAME"))


@app.on_event("startup")
def on_startup() -> None:
    if not (os.getenv("DATABASE_URL") or os.getenv("POSTGRES_URL")):
        config.DATA_DIR.mkdir(parents=True, exist_ok=True)
        config.UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    init_db()

    if not _IS_SERVERLESS:
        # Traditional server: use background threads as before
        def _seed_and_backfill():
            _seed_minds_batch(len(SEED_MINDS))
            from .core.minds import backfill_mind_embeddings
            backfill_mind_embeddings()
        t_minds = threading.Thread(target=_seed_and_backfill, daemon=True)
        t_minds.start()
        if DISCOVERY_INTERVAL > 0:
            t = threading.Thread(target=_discovery_loop, daemon=True)
            t.start()


@app.on_event("shutdown")
def on_shutdown() -> None:
    _discovery_stop.set()


@app.get("/", response_class=HTMLResponse)
def index() -> HTMLResponse:
    html = (static_dir / "index.html").read_text(encoding="utf-8")
    return HTMLResponse(html)


@app.get("/terms", response_class=HTMLResponse)
def terms_page() -> HTMLResponse:
    return HTMLResponse((static_dir / "terms.html").read_text(encoding="utf-8"))


@app.get("/privacy", response_class=HTMLResponse)
def privacy_page() -> HTMLResponse:
    return HTMLResponse((static_dir / "privacy.html").read_text(encoding="utf-8"))


# ─── SEO & GEO endpoints ───

_SITE_URL = os.getenv("APP_URL", "https://feynman.wiki").rstrip("/")


@app.get("/robots.txt")
def robots_txt():
    from fastapi.responses import PlainTextResponse
    content = f"""User-agent: *
Allow: /
Allow: /book/
Allow: /mind/
Disallow: /api/
Allow: /api/og-image/
Disallow: /static/

User-agent: GPTBot
Allow: /
Disallow: /api/
Allow: /api/og-image/

User-agent: ChatGPT-User
Allow: /
Disallow: /api/
Allow: /api/og-image/

User-agent: ClaudeBot
Allow: /
Disallow: /api/
Allow: /api/og-image/

User-agent: Google-Extended
Allow: /

User-agent: PerplexityBot
Allow: /
Disallow: /api/
Allow: /api/og-image/

User-agent: Applebot-Extended
Allow: /
Disallow: /api/
Allow: /api/og-image/

User-agent: cohere-ai
Allow: /
Disallow: /api/
Allow: /api/og-image/

Sitemap: {_SITE_URL}/sitemap.xml
"""
    return PlainTextResponse(
        content,
        media_type="text/plain; charset=utf-8",
        headers={"Cache-Control": "public, max-age=86400, s-maxage=86400"},
    )


@app.get("/sitemap")
def sitemap_redirect():
    from fastapi.responses import RedirectResponse
    return RedirectResponse("/sitemap.xml", status_code=301)


@app.get("/sitemap.xml")
def sitemap_xml():
    from fastapi.responses import Response
    from datetime import date
    today = date.today().isoformat()
    pages = [
        {"loc": "/", "priority": "1.0", "changefreq": "daily"},
        {"loc": "/terms", "priority": "0.3", "changefreq": "yearly"},
        {"loc": "/privacy", "priority": "0.3", "changefreq": "yearly"},
    ]
    urls = ""
    for p in pages:
        urls += f"""  <url>
    <loc>{_SITE_URL}{p["loc"]}</loc>
    <lastmod>{today}</lastmod>
    <changefreq>{p["changefreq"]}</changefreq>
    <priority>{p["priority"]}</priority>
  </url>
"""
    # Include all ready books and minds
    try:
        for agent in list_agents():
            if agent.get("status") != "ready":
                continue
            priority = "0.7" if agent.get("type") == "ai_book" else "0.5"
            urls += f"""  <url>
    <loc>{_SITE_URL}/book/{agent["id"]}</loc>
    <lastmod>{today}</lastmod>
    <changefreq>monthly</changefreq>
    <priority>{priority}</priority>
  </url>
"""
        for mind in list_minds():
            urls += f"""  <url>
    <loc>{_SITE_URL}/mind/{mind["id"]}</loc>
    <lastmod>{today}</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.6</priority>
  </url>
"""
    except Exception:
        pass

    xml = f"""<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
{urls}</urlset>"""
    return Response(
        content=xml,
        media_type="application/xml; charset=utf-8",
        headers={"Cache-Control": "public, max-age=3600, s-maxage=86400"},
    )


@app.get("/llms.txt")
def llms_txt():
    from fastapi.responses import PlainTextResponse
    content = f"""# Feynman

> An interactive knowledge network built on the world's most important books and great minds. Chat with any book, explore topics with AI-curated sources, and discuss ideas with simulated great thinkers.

## About

Feynman is an AI-powered study companion inspired by the Feynman learning method.
Users can chat with books using a four-layer content system (RAG, Content Fetch, Web Search, LLM Knowledge),
explore topics with AI-curated book discovery, and engage with 50+ simulated great minds — scholars,
scientists, and practitioners — who automatically join conversations with relevant expertise.

- [Homepage]({_SITE_URL}/): Main application — chat with books, explore topics, interact with great minds
- [Library]({_SITE_URL}/#/library): Browse and discover books across all topics
- [Great Minds]({_SITE_URL}/#/minds): Interactive knowledge graph of 50+ great thinkers
- [GitHub](https://github.com/steveyeow/feynman): Open-source repository (MIT license)

## What Feynman Does

- **Chat with Books**: Ask questions about any book and get answers with passage-level citations [1], [2] from a four-layer RAG system
- **Topic-Driven Discovery**: Enter a topic (Psychology, Philosophy, Economics, Physics, etc.) and Feynman discovers the most relevant books via AI curation
- **Great Minds Network**: AI agents faithfully simulate great thinkers (Aristotle, Feynman, Adam Smith, Keynes, etc.) who join your conversations automatically
- **Cross-Book Knowledge**: Select multiple books and search across your entire library for the most relevant passages
- **AI Book Writing**: Collaboratively outline and generate full books on any topic
- **Upload Custom Minds**: Create mind agents from Twitter profiles, blog URLs, or text

## What Feynman Does NOT Do

- Feynman is not a replacement for reading — it helps you scout, scaffold, and go beyond the text
- Feynman does not provide medical, legal, or financial advice
- Feynman does not guarantee factual accuracy of AI-generated content

## Key Information

- [Terms of Service]({_SITE_URL}/terms)
- [Privacy Policy]({_SITE_URL}/privacy)

## Contact

- Twitter/X: [@steve_yeow](https://x.com/steve_yeow)
- Discord: [discord.gg/BkYSkkwq](https://discord.gg/BkYSkkwq)
- Email: support@academiai.app
- GitHub: [steveyeow/feynman](https://github.com/steveyeow/feynman)

## Optional

- [Full LLM context]({_SITE_URL}/llms-full.txt): Comprehensive product documentation for AI systems
"""
    return PlainTextResponse(
        content,
        media_type="text/plain; charset=utf-8",
        headers={"Cache-Control": "public, max-age=86400, s-maxage=86400"},
    )


@app.get("/llms-full.txt")
def llms_full_txt():
    from fastapi.responses import PlainTextResponse
    content = f"""# Feynman — Full Documentation for AI Systems

> An interactive knowledge network built on the world's most important books and great minds. Chat with any book, explore topics with AI-curated sources, and discuss ideas with simulated great thinkers.

## Product Overview

Feynman is an AI-powered interactive knowledge network that connects books, great minds, and ideas
into a navigable map of human thought. It is built on the Feynman learning method: question-driven,
multi-source, never passive.

Website: {_SITE_URL}
GitHub: https://github.com/steveyeow/feynman
License: MIT

## Three Entry Points

### 1. Enter Through a Book
Ask questions about any book and get answers grounded in the work's actual content.
Every claim is traced back to a specific passage with clickable [1], [2] citations.
A four-layer content system ensures comprehensive knowledge:

| Priority | Layer | What It Does |
|----------|-------|--------------|
| 1st | RAG | Retrieves relevant passages from the book's indexed content |
| 2nd | Content Fetch | Pulls information from Open Library, Google Books, Wikipedia |
| 3rd | Web Search | Uses Gemini Search Grounding for real-time web answers |
| 4th | LLM Knowledge | Falls back to the model's training knowledge |

### 2. Enter Through a Topic
No book needed — start with any topic (Psychology, Philosophy, Economics, Physics, etc.).
Feynman discovers the most relevant books via AI curation, proposes study questions,
answers questions grounded in discovered books, and grows your library organically.

The library expands through topic exploration, search, chat mentions, PDF/TXT/EPUB uploads,
and community voting (books with enough upvotes get auto-indexed).

### 3. Enter Through a Mind
50+ pre-generated AI agents simulate great thinkers across every field:
philosophy, physics, economics, psychology, literature, tech, startups, and more.
From Aristotle and Richard Feynman to Marc Andreessen and Naval Ravikant.

Minds automatically join conversations when relevant, accumulate memory from interactions,
and are connected to their works and to each other in an interactive knowledge graph.
Users can upload their own minds from Twitter profiles, blog URLs, or pasted text.

## Core Features

- **Book Chat with Citations**: RAG-powered Q&A with passage-level source attribution
- **AI Book Discovery**: LLM-curated book recommendations for any topic
- **Great Minds Network**: 50+ simulated thinkers with persistent memory and auto-join
- **Cross-Book Search**: Query across your entire library simultaneously
- **AI Book Writing**: Collaborative outline + full book generation
- **Knowledge Graph**: Interactive force-directed visualization of mind connections
- **Custom Mind Upload**: Create minds from Twitter, blogs, or text
- **Token Usage Transparency**: Every LLM call shows its token consumption

## Technical Architecture

- **Backend**: Python / FastAPI
- **Frontend**: Vanilla JavaScript SPA with hash-based routing
- **Database**: SQLite (local) or PostgreSQL via Supabase (production)
- **LLM Providers**: 6-provider auto-fallback — DeepSeek, Gemini, OpenAI, Novita, Kimi, Anthropic
- **Embeddings**: Vector embeddings stored as BLOBs for semantic similarity
- **Deployment**: Vercel (Python serverless)
- **Auth** (optional): Supabase Auth + Stripe for Pro features

## Design Philosophy

Feynman is NOT a replacement for reading. It helps users:
- Scout books before committing to a deep read
- Build knowledge scaffolds across unfamiliar fields
- Go beyond the text by surfacing context and insights from broader knowledge

The project draws inspiration from Richard Feynman's approach to learning:
"You learn by asking questions, by thinking, and by experimenting."

## Pages

- [Home]({_SITE_URL}/): Main chat interface — ask about books, topics, or anything
- [Library]({_SITE_URL}/#/library): Browse, search, and discover books
- [Great Minds]({_SITE_URL}/#/minds): Interactive knowledge graph of great thinkers
- [Chats]({_SITE_URL}/#/chats): Chat session history
- [Terms of Service]({_SITE_URL}/terms)
- [Privacy Policy]({_SITE_URL}/privacy)

## Available Books

"""
    try:
        for agent in list_agents():
            if agent.get("status") != "ready":
                continue
            name = agent.get("name", "Untitled")
            source = agent.get("source", "")
            agent_type = agent.get("type", "book")
            label = "AI-generated book" if agent_type == "ai_book" else "book"
            author_part = f" by {source}" if source else ""
            content += f"- [{name}]({_SITE_URL}/book/{agent['id']}): {label}{author_part}\n"
    except Exception:
        content += "- (catalog temporarily unavailable)\n"

    content += f"""
## Available Great Minds

"""
    try:
        for mind in list_minds():
            name = mind.get("name", "Unknown")
            domain = mind.get("domain", "")
            content += f"- [{name}]({_SITE_URL}/mind/{mind['id']}): {domain}\n"
    except Exception:
        content += "- (minds catalog temporarily unavailable)\n"

    content += f"""
## Contact

- Creator: Steve Yao
- Twitter/X: https://x.com/steve_yeow
- Discord: https://discord.gg/BkYSkkwq
- Email: support@academiai.app
- GitHub: https://github.com/steveyeow/feynman
"""
    return PlainTextResponse(
        content,
        media_type="text/plain; charset=utf-8",
        headers={"Cache-Control": "public, max-age=86400, s-maxage=86400"},
    )


@app.get("/share/{agent_id}", response_class=HTMLResponse)
def share_page(agent_id: str) -> HTMLResponse:
    """Legacy share URL — 301 redirect to canonical /book/ path."""
    from fastapi.responses import RedirectResponse
    from urllib.parse import quote
    return RedirectResponse(f"/book/{quote(agent_id, safe='')}", status_code=301)


@app.get("/share/{agent_id}/og.png")
@app.get("/api/og-image/{agent_id}")
def api_og_image(agent_id: str):
    """Generate a dynamic Open Graph image for a book.

    Primary path is /share/{id}/og.png (crawler-friendly, outside /api/).
    Legacy /api/og-image/{id} kept for backward compat.
    """
    from fastapi.responses import Response
    from .core.og_image import generate_og_image

    agent = get_agent(agent_id)
    book = get_ai_book_by_agent(agent_id) if agent else None
    title = book["title"] if book and book.get("title") else (agent["name"] if agent else "Untitled")
    outline = book.get("outline") if book else None
    subtitle = outline.get("subtitle", "") if isinstance(outline, dict) else ""
    chapter_count = len(outline.get("chapters", [])) if isinstance(outline, dict) else 0
    total_words = book.get("total_words", 0) if book else 0
    author = _resolve_og_author(agent, book)

    png_bytes = generate_og_image(
        title=title,
        subtitle=subtitle,
        chapter_count=chapter_count,
        total_words=total_words,
        author=author,
    )
    return Response(content=png_bytes, media_type="image/png", headers={
        "Cache-Control": "public, max-age=86400, s-maxage=604800",
    })


# ─── Crawlable SSR pages for books and minds ───

@app.get("/book/{agent_id}", response_class=HTMLResponse)
def book_page(agent_id: str) -> HTMLResponse:
    """Server-rendered book landing page with OG tags and JSON-LD for SEO/GEO."""
    from html import escape as html_esc
    from urllib.parse import quote

    agent = get_agent(agent_id)
    if not agent:
        raise HTTPException(status_code=404, detail="Book not found")

    book = get_ai_book_by_agent(agent_id) if agent else None
    title = html_esc(book["title"] if book and book.get("title") else agent.get("name", "Untitled"))
    meta = agent.get("meta") or {}
    outline = book.get("outline") if book else None
    subtitle_raw = outline.get("subtitle", "") if isinstance(outline, dict) else ""
    chapter_count = len(outline.get("chapters", [])) if isinstance(outline, dict) else 0
    author_raw = _resolve_og_author(agent, book)
    total_words = book.get("total_words", 0) if book else 0

    if subtitle_raw:
        desc = html_esc(subtitle_raw)
    elif author_raw:
        desc = html_esc(f"by {author_raw} — Read and chat with this book on Feynman")
    else:
        desc = html_esc(f"Read and chat with this book on Feynman")

    base = _SITE_URL
    id_path = quote(agent_id, safe="")
    canonical = f"{base}/book/{id_path}"
    reader_url = f"{base}/#/read/{id_path}"
    v = config.OG_IMAGE_CACHE_VERSION
    og_image_url = f"{base}/book/{id_path}/og.png?v={v}"
    reader_js = json.dumps(reader_url)

    chapters_json = "[]"
    toc_html = ""
    if book and isinstance(outline, dict):
        chapters = outline.get("chapters", [])
        toc_items = "".join(f"<li>{html_esc(ch.get('title', ''))}</li>" for ch in chapters)
        toc_html = f"<h2>Table of Contents</h2><ol>{toc_items}</ol>" if toc_items else ""
        chapters_json = json.dumps([
            {"@type": "Chapter", "name": ch.get("title", ""), "position": i + 1}
            for i, ch in enumerate(chapters)
        ])

    jsonld = json.dumps({
        "@context": "https://schema.org",
        "@type": "Book",
        "name": book["title"] if book and book.get("title") else agent.get("name", "Untitled"),
        "description": subtitle_raw or desc,
        "author": {"@type": "Person", "name": author_raw} if author_raw else None,
        "url": canonical,
        "image": og_image_url,
        "numberOfPages": chapter_count or None,
        "wordCount": total_words or None,
        "hasPart": json.loads(chapters_json) if chapters_json != "[]" else None,
        "publisher": {"@type": "Organization", "name": "Feynman", "url": base},
    }, ensure_ascii=False)

    read_time = max(1, (total_words or 0) // 250)
    stats_parts = []
    if total_words:
        stats_parts.append(f"{total_words:,} words")
    if read_time:
        stats_parts.append(f"~{read_time} min read")
    if chapter_count:
        stats_parts.append(f"{chapter_count} chapters")
    stats_html = " · ".join(stats_parts)

    html = f"""<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title} — Feynman</title>
<meta name="description" content="{desc}">
<link rel="canonical" href="{canonical}">
<meta property="og:type" content="book">
<meta property="og:title" content="{title}">
<meta property="og:description" content="{desc}">
<meta property="og:image" content="{og_image_url}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:url" content="{canonical}">
<meta property="og:site_name" content="Feynman">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="{title}">
<meta name="twitter:description" content="{desc}">
<meta name="twitter:image" content="{og_image_url}">
<script type="application/ld+json">{jsonld}</script>
</head><body>
<h1>{title}</h1>
{f'<p>by {html_esc(author_raw)}</p>' if author_raw else ''}
{f'<p>{desc}</p>' if subtitle_raw else ''}
{toc_html}
<p><a href="{html_esc(reader_url)}">Read this book on Feynman</a></p>
<script>window.location.replace({json.dumps(reader_url)});</script>
</body></html>"""
    return HTMLResponse(html, headers={"Cache-Control": "public, max-age=3600, s-maxage=86400"})


@app.get("/book/{agent_id}/og.png")
def book_og_image(agent_id: str):
    """OG image via /book/ path — delegates to the shared generator."""
    return api_og_image(agent_id)


@app.get("/mind/{mind_id}/og.png")
def mind_og_image(mind_id: str):
    """Generate a dynamic Open Graph image for a mind."""
    from fastapi.responses import Response
    from .core.og_image import generate_mind_og_image

    mind = get_mind(mind_id)
    if not mind:
        raise HTTPException(status_code=404, detail="Mind not found")

    png_bytes = generate_mind_og_image(
        name=mind.get("name", "Unknown"),
        domain=mind.get("domain", ""),
        era=mind.get("era", ""),
        bio=mind.get("bio_summary", ""),
    )
    return Response(content=png_bytes, media_type="image/png",
                    headers={"Cache-Control": "public, max-age=86400, s-maxage=604800"})


@app.get("/mind/{mind_id}", response_class=HTMLResponse)
def mind_page(mind_id: str) -> HTMLResponse:
    """Server-rendered mind landing page with OG tags and JSON-LD Person schema."""
    from html import escape as html_esc

    mind = get_mind(mind_id)
    if not mind:
        raise HTTPException(status_code=404, detail="Mind not found")

    name = html_esc(mind.get("name", "Unknown"))
    era = html_esc(mind.get("era", ""))
    domain = html_esc(mind.get("domain", ""))
    bio = html_esc(mind.get("bio_summary", ""))
    works_raw = mind.get("works") or []
    works_list = works_raw if isinstance(works_raw, list) else []

    desc = bio or f"{name} — {domain} thinker on Feynman"
    base = _SITE_URL
    canonical = f"{base}/mind/{mind_id}"
    og_image_url = f"{base}/mind/{mind_id}/og.png"
    reader_url = f"{base}/#/mind/{mind_id}"
    reader_js = json.dumps(reader_url)

    works_html = ""
    if works_list:
        items = "".join(f"<li>{html_esc(w)}</li>" for w in works_list[:20])
        works_html = f"<h2>Notable Works</h2><ul>{items}</ul>"

    jsonld = json.dumps({
        "@context": "https://schema.org",
        "@type": "Person",
        "name": mind.get("name", "Unknown"),
        "description": mind.get("bio_summary", ""),
        "knowsAbout": mind.get("domain", ""),
        "url": canonical,
        "image": og_image_url,
        "sameAs": [],
    }, ensure_ascii=False)

    chat_count = mind.get("chat_count", 0)
    domains_list = [d.strip() for d in domain.split(",") if d.strip()] if domain else []
    domains_tags = "".join(f'<span class="domain-tag">{html_esc(d)}</span>' for d in domains_list)
    domains_html = f'<div class="domains">{domains_tags}</div>' if domains_list else ""

    html = f"""<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{name} — Feynman Great Minds</title>
<meta name="description" content="{desc}">
<link rel="canonical" href="{canonical}">
<meta property="og:type" content="profile">
<meta property="og:title" content="{name}">
<meta property="og:description" content="{desc}">
<meta property="og:image" content="{og_image_url}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:url" content="{canonical}">
<meta property="og:site_name" content="Feynman">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="{name}">
<meta name="twitter:description" content="{desc}">
<meta name="twitter:image" content="{og_image_url}">
<script type="application/ld+json">{jsonld}</script>
</head><body>
<h1>{name}</h1>
{f'<p>{era} · {domain}</p>' if era else f'<p>{domain}</p>'}
{f'<p>{bio}</p>' if bio else ''}
{works_html}
<p><a href="{html_esc(reader_url)}">Chat with {name} on Feynman</a></p>
<script>window.location.replace({json.dumps(reader_url)});</script>
</body></html>"""
    return HTMLResponse(html, headers={"Cache-Control": "public, max-age=3600, s-maxage=86400"})


@app.get("/api/public/book/{agent_id}/read")
def api_public_read_book(agent_id: str, request: Request) -> dict[str, Any]:
    """Public read endpoint — only serves ready (published) books without auth."""
    agent = get_agent(agent_id)
    if not agent or agent.get("status") != "ready":
        raise HTTPException(status_code=404, detail="Book not found or not published")
    request.state._public_agent = agent
    return api_read_book(agent_id, _agent=agent)


@app.get("/api/health")
def health() -> dict[str, Any]:
    return {"status": "ok", "app": config.APP_NAME}


# ─── Topic discovery endpoints ───

@app.get("/api/topics")
def api_topics():
    from fastapi.responses import JSONResponse
    return JSONResponse(
        content={"topics": TOPIC_TAGS},
        headers={"Cache-Control": "public, max-age=86400, s-maxage=86400"},
    )


class DiscoverRequest(BaseModel):
    topic: str = Field(..., min_length=1)
    count: int = Field(default=TOPIC_DISCOVER_COUNT, ge=1, le=10)


class SearchBookRequest(BaseModel):
    query: str = Field(..., min_length=2)


@app.post("/api/discover")
def api_discover(payload: DiscoverRequest, request: Request, background_tasks: BackgroundTasks) -> dict[str, Any]:
    _check_quota(request, "discover")
    try:
        books, usage = _discover_books_for_topic(payload.topic.strip(), count=payload.count)
    except ProviderError as exc:
        raise HTTPException(status_code=503, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Discovery failed: {exc}")
    # Trigger background learning for each new agent
    for book in books:
        agent = get_agent(book["id"])
        if agent and agent["status"] == "catalog":
            background_tasks.add_task(_learn_agent, book["id"])
    _track_usage(request, "discover")
    return {"topic": payload.topic.strip(), "books": books, "usage": usage}


@app.post("/api/search-book")
def api_search_book(payload: SearchBookRequest, request: Request, background_tasks: BackgroundTasks) -> dict[str, Any]:
    """Search for a specific book by name. Uses LLM to identify the book and add it."""
    _check_quota(request, "discover")
    query = payload.query.strip()
    # Check if already exists
    existing = find_agent_by_name(query)
    if existing:
        return {"books": [{"id": existing["id"], "title": existing["name"], "author": existing.get("source", ""), "existing": True}], "usage": {"input_tokens": 0, "output_tokens": 0, "total_tokens": 0}}

    prompt = (
        f'The user is searching for a book: "{query}". '
        "Identify the most likely book they mean. Return a JSON array with exactly 1 object "
        "containing keys: title (full correct title), author, category (broad academic topic), "
        "description (one sentence). Only output the JSON array, no other text."
    )
    try:
        result, _ = chat_with_fallback(system="You are a book identification expert.", user=prompt)
        text = result.content.strip()
        if text.startswith("```"):
            text = re.sub(r"^```\w*\n?", "", text)
            text = re.sub(r"\n?```$", "", text)
        books_data = json.loads(text)
    except ProviderError as exc:
        raise HTTPException(status_code=503, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Search failed: {exc}")

    results = []
    for entry in books_data[:1]:
        title = entry.get("title", "").strip()
        author = entry.get("author", "").strip()
        category = entry.get("category", "").strip()
        desc = entry.get("description", "").strip()
        if not title:
            continue
        agent_id = create_catalog_agent(title=title, author=author, category=category, description=desc)
        results.append({"id": agent_id, "title": title, "author": author, "existing": False})
        agent = get_agent(agent_id)
        if agent and agent["status"] == "catalog":
            background_tasks.add_task(_learn_agent, agent_id)
    _track_usage(request, "discover")
    return {"books": results, "usage": _usage_dict(result)}


# ─── Cron endpoints (Vercel Cron / external scheduler) ───

_CRON_SECRET = os.getenv("CRON_SECRET", "")


def _verify_cron(request: Request) -> None:
    """Verify the request comes from Vercel Cron or an authorized caller."""
    if _CRON_SECRET and request.headers.get("authorization") != f"Bearer {_CRON_SECRET}":
        raise HTTPException(status_code=401, detail="Unauthorized")


@app.get("/api/cron/discover")
def api_cron_discover(request: Request, background_tasks: BackgroundTasks) -> dict[str, Any]:
    """Cron-triggered book discovery. Replaces the daemon discovery loop."""
    _verify_cron(request)
    agents = list_agents()
    if not agents:
        return {"status": "skip", "reason": "no agents yet"}
    _discover_books()
    # Trigger learning for any new catalog agents
    for a in list_agents():
        if a["status"] == "catalog":
            background_tasks.add_task(_learn_agent, a["id"])
    return {"status": "ok"}


@app.get("/api/cron/seed-minds")
def api_cron_seed_minds(request: Request) -> dict[str, Any]:
    """Cron-triggered mind seeding. Seeds a batch per run (Hobby has 60s timeout)."""
    _verify_cron(request)
    existing_count = len(list_minds())
    if existing_count >= len(SEED_MINDS):
        return {"status": "complete", "total": existing_count}
    seeded = _seed_minds_batch(_SEED_BATCH_SIZE)
    return {"status": "ok", "seeded": seeded, "total": existing_count + seeded}


@app.get("/api/cron/embed-minds")
def api_cron_embed_minds(request: Request) -> dict[str, Any]:
    """Cron-triggered embedding backfill for minds missing vectors.
    Processes up to 10 minds per call to stay within Vercel's timeout.
    """
    _verify_cron(request)
    from .core.minds import backfill_mind_embeddings
    from .core.db import list_minds_missing_embeddings
    try:
        remaining_before = len(list_minds_missing_embeddings())
        count = backfill_mind_embeddings(batch_size=10)
        remaining_after = remaining_before - count
        return {"status": "ok", "embedded": count, "remaining": remaining_after}
    except Exception as exc:
        log.error("Embed-minds cron failed: %s", exc)
        return {"status": "error", "detail": str(exc)}


@app.get("/api/cron/reset-embeddings")
def api_cron_reset_embeddings() -> dict[str, Any]:
    """Clear all corrupted embeddings so backfill can regenerate them."""
    from .core.db import get_conn, _q, _execute
    try:
        with get_conn() as conn:
            _execute(conn, _q("UPDATE minds SET embedding = NULL, embedding_dim = NULL, embedding_norm = NULL"))
        global _similarities_cache, _similarities_cache_ts
        _similarities_cache = {}
        _similarities_cache_ts = 0
        return {"status": "ok", "message": "All embeddings cleared. Run /api/cron/embed-minds repeatedly to regenerate."}
    except Exception as exc:
        log.error("Reset embeddings failed: %s", exc)
        return {"status": "error", "detail": str(exc)}


@app.get("/api/debug/embedding-status")
def api_debug_embedding_status() -> dict[str, Any]:
    """Diagnostic: check embedding column existence and mind counts.
    Also auto-creates missing columns if they don't exist (self-healing).
    """
    from .core.db import get_conn, _q, _USE_PG, _fetchone, _execute
    result: dict[str, Any] = {"pg": _USE_PG}
    try:
        with get_conn() as conn:
            row = _fetchone(conn, _q("SELECT COUNT(*) as total FROM minds"), ())
            result["total_minds"] = row["total"] if row else 0
    except Exception as exc:
        result["total_minds_error"] = str(exc)

    # Self-healing: try to add embedding columns if missing
    columns_added = []
    if _USE_PG:
        for col, col_type in [("embedding", "BYTEA"), ("embedding_dim", "INTEGER"), ("embedding_norm", "DOUBLE PRECISION")]:
            try:
                from .core.db import DATABASE_URL, _pg, _clean_dsn
                pg = _pg()
                conn = pg.connect(_clean_dsn(DATABASE_URL))
                conn.autocommit = True
                cur = conn.cursor()
                cur.execute(f"ALTER TABLE minds ADD COLUMN {col} {col_type}")
                columns_added.append(col)
                conn.close()
            except Exception as exc:
                err_str = str(exc)
                if "already exists" in err_str:
                    pass
                else:
                    result[f"add_{col}_error"] = err_str
    if columns_added:
        result["columns_added"] = columns_added

    try:
        with get_conn() as conn:
            row = _fetchone(conn, _q("SELECT COUNT(*) as cnt FROM minds WHERE embedding IS NOT NULL"), ())
            result["with_embedding"] = row["cnt"] if row else 0
    except Exception as exc:
        result["embedding_column_error"] = str(exc)
    try:
        with get_conn() as conn:
            row = _fetchone(conn, _q("SELECT COUNT(*) as cnt FROM minds WHERE embedding IS NULL"), ())
            result["without_embedding"] = row["cnt"] if row else 0
    except Exception as exc:
        result["null_query_error"] = str(exc)
    return result


# ─── Pro config endpoint ───

@app.get("/api/pro/config")
def pro_config() -> dict[str, Any]:
    """Public config for frontend — safe to expose."""
    return {
        "auth_enabled": bool(os.getenv("ENABLE_AUTH")),
        "supabase_url": os.getenv("SUPABASE_URL", "").strip(),
        "supabase_key": os.getenv("SUPABASE_ANON_KEY", os.getenv("SUPABASE_KEY", "")).strip(),
        "stripe_enabled": bool(os.getenv("STRIPE_SECRET_KEY")),
    }


# ─── Agent endpoints ───

@app.get("/api/agents")
def api_list_agents():
    from fastapi.responses import JSONResponse
    result = list_agents()
    try:
        _enrich_ai_book_agents(result)
    except Exception as exc:
        log.error("Failed to enrich AI book agents: %s", exc)
    return JSONResponse(
        content=result,
        headers={"Cache-Control": "public, max-age=30, s-maxage=120"},
    )


def _enrich_ai_book_agents(agents: list[dict[str, Any]]) -> None:
    """Best-effort enrichment: backfill creator names, detect stale writing."""
    from datetime import datetime as _dt, timezone as _tz
    for agent in agents:
        if agent.get("type") != "ai_book":
            continue
        meta = agent.get("meta") or {}
        try:
            if not meta.get("creator_name") or meta.get("creator_name") == "User":
                uid = meta.get("creator_user_id") or agent.get("user_id") or ""
                resolved = _resolve_creator_name(uid)
                if resolved:
                    meta["creator_name"] = resolved
                    agent["meta"] = meta
        except Exception:
            pass
        if agent.get("status") != "writing":
            continue
        try:
            ai_book = get_ai_book_by_agent(agent["id"])
            if not ai_book:
                continue
            # All chapters saved but never finalized (index/complete) — same heal as GET /api/ai-books/{id}
            if all_outline_chapters_have_content(ai_book):
                threading.Thread(
                    target=write_full_book,
                    args=(ai_book["id"],),
                    daemon=True,
                    name=f"heal-ai-book-{ai_book['id'][:8]}",
                ).start()
                continue
            if not ai_book.get("updated_at"):
                continue
            raw = ai_book["updated_at"]
            updated = _dt.fromisoformat(raw.replace("Z", "+00:00")) if isinstance(raw, str) else raw
            if hasattr(updated, 'tzinfo') and updated.tzinfo is None:
                updated = updated.replace(tzinfo=_tz.utc)
            age = (_dt.now(_tz.utc) - updated).total_seconds()
            if age > _STALE_WRITING_SECONDS:
                log.warning("Agent %s / book %s stuck writing %ds — marking failed",
                            agent["id"], ai_book["id"], int(age))
                update_ai_book_status(ai_book["id"], "failed")
                new_status = "error" if ai_book["chapters_written"] == 0 else "ready"
                update_agent_status(agent["id"], new_status)
                agent["status"] = new_status
        except Exception as exc:
            log.error("Stale check failed for agent %s: %s", agent["id"], exc)


@app.get("/api/agents/{agent_id}")
def api_get_agent(agent_id: str) -> dict[str, Any]:
    agent = get_agent(agent_id)
    if not agent:
        raise HTTPException(status_code=404, detail="Agent not found")
    return agent


@app.delete("/api/agents/{agent_id}")
def api_delete_agent(agent_id: str, request: Request) -> dict[str, Any]:
    user_id = _get_user_id(request)
    if not user_id:
        raise HTTPException(status_code=401, detail="Authentication required")
    agent = get_agent(agent_id)
    if not agent:
        raise HTTPException(status_code=404, detail="Agent not found")
    if agent.get("user_id") and agent["user_id"] != user_id:
        raise HTTPException(status_code=403, detail="Only the uploader can delete this book")
    if not delete_agent(agent_id, user_id):
        raise HTTPException(status_code=403, detail="Delete not permitted")
    return {"status": "deleted"}


class AgentRenameRequest(BaseModel):
    name: str


@app.patch("/api/agents/{agent_id}")
def api_rename_agent(agent_id: str, payload: AgentRenameRequest, request: Request) -> dict[str, Any]:
    user_id = _get_user_id(request)
    if not user_id:
        raise HTTPException(status_code=401, detail="Authentication required")
    agent = get_agent(agent_id)
    if not agent:
        raise HTTPException(status_code=404, detail="Agent not found")
    owner = agent.get("user_id") or (agent.get("meta") or {}).get("creator_user_id")
    if owner and owner != user_id:
        raise HTTPException(status_code=403, detail="Only the creator can rename this book")
    new_name = payload.name.strip()
    if not new_name:
        raise HTTPException(status_code=400, detail="Name cannot be empty")
    rename_agent(agent_id, new_name)
    return get_agent(agent_id)


def _run_index(agent_id: str, text: str) -> None:
    try:
        index_text(agent_id, text)
        from .core.db import sync_fts
        sync_fts(agent_id)
    except Exception as exc:
        update_agent_status(agent_id, "error", {"error": str(exc)})


@app.post("/api/agents/upload")
def api_create_upload_agent(request: Request, background_tasks: BackgroundTasks, file: UploadFile = File(...)) -> dict[str, Any]:
    _check_quota(request, "upload")
    user_id = _get_user_id(request)
    name = Path(file.filename).stem if file.filename else "Uploaded Book"

    existing = find_existing_upload(name)
    if existing:
        return {"id": existing["id"], "status": existing["status"], "duplicate": True, "name": existing["name"]}

    _check_upload_limit(request)

    agent_id = create_agent(name=name, agent_type="upload", source=file.filename, meta={}, user_id=user_id)
    config.UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    dest = config.UPLOAD_DIR / f"{agent_id}_{file.filename}"
    with dest.open("wb") as f:
        f.write(file.file.read())

    try:
        text = extract_text_from_file(dest)
    except Exception as exc:
        update_agent_status(agent_id, "error", {"error": str(exc)})
        raise HTTPException(status_code=400, detail=str(exc))
    finally:
        dest.unlink(missing_ok=True)

    background_tasks.add_task(_run_index, agent_id, text)
    _track_usage(request, "upload")
    return {"id": agent_id, "status": "indexing"}


@app.post("/api/agents/upload-url")
def api_create_upload_from_url(
    payload: UploadUrlRequest, request: Request, background_tasks: BackgroundTasks
) -> dict[str, Any]:
    """Import plain text from a public web page (HTML or text) as a user book."""
    _check_quota(request, "upload")
    user_id = _get_user_id(request)
    try:
        text, name, final_url = fetch_url_as_book_text(payload.url)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    name = name.strip()[:240]

    existing = find_existing_upload(name)
    if existing:
        return {"id": existing["id"], "status": existing["status"], "duplicate": True, "name": existing["name"]}

    _check_upload_limit(request)

    agent_id = create_agent(
        name=name,
        agent_type="upload",
        source=final_url,
        meta={"import_url": final_url},
        user_id=user_id,
    )
    background_tasks.add_task(_run_index, agent_id, text)
    _track_usage(request, "upload")
    return {"id": agent_id, "status": "indexing"}


@app.post("/api/agents/topic")
def api_create_topic_agent(payload: TopicAgentRequest, request: Request, background_tasks: BackgroundTasks) -> dict[str, Any]:
    _check_quota(request, "upload")
    _check_upload_limit(request)
    topic = payload.topic.strip()
    if not topic:
        raise HTTPException(status_code=400, detail="Topic is required")

    text = ""
    if payload.use_wikipedia:
        summary = fetch_wikipedia_summary(topic, payload.language)
        if summary:
            text = f"{topic}\n\n{summary}"

    if not text:
        raise HTTPException(status_code=400, detail="No source text found. Try another topic or upload material.")

    user_id = _get_user_id(request)
    agent_id = create_agent(name=topic, agent_type="topic", source="wikipedia", meta={"language": payload.language}, user_id=user_id)
    background_tasks.add_task(_run_index, agent_id, text)
    _track_usage(request, "upload")
    return {"id": agent_id, "status": "indexing"}


# ─── Book-specific chat (skill-based) ───

@app.post("/api/agents/{agent_id}/chat")
def api_chat(agent_id: str, payload: ChatRequest, request: Request, background_tasks: BackgroundTasks) -> dict[str, Any]:
    _check_quota(request, "chat")
    agent = get_agent(agent_id)
    if not agent:
        raise HTTPException(status_code=404, detail="Agent not found")
    if agent["status"] in ("error",):
        raise HTTPException(status_code=409, detail=f"Agent status is {agent['status']}")

    # Trigger background learning for catalog agents
    if agent["status"] == "catalog":
        background_tasks.add_task(_learn_agent, agent_id)

    # Resolve skills
    skill_result = resolve_skills(agent, payload.message, top_k=payload.top_k)

    # Build prompt
    meta = agent.get("meta") or {}
    title = meta.get("title") or agent["name"]
    author = meta.get("author") or ""
    book_hint = f'the book "{title}"' + (f" by {author}" if author else "")

    system = (
        "You are Feynman, a Socratic study assistant inspired by the Feynman learning method. "
        f"You are helping the user study {book_hint}. "
        "Answer using the provided context passages. Each passage has a unique number: [Passage 1], [Passage 2], [Passage 3], etc. "
        "IMPORTANT: Even though all passages are from the same book, they are DIFFERENT text segments with DIFFERENT numbers. "
        "Cite the specific passage number you used, e.g. [1], [2], [3]. Never cite all as [1] — each passage must keep its own number. "
        "If the context is insufficient, supplement with your own knowledge (no citation needed). "
        "Encourage deeper thinking by occasionally suggesting follow-up questions. "
        "Respond in the same language as the user's question."
    )

    if skill_result.context:
        user_prompt = f"Context:\n{skill_result.context}\n\nQuestion:\n{payload.message}"
    else:
        user_prompt = payload.message

    uid = _get_user_id(request)
    history = [{"role": msg["role"], "content": msg["content"]} for msg in list_messages(agent_id, limit=6, user_id=uid)]

    try:
        result, chat_provider = chat_with_fallback(
            system=system, user=user_prompt, history=history,
            use_grounding=skill_result.use_grounding,
        )
    except ProviderError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    add_message(agent_id, "user", payload.message, user_id=uid)
    add_message(agent_id, "assistant", result.content, user_id=uid)

    # Process LLM recommendations in background
    background_tasks.add_task(_process_recommendations, result.content)

    # Build references only for chunks actually cited in the response
    answer_text = _normalize_citations(result.content)
    cited_nums = _extract_cited_numbers(answer_text)
    chunks = skill_result.metadata.get("chunks", [])
    references = []
    for idx, chunk in enumerate(chunks, start=1):
        if idx not in cited_nums:
            continue
        text = chunk.get("text", "")
        references.append({
            "index": idx,
            "book": agent.get("name", "Unknown"),
            "snippet": _clean_snippet(text),
            "full_text": text.strip(),
        })

    resp: dict[str, Any] = {
        "answer": answer_text,
        "skill_used": skill_result.skill_name,
        "references": references,
        "provider": chat_provider.name,
        "usage": _usage_dict(result),
    }
    if result.grounding:
        resp["web_sources"] = result.grounding
        resp["grounded"] = True
    else:
        resp["grounded"] = False
    _track_usage(request, "chat", resp["usage"].get("total_tokens", 0))
    return resp


# ─── Global cross-book chat (skill-based) ───

@app.post("/api/chat")
def api_global_chat(payload: GlobalChatRequest, request: Request, background_tasks: BackgroundTasks) -> dict[str, Any]:
    _check_quota(request, "chat")
    # Gather target agents
    target_agents: list[dict[str, Any]] = []

    if payload.agent_ids:
        for aid in payload.agent_ids:
            a = get_agent(aid)
            if a:
                target_agents.append(a)

    # Also resolve from book_context titles (for catalog books without agent_ids in payload)
    if payload.book_context:
        known_ids = {a["id"] for a in target_agents}
        for bc in payload.book_context:
            agent = find_agent_by_name(bc.title)
            if agent and agent["id"] not in known_ids:
                target_agents.append(agent)
                known_ids.add(agent["id"])
            elif not agent:
                # Chat-driven creation: auto-create agent for unknown book
                new_id = create_catalog_agent(title=bc.title, author=bc.author)
                new_agent = get_agent(new_id)
                if new_agent:
                    target_agents.append(new_agent)
                    known_ids.add(new_id)

    # Trigger learning for catalog agents
    for a in target_agents:
        if a["status"] == "catalog":
            background_tasks.add_task(_learn_agent, a["id"])

    # Build book focus string
    book_focus = ""
    if payload.book_context:
        titles = [f'"{b.title}" by {b.author}' if b.author else f'"{b.title}"' for b in payload.book_context]
        book_focus = "The user is studying: " + ", ".join(titles) + ". "

    # Run skill resolution and RAG retrieval concurrently
    use_grounding = False
    supplementary_context = ""
    _RAG_RELEVANCE_THRESHOLD = 0.65
    ready_ids = [a["id"] for a in target_agents if a["status"] == "ready"]
    rag_context = ""
    rag_chunks: list[dict[str, Any]] = []

    skill_results: list | None = None
    rag_result_holder: list[dict[str, Any]] = []

    def _run_skills():
        nonlocal skill_results
        if target_agents:
            skill_results = resolve_multi_agent(target_agents, payload.message, top_k=payload.top_k)

    def _run_rag():
        nonlocal rag_result_holder
        try:
            if ready_ids:
                rag_result_holder = retrieve_cross_book(payload.message, payload.top_k, agent_ids=ready_ids)
            elif not target_agents:
                rag_result_holder = retrieve_cross_book(payload.message, payload.top_k)
                if rag_result_holder and rag_result_holder[0]["score"] < _RAG_RELEVANCE_THRESHOLD:
                    log.info("RAG top score %.3f below threshold — ignoring library results", rag_result_holder[0]["score"])
                    rag_result_holder.clear()
        except ProviderError:
            pass

    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = [pool.submit(_run_skills), pool.submit(_run_rag)]
        for f in futures:
            f.result()

    if skill_results and target_agents:
        context_parts = []
        for agent, sr in zip(target_agents, skill_results):
            if sr.use_grounding:
                use_grounding = True
            if sr.context:
                clean = re.sub(r"\[\d+\]\s*(?:\(from\s+\"[^\"]*\"\)\s*)?", "", sr.context)
                context_parts.append(f"--- {agent['name']} ---\n{clean}")
        supplementary_context = "\n\n".join(context_parts)

    rag_chunks = rag_result_holder
    if rag_chunks:
        rag_context = build_context(rag_chunks)

    # Auto-discover: if no books selected and no relevant RAG results,
    # discover books in background and respond immediately with grounding
    if not target_agents and not rag_chunks:
        use_grounding = True
        background_tasks.add_task(_background_discover, payload.message[:80])

    # Merge contexts: RAG chunks are the numbered citation source; supplementary is background info
    if rag_context and supplementary_context:
        final_context = f"{rag_context}\n\nAdditional background:\n{supplementary_context}"
    elif rag_context:
        final_context = rag_context
    else:
        final_context = supplementary_context

    # Build system prompt and user message
    if final_context:
        system = (
            "You are Feynman, a Socratic study assistant that helps users learn through questioning. "
            f"{book_focus}"
            "Use the provided context passages to answer. Each passage has a unique number: [Passage 1], [Passage 2], [Passage 3], etc. "
            "IMPORTANT: Even when multiple passages come from the same book, they are DIFFERENT text segments with DIFFERENT numbers. "
            "Cite the specific passage number you used, e.g. [1], [2], [3]. Never cite all as [1] — each passage must keep its own number. "
            "If the context is insufficient, supplement with your own knowledge (no citation needed). "
            "Encourage deeper thinking by suggesting follow-up questions. "
            "Respond in the same language as the user's question."
        )
        user_prompt = f"Context from books:\n{final_context}\n\nQuestion:\n{payload.message}"
    elif book_focus and use_grounding:
        system = (
            "You are Feynman, a Socratic study assistant that helps users learn through questioning. "
            f"{book_focus}"
            "Use your deep knowledge of these books to answer the user's questions. "
            "Reference specific ideas, chapters, and arguments from the books. "
            "Encourage deeper thinking by suggesting follow-up questions. "
            "Respond in the same language as the user's question."
        )
        user_prompt = payload.message
    elif book_focus:
        system = (
            "You are Feynman, a Socratic study assistant that helps users learn through questioning. "
            f"{book_focus}"
            "Use your knowledge of these books to answer. "
            "Reference specific ideas and concepts from the books. "
            "Encourage deeper thinking by suggesting follow-up questions. "
            "Respond in the same language as the user's question."
        )
        user_prompt = payload.message
    else:
        system = (
            "You are Feynman, a Socratic study assistant that helps users learn through questioning. "
            "The user has not selected any books yet, so answer using your own knowledge. "
            "Be thorough and educational. Suggest relevant books the user might want to explore. "
            "Encourage deeper thinking by suggesting follow-up questions. "
            "Respond in the same language as the user's question."
        )
        user_prompt = payload.message

    try:
        conv_history = None
        if payload.history:
            conv_history = [{"role": m.role, "content": m.content} for m in payload.history]
        result, chat_provider = chat_with_fallback(
            system=system, user=user_prompt, history=conv_history, use_grounding=use_grounding,
        )
    except ProviderError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    # Process LLM recommendations in background
    background_tasks.add_task(_process_recommendations, result.content)

    # Deduplicate source agents from RAG chunks
    seen: set[str] = set()
    sources: list[dict[str, Any]] = []
    for chunk in rag_chunks:
        aid = chunk.get("agent_id")
        if aid and aid not in seen:
            seen.add(aid)
            sources.append({"agent_id": aid, "agent_name": chunk.get("agent_name", "Unknown")})

    # Build references only for chunks actually cited in the response
    answer_text = _normalize_citations(result.content)
    cited_nums = _extract_cited_numbers(answer_text)
    references = []
    for idx, chunk in enumerate(rag_chunks, start=1):
        if idx not in cited_nums:
            continue
        text = chunk.get("text", "")
        references.append({
            "index": idx,
            "book": chunk.get("agent_name", "Unknown"),
            "snippet": _clean_snippet(text),
            "full_text": text.strip(),
        })

    resp: dict[str, Any] = {
        "answer": answer_text,
        "sources": sources,
        "references": references,
        "provider": chat_provider.name,
        "usage": _usage_dict(result),
    }
    if result.grounding:
        resp["web_sources"] = result.grounding
        resp["grounded"] = True
    else:
        resp["grounded"] = False

    _track_usage(request, "chat", resp["usage"].get("total_tokens", 0))
    return resp


# ─── Questions endpoint ───

@app.get("/api/agents/{agent_id}/questions")
def api_get_questions(agent_id: str) -> dict[str, Any]:
    agent = get_agent(agent_id)
    if not agent:
        raise HTTPException(status_code=404, detail="Agent not found")
    questions = list_questions(agent_id)
    # Fallback to meta.questions if no dedicated records
    if not questions:
        questions = (agent.get("meta") or {}).get("questions", [])
    return {"questions": questions}


# ─── Messages endpoint ───

@app.get("/api/agents/{agent_id}/messages")
def api_get_messages(agent_id: str, request: Request) -> list[dict[str, Any]]:
    agent = get_agent(agent_id)
    if not agent:
        raise HTTPException(status_code=404, detail="Agent not found")
    return list_messages(agent_id, limit=50, user_id=_get_user_id(request))


# ─── Chat sessions endpoints ───

class CreateSessionRequest(BaseModel):
    title: str = "New chat"
    session_type: str = "chat"
    mind_id: str | None = None
    meta: dict[str, Any] | None = None


class UpdateSessionRequest(BaseModel):
    title: str | None = None
    meta: dict[str, Any] | None = None


class AddSessionMessageRequest(BaseModel):
    role: str = Field(..., min_length=1)
    content: str = ""
    meta: dict[str, Any] | None = None


@app.get("/api/sessions")
def api_list_sessions(request: Request) -> list[dict[str, Any]]:
    return list_chat_sessions(user_id=_get_user_id(request))


@app.post("/api/sessions")
def api_create_session(payload: CreateSessionRequest, request: Request) -> dict[str, Any]:
    return create_chat_session(
        title=payload.title, session_type=payload.session_type,
        mind_id=payload.mind_id, meta=payload.meta,
        user_id=_get_user_id(request),
    )


@app.get("/api/sessions/{session_id}")
def api_get_session(session_id: str, request: Request) -> dict[str, Any]:
    session = get_chat_session(session_id, user_id=_get_user_id(request))
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    return session


@app.patch("/api/sessions/{session_id}")
def api_update_session(session_id: str, payload: UpdateSessionRequest, request: Request) -> dict[str, Any]:
    uid = _get_user_id(request)
    session = get_chat_session(session_id, user_id=uid)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    update_chat_session(session_id, title=payload.title, meta=payload.meta, user_id=uid)
    return get_chat_session(session_id, user_id=uid)


@app.delete("/api/sessions/{session_id}")
def api_delete_session(session_id: str, request: Request) -> dict[str, Any]:
    if not delete_chat_session(session_id, user_id=_get_user_id(request)):
        raise HTTPException(status_code=404, detail="Session not found")
    return {"status": "deleted"}


@app.get("/api/sessions/{session_id}/messages")
def api_list_session_messages(session_id: str, request: Request) -> list[dict[str, Any]]:
    uid = _get_user_id(request)
    session = get_chat_session(session_id, user_id=uid)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    return list_session_messages(session_id, user_id=uid)


@app.post("/api/sessions/{session_id}/messages")
def api_add_session_message(session_id: str, payload: AddSessionMessageRequest, request: Request) -> dict[str, Any]:
    uid = _get_user_id(request)
    session = get_chat_session(session_id, user_id=uid)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    return add_session_message(session_id, role=payload.role, content=payload.content, meta=payload.meta, user_id=uid)


# ─── User interest profile (for future user matching) ───

@app.get("/api/users/{user_id}/interests")
def api_user_interests(user_id: str, request: Request) -> list[dict[str, Any]]:
    req_user = getattr(request.state, "user_id", None)
    if req_user and req_user != user_id:
        raise HTTPException(status_code=403, detail="Cannot view another user's profile")
    return list_user_interest_profile(user_id)


# ─── Vote endpoints (with auto-creation threshold) ───

@app.get("/api/votes")
def api_list_votes() -> list[dict[str, Any]]:
    return list_votes()


@app.post("/api/votes")
def api_create_vote(payload: VoteRequest, background_tasks: BackgroundTasks) -> dict[str, Any]:
    result = create_vote(payload.title.strip())
    # If vote count reaches threshold, auto-create a catalog agent and learn it
    if result["count"] >= VOTE_THRESHOLD:
        existing = find_agent_by_name(payload.title.strip())
        if not existing:
            agent_id = create_catalog_agent(title=payload.title.strip())
            background_tasks.add_task(_learn_agent, agent_id)
        elif existing["status"] == "catalog":
            background_tasks.add_task(_learn_agent, existing["id"])
    return result


@app.post("/api/votes/{vote_id}/upvote")
def api_upvote(vote_id: str, background_tasks: BackgroundTasks) -> dict[str, Any]:
    result = upvote(vote_id)
    if not result:
        raise HTTPException(status_code=404, detail="Vote not found")
    # Check threshold
    if result["count"] >= VOTE_THRESHOLD:
        existing = find_agent_by_name(result["title"])
        if not existing:
            agent_id = create_catalog_agent(title=result["title"])
            background_tasks.add_task(_learn_agent, agent_id)
        elif existing["status"] == "catalog":
            background_tasks.add_task(_learn_agent, existing["id"])
    return result


# ─── AI Book Writing endpoints ───

class AIBookStartRequest(BaseModel):
    description: str = Field(..., min_length=10)
    language: str = "en"
    preferences: dict[str, Any] = Field(default_factory=dict)


class AIBookChatRequest(BaseModel):
    message: str = Field(..., min_length=1)
    history: list[HistoryMessage] | None = None


@app.post("/api/ai-books/start")
def api_ai_book_start(payload: AIBookStartRequest, request: Request) -> dict[str, Any]:
    """Start a new AI book project: generate outline from description."""
    _check_ai_book_quota(request)
    user_id = _get_user_id(request) or "anon"

    try:
        outline, ai_message, usage = generate_outline(
            payload.description, payload.preferences, payload.language,
        )
    except ProviderError as exc:
        raise HTTPException(status_code=503, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Outline generation failed: {exc}")

    title = outline.get("title", "Untitled Book")
    prefs = {**payload.preferences, "language": payload.language}

    creator_name = _resolve_creator_name(user_id)

    meta = {
        "title": title,
        "author": "AI",
        "is_ai_generated": True,
        "creator_name": creator_name or "User",
        "creator_user_id": user_id,
        "description": outline.get("subtitle", ""),
    }

    try:
        agent_id = create_agent(
            name=title, agent_type="ai_book", source="ai_writer",
            meta=meta, user_id=user_id,
        )
        update_agent_status(agent_id, "outlining", meta)

        book_id = create_ai_book(
            agent_id=agent_id, user_id=user_id, title=title,
            description=payload.description, outline=outline, preferences=prefs,
        )
    except Exception as exc:
        log.error("Failed to persist AI book: %s", exc)
        raise HTTPException(status_code=500, detail=f"Failed to save book: {exc}")

    _track_usage(request, "ai_book", usage.get("total_tokens", 0))
    return {
        "id": book_id,
        "agent_id": agent_id,
        "title": title,
        "outline": outline,
        "ai_message": ai_message,
        "usage": usage,
    }


@app.post("/api/ai-books/{book_id}/chat")
def api_ai_book_chat(book_id: str, payload: AIBookChatRequest, request: Request) -> dict[str, Any]:
    """Refine the book outline through conversation."""
    _check_quota(request, "chat")
    user_id = _get_user_id(request) or "anon"

    book = get_ai_book(book_id)
    if not book:
        raise HTTPException(status_code=404, detail="AI book not found")
    if book["user_id"] != user_id:
        raise HTTPException(status_code=403, detail="Access denied")
    if book["status"] not in ("outlining",):
        raise HTTPException(status_code=409, detail=f"Book is in '{book['status']}' state, cannot edit outline")

    history = None
    if payload.history:
        history = [{"role": m.role, "content": m.content} for m in payload.history]

    try:
        updated_outline, response_text, usage = refine_outline(
            book["outline"], payload.message, history=history,
        )
    except ProviderError as exc:
        raise HTTPException(status_code=503, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Refinement failed: {exc}")

    update_ai_book_outline(book_id, updated_outline)
    # Sync title to agent
    update_agent_meta(book["agent_id"], {"title": updated_outline.get("title", book["title"])})

    _track_usage(request, "ai_book", usage.get("total_tokens", 0))
    return {
        "outline": updated_outline,
        "response": response_text,
        "usage": usage,
    }


@app.post("/api/ai-books/{book_id}/confirm")
def api_ai_book_confirm(book_id: str, request: Request, background_tasks: BackgroundTasks) -> dict[str, Any]:
    """Confirm the outline and start writing chapters in background."""
    user_id = _get_user_id(request) or "anon"

    book = get_ai_book(book_id)
    if not book:
        raise HTTPException(status_code=404, detail="AI book not found")
    if book["user_id"] != user_id:
        raise HTTPException(status_code=403, detail="Access denied")
    if book["status"] not in ("outlining",):
        raise HTTPException(status_code=409, detail=f"Book is in '{book['status']}' state")

    update_ai_book_status(book_id, "confirmed")
    creator_name = book.get("preferences", {}).get("creator_name", "")
    if not creator_name or creator_name == "User":
        creator_name = _resolve_creator_name(user_id)
    update_agent_status(book["agent_id"], "writing", {
        "title": book["title"],
        "is_ai_generated": True,
        "creator_name": creator_name or "User",
        "creator_user_id": user_id,
    })

    background_tasks.add_task(write_full_book, book_id)

    return {"status": "writing", "chapters_total": book["chapters_total"]}


@app.post("/api/ai-books/{book_id}/cancel")
def api_ai_book_cancel(book_id: str, request: Request) -> dict[str, Any]:
    """Cancel a book that is currently being written."""
    user_id = _get_user_id(request) or "anon"

    book = get_ai_book(book_id)
    if not book:
        raise HTTPException(status_code=404, detail="AI book not found")
    if book["user_id"] != user_id:
        raise HTTPException(status_code=403, detail="Access denied")
    if book["status"] not in ("writing", "confirmed"):
        raise HTTPException(status_code=409, detail=f"Book is in '{book['status']}' state, cannot cancel")

    update_ai_book_status(book_id, "cancelled")
    return {"status": "cancelled", "chapters_written": book.get("chapters_written", 0)}


@app.post("/api/ai-books/{book_id}/retry")
def api_ai_book_retry(book_id: str, request: Request, background_tasks: BackgroundTasks) -> dict[str, Any]:
    """Retry writing a failed book — resumes from the first unwritten chapter."""
    user_id = _get_user_id(request) or "anon"

    book = get_ai_book(book_id)
    if not book:
        raise HTTPException(status_code=404, detail="AI book not found")
    if book["user_id"] != user_id:
        raise HTTPException(status_code=403, detail="Access denied")
    if book["status"] != "failed":
        raise HTTPException(status_code=409, detail=f"Book is in '{book['status']}' state, retry only works for failed books")

    background_tasks.add_task(write_full_book, book_id)

    return {"status": "writing", "chapters_total": book["chapters_total"], "chapters_written": book.get("chapters_written", 0)}


@app.get("/api/ai-books/{book_id}")
def api_ai_book_get(
    book_id: str,
    request: Request,
    background_tasks: BackgroundTasks,
) -> dict[str, Any]:
    """Get AI book details including writing progress."""
    user_id = _get_user_id(request) or "anon"
    book = get_ai_book(book_id)
    if not book:
        raise HTTPException(status_code=404, detail="AI book not found")
    if book["user_id"] != user_id:
        raise HTTPException(status_code=403, detail="Access denied")

    # If every chapter is on disk but status never flipped (crash/hang before indexing),
    # re-run the writer — it skips written chapters and completes indexing.
    if book["status"] == "writing" and all_outline_chapters_have_content(book):
        background_tasks.add_task(write_full_book, book_id)
    elif book["status"] == "writing" and book.get("updated_at"):
        from datetime import datetime, timezone

        try:
            updated = datetime.fromisoformat(book["updated_at"].replace("Z", "+00:00"))
            if updated.tzinfo is None:
                updated = updated.replace(tzinfo=timezone.utc)
            age = (datetime.now(timezone.utc) - updated).total_seconds()
            if age > _STALE_WRITING_SECONDS:
                log.warning("Book %s stuck in writing for %ds — marking failed", book_id, int(age))
                update_ai_book_status(book_id, "failed")
                book["status"] = "failed"
        except Exception:
            pass

    # Enrich with creator_name from agent meta for frontend share features
    agent = get_agent(book.get("agent_id", ""))
    if agent:
        meta = agent.get("meta") or {}
        creator = meta.get("creator_name", "")
        if not creator or creator == "User":
            creator = _resolve_creator_name(meta.get("creator_user_id") or agent.get("user_id") or "")
        book["creator_name"] = creator or ""

    return book


@app.get("/api/ai-books/{book_id}/status")
def api_ai_book_status(book_id: str, request: Request) -> dict[str, Any]:
    """Lightweight status endpoint for polling — no content_json."""
    user_id = _get_user_id(request) or "anon"
    book = get_ai_book_status(book_id)
    if not book:
        raise HTTPException(status_code=404, detail="AI book not found")
    if book["user_id"] != user_id:
        raise HTTPException(status_code=403, detail="Access denied")
    return book


@app.get("/api/ai-books")
def api_ai_books_list(request: Request) -> list[dict[str, Any]]:
    """List the current user's AI book projects."""
    user_id = _get_user_id(request) or "anon"
    return list_ai_books(user_id)


# ─── Book Reader endpoint ───

@app.get("/api/agents/{agent_id}/read")
def api_read_book(agent_id: str, _agent: dict | None = None) -> dict[str, Any]:
    """Return book content for the reader. AI books return chapters; regular books return reassembled chunks."""
    agent = _agent or get_agent(agent_id)
    if not agent:
        raise HTTPException(status_code=404, detail="Book not found")

    title = agent.get("name", "Untitled")
    author = agent.get("source", "")
    meta = agent.get("meta") or {}

    # AI-written book: return structured chapters
    ai_book = get_ai_book_by_agent(agent_id)
    if ai_book and ai_book.get("content"):
        outline = ai_book.get("outline") or {}
        chapters_outline = outline.get("chapters", [])
        content = ai_book["content"]
        chapters = []
        for ch in chapters_outline:
            ch_data = content.get(str(ch["number"]), {})
            if ch_data.get("content"):
                chapters.append({
                    "number": ch["number"],
                    "title": ch["title"],
                    "content": ch_data["content"],
                    "word_count": ch_data.get("word_count", len(ch_data["content"].split())),
                })
        creator = meta.get("creator_name", "") or ai_book.get("preferences", {}).get("creator_name", "")
        if not creator or creator == "User":
            creator = _resolve_creator_name(ai_book.get("user_id", ""))
        if creator in ("anon", ""):
            creator = ""
        author_display = f"{creator} · AI" if creator else "AI"
        return {
            "type": "ai_book",
            "content_tier": "full",
            "title": meta.get("title") or title,
            "subtitle": outline.get("subtitle", ""),
            "author": author_display,
            "chapters": chapters,
            "total_words": sum(c["word_count"] for c in chapters),
        }

    # Regular book: reassemble chunks into readable text (text-only, no vectors)
    chunks = get_chunks_text_only(agent_id)
    if not chunks:
        raise HTTPException(status_code=404, detail="No content available")

    full_text = _reassemble_chunks([c["text"] for c in chunks])
    paragraphs = [p.strip() for p in full_text.split("\n") if p.strip()]
    content_tier = "full" if len(chunks) >= 10 else "preview"

    return {
        "type": "book",
        "content_tier": content_tier,
        "title": meta.get("title") or title,
        "subtitle": meta.get("description", ""),
        "author": meta.get("author") or author,
        "paragraphs": paragraphs,
        "total_words": len(full_text.split()),
    }


def _reassemble_chunks(chunks: list[str], overlap: int = 120) -> str:
    """Reassemble overlapping text chunks into continuous text."""
    if not chunks:
        return ""
    parts = [chunks[0]]
    for chunk in chunks[1:]:
        prev = parts[-1]
        # Find the overlap region
        best = 0
        check_len = min(overlap * 2, len(prev), len(chunk))
        for size in range(check_len, 10, -1):
            if prev.endswith(chunk[:size]):
                best = size
                break
        parts.append(chunk[best:])
    return "".join(parts)


# ─── Great Minds endpoints ───

class MindGenerateRequest(BaseModel):
    name: str = Field(..., min_length=1)
    era: str = ""
    domain: str = ""
    link_works: bool = True


class MindFromContentRequest(BaseModel):
    name: str = Field(..., min_length=1)
    source_url: str = ""
    content: str = ""


class MindSuggestRequest(BaseModel):
    book_title: str = ""
    book_author: str = ""
    topic: str = ""
    exclude: list[str] = Field(default_factory=list)
    count: int = Field(default=3, ge=1, le=6)


class MindChatRequest(BaseModel):
    message: str = Field(..., min_length=1)
    agent_ids: list[str] | None = None
    book_context: list[BookContext] | None = None
    history: list[HistoryMessage] | None = None


class PanelChatRequest(BaseModel):
    message: str = Field(..., min_length=1)
    mind_ids: list[str] = Field(..., min_items=1)
    target_minds: list[str] | None = None
    invited_mind_ids: list[str] | None = None
    agent_ids: list[str] | None = None
    book_context: list[BookContext] | None = None
    history: list[HistoryMessage] | None = None


_LAZY_SEED_SIZE = int(os.getenv("LAZY_SEED_SIZE", "1"))


_embed_backfill_done = False

@app.get("/api/minds")
def api_list_minds(background_tasks: BackgroundTasks):
    from fastapi.responses import JSONResponse
    global _embed_backfill_done
    minds = list_minds()
    # Lazy seeding: seed 1 mind per request to stay within Vercel's 10s timeout
    if _IS_SERVERLESS and len(minds) < len(SEED_MINDS):
        seeded = _seed_minds_batch(_LAZY_SEED_SIZE)
        if seeded:
            minds = list_minds()
    # Lazy embedding backfill: only schedule if there's actual work
    if not _embed_backfill_done:
        _embed_backfill_done = True
        from .core.db import list_minds_missing_embeddings
        if list_minds_missing_embeddings():
            from .core.minds import backfill_mind_embeddings
            background_tasks.add_task(backfill_mind_embeddings)
    for m in minds:
        m.pop("persona", None)
    return JSONResponse(
        content=minds,
        headers={"Cache-Control": "public, max-age=60, s-maxage=300"},
    )


_similarities_cache: dict[str, Any] = {}
_similarities_cache_ts: float = 0
_SIMILARITIES_TTL = 3600  # 1 hour

@app.get("/api/minds/similarities")
def api_mind_similarities():
    from fastapi.responses import JSONResponse
    from .core.minds import compute_mind_similarities, compute_mind_layout
    global _similarities_cache, _similarities_cache_ts
    now = time.monotonic()
    if _similarities_cache and (now - _similarities_cache_ts) < _SIMILARITIES_TTL:
        return JSONResponse(
            content=_similarities_cache,
            headers={"Cache-Control": "public, max-age=3600, s-maxage=3600"},
        )
    result = {"links": compute_mind_similarities(), "layout": compute_mind_layout()}
    _similarities_cache = result
    _similarities_cache_ts = now
    return JSONResponse(
        content=result,
        headers={"Cache-Control": "public, max-age=3600, s-maxage=3600"},
    )


@app.get("/api/minds/{mind_id}")
def api_get_mind(mind_id: str) -> dict[str, Any]:
    mind = get_mind(mind_id)
    if not mind:
        raise HTTPException(status_code=404, detail="Mind not found")
    mind.pop("persona", None)
    return mind


@app.post("/api/minds/generate")
def api_generate_mind(payload: MindGenerateRequest, request: Request, background_tasks: BackgroundTasks) -> dict[str, Any]:
    _check_quota(request, "generate_mind")
    try:
        mind = get_or_create_mind(payload.name.strip(), era=payload.era, domain=payload.domain, link_works=payload.link_works)
    except ProviderError as exc:
        raise HTTPException(status_code=503, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Mind generation failed: {exc}")
    if payload.link_works:
        from .core.db import get_mind_work_ids
        for agent_id in get_mind_work_ids(mind["id"]):
            agent = get_agent(agent_id)
            if agent and agent["status"] == "catalog":
                background_tasks.add_task(_learn_agent, agent_id)
    safe = {k: v for k, v in mind.items() if k != "persona"}
    _track_usage(request, "generate_mind")
    return safe


@app.post("/api/minds/create-from-content")
def api_create_mind_from_content(
    payload: MindFromContentRequest, request: Request, background_tasks: BackgroundTasks
) -> dict[str, Any]:
    _check_quota(request, "custom_minds")
    if not payload.source_url and not payload.content:
        raise HTTPException(status_code=400, detail="Provide source_url or content")
    try:
        mind = create_mind_from_content(
            name=payload.name.strip(),
            source_url=payload.source_url.strip(),
            content=payload.content,
        )
    except ProviderError as exc:
        raise HTTPException(status_code=503, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Mind creation failed: {exc}")
    from .core.db import get_mind_work_ids
    for agent_id in get_mind_work_ids(mind["id"]):
        agent = get_agent(agent_id)
        if agent and agent["status"] == "catalog":
            background_tasks.add_task(_learn_agent, agent_id)
    safe = {k: v for k, v in mind.items() if k != "persona"}
    _track_usage(request, "custom_minds")
    return safe


@app.post("/api/minds/suggest")
def api_suggest_minds(payload: MindSuggestRequest, request: Request) -> dict[str, Any]:
    _check_quota(request, "generate_mind")
    try:
        if payload.book_title:
            suggestions, usage = suggest_minds_for_book(
                payload.book_title, payload.book_author,
                count=payload.count,
            )
        elif payload.topic:
            suggestions, usage = suggest_minds_for_topic(
                payload.topic, count=payload.count,
            )
        else:
            raise HTTPException(status_code=400, detail="Provide book_title or topic")
    except ProviderError as exc:
        raise HTTPException(status_code=503, detail=str(exc))
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Suggestion failed: {exc}")

    # Filter out excluded names
    if payload.exclude:
        excluded = {n.lower() for n in payload.exclude}
        suggestions = [s for s in suggestions if s.get("name", "").lower() not in excluded]

    _track_usage(request, "generate_mind")
    return {"minds": suggestions, "usage": usage}


@app.post("/api/minds/{mind_id}/chat")
def api_mind_chat(mind_id: str, payload: MindChatRequest, request: Request, background_tasks: BackgroundTasks) -> dict[str, Any]:
    _check_quota(request, "mind_chat")
    mind = get_mind(mind_id)
    if not mind:
        raise HTTPException(status_code=404, detail="Mind not found")

    book_ctx = ""
    agent_ids = payload.agent_ids or []
    if payload.book_context:
        titles = [f'"{b.title}" by {b.author}' if b.author else f'"{b.title}"' for b in payload.book_context]
        book_ctx = "Books being discussed: " + ", ".join(titles)
        for bc in payload.book_context:
            agent = find_agent_by_name(bc.title)
            if agent and agent["id"] not in agent_ids:
                agent_ids.append(agent["id"])

    history = None
    if payload.history:
        history = [{"role": m.role, "content": m.content} for m in payload.history]

    uid = _get_user_id(request)
    try:
        result = mind_chat(
            mind, payload.message,
            book_context=book_ctx,
            agent_ids=agent_ids if agent_ids else None,
            history=history,
            user_id=uid,
        )
    except ProviderError as exc:
        raise HTTPException(status_code=503, detail=str(exc))

    background_tasks.add_task(
        extract_and_save_memory, mind["id"], payload.message, result["response"],
        user_id=uid,
    )

    _track_usage(request, "mind_chat")
    return result


@app.post("/api/minds/{mind_id}/greet")
def api_mind_greet(mind_id: str, request: Request) -> dict[str, Any]:
    """Generate a short in-character greeting from a mind agent."""
    mind = get_mind(mind_id)
    if not mind:
        raise HTTPException(status_code=404, detail="Mind not found")
    uid = _get_user_id(request)
    try:
        result = mind_chat(
            mind,
            "Please introduce yourself briefly. Greet the user warmly and invite them to discuss topics in your area of expertise. Keep it to 2-3 sentences.",
            user_id=uid,
            brief=True,
        )
    except ProviderError as exc:
        raise HTTPException(status_code=503, detail=str(exc))
    _track_usage(request, "mind_chat")
    return result


@app.post("/api/minds/panel-chat")
def api_panel_chat(payload: PanelChatRequest, request: Request, background_tasks: BackgroundTasks) -> dict[str, Any]:
    _check_quota(request, "mind_chat")
    minds = []
    for mid in payload.mind_ids:
        m = get_mind(mid)
        if m:
            minds.append(m)
    if not minds:
        raise HTTPException(status_code=400, detail="No valid minds found")

    # Filter to targeted minds if @mentions are used
    if payload.target_minds:
        targets = {n.lower() for n in payload.target_minds}
        targeted = [m for m in minds if m["name"].lower() in targets]
        if not targeted:
            raise HTTPException(status_code=400, detail="No matching target minds")
        minds = targeted
        # Ensure @mentioned minds get the user_invited prompt
        if not payload.invited_mind_ids:
            payload.invited_mind_ids = []
        for m in minds:
            if m["id"] not in payload.invited_mind_ids:
                payload.invited_mind_ids.append(m["id"])

    book_ctx = ""
    agent_ids = payload.agent_ids or []
    if payload.book_context:
        titles = [f'"{b.title}" by {b.author}' if b.author else f'"{b.title}"' for b in payload.book_context]
        book_ctx = "Books being discussed: " + ", ".join(titles)
        for bc in payload.book_context:
            agent = find_agent_by_name(bc.title)
            if agent and agent["id"] not in agent_ids:
                agent_ids.append(agent["id"])

    history = None
    if payload.history:
        history = [{"role": m.role, "content": m.content} for m in payload.history]

    uid = _get_user_id(request)
    try:
        results = panel_chat(
            minds, payload.message,
            book_context=book_ctx,
            agent_ids=agent_ids if agent_ids else None,
            history=history,
            user_id=uid,
            invited_mind_ids=payload.invited_mind_ids,
            is_mention=bool(payload.target_minds),
        )
    except ProviderError as exc:
        raise HTTPException(status_code=503, detail=str(exc))

    # Save memories in background
    for r in results:
        if r.get("response") and not r["response"].startswith("["):
            background_tasks.add_task(
                extract_and_save_memory, r["mind_id"], payload.message, r["response"],
                user_id=uid,
            )

    total_usage = {"input_tokens": 0, "output_tokens": 0, "total_tokens": 0}
    for r in results:
        for k in total_usage:
            total_usage[k] += r.get("usage", {}).get(k, 0)

    _track_usage(request, "mind_chat", total_usage.get("total_tokens", 0))
    return {"responses": results, "total_usage": total_usage}
