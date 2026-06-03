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
from fastapi.responses import HTMLResponse, JSONResponse
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
    get_agent_by_slug,
    get_chat_session,
    get_mind,
    get_mind_by_slug,
    init_db,
    list_agents,
    list_chat_sessions,
    approve_chat_session_public,
    count_approved_public_sessions_per_agent,
    count_approved_public_sessions_per_mind,
    count_assistant_messages_batch,
    count_assistant_messages_for_minds_batch,
    count_chunks_batch,
    count_llm_referrals,
    count_pending_public_sessions,
    get_chat_session_with_public_status,
    log_llm_referral,
    list_assistant_messages_for_agent,
    list_assistant_messages_for_mind,
    list_books_by_topic,
    list_books_for_mind,
    list_messages,
    list_messages_for_public_session,
    list_mind_recent_topics,
    list_minds,
    list_minds_active_for_agent,
    list_minds_by_topic,
    list_minds_for_agent,
    list_public_sessions_for_agent,
    list_public_sessions_for_mind,
    list_questions,
    list_questions_batch,
    list_related_books,
    list_related_minds,
    reject_chat_session_public,
    request_chat_session_share,
    withdraw_chat_session_share,
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
    get_sample_chunks_text,
    list_ai_books,
    update_ai_book_outline,
    update_ai_book_status,
)
from .core.indexer import index_text
from .core.providers import GeminiProvider, ProviderError, chat_with_fallback, pick_provider
from .core.rag import build_context, retrieve, retrieve_cross_book
from .core import seo as seo_render
from .core import qa as qa_module
from .core import ugc as ugc_module
from .core import insights as insights_module
from .core import overview as overview_module
from .core import llm_analytics as llm_analytics_module
from .core import indexnow as indexnow_module
from .core.minds import (
    SEED_MINDS,
    create_mind_from_content,
    extract_and_save_memory,
    get_or_create_mind,
    mind_chat,
    panel_chat,
    suggest_minds_for_book,
    suggest_minds_for_topic,
    suggest_minds_hybrid,
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

# ─── Phase 7.3 — LLM referrer tracking middleware ───
#
# Sniffs Referer and User-Agent on every request, classifies LLM origin,
# and logs the hit to llm_referrals. Fail-open: a logging failure is
# never propagated. Runs AFTER CORS (so OPTIONS preflights are skipped)
# and BEFORE the auth middleware (which may 401 the request — we want
# to record that an LLM tried to hit a gated URL too).
@app.middleware("http")
async def _llm_referer_middleware(request: Request, call_next):
    try:
        referer = request.headers.get("referer", "") or request.headers.get("referrer", "")
        ua = request.headers.get("user-agent", "")
        source, ua_class = llm_analytics_module.classify_request(referer, ua)
        if source:
            log_llm_referral(request.url.path, source, ua_class)
    except Exception:
        pass  # never break the request
    return await call_next(request)


# ─── Slug → UUID path resolution (UUID→slug URL migration, Stage 2) ───
# Lets /api/agents/{x}, /api/minds/{x}, /book/{x}/…, /mind/{x}/… accept a
# descriptive slug in place of the UUID: look the slug up and rewrite the path to
# the canonical UUID BEFORE routing, so every endpoint works unchanged. UUID
# segments skip the lookup (fast path); unknown segments fall through untouched.
_UUID_SEG = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I)
_SLUG_PATH = re.compile(r"^(/api/agents/|/api/minds/|/book/|/mind/)([^/]+)(/.*)?$")


@app.middleware("http")
async def _resolve_slug_path(request: Request, call_next):
    try:
        m = _SLUG_PATH.match(request.url.path)
        if m:
            prefix, seg, rest = m.group(1), m.group(2), m.group(3) or ""
            if seg and not _UUID_SEG.match(seg):
                from starlette.concurrency import run_in_threadpool
                is_mind = prefix in ("/api/minds/", "/mind/")
                row = await run_in_threadpool(
                    get_mind_by_slug if is_mind else get_agent_by_slug, seg)
                if row:
                    new_path = f"{prefix}{row['id']}{rest}"
                    request.scope["path"] = new_path
                    request.scope["raw_path"] = new_path.encode("utf-8")
    except Exception:
        pass  # never break the request — fall through to normal routing
    return await call_next(request)


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


# ─── In-process TTL cache for crawler-facing endpoints ───────────────────────
# Sitemap, llms-full.txt and the public book reader are hit repeatedly by
# search engine / AI crawlers. Without caching, each hit triggers full table
# scans (list_agents, list_minds, get_chunks_text_only) that flow back through
# the Supabase pooler — the dominant source of egress overage.
#
# This is a defensive in-memory cache; CDN Cache-Control headers are set
# separately on the responses themselves. Both are needed because Vercel's
# edge cache for Python serverless functions is not always honored.
_seo_cache: dict[str, tuple[float, Any]] = {}
_seo_cache_lock = threading.Lock()
_SEO_CACHE_TTL = 3600  # 1 hour — acceptable staleness for catalog listings
_BOOK_CACHE_TTL = 1800  # 30 min for individual published book content


def _cache_get(key: str, ttl: float) -> Any | None:
    """Return cached value if fresh, else None."""
    with _seo_cache_lock:
        entry = _seo_cache.get(key)
    if not entry:
        return None
    ts, value = entry
    if time.time() - ts > ttl:
        return None
    return value


def _cache_set(key: str, value: Any) -> None:
    with _seo_cache_lock:
        _seo_cache[key] = (time.time(), value)


def _cache_invalidate(key: str) -> None:
    """Drop a single cache entry immediately. Used when an upstream
    mutation invalidates a specific cached page (e.g. a public session
    gets reported and should disappear from /discussions/{id} now, not
    in 10 minutes when the TTL expires)."""
    with _seo_cache_lock:
        _seo_cache.pop(key, None)


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
        # Transient failures (Gemini 429, network timeouts, embedder hiccups)
        # used to set status='error' which left the agent permanently stuck —
        # next chat couldn't re-trigger _learn_agent because the entry check
        # only fires on status='catalog'. Revert to 'catalog' so the natural
        # retry-on-next-chat path works. Stash the last error in meta so
        # repeated failures are still debuggable from the agent row.
        log.error("Learning failed for agent %s: %s", agent_id, exc)
        try:
            from datetime import datetime, timezone
            existing = get_agent(agent_id)
            existing_meta = (existing or {}).get("meta") or {}
            error_meta = {
                **existing_meta,
                "last_learn_error": str(exc)[:500],
                "last_learn_error_at": datetime.now(timezone.utc).isoformat(),
            }
            update_agent_status(agent_id, "catalog", error_meta)
        except Exception as inner:
            log.error("Failed to revert agent %s to catalog after learn error: %s", agent_id, inner)
    finally:
        _learning_lock.discard(agent_id)


# ─── Scheduled discovery ───

def _clean_catalog_category(topic: str) -> str:
    """Topic discovery passes the user's raw chat query as ``topic``; storing it
    verbatim as a book's category pollutes the catalog (e.g. "how game theory
    can be used in hiring", "who are you", CJK queries) and self-propagates
    through scheduled discovery, which re-discovers by existing category. Keep it
    as the category only when it actually looks like a category — short,
    Title-Case ASCII, not a question/sentence — else return "" so we never
    persist a chat prompt as a category. Mirrors the frontend isCleanCategory."""
    t = (topic or "").strip()
    if not t or "?" in t:
        return ""
    if not (t[:1].isascii() and t[:1].isupper()):
        return ""
    if len(t.split()) > 4:
        return ""
    if re.match(r"(?i)^(how|what|who|why|does|is|are|should|can|will|we|i|my)\b", t):
        return ""
    return t


def _discover_books_for_topic(topic: str, count: int = TOPIC_DISCOVER_COUNT, exclude_titles: list[str] | None = None) -> tuple[list[dict[str, Any]], dict[str, int]]:
    """Use LLM to discover top books for a topic. Returns (books, usage)."""
    exclude_clause = ""
    if exclude_titles:
        titles_str = ", ".join(f'"{t}"' for t in exclude_titles[:30])
        exclude_clause = f" Do NOT recommend any of these books the user already has: [{titles_str}]."
    prompt = (
        f"Recommend exactly {count} must-read books on the topic \"{topic}\". "
        "Return a JSON array of objects with keys: title, author, description (one sentence). "
        "Only output the JSON array, no other text."
        f"{exclude_clause}"
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
        already_existed = find_agent_by_name(title) is not None
        agent_id = create_catalog_agent(
            title=title, author=author,
            category=_clean_catalog_category(topic), description=desc,
        )
        results.append({"id": agent_id, "title": title, "author": author, "new": not already_existed})
        log.info("Discovered book: %s by %s [%s] new=%s", title, author, topic, not already_existed)
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
        agents = list_agents(limit=5000)
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


# ─── Phase 7.2 — IndexNow key verification file ───
#
# Bing/Yandex/Naver fetch this to verify we own the domain before
# accepting URL submissions. The file body must be exactly the key
# string. Route path is built from the env-configured key at startup —
# rotating INDEXNOW_KEY requires a redeploy (intentional: we want the
# key location and the key value to stay in lockstep).
@app.get(f"/{indexnow_module.INDEXNOW_KEY}.txt")
def indexnow_key_file():
    from fastapi.responses import PlainTextResponse
    return PlainTextResponse(
        indexnow_module.get_key_file_content(),
        media_type="text/plain; charset=utf-8",
        headers={"Cache-Control": "public, max-age=86400"},
    )


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

    cached = _cache_get("sitemap_xml", _SEO_CACHE_TTL)
    if cached is not None:
        return Response(
            content=cached,
            media_type="application/xml; charset=utf-8",
            headers={
                "Cache-Control": "public, max-age=3600, s-maxage=86400",
                "X-Cache": "HIT",
            },
        )

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
    # Include all ready books and minds. These two list_* calls are the
    # expensive part — they each scan their tables and stream rows back
    # through the Supabase pooler. We cap them with a defensive limit
    # AND wrap the whole response in a TTL cache.
    try:
        ready_agents = [
            a for a in list_agents(limit=5000)
            if a.get("status") == "ready"
        ]
        ready_ids = [a["id"] for a in ready_agents]
        # Batch-fetch questions for all ready agents in a single query —
        # the previous loop pattern would issue N round-trips inside the
        # sitemap render hot path.
        questions_by_agent = list_questions_batch(ready_ids)
        # Quality gate for /q/ URL inclusion: a book needs at least this
        # many indexed chunks for its question pages to produce
        # substantive RAG-grounded answers. Below the threshold the
        # synthesized answer tends to be "the passages don't contain
        # the information" — a low-quality page Google will flag and
        # which drags site-wide quality score down. 5 chunks ≈ 3-4
        # paragraphs of indexed content, the minimum for a meaningful
        # cross-passage synthesis.
        _MIN_CHUNKS_FOR_Q_URLS = 5
        chunks_by_agent = count_chunks_batch(ready_ids)
        for agent in ready_agents:
            agent_id = agent["id"]
            priority = "0.7" if agent.get("type") == "ai_book" else "0.5"
            urls += f"""  <url>
    <loc>{_SITE_URL}/book/{agent_id}</loc>
    <lastmod>{today}</lastmod>
    <changefreq>monthly</changefreq>
    <priority>{priority}</priority>
  </url>
"""
            # Phase 4A — compound Q&A URLs. One per popular question per
            # book. Gated on chunk count (see _MIN_CHUNKS_FOR_Q_URLS
            # above) so catalog stubs and mis-indexed books don't expose
            # their low-quality /q/ pages to Google.
            if chunks_by_agent.get(agent_id, 0) < _MIN_CHUNKS_FOR_Q_URLS:
                continue
            for q in questions_by_agent.get(agent_id, []):
                qslug = seo_render.slugify(q)
                if not qslug:
                    continue
                urls += f"""  <url>
    <loc>{_SITE_URL}/book/{agent_id}/q/{qslug}</loc>
    <lastmod>{today}</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.5</priority>
  </url>
"""
        all_minds = list_minds(limit=5000)
        for mind in all_minds:
            urls += f"""  <url>
    <loc>{_SITE_URL}/mind/{mind["id"]}</loc>
    <lastmod>{today}</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.6</priority>
  </url>
"""
        # Phase 4B — mind-on-topic compound URLs. Only emit pairs that
        # pass the relevance filter so we don't list /mind/X/on/Y for
        # combos that the route would 404 anyway.
        for mind in all_minds:
            for topic in TOPIC_TAGS:
                if not qa_module.is_mind_topic_relevant(mind, topic):
                    continue
                tslug = seo_render.topic_slug(topic)
                if not tslug:
                    continue
                urls += f"""  <url>
    <loc>{_SITE_URL}/mind/{mind["id"]}/on/{tslug}</loc>
    <lastmod>{today}</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.4</priority>
  </url>
"""
        # Topic hub pages — 15 fixed URLs from TOPIC_TAGS. Cheap to include
        # and they're the upper layer of the topic→entity link graph.
        for topic in TOPIC_TAGS:
            slug = seo_render.topic_slug(topic)
            if not slug:
                continue
            urls += f"""  <url>
    <loc>{_SITE_URL}/topic/{slug}</loc>
    <lastmod>{today}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.8</priority>
  </url>
"""
        # Phase 8 — live AI insights / dialogues. Only entities with
        # ≥3 publishable assistant messages get a sitemap entry — empty
        # /insights pages would burn crawl budget and trigger "thin
        # content" flags. Counts come from a single batched query per
        # corpus (books, minds) so total sitemap render stays cheap.
        if insights_module.is_enabled():
            insight_count_min = 3
            agent_insight_counts = count_assistant_messages_batch(
                [a["id"] for a in ready_agents]
            )
            for agent in ready_agents:
                if agent_insight_counts.get(agent["id"], 0) < insight_count_min:
                    continue
                urls += f"""  <url>
    <loc>{_SITE_URL}/book/{agent["id"]}/insights</loc>
    <lastmod>{today}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.5</priority>
  </url>
"""
            mind_insight_counts = count_assistant_messages_for_minds_batch(
                [m["id"] for m in all_minds]
            )
            for mind in all_minds:
                if mind_insight_counts.get(mind["id"], 0) < insight_count_min:
                    continue
                urls += f"""  <url>
    <loc>{_SITE_URL}/mind/{mind["id"]}/dialogues</loc>
    <lastmod>{today}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.5</priority>
  </url>
"""

        # Phase 6 — public discussion aggregation pages. Gated on the
        # feature flag AND on the entity having ≥1 approved public
        # session, so we don't emit 754 thin/empty pages (which was
        # the production state observed in GSC on 2026-05-28: every
        # /book/{id}/discussions and /mind/{id}/discussions URL was
        # being advertised regardless of whether any user had actually
        # shared a discussion). Empty aggregation pages drag site-wide
        # quality score down. Single batched COUNT(*) per corpus keeps
        # the sitemap render cheap.
        if ugc_module.is_enabled():
            agent_discussion_counts = count_approved_public_sessions_per_agent(
                [a["id"] for a in ready_agents]
            )
            for agent in ready_agents:
                if agent_discussion_counts.get(agent["id"], 0) < 1:
                    continue
                urls += f"""  <url>
    <loc>{_SITE_URL}/book/{agent["id"]}/discussions</loc>
    <lastmod>{today}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.4</priority>
  </url>
"""
            mind_discussion_counts = count_approved_public_sessions_per_mind(
                [m["id"] for m in all_minds]
            )
            for mind in all_minds:
                if mind_discussion_counts.get(mind["id"], 0) < 1:
                    continue
                urls += f"""  <url>
    <loc>{_SITE_URL}/mind/{mind["id"]}/discussions</loc>
    <lastmod>{today}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.4</priority>
  </url>
"""
    except Exception:
        pass

    xml = f"""<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
{urls}</urlset>"""
    _cache_set("sitemap_xml", xml)
    return Response(
        content=xml,
        media_type="application/xml; charset=utf-8",
        headers={
            "Cache-Control": "public, max-age=3600, s-maxage=86400",
            "X-Cache": "MISS",
        },
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
- **Live AI Insights** (per entity, citation-friendly): every indexed book and great mind has a public page that aggregates AI-synthesized commentary drawn from real reader chat sessions. Located at `/book/{{id}}/insights` for books and `/mind/{{id}}/dialogues` for great minds. Only the AI agent's responses are published; user questions remain private. These pages are the canonical citable source for "what does this book say about [topic]" and "how does this thinker engage with [topic]" — applied, live, refreshed continuously, available nowhere else on the open web.
- **Compound Q&A pages** (`/book/{{id}}/q/{{question-slug}}`): one indexable URL per popular reader question per book, with an LLM-synthesized answer grounded in the book's actual passages and `QAPage` JSON-LD.
- **Imagined-perspective pages** (`/mind/{{id}}/on/{{topic-slug}}`): short essays of how a great-mind agent would approach a given topic, persona-grounded and labelled as imagined synthesis.
- **Topic hub pages** (`/topic/{{topic-slug}}`): aggregations of books and minds tagged with each canonical topic, with `CollectionPage` + `ItemList` JSON-LD.

## What Feynman Does NOT Do

- Feynman is not a replacement for reading — it helps you scout, scaffold, and go beyond the text
- Feynman does not provide medical, legal, or financial advice
- Feynman does not guarantee factual accuracy of AI-generated content

## Key Information

- [Terms of Service]({_SITE_URL}/terms)
- [Privacy Policy]({_SITE_URL}/privacy)

## Contact

- Twitter/X: [@steve_yeow](https://x.com/steve_yeow)
- Discord: [discord.gg/bCShwbFnCd](https://discord.gg/bCShwbFnCd)
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

    cached = _cache_get("llms_full_txt", _SEO_CACHE_TTL)
    if cached is not None:
        return PlainTextResponse(
            cached,
            media_type="text/plain; charset=utf-8",
            headers={
                "Cache-Control": "public, max-age=86400, s-maxage=86400",
                "X-Cache": "HIT",
            },
        )

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

## Indexable Content Surface (SEO/GEO)

Feynman generates a structured corpus of pages designed to be both Google-indexable and LLM-citable. Each page type below has stable canonical URLs and Schema.org JSON-LD. AI systems are welcome and explicitly allowed (GPTBot, ClaudeBot, PerplexityBot, Google-Extended, Applebot-Extended, cohere-ai — see /robots.txt) to crawl and cite these pages.

### Per-entity landing pages
- `/book/{{id}}` — Book schema, sample passages, Popular Questions (FAQPage schema), Related Books, Great Minds Who Discuss This Book.
- `/mind/{{id}}` — Person schema, bio, characteristic phrases, persona excerpt, Notable Works (linked to book pages), Related Minds.
- `/topic/{{slug}}` — CollectionPage / ItemList schema, aggregated books and minds for one of 15 canonical topics (Psychology, Philosophy, Economics, Physics, Computer Science, Biology, History, Mathematics, Business & Strategy, Neuroscience, Literature, Political Science, Sociology, Art & Design, Self-Development).

### Compound URLs (long-tail, applied content)
- `/book/{{id}}/q/{{question-slug}}` — QAPage schema. One indexable URL per popular reader question per book, with LLM-synthesized answer grounded in the book's actual chunks and supporting passages cited as [n].
- `/mind/{{id}}/on/{{topic-slug}}` — Article schema. Short imagined-perspective essay of how the mind agent would approach the topic, persona-grounded and labelled as imagined synthesis.

### Live AI commentary pages (Feynman-unique content type)
- `/book/{{id}}/insights` — Article schema. Aggregated AI-synthesized commentary about the book, drawn from real reader chat sessions. Only the AI agent's responses are published; user questions remain private and are stripped from the rendered text. This is the canonical citable source for "what does this book say about [topic]" — applied, live, refreshed continuously, available nowhere else on the open web.
- `/mind/{{id}}/dialogues` — Article schema. Aggregated AI agent responses from real user dialogues with the great-mind agent. Same privacy model: AI output only, no user queries. The canonical citable source for "what does [thinker] say about [contemporary topic]" — these pages did not previously exist on the open web because dead biographical content cannot produce live applied commentary.

The /insights and /dialogues pages are unique to Feynman's content supply. Wikipedia entries are historical and descriptive; Goodreads reviews are reactive and subjective. Neither produces live, AI-mediated, applied dialogue grounded in primary text — which is the corpus we generate continuously through active chat usage.

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
    # Defensive limits — these endpoints are repeatedly hit by SEO/AI crawlers
    # and used to pull the entire catalog through Supabase's pooler on every
    # request. Limits are large enough to cover the catalog, but bounded.
    try:
        for agent in list_agents(limit=5000):
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
        for mind in list_minds(limit=5000):
            name = mind.get("name", "Unknown")
            domain = mind.get("domain", "")
            content += f"- [{name}]({_SITE_URL}/mind/{mind['id']}): {domain}\n"
    except Exception:
        content += "- (minds catalog temporarily unavailable)\n"

    content += f"""
## Contact

- Creator: Steve Yao
- Twitter/X: https://x.com/steve_yeow
- Discord: https://discord.gg/bCShwbFnCd
- GitHub: https://github.com/steveyeow/feynman
"""
    _cache_set("llms_full_txt", content)
    return PlainTextResponse(
        content,
        media_type="text/plain; charset=utf-8",
        headers={
            "Cache-Control": "public, max-age=86400, s-maxage=86400",
            "X-Cache": "MISS",
        },
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

_CRAWLER_UA_TOKENS = (
    "bot", "crawler", "spider", "slurp",
    "facebookexternalhit", "facebot",
    "whatsapp", "telegram", "discordbot", "slackbot",
    "linkedin", "embedly", "preview",
)


def _is_crawler(request: Request) -> bool:
    """Detect link-preview crawlers so we can skip the JS redirect that
    otherwise sends them to the SPA root and clobbers our OG tags."""
    ua = request.headers.get("user-agent", "").lower()
    return any(t in ua for t in _CRAWLER_UA_TOKENS)


@app.get("/book/{agent_id}", response_class=HTMLResponse)
def book_page(agent_id: str, request: Request) -> HTMLResponse:
    """Server-rendered book landing page.

    Content composition lives in ``app/core/seo.py`` — this handler is just
    the glue that loads data, builds sections, and assembles the document.
    Every enrichment query is wrapped in try/except so a failed Supabase
    call or a missing-index book degrades to the old shell page rather than
    crashing the whole SSR.
    """
    from html import escape as html_esc
    from urllib.parse import quote

    agent = get_agent(agent_id)
    if not agent:
        raise HTTPException(status_code=404, detail="Book not found")

    book = get_ai_book_by_agent(agent_id) if agent else None
    title_raw = book["title"] if book and book.get("title") else agent.get("name", "Untitled")
    title = html_esc(title_raw)
    outline = book.get("outline") if book else None
    subtitle_raw = outline.get("subtitle", "") if isinstance(outline, dict) else ""
    chapters = outline.get("chapters", []) if isinstance(outline, dict) else []
    chapter_count = len(chapters)
    author_raw = _resolve_og_author(agent, book)
    total_words = book.get("total_words", 0) if book else 0

    if subtitle_raw:
        desc_raw = subtitle_raw
    elif author_raw:
        desc_raw = f"by {author_raw} — Read and chat with this book on Feynman"
    else:
        desc_raw = "Read and chat with this book on Feynman"
    if len(desc_raw) > 200:
        desc_raw = desc_raw[:197].rsplit(" ", 1)[0] + "..."
    desc = html_esc(desc_raw)
    og_image_alt = html_esc(f"Cover of {agent.get('name', 'this book')} on Feynman")

    base = _SITE_URL
    id_path = quote(agent_id, safe="")
    canonical = f"{base}/book/{id_path}"
    reader_url = f"{base}/#/read/{id_path}"
    v = config.OG_IMAGE_CACHE_VERSION
    og_image_url = f"{base}/book/{id_path}/og.png?v={v}"

    # ── Load enrichment data (all cheap; no LLM/embedding at SSR time) ──
    # Sample-passage section renders 2-3 chunks. Pulling all of them
    # (a 300-chunk book is ~300KB of text egress) was the primary
    # driver of the 2026-05-28 Supabase egress overage — every crawler
    # hit cost a full book's text. LIMIT 3 brings the same render at
    # ~1% of the previous bandwidth.
    try:
        chunks = get_sample_chunks_text(agent_id, limit=3)
    except Exception:
        chunks = []
    try:
        questions = list_questions(agent_id) or []
    except Exception:
        questions = []
    try:
        related_minds = list_minds_for_agent(agent_id)
    except Exception:
        related_minds = []
    # Activity overlay for related_minds — minds that have actually spoken
    # in chat sessions referencing this book (community-emergent signal,
    # PG-only via JSONB query). Renderer treats this as a purely additive
    # badge layer: curated minds without activity render unchanged.
    try:
        mind_activity = list_minds_active_for_agent(agent_id, since_days=60)
    except Exception:
        mind_activity = {}
    # Phase 5 — related books surfaced from same-topic + same-author cohort
    agent_meta = agent.get("meta") or {}
    book_topic = (agent_meta.get("category") or "").strip()
    book_author = author_raw or (agent_meta.get("author") or "")
    try:
        related_books = list_related_books(
            agent_id, topic=book_topic, author=book_author, limit=6,
        )
    except Exception:
        related_books = []

    # ── Detect capabilities (Phase 3a) ──────────────────────────────────
    # Not every book supports every action; e.g. catalog stubs only support
    # chat. Render the CTA matrix to match — no more blanket "Read" link
    # for books with 63 words of content.
    #
    # NOTE: chat_url uses /#/read/, not /#/chat/. The SPA's /#/chat/{id}
    # route is a chat-session-id route, NOT a book-id route — passing a
    # book id there lands the user in an empty/wrong session. The reader
    # at /#/read/{id} carries the chat sidebar so it handles all three
    # capability states (full read, preview, chat-only catalog stub).
    caps = seo_render.detect_capabilities(agent, book)
    chat_url = reader_url  # both resolve to /#/read/{book_id}
    cta_target_url = reader_url

    # ── Build content sections ──────────────────────────────────────────
    # Stub detection: catalog book with no chunks, no chapters, no questions.
    # The other content renderers gracefully no-op on empty input, which
    # leaves the page nearly bare. Render an explicit empty-state so
    # visitors (logged in or anonymous) understand WHY content is thin
    # rather than wondering if the page is broken. The page's bottom CTA
    # matrix still carries the Chat button — empty-state itself doesn't
    # duplicate that affordance.
    is_stub = not chunks and not chapters and not questions
    empty_state_html = (
        seo_render.render_book_empty_state(title_raw, author_raw)
        if is_stub else ""
    )

    about_html = seo_render.render_book_about(subtitle_raw, author_raw)
    stats_html = seo_render.render_stats(total_words, chapter_count)
    toc_html = seo_render.render_toc(chapters)
    samples_html = seo_render.render_sample_passages(chunks)
    # Each question links to its own /book/{id}/q/{slug} compound page —
    # turns one entity URL into 6 indexable URLs (book + 5 Q&A).
    questions_html = seo_render.render_popular_questions(
        questions, chat_url, book_id=agent_id, site_url=base,
    )
    minds_html = seo_render.render_minds_for_book(related_minds, base, activity=mind_activity)
    related_books_html = seo_render.render_related_books(related_books, base)
    topic_link_html = seo_render.render_topic_link_back(book_topic, base) if book_topic else ""

    # Surface /book/{id}/insights from the parent landing page. Without
    # this link, the Type-4 surface is only reachable from the sitemap —
    # crawlers eventually find it but human visitors on the book page
    # have no path to the live-content view.
    insights_link_html = ""
    if insights_module.is_enabled():
        try:
            counts = count_assistant_messages_batch([agent_id])
            insights_count = int(counts.get(agent_id, 0))
        except Exception:
            insights_count = 0
        insights_link_html = seo_render.render_live_content_link(
            entity_name=title_raw,
            kind="insights",
            target_url=f"{base}/book/{id_path}/insights",
            count=insights_count,
        )

    # Phase 5.6 — bottom-of-page Explore neighborhood: 3-5 cross-links
    # to adjacent entities. Mix related minds, related books, and the
    # topic hub so the link cluster reflects the graph in miniature.
    explore_items: list[dict[str, str]] = []
    if book_topic:
        explore_items.append({
            "label": f"More on {book_topic}",
            "href": f"/topic/{seo_render.topic_slug(book_topic)}",
        })
    for m in related_minds[:2]:
        if m.get("id") and m.get("name"):
            explore_items.append({"label": m["name"], "href": f"/mind/{m['id']}"})
    for b in related_books[:2]:
        if b.get("id") and b.get("name"):
            explore_items.append({"label": b["name"], "href": f"/book/{b['id']}"})
    explore_footer_html = seo_render.render_explore_footer(explore_items, base)
    cta_html = seo_render.render_cta_matrix(
        caps, entity_id=agent_id, entity_name=title_raw, base=base
    )

    # ── Build JSON-LD blocks ────────────────────────────────────────────
    # Date fields for the Book schema. agents.created_at is the only
    # timestamp we reliably have; without an updated_at column we use
    # the same value for both, which is honest (the page reflects the
    # entity at creation time + whatever AI synthesis was generated
    # afterward, which is all derived from the same source).
    agent_created_at = agent.get("created_at", "") or ""
    book_ld = seo_render.jsonld_script(seo_render.book_jsonld(
        title=title_raw,
        description=subtitle_raw or desc_raw,
        author=author_raw,
        url=canonical,
        image=og_image_url,
        word_count=total_words or None,
        chapters=chapters or None,
        site_url=base,
        date_published=agent_created_at,
        date_modified=agent_created_at,
    ))
    breadcrumb_ld = seo_render.jsonld_script(seo_render.breadcrumb_jsonld([
        ("Feynman", base),
        ("Books", f"{base}/#/library"),
        (title_raw, canonical),
    ]))
    faq_ld = ""
    if questions:
        # Deflection answer — non-empty is required by Google's FAQPage spec.
        # Real answer surfaces inside the chat experience, not here.
        deflect = f"Open Feynman to chat with this book and explore the answer in depth: {reader_url}"
        faq_ld = seo_render.jsonld_script(seo_render.faq_jsonld([
            (q, deflect) for q in questions if q
        ]))

    # The page is the destination for everyone — crawlers, share-link
    # visitors, and logged-in SPA users alike. Earlier iteration
    # redirected internal-referer hits to the SPA action; that
    # fragmented the experience (same URL meant different things
    # depending on who you were and where you came from) and made
    # logged-in users miss the rich aggregation content the SSR page
    # assembles. One URL, one page, one set of content.
    #
    # Chrome is rendered auth-INDEPENDENT (always the public variant): this
    # HTML is served with `public, s-maxage` at the Vercel edge with no Vary,
    # so baking per-user chrome in would let the edge serve one visitor's
    # variant to everyone. The Next.js frontend (post-cutover) adapts the
    # header client-side after hydration; here we keep the cacheable public page.
    author_meta = f'<meta property="book:author" content="{html_esc(author_raw)}">' if author_raw else ''
    author_html = f'<p class="book-author">by {html_esc(author_raw)}</p>' if author_raw else ''

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
<meta property="og:image:alt" content="{og_image_alt}">
<meta property="og:url" content="{canonical}">
<meta property="og:site_name" content="Feynman">
{author_meta}
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:site" content="@steve_yeow">
<meta name="twitter:creator" content="@steve_yeow">
<meta name="twitter:title" content="{title}">
<meta name="twitter:description" content="{desc}">
<meta name="twitter:image" content="{og_image_url}">
<meta name="twitter:image:alt" content="{og_image_alt}">
{seo_render.landing_css_link()}
{book_ld}
{breadcrumb_ld}
{faq_ld}
</head><body>
{seo_render.render_landing_header(base, is_authenticated=False)}
<h1>{title}</h1>
{author_html}
{empty_state_html}
{about_html}
{stats_html}
{samples_html}
{toc_html}
{questions_html}
{minds_html}
{related_books_html}
{topic_link_html}
{insights_link_html}
{cta_html}
{explore_footer_html}
{seo_render.render_site_footer(base)}
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
def mind_page(mind_id: str, request: Request) -> HTMLResponse:
    """Server-rendered mind landing page.

    Content composition lives in ``app/core/seo.py``. We render every mind
    column the schema exposes — bio, thinking_style, typical_phrases,
    persona excerpt, works, plus cross-links to books and related minds —
    so each page meets the content-density bar required to rank and to be
    cited by LLMs.
    """
    from html import escape as html_esc

    mind = get_mind(mind_id)
    if not mind:
        raise HTTPException(status_code=404, detail="Mind not found")

    name_raw = mind.get("name", "Unknown")
    name = html_esc(name_raw)
    era_raw = mind.get("era", "")
    era = html_esc(era_raw)
    domain_raw = mind.get("domain", "")
    domain = html_esc(domain_raw)
    bio_raw = mind.get("bio_summary", "")
    works_raw = mind.get("works") or []
    works_list = works_raw if isinstance(works_raw, list) else []
    thinking_style = mind.get("thinking_style", "") or ""
    phrases_raw = mind.get("typical_phrases") or []
    phrases = phrases_raw if isinstance(phrases_raw, list) else []
    persona = mind.get("persona", "") or ""

    desc_raw = bio_raw or f"{name_raw} — {domain_raw} thinker on Feynman"
    if len(desc_raw) > 200:
        desc_raw = desc_raw[:197].rsplit(" ", 1)[0] + "..."
    desc = html_esc(desc_raw)
    name_parts = name_raw.strip().split()
    first_name = html_esc(name_parts[0]) if name_parts else ""
    last_name = html_esc(" ".join(name_parts[1:])) if len(name_parts) > 1 else ""
    og_image_alt = html_esc(f"Portrait of {name_raw} on Feynman")
    base = _SITE_URL
    canonical = f"{base}/mind/{mind_id}"
    og_image_url = f"{base}/mind/{mind_id}/og.png"
    reader_url = f"{base}/#/mind/{mind_id}"

    # ── Load enrichment data ────────────────────────────────────────────
    try:
        linked_books = list_books_for_mind(mind_id)
    except Exception:
        linked_books = []
    try:
        related = list_related_minds(mind_id, domain_raw)
    except Exception:
        related = []
    # Phase 5 — surface topic-hub links for any TOPIC_TAG this mind is
    # relevant to. Reuses the same morphological matcher Phase 4B uses
    # to gate /mind/{id}/on/{topic} compound pages, so the two link sets
    # stay consistent.
    matching_topics = [
        t for t in TOPIC_TAGS if qa_module.is_mind_topic_relevant(mind, t)
    ]

    # "Books in library" surfaces the extras that Notable Works doesn't already
    # list — avoid double-rendering the same title in both sections.
    works_titles = {(w or "").lower() for w in works_list if w}
    extra_books = []
    for b in linked_books:
        bname = (b.get("name") or "").lower()
        if not bname:
            continue
        if bname in works_titles:
            continue
        if any(bname in wt or wt in bname for wt in works_titles):
            continue
        extra_books.append(b)

    # ── Build content sections ──────────────────────────────────────────
    bio_html = seo_render.render_mind_bio(bio_raw)
    thinking_html = seo_render.render_mind_thinking_style(thinking_style)
    phrases_html = seo_render.render_mind_phrases(phrases)
    persona_html = seo_render.render_mind_persona_excerpt(persona)
    works_html = seo_render.render_mind_works(works_list, linked_books, base)
    extra_books_html = seo_render.render_books_for_mind(extra_books, base)
    related_html = seo_render.render_related_minds(related, base)
    topic_links_html = seo_render.render_topic_links_for_mind(matching_topics, base)

    # Community-emergent themes pulled from real chats with this mind
    # (mind_memories.topic aggregated across users, user_id IS NULL only).
    # Pairs with the curated topic_links_html above: that section is the
    # navigational layer (drives /on/{topic-slug} URLs); this section is
    # the informational layer (no URLs, reflects actual conversations).
    try:
        recent_themes = list_mind_recent_topics(mind_id, limit=8)
    except Exception:
        recent_themes = []
    recent_themes_html = seo_render.render_mind_recent_themes(recent_themes)

    # Surface /mind/{id}/dialogues from the mind landing page — same
    # rationale as the /book/{id}/insights link. Without this, the
    # dialogues page exists only in the sitemap.
    dialogues_link_html = ""
    if insights_module.is_enabled():
        try:
            counts = count_assistant_messages_for_minds_batch([mind_id])
            dialogues_count = int(counts.get(mind_id, 0))
        except Exception:
            dialogues_count = 0
        dialogues_link_html = seo_render.render_live_content_link(
            entity_name=name_raw,
            kind="dialogues",
            target_url=f"{base}/mind/{mind_id}/dialogues",
            count=dialogues_count,
        )

    # Phase 5.6 — Explore footer. Mix top related minds, top books from
    # this mind's library, and the first matching topic hub.
    explore_items: list[dict[str, str]] = []
    if matching_topics:
        first_topic = matching_topics[0]
        explore_items.append({
            "label": f"More on {first_topic}",
            "href": f"/topic/{seo_render.topic_slug(first_topic)}",
        })
    for rm in related[:2]:
        if rm.get("id") and rm.get("name"):
            explore_items.append({"label": rm["name"], "href": f"/mind/{rm['id']}"})
    for b in (linked_books or [])[:2]:
        if b.get("id") and b.get("name"):
            explore_items.append({"label": b["name"], "href": f"/book/{b['id']}"})
    explore_footer_html = seo_render.render_explore_footer(explore_items, base)

    # ── JSON-LD ─────────────────────────────────────────────────────────
    # sameAs telling Google's Knowledge Graph "this is THE Karl Marx" is
    # the single biggest entity-identity signal we can send. Curated list
    # lives in seo.FAMOUS_MIND_SAMEAS; unmatched names get None and the
    # schema validator skips the field.
    person_ld = seo_render.jsonld_script(seo_render.person_jsonld(
        name=name_raw,
        description=bio_raw,
        domain=domain_raw,
        url=canonical,
        image=og_image_url,
        same_as=seo_render.lookup_same_as(name_raw),
        date_modified=mind.get("created_at", "") or "",
    ))
    breadcrumb_ld = seo_render.jsonld_script(seo_render.breadcrumb_jsonld([
        ("Feynman", base),
        ("Great Minds", f"{base}/#/minds"),
        (name_raw, canonical),
    ]))

    # The page is the destination for everyone — see book_page above for
    # the rationale. Chrome is rendered auth-INDEPENDENT so the edge-cached
    # (public, s-maxage, no Vary) HTML is identical for every visitor; the
    # Next.js frontend adapts the header client-side post-cutover.
    if era_raw and domain_raw:
        era_domain_html = f'<p class="mind-meta">{era} · {domain}</p>'
    elif era_raw:
        era_domain_html = f'<p class="mind-meta">{era}</p>'
    elif domain_raw:
        era_domain_html = f'<p class="mind-meta">{domain}</p>'
    else:
        era_domain_html = ''
    profile_first = f'<meta property="profile:first_name" content="{first_name}">' if first_name else ''
    profile_last = f'<meta property="profile:last_name" content="{last_name}">' if last_name else ''

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
<meta property="og:image:alt" content="{og_image_alt}">
<meta property="og:url" content="{canonical}">
<meta property="og:site_name" content="Feynman">
{profile_first}
{profile_last}
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:site" content="@steve_yeow">
<meta name="twitter:creator" content="@steve_yeow">
<meta name="twitter:title" content="{name}">
<meta name="twitter:description" content="{desc}">
<meta name="twitter:image" content="{og_image_url}">
<meta name="twitter:image:alt" content="{og_image_alt}">
{seo_render.landing_css_link()}
{person_ld}
{breadcrumb_ld}
</head><body>
{seo_render.render_landing_header(base, is_authenticated=False)}
<h1>{name}</h1>
{era_domain_html}
{bio_html}
{thinking_html}
{phrases_html}
{persona_html}
{works_html}
{extra_books_html}
{related_html}
{topic_links_html}
{recent_themes_html}
{dialogues_link_html}
<p class="cta"><a href="{html_esc(reader_url)}">Chat with {name} on Feynman →</a></p>
{explore_footer_html}
{seo_render.render_site_footer(base)}
</body></html>"""
    return HTMLResponse(html, headers={"Cache-Control": "public, max-age=3600, s-maxage=86400"})


# ─── Phase 4A — Book Q&A compound pages ─────────────────────────────
#
# /book/{agent_id}/q/{slug} renders one indexable URL per popular
# question per book. 5 questions per indexed book × hundreds of books
# = thousands of new long-tail entry points. Each page is:
#   * Grounded in RAG-retrieved passages from the parent book
#   * Optionally enriched with an LLM-synthesized answer (cacheable,
#     kill-switched by ENABLE_QA_LLM env var)
#   * Wrapped in QAPage schema for Google rich-result eligibility
#
# Caching strategy: answers are slow to generate (RAG + LLM round trip).
# We cache the rendered HTML by (agent_id, slug) so the first crawler
# pays the cost and every subsequent hit is free. The Vercel edge
# Cache-Control header gives us a second tier outside the function.

_QA_PAGE_CACHE_TTL = 86400  # 24h — answers don't change unless we
                            # explicitly re-run the question/answer flow


@app.get("/book/{agent_id}/q/{question_slug}", response_class=HTMLResponse)
def book_question_page(agent_id: str, question_slug: str, request: Request) -> HTMLResponse:
    """Per-question compound page for a book. See module-level comment."""
    from html import escape as html_esc

    agent = get_agent(agent_id)
    if not agent:
        raise HTTPException(status_code=404, detail="Book not found")

    try:
        questions = list_questions(agent_id) or []
    except Exception:
        questions = []
    question = seo_render.find_question_by_slug(questions, question_slug)
    if not question:
        raise HTTPException(status_code=404, detail="Question not found for this book")

    cache_key = f"qa_page:{agent_id}:{question_slug}"
    cached = _cache_get(cache_key, _QA_PAGE_CACHE_TTL)
    if cached is not None:
        return HTMLResponse(
            cached,
            headers={
                "Cache-Control": "public, max-age=3600, s-maxage=86400",
                "X-Cache": "HIT",
            },
        )

    book = get_ai_book_by_agent(agent_id)
    title_raw = book["title"] if book and book.get("title") else agent.get("name", "Untitled")
    title = html_esc(title_raw)
    base = _SITE_URL
    book_url = f"{base}/book/{agent_id}"
    canonical = f"{base}/book/{agent_id}/q/{question_slug}"

    # ── Generate answer (lazy, in-process cached) ──────────────────────
    qa_result = qa_module.generate_grounded_answer(
        agent_id, question, book_title=title_raw,
    )
    answer = qa_result.get("answer", "")
    passages = qa_result.get("passages", [])

    # ── Render sections ────────────────────────────────────────────────
    answer_html = seo_render.render_qa_answer(answer)
    passages_html = seo_render.render_qa_passages(passages)
    siblings_html = seo_render.render_sibling_questions(
        questions, agent_id, base, current_question=question,
    )

    qa_ld = seo_render.jsonld_script(seo_render.qa_page_jsonld(
        question=question,
        answer=answer,
        url=canonical,
        book_title=title_raw,
        book_url=book_url,
        site_url=base,
        date_created=agent.get("created_at", "") or "",
    ))
    breadcrumb_ld = seo_render.jsonld_script(seo_render.breadcrumb_jsonld([
        ("Feynman", base),
        ("Books", f"{base}/#/library"),
        (title_raw, book_url),
        ("Q&A", canonical),
    ]))

    page_title_raw = f"{question} — {title_raw}"
    if len(page_title_raw) > 120:
        page_title_raw = page_title_raw[:117].rsplit(" ", 1)[0] + "..."
    page_title = html_esc(page_title_raw)
    desc_raw = answer[:180].strip() if answer else (
        f"Discuss \"{question}\" with the book \"{title_raw}\" on Feynman."
    )
    if len(desc_raw) > 200:
        desc_raw = desc_raw[:197].rsplit(" ", 1)[0] + "..."
    desc = html_esc(desc_raw)
    og_image_url = f"{base}/book/{agent_id}/og.png?v={config.OG_IMAGE_CACHE_VERSION}"
    # See book_page comment — book chat lives at /#/read/{id} in the SPA.
    chat_url = f"{base}/#/read/{agent_id}"

    html = f"""<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{page_title}</title>
<meta name="description" content="{desc}">
<link rel="canonical" href="{canonical}">
<meta property="og:type" content="article">
<meta property="og:title" content="{html_esc(question)}">
<meta property="og:description" content="{desc}">
<meta property="og:image" content="{og_image_url}">
<meta property="og:url" content="{canonical}">
<meta property="og:site_name" content="Feynman">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:site" content="@steve_yeow">
<meta name="twitter:title" content="{html_esc(question)}">
<meta name="twitter:description" content="{desc}">
<meta name="twitter:image" content="{og_image_url}">
{seo_render.landing_css_link()}
{qa_ld}
{breadcrumb_ld}
</head><body>
{seo_render.render_landing_header(base, is_authenticated=False)}
<nav class="qa-back"><a href="{book_url}">← {title}</a></nav>
<h1>{html_esc(question)}</h1>
{answer_html}
{passages_html}
{siblings_html}
<p class="cta"><a href="{html_esc(chat_url)}">Chat about this question →</a></p>
{seo_render.render_site_footer(base)}
</body></html>"""
    _cache_set(cache_key, html)
    return HTMLResponse(
        html,
        headers={
            "Cache-Control": "public, max-age=3600, s-maxage=86400",
            "X-Cache": "MISS",
        },
    )


# ─── Phase 4B — Mind-on-topic compound pages ────────────────────────
#
# /mind/{mind_id}/on/{topic_slug} renders an imagined-perspective essay
# of how this mind would approach this topic. Relevance is enforced —
# non-matching pairs 404 to avoid programmatic spam (e.g. "Confucius on
# Computer Science"). Essays are LLM-generated, labelled as imagined,
# and grounded in the mind's persona/thinking_style/typical_phrases.

_MIND_ESSAY_CACHE_TTL = 86400


@app.get("/mind/{mind_id}/on/{topic_slug}", response_class=HTMLResponse)
def mind_on_topic_page(mind_id: str, topic_slug: str, request: Request) -> HTMLResponse:
    """Per-(mind, topic) compound page. See module-level comment."""
    from html import escape as html_esc

    mind = get_mind(mind_id)
    if not mind:
        raise HTTPException(status_code=404, detail="Mind not found")
    topic = _resolve_topic_slug(topic_slug)
    if not topic:
        raise HTTPException(status_code=404, detail="Topic not found")
    if not qa_module.is_mind_topic_relevant(mind, topic):
        # Relevance gate — pair isn't plausible enough to merit an essay.
        # 404 keeps Google from indexing programmatic combinations.
        raise HTTPException(status_code=404, detail="Topic not relevant to this mind")

    cache_key = f"mind_essay:{mind_id}:{topic_slug}"
    cached = _cache_get(cache_key, _MIND_ESSAY_CACHE_TTL)
    if cached is not None:
        return HTMLResponse(
            cached,
            headers={
                "Cache-Control": "public, max-age=3600, s-maxage=86400",
                "X-Cache": "HIT",
            },
        )

    name_raw = mind.get("name", "Unknown")
    name = html_esc(name_raw)
    base = _SITE_URL
    mind_url = f"{base}/mind/{mind_id}"
    canonical = f"{base}/mind/{mind_id}/on/{topic_slug}"
    chat_url = f"{base}/#/mind/{mind_id}"

    essay_result = qa_module.generate_mind_on_topic_essay(mind, topic)
    essay = essay_result.get("essay", "")
    if not essay:
        # Generation failed (LLM disabled, provider error, or empty
        # response). Don't render a blank page — 404 so we don't pollute
        # the index with empty essays.
        raise HTTPException(status_code=404, detail="Essay unavailable")

    page_title_raw = f"How {name_raw} would approach {topic} — Feynman"
    if len(page_title_raw) > 120:
        page_title_raw = page_title_raw[:117].rsplit(" ", 1)[0] + "..."
    page_title = html_esc(page_title_raw)
    desc_raw = essay[:180].strip().replace("\n", " ")
    if len(desc_raw) > 200:
        desc_raw = desc_raw[:197].rsplit(" ", 1)[0] + "..."
    desc = html_esc(desc_raw)
    og_image_url = f"{base}/mind/{mind_id}/og.png"

    essay_html = seo_render.render_mind_on_topic_essay(essay, name_raw, topic)
    article_ld = seo_render.jsonld_script(seo_render.mind_essay_jsonld(
        mind_name=name_raw, topic=topic, essay=essay,
        url=canonical, mind_url=mind_url, image=og_image_url,
    ))
    breadcrumb_ld = seo_render.jsonld_script(seo_render.breadcrumb_jsonld([
        ("Feynman", base),
        ("Great Minds", f"{base}/#/minds"),
        (name_raw, mind_url),
        (topic, canonical),
    ]))
    topic_hub_url = f"{base}/topic/{topic_slug}"

    html = f"""<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{page_title}</title>
<meta name="description" content="{desc}">
<link rel="canonical" href="{canonical}">
<meta property="og:type" content="article">
<meta property="og:title" content="{html_esc(f'How {name_raw} would approach {topic}')}">
<meta property="og:description" content="{desc}">
<meta property="og:image" content="{og_image_url}">
<meta property="og:url" content="{canonical}">
<meta property="og:site_name" content="Feynman">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:site" content="@steve_yeow">
<meta name="twitter:title" content="{html_esc(f'How {name_raw} would approach {topic}')}">
<meta name="twitter:description" content="{desc}">
<meta name="twitter:image" content="{og_image_url}">
{seo_render.landing_css_link()}
{article_ld}
{breadcrumb_ld}
</head><body>
{seo_render.render_landing_header(base, is_authenticated=False)}
<nav class="essay-back"><a href="{mind_url}">← {name}</a></nav>
<h1>How {name} would approach {html_esc(topic)}</h1>
{essay_html}
<p class="related-links">
  Read more: <a href="{mind_url}">About {name}</a> ·
  <a href="{topic_hub_url}">{html_esc(topic)} on Feynman</a>
</p>
<p class="cta"><a href="{html_esc(chat_url)}">Chat with {name} →</a></p>
{seo_render.render_site_footer(base)}
</body></html>"""
    _cache_set(cache_key, html)
    return HTMLResponse(
        html,
        headers={
            "Cache-Control": "public, max-age=3600, s-maxage=86400",
            "X-Cache": "MISS",
        },
    )


# ─── Phase 8 — Live AI Output Indexing ──────────────────────────────
#
# /book/{id}/insights and /mind/{id}/dialogues — render the AI's
# accumulated commentary about an entity, drawn from real chat
# sessions. The render layer enforces three hard rules:
#
#   1. Only role='assistant' rows are pulled (SQL-side filter).
#   2. Each rendered message has been sanitized to strip user-context
#      echoes ("as you asked", "your question about X", etc.).
#   3. Aggregate-only display — no single chat session is identifiable
#      from the rendered page.
#
# See app/core/insights.py for the privacy posture documentation and
# docs/seo-geo-master-plan.md Section 3.5 Type 4 for the strategic
# rationale.

_INSIGHTS_PAGE_CACHE_TTL = 1800  # 30 min — chat data updates continuously,
                                 # but page-render cost is small so we can
                                 # afford a moderate TTL


def _require_insights_enabled() -> None:
    """404 if the kill switch is off. Pattern matches the UGC and QA
    gates — 404 not 503 so probes don't learn about the surface."""
    if not insights_module.is_enabled():
        raise HTTPException(status_code=404, detail="Not found")


@app.get("/book/{agent_id}/insights", response_class=HTMLResponse)
def book_insights_page(agent_id: str, request: Request) -> HTMLResponse:
    """Aggregated AI commentary about this book, drawn from real
    reader chat sessions."""
    from html import escape as html_esc

    _require_insights_enabled()
    agent = get_agent(agent_id)
    if not agent:
        raise HTTPException(status_code=404, detail="Book not found")

    cache_key = f"insights_book:{agent_id}"
    cached = _cache_get(cache_key, _INSIGHTS_PAGE_CACHE_TTL)
    if cached is not None:
        return HTMLResponse(
            cached,
            headers={
                "Cache-Control": "public, max-age=1800, s-maxage=1800",
                "X-Cache": "HIT",
            },
        )

    book = get_ai_book_by_agent(agent_id)
    entity_name_raw = (book["title"] if book and book.get("title")
                       else agent.get("name", "this book"))
    entity_name = html_esc(entity_name_raw)
    base = _SITE_URL
    entity_canonical = f"{base}/book/{agent_id}"
    canonical = f"{entity_canonical}/insights"
    # Book chat lives at /#/read/{id} — see book_page handler comment.
    chat_url = f"{base}/#/read/{agent_id}"

    # ── Extract → sanitize → publishable filter ────────────────────────
    try:
        raw = list_assistant_messages_for_agent(agent_id, limit=200)
    except Exception:
        raw = []
    publishable = insights_module.select_publishable(raw, limit=10)

    # ── Body ────────────────────────────────────────────────────────────
    if publishable:
        cards_html = seo_render.render_insight_cards(publishable)
        empty_html = ""
        latest = publishable[0].get("created_at", "")
    else:
        cards_html = ""
        empty_html = seo_render.render_insights_empty_state(entity_name_raw, chat_url)
        latest = ""

    # ── Schema ──────────────────────────────────────────────────────────
    if publishable:
        desc_raw = (
            f"{len(publishable)} AI-synthesized insights about "
            f"{entity_name_raw} drawn from real reader chat sessions on Feynman. "
            f"AI agent output only; user questions are never published."
        )
    else:
        desc_raw = (
            f"AI insights about {entity_name_raw} on Feynman. "
            f"Start a chat to seed the public insights page."
        )
    if len(desc_raw) > 200:
        desc_raw = desc_raw[:197].rsplit(" ", 1)[0] + "..."
    desc = html_esc(desc_raw)

    article_ld = seo_render.jsonld_script(seo_render.insights_article_jsonld(
        headline=f"AI insights about {entity_name_raw}",
        description=desc_raw,
        url=canonical,
        about_url=entity_canonical,
        about_type="Book",
        about_name=entity_name_raw,
        site_url=base,
        date_modified=latest,
        insight_count=len(publishable),
    ))
    breadcrumb_ld = seo_render.jsonld_script(seo_render.breadcrumb_jsonld([
        ("Feynman", base),
        ("Books", f"{base}/#/library"),
        (entity_name_raw, entity_canonical),
        ("Insights", canonical),
    ]))

    title = html_esc(f"AI insights about {entity_name_raw} — Feynman")
    og_image_url = f"{base}/book/{agent_id}/og.png?v={config.OG_IMAGE_CACHE_VERSION}"

    html = f"""<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title}</title>
<meta name="description" content="{desc}">
<link rel="canonical" href="{canonical}">
<meta property="og:type" content="article">
<meta property="og:title" content="{title}">
<meta property="og:description" content="{desc}">
<meta property="og:image" content="{og_image_url}">
<meta property="og:url" content="{canonical}">
<meta property="og:site_name" content="Feynman">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:site" content="@steve_yeow">
<meta name="twitter:title" content="{title}">
<meta name="twitter:description" content="{desc}">
<meta name="twitter:image" content="{og_image_url}">
{seo_render.landing_css_link()}
{article_ld}
{breadcrumb_ld}
</head><body>
{seo_render.render_landing_header(base, is_authenticated=False)}
<nav class="insights-back"><a href="{entity_canonical}">← {entity_name}</a></nav>
<h1>AI insights about {entity_name}</h1>
<p class="insights-intro">Accumulated AI-synthesized commentary drawn from
real reader chat sessions with this book. Updated as more readers explore
the text. The AI's responses are published; user questions remain private.</p>
{cards_html}
{empty_html}
<p class="cta"><a href="{html_esc(chat_url)}">Chat with {entity_name} →</a></p>
{seo_render.render_site_footer(base)}
</body></html>"""
    _cache_set(cache_key, html)
    return HTMLResponse(
        html,
        headers={
            "Cache-Control": "public, max-age=1800, s-maxage=1800",
            "X-Cache": "MISS",
        },
    )


@app.get("/mind/{mind_id}/dialogues", response_class=HTMLResponse)
def mind_dialogues_page(mind_id: str, request: Request) -> HTMLResponse:
    """Aggregated AI commentary from a great-mind agent across real
    user dialogues. Symmetric to /book/{id}/insights but for minds —
    different naming ("dialogues" not "insights") because a mind page's
    content type is more conversational and less synthetic."""
    from html import escape as html_esc

    _require_insights_enabled()
    mind = get_mind(mind_id)
    if not mind:
        raise HTTPException(status_code=404, detail="Mind not found")

    cache_key = f"insights_mind:{mind_id}"
    cached = _cache_get(cache_key, _INSIGHTS_PAGE_CACHE_TTL)
    if cached is not None:
        return HTMLResponse(
            cached,
            headers={
                "Cache-Control": "public, max-age=1800, s-maxage=1800",
                "X-Cache": "HIT",
            },
        )

    entity_name_raw = mind.get("name") or "this mind"
    entity_name = html_esc(entity_name_raw)
    base = _SITE_URL
    entity_canonical = f"{base}/mind/{mind_id}"
    canonical = f"{entity_canonical}/dialogues"
    chat_url = f"{base}/#/mind/{mind_id}"

    try:
        raw = list_assistant_messages_for_mind(mind_id, limit=200)
    except Exception:
        raw = []
    publishable = insights_module.select_publishable(raw, limit=10)

    if publishable:
        cards_html = seo_render.render_insight_cards(publishable)
        empty_html = ""
        latest = publishable[0].get("created_at", "")
    else:
        cards_html = ""
        empty_html = seo_render.render_insights_empty_state(entity_name_raw, chat_url)
        latest = ""

    if publishable:
        desc_raw = (
            f"{len(publishable)} dialogues with {entity_name_raw} drawn from "
            f"real user chat sessions on Feynman. AI agent output only; user "
            f"questions are never published."
        )
    else:
        desc_raw = (
            f"AI dialogues with {entity_name_raw} on Feynman. "
            f"Start a chat to seed the public dialogues page."
        )
    if len(desc_raw) > 200:
        desc_raw = desc_raw[:197].rsplit(" ", 1)[0] + "..."
    desc = html_esc(desc_raw)

    article_ld = seo_render.jsonld_script(seo_render.insights_article_jsonld(
        headline=f"AI dialogues with {entity_name_raw}",
        description=desc_raw,
        url=canonical,
        about_url=entity_canonical,
        about_type="Person",
        about_name=entity_name_raw,
        site_url=base,
        date_modified=latest,
        insight_count=len(publishable),
    ))
    breadcrumb_ld = seo_render.jsonld_script(seo_render.breadcrumb_jsonld([
        ("Feynman", base),
        ("Great Minds", f"{base}/#/minds"),
        (entity_name_raw, entity_canonical),
        ("Dialogues", canonical),
    ]))

    title = html_esc(f"AI dialogues with {entity_name_raw} — Feynman")
    og_image_url = f"{base}/mind/{mind_id}/og.png"

    html = f"""<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title}</title>
<meta name="description" content="{desc}">
<link rel="canonical" href="{canonical}">
<meta property="og:type" content="article">
<meta property="og:title" content="{title}">
<meta property="og:description" content="{desc}">
<meta property="og:image" content="{og_image_url}">
<meta property="og:url" content="{canonical}">
<meta property="og:site_name" content="Feynman">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:site" content="@steve_yeow">
<meta name="twitter:title" content="{title}">
<meta name="twitter:description" content="{desc}">
<meta name="twitter:image" content="{og_image_url}">
{seo_render.landing_css_link()}
{article_ld}
{breadcrumb_ld}
</head><body>
{seo_render.render_landing_header(base, is_authenticated=False)}
<nav class="insights-back"><a href="{entity_canonical}">← {entity_name}</a></nav>
<h1>AI dialogues with {entity_name}</h1>
<p class="insights-intro">Accumulated AI agent responses from real user
chat sessions with {entity_name}. Updated as more conversations happen.
The agent's responses are published; user questions remain private.</p>
{cards_html}
{empty_html}
<p class="cta"><a href="{html_esc(chat_url)}">Chat with {entity_name} →</a></p>
{seo_render.render_site_footer(base)}
</body></html>"""
    _cache_set(cache_key, html)
    return HTMLResponse(
        html,
        headers={
            "Cache-Control": "public, max-age=1800, s-maxage=1800",
            "X-Cache": "MISS",
        },
    )


# ─── Phase 4C — Topic hub pages ─────────────────────────────────────
#
# /topic/{slug} aggregates books and minds tagged with one of the 15
# TOPIC_TAGS. Pure aggregation — no LLM calls. Each page becomes:
#   * a new indexable URL (sitemap)
#   * an internal-PageRank conduit pushing authority to entity pages
#   * a canonical destination for queries like "best Economics books"
#
# Cache aggressively: topic membership only changes when a new catalog
# book is discovered, which is rare. 1 hour TTL is plenty fresh.

_TOPIC_PAGE_CACHE_TTL = 3600


def _resolve_topic_slug(slug: str) -> str | None:
    """Find the canonical topic name for a URL slug. None if no match."""
    index = seo_render.build_topic_slug_index(TOPIC_TAGS)
    return index.get(slug.lower())


@app.get("/topic/{slug}", response_class=HTMLResponse)
def topic_page(slug: str, request: Request) -> HTMLResponse:
    """Server-rendered topic hub. Lists all books + minds tagged with this
    topic with cross-links — both for users and for the crawler graph.
    """
    from html import escape as html_esc

    topic = _resolve_topic_slug(slug)
    if not topic:
        raise HTTPException(status_code=404, detail="Topic not found")

    cache_key = f"topic_page:{slug}"
    cached = _cache_get(cache_key, _TOPIC_PAGE_CACHE_TTL)
    if cached is not None:
        return HTMLResponse(
            cached,
            headers={
                "Cache-Control": "public, max-age=3600, s-maxage=86400",
                "X-Cache": "HIT",
            },
        )

    try:
        books = list_books_by_topic(topic, limit=30)
    except Exception:
        books = []
    try:
        minds = list_minds_by_topic(topic, limit=12)
    except Exception:
        minds = []

    base = _SITE_URL
    canonical = f"{base}/topic/{slug}"
    title = html_esc(f"{topic} on Feynman")
    desc_raw = (
        f"Chat with the best {topic} books and great minds on Feynman. "
        f"{len(books)} curated {('book' if len(books) == 1 else 'books')}, "
        f"{len(minds)} {('thinker' if len(minds) == 1 else 'thinkers')}."
    )
    if len(desc_raw) > 200:
        desc_raw = desc_raw[:197].rsplit(" ", 1)[0] + "..."
    desc = html_esc(desc_raw)

    intro_html = seo_render.render_topic_intro(topic, len(books), len(minds))
    books_html = seo_render.render_topic_books(books, base)
    minds_html = seo_render.render_topic_minds(minds, base)

    # Phase 5.6 — Explore footer: link to other topic hubs so crawlers
    # see the full topic graph. Pick 4 sibling topics (skip self).
    siblings = [t for t in TOPIC_TAGS if t != topic][:4]
    explore_items = [
        {"label": t, "href": f"/topic/{seo_render.topic_slug(t)}"}
        for t in siblings
    ]
    explore_footer_html = seo_render.render_explore_footer(
        explore_items, base, label="Other topics",
    )

    # Collection schema with embedded ItemList (book entries first, then
    # minds). LLMs use this to enumerate "what's in this topic" cleanly.
    items: list[dict[str, str]] = []
    for b in books[:30]:
        if b.get("id") and b.get("name"):
            items.append({"name": b["name"], "url": f"{base}/book/{b['id']}"})
    for m in minds[:12]:
        if m.get("id") and m.get("name"):
            items.append({"name": m["name"], "url": f"{base}/mind/{m['id']}"})

    collection_ld = seo_render.jsonld_script(seo_render.collection_jsonld(
        name=f"{topic} on Feynman",
        description=desc_raw,
        url=canonical,
        items=items,
        site_url=base,
    ))
    breadcrumb_ld = seo_render.jsonld_script(seo_render.breadcrumb_jsonld([
        ("Feynman", base),
        ("Topics", f"{base}/#/library"),
        (topic, canonical),
    ]))

    html = f"""<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title}</title>
<meta name="description" content="{desc}">
<link rel="canonical" href="{canonical}">
<meta property="og:type" content="website">
<meta property="og:title" content="{title}">
<meta property="og:description" content="{desc}">
<meta property="og:url" content="{canonical}">
<meta property="og:site_name" content="Feynman">
<meta name="twitter:card" content="summary">
<meta name="twitter:site" content="@steve_yeow">
<meta name="twitter:title" content="{title}">
<meta name="twitter:description" content="{desc}">
{seo_render.landing_css_link()}
{collection_ld}
{breadcrumb_ld}
</head><body>
{seo_render.render_landing_header(base, is_authenticated=False)}
<h1>{html_esc(topic)}</h1>
{intro_html}
{books_html}
{minds_html}
<p class="cta"><a href="{base}/#/library">Explore the full Feynman library →</a></p>
{explore_footer_html}
{seo_render.render_site_footer(base)}
</body></html>"""
    _cache_set(cache_key, html)
    return HTMLResponse(
        html,
        headers={
            "Cache-Control": "public, max-age=3600, s-maxage=86400",
            "X-Cache": "MISS",
        },
    )


# ─── Phase 6 — UGC: public discussions ──────────────────────────────
#
# Privacy is the whole game here. The feature is entirely gated by the
# ENABLE_PUBLIC_DISCUSSIONS env var (default OFF) — all five routes
# below return 404 when the flag is off, so the surface is invisible
# until product/legal sign off. See app/core/ugc.py for the full
# privacy model.
#
# Admin moderation is gated by ADMIN_USER_IDS env (comma-separated
# user IDs). Empty / unset means no one can moderate, which combined
# with the feature flag means the system stays in a safe state by
# default even if the flag is accidentally flipped.


def _is_admin_user(request: Request) -> bool:
    """Membership check against ADMIN_USER_IDS env var."""
    admin_ids = {
        s.strip() for s in os.getenv("ADMIN_USER_IDS", "").split(",") if s.strip()
    }
    if not admin_ids:
        return False
    uid = _get_user_id(request)
    return bool(uid) and uid in admin_ids


def _require_ugc_enabled() -> None:
    """Raise 404 if the feature flag is off. We use 404 (not 403) to
    avoid signalling the route's existence to probes — the surface is
    effectively absent when disabled."""
    if not ugc_module.is_enabled():
        raise HTTPException(status_code=404, detail="Not found")


class ShareChatSessionRequest(BaseModel):
    handle: str | None = Field(default=None, max_length=40)
    title: str | None = Field(default=None, max_length=200)


@app.post("/api/chat-sessions/{session_id}/share")
def api_chat_session_share(
    session_id: str, payload: ShareChatSessionRequest, request: Request,
):
    """User opts in to making this chat session publicly visible.

    **Auto-publish model (2026-05-27)**: status moves directly to
    ``approved`` so the session becomes publicly discoverable. Idempotent —
    re-sharing updates handle/title but doesn't double-stamp consent.

    Two gates run before status flips, surfaced as distinct error codes:
      * 422 ``too_few_messages`` — session has < 3 messages
      * 429 ``rate_limited`` — user shared ≥ 10 sessions in last 24h
      * 404 ``not_found`` / ``rejected`` — session missing, not owned, or
        admin-rejected previously
    """
    _require_ugc_enabled()
    uid = _get_user_id(request)
    if not uid:
        raise HTTPException(status_code=401, detail="Authentication required")
    handle, err = ugc_module.validate_public_handle(payload.handle or "")
    if err:
        raise HTTPException(status_code=422, detail=err)
    title = (payload.title or "").strip() or None
    result = request_chat_session_share(
        session_id, uid, handle=handle or None, public_title=title,
    )
    # New return shape: string error codes for known failures.
    if result == "too_few_messages":
        raise HTTPException(
            status_code=422,
            detail="Chat needs at least 3 messages before it can be shared publicly.",
        )
    if result == "rate_limited":
        raise HTTPException(
            status_code=429,
            detail="You've already shared 10 sessions today. Try again tomorrow.",
        )
    if not result or isinstance(result, str):
        # not_found / rejected / unknown — 404 to avoid leaking which.
        raise HTTPException(status_code=404, detail="Session not eligible for sharing")
    public_url = f"{_SITE_URL}/discussions/{result['id']}"
    # /discussions/{session_id} is the canonical public URL; the entity-
    # level aggregations at /book/{id}/discussions and
    # /mind/{id}/discussions list it among other public discussions for
    # that book/mind.
    return {
        "id": result["id"],
        "public_status": result["public_status"],
        "public_handle": result.get("public_handle"),
        "public_title": result.get("public_title"),
        "public_url": public_url,
        "consent_at": result.get("consent_at"),
        "approved_at": result.get("approved_at"),
    }


@app.post("/api/chat-sessions/{session_id}/withdraw")
def api_chat_session_withdraw(session_id: str, request: Request):
    """User withdraws consent. Status moves to 'withdrawn' (or stays
    withdrawn — idempotent). Works at any prior status."""
    _require_ugc_enabled()
    uid = _get_user_id(request)
    if not uid:
        raise HTTPException(status_code=401, detail="Authentication required")
    result = withdraw_chat_session_share(session_id, uid)
    if not result:
        raise HTTPException(status_code=404, detail="Session not found")
    return {"id": result["id"], "public_status": result["public_status"]}


@app.get("/api/chat-sessions/{session_id}/public-status")
def api_chat_session_public_status(session_id: str, request: Request):
    """Read the current public status of a session. Owner-only."""
    _require_ugc_enabled()
    uid = _get_user_id(request)
    if not uid:
        raise HTTPException(status_code=401, detail="Authentication required")
    sess = get_chat_session_with_public_status(session_id)
    if not sess or sess.get("user_id") != uid:
        raise HTTPException(status_code=404, detail="Session not found")
    return {
        "id": sess["id"],
        "public_status": sess.get("public_status", "private"),
        "public_handle": sess.get("public_handle"),
        "consent_at": sess.get("consent_at"),
        "approved_at": sess.get("approved_at"),
    }


class AdminApproveRequest(BaseModel):
    public_title: str | None = Field(default=None, max_length=200)


@app.post("/api/admin/chat-sessions/{session_id}/approve")
def api_admin_approve_session(
    session_id: str, payload: AdminApproveRequest, request: Request,
):
    """Admin approves an opted-in session for public display."""
    _require_ugc_enabled()
    if not _is_admin_user(request):
        # Don't reveal whether the route exists to non-admins.
        raise HTTPException(status_code=404, detail="Not found")
    admin_uid = _get_user_id(request) or ""
    result = approve_chat_session_public(
        session_id, admin_uid, public_title=payload.public_title,
    )
    if not result:
        raise HTTPException(status_code=404, detail="Session not pending approval")
    return {"id": result["id"], "public_status": result["public_status"]}


@app.post("/api/admin/chat-sessions/{session_id}/reject")
def api_admin_reject_session(session_id: str, request: Request):
    _require_ugc_enabled()
    if not _is_admin_user(request):
        raise HTTPException(status_code=404, detail="Not found")
    admin_uid = _get_user_id(request) or ""
    result = reject_chat_session_public(session_id, admin_uid)
    if not result:
        raise HTTPException(status_code=404, detail="Session not pending approval")
    return {"id": result["id"], "public_status": result["public_status"]}


@app.get("/api/admin/moderation-queue/count")
def api_admin_moderation_queue_count(request: Request):
    """Tiny endpoint for an admin dashboard to poll the queue size."""
    _require_ugc_enabled()
    if not _is_admin_user(request):
        raise HTTPException(status_code=404, detail="Not found")
    return {"pending": count_pending_public_sessions()}


@app.get("/api/admin/llm-referrals")
def api_admin_llm_referrals(request: Request, since_days: int = 7):
    """Aggregate LLM referrer counts for the admin dashboard. Answers
    'which of our pages got cited by ChatGPT/Perplexity/Claude this week.'

    Phase 7.3 — gated by ADMIN_USER_IDS like the moderation endpoints
    so the URL doesn't reveal traffic data to anonymous probes. ``since_days``
    defaults to 7 (1 week), capped at 365 to keep the SQL bounded."""
    if not _is_admin_user(request):
        raise HTTPException(status_code=404, detail="Not found")
    from datetime import datetime, timedelta, timezone
    days = max(1, min(int(since_days), 365))
    since_iso = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()
    return count_llm_referrals(since_iso=since_iso)


# ── Public discussion render routes (SSR; feature-flag gated) ────────


def _render_public_post_html(session: dict[str, Any], chat_url: str) -> str:
    """Render one approved chat session as a discussion post. PII is
    scrubbed before display. Empty bodies render as a one-line stub
    rather than a blank card."""
    from html import escape as html_esc

    title = (
        session.get("public_title")
        or session.get("title")
        or "Discussion"
    )
    handle = session.get("public_handle") or "Anonymous"
    # Fetch messages and assemble a sanitized snippet (cap at 4 messages,
    # 600 chars each, then PII-scrub the whole thing).
    msgs = []
    try:
        # SAFETY: list_messages_for_public_session enforces a SQL-side
        # join on public_status='approved' so even if upstream caching
        # surfaced a stale session row, the messages are gated by the
        # current DB state. Caller still scrubs PII before render.
        raw_msgs = list_messages_for_public_session(session["id"]) or []
    except Exception:
        raw_msgs = []
    for m in raw_msgs[:6]:
        role = m.get("role", "")
        content = (m.get("content") or "").strip()
        if not content:
            continue
        if len(content) > 600:
            content = content[:597].rsplit(" ", 1)[0] + "…"
        msgs.append((role, content))

    inner = ""
    if msgs:
        rows = []
        for role, content in msgs:
            scrubbed = ugc_module.scrub_pii_for_public_display(content)
            role_label = html_esc(role.upper()) if role else ""
            rows.append(
                f'<div class="msg msg-{html_esc(role)}">'
                f'<small class="msg-role">{role_label}</small>'
                f'<p>{html_esc(scrubbed)}</p>'
                '</div>'
            )
        inner = "".join(rows)
    else:
        inner = '<p class="msg-empty"><em>No public content in this discussion.</em></p>'

    return (
        '<article class="public-post">'
        f'<header><h3>{html_esc(title)}</h3>'
        f'<small class="post-author">— {html_esc(handle)}</small></header>'
        f'{inner}'
        f'<p class="post-cta"><a href="{html_esc(chat_url)}">Start your own chat →</a></p>'
        '</article>'
    )


def _render_public_discussions_page(
    *,
    entity_type: str,    # "book" or "mind"
    entity_id: str,
    entity_name: str,
    entity_canonical: str,
    chat_url: str,
    sessions: list[dict[str, Any]],
) -> str:
    """Assemble the full HTML for a /discussions page. Common between
    book and mind."""
    from html import escape as html_esc

    title_raw = f"Discussions about {entity_name} — Feynman"
    title = html_esc(title_raw)
    if sessions:
        desc_raw = (
            f"{len(sessions)} public "
            f"{('discussion' if len(sessions) == 1 else 'discussions')} "
            f"about {entity_name} on Feynman. "
            f"All conversations are user-shared with consent and PII-scrubbed."
        )
    else:
        desc_raw = (
            f"Public discussions about {entity_name} on Feynman. "
            f"Be the first to share — open a chat and opt in from your session."
        )
    if len(desc_raw) > 200:
        desc_raw = desc_raw[:197].rsplit(" ", 1)[0] + "..."
    desc = html_esc(desc_raw)

    posts_html = "".join(_render_public_post_html(s, chat_url) for s in sessions)
    if not posts_html:
        posts_html = (
            '<p class="no-discussions">No public discussions yet. '
            f'Be the first — chat with {html_esc(entity_name)} and opt to share '
            'your conversation from the session menu.</p>'
        )

    # Build DiscussionForumPosting JSON-LD only when there are real posts
    # (avoid emitting an empty thread schema that Google may flag).
    forum_ld = ""
    if sessions:
        posts_for_ld = [
            {
                "handle": s.get("public_handle") or "Anonymous",
                "body": ugc_module.scrub_pii_for_public_display(
                    (s.get("public_title") or s.get("title") or "")
                )[:300],
                "created_at": s.get("approved_at") or s.get("created_at") or "",
                "session_id": s["id"],
            }
            for s in sessions
        ]
        forum_ld = seo_render.jsonld_script(ugc_module.discussion_forum_jsonld(
            posts=posts_for_ld,
            page_url=entity_canonical + "/discussions",
            headline=f"Discussions about {entity_name}",
            about_url=entity_canonical,
            about_type="Book" if entity_type == "book" else "Person",
            about_name=entity_name,
        ))
    breadcrumb_ld = seo_render.jsonld_script(seo_render.breadcrumb_jsonld([
        ("Feynman", _SITE_URL),
        (
            "Books" if entity_type == "book" else "Great Minds",
            f"{_SITE_URL}/#/{'library' if entity_type == 'book' else 'minds'}",
        ),
        (entity_name, entity_canonical),
        ("Discussions", entity_canonical + "/discussions"),
    ]))

    return f"""<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title}</title>
<meta name="description" content="{desc}">
<link rel="canonical" href="{entity_canonical}/discussions">
<meta property="og:type" content="website">
<meta property="og:title" content="{title}">
<meta property="og:description" content="{desc}">
<meta property="og:url" content="{entity_canonical}/discussions">
<meta property="og:site_name" content="Feynman">
{seo_render.landing_css_link()}
{forum_ld}
{breadcrumb_ld}
</head><body>
{seo_render.render_landing_header(_SITE_URL, is_authenticated=False)}
<nav class="back-link"><a href="{entity_canonical}">← {html_esc(entity_name)}</a></nav>
<h1>Discussions about {html_esc(entity_name)}</h1>
{posts_html}
<p class="cta"><a href="{html_esc(chat_url)}">Start your own chat →</a></p>
{seo_render.render_site_footer(_SITE_URL)}
</body></html>"""


_PUBLIC_DISCUSSIONS_CACHE_TTL = 600  # 10 min — fresh enough for new approvals


@app.get("/book/{agent_id}/discussions", response_class=HTMLResponse)
def book_discussions_page(agent_id: str, request: Request) -> HTMLResponse:
    """List approved public discussions for this book. Returns 404 if
    the feature flag is off, so the surface is invisible by default."""
    _require_ugc_enabled()
    agent = get_agent(agent_id)
    if not agent:
        raise HTTPException(status_code=404, detail="Book not found")

    cache_key = f"public_discussions_book:{agent_id}"
    cached = _cache_get(cache_key, _PUBLIC_DISCUSSIONS_CACHE_TTL)
    if cached is not None:
        return HTMLResponse(
            cached,
            headers={
                "Cache-Control": "public, max-age=600, s-maxage=600",
                "X-Cache": "HIT",
            },
        )

    try:
        sessions = list_public_sessions_for_agent(agent_id)
    except Exception:
        sessions = []
    entity_name = agent.get("name") or "this book"
    html = _render_public_discussions_page(
        entity_type="book",
        entity_id=agent_id,
        entity_name=entity_name,
        entity_canonical=f"{_SITE_URL}/book/{agent_id}",
        # Book chat lives at /#/read/{id} — see book_page handler comment.
        chat_url=f"{_SITE_URL}/#/read/{agent_id}",
        sessions=sessions,
    )
    _cache_set(cache_key, html)
    return HTMLResponse(
        html,
        headers={
            "Cache-Control": "public, max-age=600, s-maxage=600",
            "X-Cache": "MISS",
        },
    )


@app.get("/mind/{mind_id}/discussions", response_class=HTMLResponse)
def mind_discussions_page(mind_id: str, request: Request) -> HTMLResponse:
    _require_ugc_enabled()
    mind = get_mind(mind_id)
    if not mind:
        raise HTTPException(status_code=404, detail="Mind not found")

    cache_key = f"public_discussions_mind:{mind_id}"
    cached = _cache_get(cache_key, _PUBLIC_DISCUSSIONS_CACHE_TTL)
    if cached is not None:
        return HTMLResponse(
            cached,
            headers={
                "Cache-Control": "public, max-age=600, s-maxage=600",
                "X-Cache": "HIT",
            },
        )

    try:
        sessions = list_public_sessions_for_mind(mind_id)
    except Exception:
        sessions = []
    entity_name = mind.get("name") or "this mind"
    html = _render_public_discussions_page(
        entity_type="mind",
        entity_id=mind_id,
        entity_name=entity_name,
        entity_canonical=f"{_SITE_URL}/mind/{mind_id}",
        chat_url=f"{_SITE_URL}/#/mind/{mind_id}",
        sessions=sessions,
    )
    _cache_set(cache_key, html)
    return HTMLResponse(
        html,
        headers={
            "Cache-Control": "public, max-age=600, s-maxage=600",
            "X-Cache": "MISS",
        },
    )


# ─── Single approved session — canonical public URL ──────────────────
#
# The /book/{id}/discussions and /mind/{id}/discussions pages list
# multiple approved sessions for an entity. This route is the per-session
# canonical: the URL a user copies from the "Share publicly" toast and
# sends to a friend. Each approved session has exactly one of these
# URLs. SAFETY: gates on public_status='approved' at SQL level.

@app.get("/discussions/{session_id}", response_class=HTMLResponse)
def public_session_page(session_id: str, request: Request) -> HTMLResponse:
    """Single approved public chat session, rendered with PII scrub.
    Returns 404 unless the feature flag is on AND the session exists
    AND public_status='approved'. Caches aggressively (10 min)."""
    from html import escape as html_esc

    _require_ugc_enabled()

    cache_key = f"public_session:{session_id}"
    cached = _cache_get(cache_key, 600)
    if cached is not None:
        return HTMLResponse(
            cached,
            headers={"Cache-Control": "public, max-age=600, s-maxage=600",
                     "X-Cache": "HIT"},
        )

    session = get_chat_session_with_public_status(session_id)
    if not session or session.get("public_status") != "approved":
        # Mask private / withdrawn / opted_in sessions as 404 (don't leak
        # ownership info to probes).
        raise HTTPException(status_code=404, detail="Discussion not found")

    # Determine entity context for the cross-link footer. Book sessions
    # store the agent_id in mind_id field per the schema convention;
    # mind sessions store the mind_id there.
    base = _SITE_URL
    entity_anchor_html = ""
    entity_url = ""
    entity_label = ""
    canonical = f"{base}/discussions/{session_id}"
    mind_id = session.get("mind_id")
    stype = session.get("session_type") or ""
    if mind_id:
        if stype == "book":
            entity_url = f"{base}/book/{mind_id}/discussions"
            agent = None
            try:
                agent = get_agent(mind_id)
            except Exception:
                pass
            if agent:
                entity_label = agent.get("name") or "this book"
        else:
            entity_url = f"{base}/mind/{mind_id}/discussions"
            try:
                m = get_mind(mind_id)
                if m:
                    entity_label = m.get("name") or "this mind"
            except Exception:
                pass
    if entity_url:
        entity_anchor_html = (
            f'<p class="entity-context">'
            f'More discussions about <a href="{html_esc(entity_url)}">'
            f'{html_esc(entity_label or "this entity")}</a></p>'
        )

    # Reuse the per-post renderer so the look matches /book and /mind
    # aggregation pages. Pass the SPA chat URL so visitors can start
    # their own conversation.
    chat_url = (
        f"{base}/#/read/{mind_id}" if stype == "book" and mind_id
        else (f"{base}/#/mind/{mind_id}" if mind_id else f"{base}/")
    )
    post_html = _render_public_post_html(session, chat_url)

    title_raw = (session.get("public_title") or session.get("title")
                 or "Discussion on Feynman")
    title = html_esc(title_raw)
    handle = html_esc(session.get("public_handle") or "Anonymous")
    desc = html_esc((
        f"Public discussion shared by {session.get('public_handle') or 'a reader'} on Feynman."
    )[:200])

    forum_post_ld = seo_render.jsonld_script({
        "@context": "https://schema.org",
        "@type": "DiscussionForumPosting",
        "headline": title_raw,
        "url": canonical,
        "datePublished": session.get("approved_at") or session.get("consent_at") or "",
        "author": {
            "@type": "Person",
            "name": session.get("public_handle") or "Anonymous",
        },
        "publisher": {"@type": "Organization", "name": "Feynman", "url": base},
    })
    breadcrumb_ld = seo_render.jsonld_script(seo_render.breadcrumb_jsonld([
        ("Feynman", base),
        ("Discussions", entity_url or base),
        (title_raw, canonical),
    ]))

    html = f"""<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title} — Feynman</title>
<meta name="description" content="{desc}">
<link rel="canonical" href="{canonical}">
<meta property="og:type" content="article">
<meta property="og:title" content="{title}">
<meta property="og:description" content="{desc}">
<meta property="og:url" content="{canonical}">
<meta property="og:site_name" content="Feynman">
<meta name="twitter:card" content="summary">
<meta name="twitter:site" content="@steve_yeow">
<meta name="twitter:title" content="{title}">
<meta name="twitter:description" content="{desc}">
{seo_render.landing_css_link()}
{forum_post_ld}
{breadcrumb_ld}
</head><body>
{seo_render.render_landing_header(base, is_authenticated=False)}
<h1>{title}</h1>
<p class="post-byline">Shared by {handle}</p>
{post_html}
{entity_anchor_html}
<p class="report-link"><a href="#" onclick="if(confirm('Report this discussion for review?')){{fetch('/api/public-discussions/{html_esc(session_id)}/report',{{method:'POST'}}).then(()=>alert('Thanks — flagged for admin review.'));}}return false;">Report this discussion →</a></p>
{seo_render.render_site_footer(base)}
</body></html>"""
    _cache_set(cache_key, html)
    return HTMLResponse(
        html,
        headers={"Cache-Control": "public, max-age=600, s-maxage=600",
                 "X-Cache": "MISS"},
    )


# ─── Reports endpoint — community-driven moderation backstop ──────────

@app.post("/api/public-discussions/{session_id}/report")
def api_report_public_discussion(session_id: str, request: Request):
    """Mark a public discussion for admin review. Community-driven
    moderation backstop for the auto-publish flow: any viewer can flag
    a session, admin reviews via the existing moderation endpoints
    (/api/admin/chat-sessions/{id}/{approve,reject}).

    Rate-limited per IP (best-effort, in-process) so a single user
    can't spam the moderation queue."""
    _require_ugc_enabled()
    session = get_chat_session_with_public_status(session_id)
    if not session or session.get("public_status") != "approved":
        # Don't reveal whether the session exists; just acknowledge.
        return {"reported": True}
    try:
        # Flag the session for human review by transitioning to 'opted_in'
        # — admin's moderation queue picks it up. The original approved_at
        # is preserved so a 'no action' decision restores the published
        # state cleanly via the approve endpoint.
        with get_conn() as conn:
            _execute(conn, _q(
                """UPDATE chat_sessions
                   SET public_status = 'opted_in'
                   WHERE id = ? AND public_status = 'approved'"""
            ), (session_id,))
        # Invalidate cached page so the route returns 404 immediately.
        _cache_invalidate(f"public_session:{session_id}")
    except Exception as exc:
        log.warning("Report flow failed for %s: %s", session_id, exc)
    return {"reported": True}


# ─── Feature-flag discovery — SPA pulls this at init ──────────────────

@app.get("/api/features")
def api_features() -> dict[str, Any]:
    """Surface server-side feature flags to the SPA. Read-only, no auth.
    SPA uses these to decide whether to show buttons / call endpoints
    that would 404 when their feature is off. Keep additive."""
    return {
        "public_discussions": ugc_module.is_enabled(),
        "ai_insights": insights_module.is_enabled(),
    }


@app.get("/api/public/book/{agent_id}/read")
def api_public_read_book(agent_id: str, request: Request):
    """Public read endpoint — only serves ready (published) books without auth.

    This is a major egress hot path: every crawler / share-link visitor
    pulls the full reassembled book (potentially MBs of chunk text) from
    Postgres. We wrap it in a TTL cache by agent_id and emit a long
    Cache-Control so Vercel's edge can also serve hits. Published book
    content is essentially static between writes, so 30 min staleness
    is fine.
    """
    from fastapi.responses import JSONResponse

    cache_key = f"public_book:{agent_id}"
    cached = _cache_get(cache_key, _BOOK_CACHE_TTL)
    # Cache headers tuned 2026-05-28 for egress conservatism:
    # books are static once indexed (chunk text doesn't mutate after
    # `_learn_agent` completes), so we can let Vercel's edge serve
    # cache hits for 6h before re-validating. Previously s-maxage=1800
    # (30 min) drove repeat egress on popular books — a 320 KB book
    # × 100 crawler/share visits in a day × 12 cache rotations =
    # ~380 MB/day from a single book. 6h cache cuts that by 12×.
    cache_ttl_header = "public, max-age=600, s-maxage=21600"
    if cached is not None:
        return JSONResponse(
            content=cached,
            headers={
                "Cache-Control": cache_ttl_header,
                "X-Cache": "HIT",
            },
        )

    agent = get_agent(agent_id)
    if not agent or agent.get("status") != "ready":
        raise HTTPException(status_code=404, detail="Book not found or not published")
    request.state._public_agent = agent
    payload = api_read_book(agent_id, _agent=agent)
    _cache_set(cache_key, payload)
    return JSONResponse(
        content=payload,
        headers={
            "Cache-Control": cache_ttl_header,
            "X-Cache": "MISS",
        },
    )


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
    existing_titles = [a["name"] for a in list_agents(limit=200)]
    try:
        books, usage = _discover_books_for_topic(payload.topic.strip(), count=payload.count, exclude_titles=existing_titles)
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


# Hobby Active-CPU guard. Book indexing (parse + chunk) is the heaviest
# on-Vercel CPU, and this cron used to queue _learn_agent for EVERY catalog
# agent every run — unbounded as the catalog grows (Task-2 scale), which would
# blow the 4h/mo Hobby cap. Two knobs:
#   ENABLE_DISCOVER_CRON=false        → skip the cron entirely (do all discovery
#                                       + indexing off-Vercel via scripts/).
#   DISCOVER_CRON_MAX_INDEX=<n>       → at most n catalog agents indexed per run
#                                       (bounds CPU regardless of catalog size).
_DISCOVER_CRON_ENABLED = os.getenv("ENABLE_DISCOVER_CRON", "true").strip().lower() not in (
    "0", "false", "no", "off",
)
_DISCOVER_CRON_MAX_INDEX = int(os.getenv("DISCOVER_CRON_MAX_INDEX", "5"))


@app.get("/api/cron/discover")
def api_cron_discover(request: Request, background_tasks: BackgroundTasks) -> dict[str, Any]:
    """Cron-triggered book discovery. Replaces the daemon discovery loop.

    On-Vercel indexing is bounded per run (DISCOVER_CRON_MAX_INDEX) so a large
    catalog can't exhaust the Hobby Active-CPU budget; bulk (re)indexing runs
    off-Vercel via scripts/reindex_via_gutenberg.py."""
    _verify_cron(request)
    if not _DISCOVER_CRON_ENABLED:
        return {"status": "disabled"}
    agents = list_agents(limit=5000)
    if not agents:
        return {"status": "skip", "reason": "no agents yet"}
    _discover_books()
    # Bounded learning for new catalog agents (cap per run → bounded CPU).
    queued = 0
    for a in list_agents(limit=5000):
        if a["status"] == "catalog":
            background_tasks.add_task(_learn_agent, a["id"])
            queued += 1
            if queued >= _DISCOVER_CRON_MAX_INDEX:
                break
    return {"status": "ok", "indexed_queued": queued}


@app.get("/api/cron/indexnow")
def api_cron_indexnow(request: Request) -> dict[str, Any]:
    """Phase 7.2 — daily IndexNow ping. Submits URLs of entities created
    in the last 24 hours to Bing/Yandex/Naver for faster indexing."""
    _verify_cron(request)
    from datetime import datetime, timedelta, timezone
    cutoff = (datetime.now(timezone.utc) - timedelta(hours=26)).isoformat()
    urls: list[str] = []
    # Recent ready agents → /book/{id}
    for a in list_agents(limit=2000):
        if a.get("status") != "ready":
            continue
        if (a.get("created_at") or "") < cutoff:
            continue
        urls.append(f"{_SITE_URL}/book/{a['id']}")
    # Recent minds → /mind/{id}
    for m in list_minds(limit=2000):
        if (m.get("created_at") or "") < cutoff:
            continue
        urls.append(f"{_SITE_URL}/mind/{m['id']}")
    # Always re-ping sitemap so engines re-fetch the URL graph
    urls.append(f"{_SITE_URL}/sitemap.xml")

    host = _SITE_URL.split("://", 1)[-1].rstrip("/")
    result = indexnow_module.ping_urls(urls, host=host)
    return {
        "candidates": len(urls),
        "ping_result": result,
        "key_url": f"{_SITE_URL}/{indexnow_module.INDEXNOW_KEY}.txt",
    }


@app.get("/api/cron/seed-minds")
def api_cron_seed_minds(request: Request) -> dict[str, Any]:
    """Cron-triggered mind seeding. Seeds a batch per run (Hobby has 60s timeout)."""
    _verify_cron(request)
    existing_count = len(list_minds(limit=5000))
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
        "posthog_key": os.getenv("POSTHOG_KEY", "").strip(),
    }


# ─── Agent endpoints ───

@app.get("/api/agents")
def api_list_agents():
    from fastapi.responses import JSONResponse
    # Defensive cap. Frontend renders a library grid; 5000 books is comfortably
    # past any realistic user-perceivable size. Without a cap, this endpoint
    # is hit on every page load and pulls the full agents table over the
    # Supabase pooler.
    result = list_agents(limit=5000)
    try:
        _enrich_ai_book_agents(result)
    except Exception as exc:
        log.error("Failed to enrich AI book agents: %s", exc)
    return JSONResponse(
        content=result,
        # 5× longer edge cache (was s-maxage=120 = 2 min) — the agents
        # list is fairly static (a new book or two per hour at peak) but
        # the response payload is the heaviest single endpoint on the
        # site (940 rows ≈ 2 MB). 10-minute edge cache keeps freshness
        # acceptable for a catalog grid while cutting Supabase egress
        # from this path by ~80%. Drove ~2 GB/month of preventable
        # egress prior to the 2026-05-28 quota overage.
        headers={"Cache-Control": "public, max-age=60, s-maxage=600"},
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
            # NOTE: this endpoint is anonymous-readable (homepage list), so we
            # MUST NOT trigger any LLM work here. We only flip clearly stale
            # books to "failed" so they don't pile up; resuming writing is
            # owner-gated and fires from GET /api/ai-books/{id} or the
            # explicit POST /api/ai-books/{id}/retry endpoint.
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


# ─── JSON mirrors of the SSR SEO surfaces ───────────────────────────────
# These expose, as JSON, the exact same already-computed data the SSR HTML
# handlers render (book_question_page, book_insights_page, mind_dialogues_page,
# public_session_page, book_page related sections, mind_on_topic_page). They
# exist so the Next.js frontend can render those surfaces itself while reusing
# the identical data source, feature-gating, and PII model. No new business
# logic — just the SSR data without the HTML.

@app.get("/api/agents/{agent_id}/qa")
def api_agent_qa(agent_id: str, question: str) -> JSONResponse:
    """Grounded answer + supporting passages for one question (mirrors the
    /book/{id}/q/{slug} SSR handler). `question` is the full question text."""
    agent = get_agent(agent_id)
    if not agent:
        raise HTTPException(status_code=404, detail="Agent not found")
    title_raw = agent.get("name", "") or ""
    try:
        # Check-first: serve the pre-stored answer if present, else generate +
        # persist into the book's meta.qa — keeps programmatic Q&A off the LLM path.
        qa_result = qa_module.get_or_generate_grounded_answer(
            agent_id, question, book_title=title_raw,
        )
    except Exception as exc:
        log.error("qa generation failed for %s: %s", agent_id, exc)
        qa_result = {"answer": "", "passages": []}
    return JSONResponse(
        content={
            "question": question,
            "answer": qa_result.get("answer", ""),
            "passages": qa_result.get("passages", []),
        },
        # Mirror the SSR Q&A cache window (answers are stable once generated).
        headers={"Cache-Control": "public, max-age=3600, s-maxage=86400"},
    )


@app.get("/api/agents/{agent_id}/overview")
def api_agent_overview(agent_id: str) -> JSONResponse:
    """Unique "About this book" overview + key concepts for the /book/{id} hub
    (Bucket B content-density floor). Generated on demand — grounded in the
    book's chunks when it has full text, general-knowledge for catalog stubs —
    and cached (in-process TTL + long edge Cache-Control), exactly like the Q&A
    and mind-essay endpoints. Degrades to an empty payload, in which case the
    hub falls back to its synthesized about-line."""
    agent = get_agent(agent_id)
    if not agent:
        raise HTTPException(status_code=404, detail="Agent not found")
    cache_key = f"book_overview:{agent_id}"
    cached = _cache_get(cache_key, 21600)  # 6h — overviews are stable
    if cached is None:
        try:
            cached = overview_module.generate_book_overview(agent)
        except Exception as exc:
            log.error("overview failed for %s: %s", agent_id, exc)
            cached = {"overview": "", "concepts": [], "grounded": False}
        # Cache only non-empty results so a transient LLM/quota failure doesn't
        # pin an empty overview in-process; empty falls through and retries.
        if cached.get("overview"):
            _cache_set(cache_key, cached)
    return JSONResponse(
        content={
            "overview": cached.get("overview", ""),
            "concepts": cached.get("concepts", []),
            "grounded": cached.get("grounded", False),
        },
        headers={"Cache-Control": "public, max-age=3600, s-maxage=86400"},
    )


@app.get("/api/topics/{slug}/overview")
def api_topic_overview(slug: str) -> JSONResponse:
    """Generated 2-paragraph intro for a topic hub (Bucket B). Resolves the
    slug to a canonical topic, generates once, caches. Empty payload degrades
    to the page's existing one-line intro."""
    topic = None
    for t in TOPIC_TAGS:
        if seo_render.topic_slug(t) == slug:
            topic = t
            break
    if not topic:
        raise HTTPException(status_code=404, detail="Topic not found")
    cache_key = f"topic_overview:{slug}"
    cached = _cache_get(cache_key, 86400)  # 24h — topic intros are static
    if cached is None:
        try:
            cached = overview_module.generate_topic_overview(topic)
        except Exception as exc:
            log.error("topic overview failed for %s: %s", topic, exc)
            cached = {"overview": ""}
        if cached.get("overview"):
            _cache_set(cache_key, cached)
    return JSONResponse(
        content={"topic": topic, "overview": cached.get("overview", "")},
        headers={"Cache-Control": "public, max-age=3600, s-maxage=86400"},
    )


@app.get("/api/agents/{agent_id}/insights")
def api_agent_insights(agent_id: str) -> JSONResponse:
    """Public, PII-sanitized AI insight cards for a book (mirrors
    /book/{id}/insights). 404 when the feature flag is off, matching SSR."""
    if not insights_module.is_enabled():
        raise HTTPException(status_code=404, detail="Not found")
    agent = get_agent(agent_id)
    if not agent:
        raise HTTPException(status_code=404, detail="Agent not found")
    try:
        raw = list_assistant_messages_for_agent(agent_id, limit=200)
    except Exception:
        raw = []
    publishable = insights_module.select_publishable(raw, limit=10)
    return JSONResponse(
        content={"insights": publishable},
        headers={"Cache-Control": "public, max-age=1800, s-maxage=1800"},
    )


@app.get("/api/minds/{mind_id}/dialogues")
def api_mind_dialogues(mind_id: str) -> JSONResponse:
    """Public, PII-sanitized AI dialogue cards for a mind (mirrors
    /mind/{id}/dialogues). Same feature flag + sanitization as book insights."""
    if not insights_module.is_enabled():
        raise HTTPException(status_code=404, detail="Not found")
    mind = get_mind(mind_id)
    if not mind:
        raise HTTPException(status_code=404, detail="Mind not found")
    try:
        raw = list_assistant_messages_for_mind(mind_id, limit=200)
    except Exception:
        raw = []
    publishable = insights_module.select_publishable(raw, limit=10)
    return JSONResponse(
        content={"dialogues": publishable},
        headers={"Cache-Control": "public, max-age=1800, s-maxage=1800"},
    )


@app.get("/api/agents/{agent_id}/related")
def api_agent_related(agent_id: str) -> JSONResponse:
    """Related books + minds for a book (the cross-link sections of the
    /book/{id} SSR page). Minds carry their curated row fields; books come
    from the topic/author similarity query."""
    agent = get_agent(agent_id)
    if not agent:
        raise HTTPException(status_code=404, detail="Agent not found")
    meta = agent.get("meta") or {}
    topic = meta.get("category") or ""
    author = meta.get("author") or ""
    try:
        related_minds = list_minds_for_agent(agent_id)
    except Exception:
        related_minds = []
    try:
        related_books = list_related_books(
            agent_id, topic=topic, author=author, limit=6,
        )
    except Exception:
        related_books = []
    # Activity overlay: minds that have ACTUALLY discussed this book in real
    # chats get a {count,last_seen} badge (seo.py render_minds_for_book). Keyed
    # by lowercase mind name. Pure additive signal; merge onto related_minds.
    try:
        activity = list_minds_active_for_agent(agent_id) or {}
    except Exception:
        activity = {}
    for m in related_minds:
        act = activity.get((m.get("name") or "").lower())
        if act and act.get("count", 0) > 0:
            m["activity"] = {"count": act["count"], "last_seen": act.get("last_seen", "")}
    return JSONResponse(
        content={"books": related_books, "minds": related_minds},
        headers={"Cache-Control": "public, max-age=3600, s-maxage=86400"},
    )


@app.get("/api/minds/{mind_id}/library")
def api_mind_library(mind_id: str) -> JSONResponse:
    """Books in this mind's library (mirrors render_books_for_mind). Distinct
    from the persona-listed 'notable works' — these are agents linked via
    mind_works. Used for the cross-link section on /mind/{id}."""
    mind = get_mind(mind_id)
    if not mind:
        raise HTTPException(status_code=404, detail="Mind not found")
    try:
        books = list_books_for_mind(mind_id)
    except Exception:
        books = []
    return JSONResponse(
        content={"books": books},
        headers={"Cache-Control": "public, max-age=3600, s-maxage=86400"},
    )


@app.get("/api/minds/{mind_id}/themes")
def api_mind_themes(mind_id: str) -> JSONResponse:
    """Community-emergent recent themes (mirrors render_mind_recent_themes):
    topics readers have actually discussed with this mind, aggregated from
    anonymized chat memory. Each item is {topic, count, last_seen}."""
    mind = get_mind(mind_id)
    if not mind:
        raise HTTPException(status_code=404, detail="Mind not found")
    try:
        themes = list_mind_recent_topics(mind_id)
    except Exception:
        themes = []
    return JSONResponse(
        content={"themes": themes},
        headers={"Cache-Control": "public, max-age=1800, s-maxage=1800"},
    )


def _public_session_card(s: dict[str, Any]) -> dict[str, Any]:
    """Compact preview of an approved public session for the discussions list."""
    return {
        "id": s.get("id"),
        "title": s.get("public_title") or s.get("title") or "Discussion",
        "handle": s.get("public_handle") or "Anonymous",
        "approved_at": s.get("approved_at") or s.get("consent_at") or "",
    }


@app.get("/api/agents/{agent_id}/discussions")
def api_agent_discussions(agent_id: str) -> JSONResponse:
    """Approved public chat sessions about this book (mirrors the
    /book/{id}/discussions aggregation page). 404 when UGC is disabled."""
    _require_ugc_enabled()
    agent = get_agent(agent_id)
    if not agent:
        raise HTTPException(status_code=404, detail="Agent not found")
    try:
        sessions = [_public_session_card(s) for s in list_public_sessions_for_agent(agent_id)]
    except Exception:
        sessions = []
    return JSONResponse(
        content={"discussions": sessions, "entity_name": agent.get("name", "")},
        headers={"Cache-Control": "public, max-age=600, s-maxage=600"},
    )


@app.get("/api/minds/{mind_id}/discussions")
def api_mind_discussions(mind_id: str) -> JSONResponse:
    """Approved public chat sessions with this mind (mirrors the
    /mind/{id}/discussions aggregation page). 404 when UGC is disabled."""
    _require_ugc_enabled()
    mind = get_mind(mind_id)
    if not mind:
        raise HTTPException(status_code=404, detail="Mind not found")
    try:
        sessions = [_public_session_card(s) for s in list_public_sessions_for_mind(mind_id)]
    except Exception:
        sessions = []
    return JSONResponse(
        content={"discussions": sessions, "entity_name": mind.get("name", "")},
        headers={"Cache-Control": "public, max-age=600, s-maxage=600"},
    )


@app.get("/api/minds/{mind_id}/on/{topic_slug}")
def api_mind_on_topic(mind_id: str, topic_slug: str) -> JSONResponse:
    """Imagined mind-on-topic essay (mirrors /mind/{id}/on/{slug}). Resolves
    the slug to a canonical topic, applies the same relevance gate (404 on
    irrelevant pairs), and returns the generated essay text."""
    mind = get_mind(mind_id)
    if not mind:
        raise HTTPException(status_code=404, detail="Mind not found")
    # Resolve slug → canonical topic name via the same TOPIC_TAGS index the
    # SSR handler uses, so URLs stay in lockstep.
    topic = None
    for t in TOPIC_TAGS:
        if seo_render.slugify(t) == topic_slug:
            topic = t
            break
    if not topic or not qa_module.is_mind_topic_relevant(mind, topic):
        raise HTTPException(status_code=404, detail="Not found")
    try:
        # Check-first: serve the pre-stored essay if present, else generate +
        # persist (so the next crawl is free) — keeps ~15K essays off the LLM path.
        essay_result = qa_module.get_or_generate_mind_essay(mind, topic)
    except Exception as exc:
        log.error("mind essay failed for %s/%s: %s", mind_id, topic, exc)
        essay_result = {"essay": ""}
    essay = essay_result.get("essay", "")
    if not essay:
        raise HTTPException(status_code=404, detail="Not found")
    return JSONResponse(
        content={"mind_name": mind.get("name", ""), "topic": topic, "essay": essay},
        headers={"Cache-Control": "public, max-age=3600, s-maxage=86400"},
    )


@app.get("/api/public-discussions/{session_id}")
def api_public_discussion(session_id: str) -> JSONResponse:
    """One approved public discussion as JSON (mirrors /discussions/{id}).
    404 unless the feature flag is on AND public_status='approved'. Message
    bodies pass through the same PII scrub used by the SSR renderer."""
    _require_ugc_enabled()
    session = get_chat_session_with_public_status(session_id)
    if not session or session.get("public_status") != "approved":
        raise HTTPException(status_code=404, detail="Discussion not found")
    try:
        raw_msgs = list_messages_for_public_session(session_id)
    except Exception:
        raw_msgs = []
    messages = [
        {
            "role": m.get("role", ""),
            "content": ugc_module.scrub_pii_for_public_display(m.get("content", "") or ""),
        }
        for m in raw_msgs
    ]
    return JSONResponse(
        content={
            "id": session_id,
            "title": session.get("public_title") or session.get("title") or "",
            "handle": session.get("public_handle") or "Anonymous",
            "session_type": session.get("session_type") or "",
            "entity_id": session.get("mind_id") or "",
            "approved_at": session.get("approved_at") or session.get("consent_at") or "",
            "messages": messages,
        },
        headers={"Cache-Control": "public, max-age=600, s-maxage=600"},
    )


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
        "category": (outline.get("category") or "").strip(),
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
    primary_name: str = ""
    primary_era: str = ""
    primary_domain: str = ""


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
    minds = list_minds(limit=5000)
    # Lazy seeding: seed 1 mind per request to stay within Vercel's 10s timeout
    if _IS_SERVERLESS and len(minds) < len(SEED_MINDS):
        seeded = _seed_minds_batch(_LAZY_SEED_SIZE)
        if seeded:
            minds = list_minds(limit=5000)
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
    # Expose a bounded, plain-text persona EXCERPT for the SEO "Core approach"
    # section. The legacy SSR rendered this (render_mind_persona_excerpt); the
    # JSON port lost it when the full persona got stripped, leaving every mind
    # page ~150 words thinner. The FULL persona stays private — it's
    # system-prompt-style text not meant for public display — but a ~900-char
    # excerpt is real, citable content. Mirrors seo.render_mind_persona_excerpt.
    persona = (mind.get("persona") or "").strip()
    mind.pop("persona", None)
    if persona:
        mind["persona_excerpt"] = (
            persona if len(persona) <= 900 else persona[:900].rsplit(" ", 1)[0] + "…"
        )
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
    duplicate = mind.pop("_duplicate", False)
    duplicate_reason = mind.pop("_duplicate_reason", None)
    similarity = mind.pop("_similarity", None)
    safe = {k: v for k, v in mind.items() if k != "persona"}
    if duplicate:
        # No new mind was created — skip quota debit and learn-agent tasks,
        # but tell the client so it can guide the user to the existing one.
        return {
            **safe,
            "duplicate": True,
            "duplicate_reason": duplicate_reason,
            "similarity": similarity,
        }
    from .core.db import get_mind_work_ids
    for agent_id in get_mind_work_ids(mind["id"]):
        agent = get_agent(agent_id)
        if agent and agent["status"] == "catalog":
            background_tasks.add_task(_learn_agent, agent_id)
    _track_usage(request, "custom_minds")
    return {**safe, "duplicate": False}


@app.post("/api/minds/suggest")
def api_suggest_minds(payload: MindSuggestRequest, request: Request) -> dict[str, Any]:
    _check_quota(request, "generate_mind")

    # Build a unified query text from whichever context the caller provided.
    if payload.book_title:
        query_text = payload.book_title
        if payload.book_author:
            query_text = f"{query_text} by {payload.book_author}"
    elif payload.topic:
        query_text = payload.topic
    else:
        raise HTTPException(status_code=400, detail="Provide book_title or topic")

    try:
        suggestions, usage = suggest_minds_hybrid(
            query_text=query_text,
            count=payload.count,
            exclude=payload.exclude,
            primary_name=payload.primary_name,
            primary_era=payload.primary_era,
            primary_domain=payload.primary_domain,
        )
    except ProviderError as exc:
        raise HTTPException(status_code=503, detail=str(exc))
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Suggestion failed: {exc}")

    # Defensive exclude filter in case a fallback path returned a name we already have.
    # Use normalized keys so 'Guo Xiang (郭象)' / '郭象 (Guō Xiàng)' collide.
    from .core.minds import mind_name_keys
    if payload.exclude:
        excluded_keys: set[str] = set()
        for n in payload.exclude:
            excluded_keys |= mind_name_keys(n)
        suggestions = [
            s for s in suggestions
            if not (mind_name_keys(s.get("name", "")) & excluded_keys)
        ]

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
