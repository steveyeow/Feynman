"""On-demand "About this book" overview + key concepts for /book/{id} hubs.

Bucket B of the SEO/GEO content plan: the entity hub pages were thin
(title + author + a synthesized one-liner — ~90 words). This module gives
each book a unique, substantive overview paragraph plus a short list of key
concepts, so the hub clears the "substantive floor" (≈500–800 words with the
passages/questions sections) on the FIRST crawl — no upfront batch job.

Two grounding modes, mirroring qa.generate_grounded_answer:
  * Real books (have indexed chunks): RAG-retrieve representative passages
    and synthesize strictly from them — no hallucination.
  * Catalog stubs (no full text): synthesize from title/author/category and
    the model's general knowledge of that *specific, real* published book,
    with an explicit "don't invent specifics" guard so an obscure stub
    degrades to a careful subject-level description instead of fabrication.

Generated at crawler request time and cached at the endpoint (in-process TTL
+ edge Cache-Control), exactly like the Q&A and mind-essay generators. A cold
miss costs ~1 LLM round trip; every hit after is free.
"""
from __future__ import annotations

import logging
import os
from typing import Any

from .providers import bulk_chat, ProviderError
from .rag import retrieve, build_context

log = logging.getLogger(__name__)

# Kill switch — ENABLE_BOOK_OVERVIEW=false renders hubs without the generated
# overview (they still have passages / questions / TOC, just thinner).
_OVERVIEW_ENABLED = os.getenv("ENABLE_BOOK_OVERVIEW", "true").strip().lower() not in (
    "0", "false", "no", "off",
)

_OVERVIEW_RAG_TOP_K = 6
_OVERVIEW_MAX_CHARS = 1400          # overview prose hard cap
_CONCEPT_MAX = 6                    # at most N key-concept bullets
_CONCEPT_NOTE_MAX_CHARS = 220


def is_enabled() -> bool:
    return _OVERVIEW_ENABLED


def _parse(text: str) -> dict[str, Any]:
    """Parse the delimited OVERVIEW/CONCEPTS format into {overview, concepts}.

    Robust to the model omitting the CONCEPTS block: whatever precedes it (or
    the whole text) becomes the overview. Each concept line is "Term: note".
    """
    overview = text.strip()
    concepts: list[dict[str, str]] = []

    upper = text.upper()
    idx = upper.find("CONCEPTS:")
    if idx != -1:
        overview = text[:idx].strip()
        for raw in text[idx + len("CONCEPTS:"):].splitlines():
            line = raw.strip().lstrip("-*•").strip()
            if not line or ":" not in line:
                continue
            term, _, note = line.partition(":")
            term = term.strip().strip("*").strip()
            note = note.strip()
            if term and note:
                if len(note) > _CONCEPT_NOTE_MAX_CHARS:
                    note = note[:_CONCEPT_NOTE_MAX_CHARS].rsplit(" ", 1)[0] + "…"
                concepts.append({"term": term, "note": note})
            if len(concepts) >= _CONCEPT_MAX:
                break

    # Strip a leading "OVERVIEW:" label if the model echoed it.
    if overview.upper().startswith("OVERVIEW:"):
        overview = overview[len("OVERVIEW:"):].strip()
    if len(overview) > _OVERVIEW_MAX_CHARS:
        overview = overview[:_OVERVIEW_MAX_CHARS].rsplit(" ", 1)[0] + "…"

    return {"overview": overview, "concepts": concepts}


def generate_book_overview(
    agent: dict[str, Any], book: dict[str, Any] | None = None
) -> dict[str, Any]:
    """Return {overview, concepts, grounded, provider}.

    ``overview`` may be empty if disabled or the LLM failed — callers must
    degrade gracefully (the hub falls back to its synthesized about-line).
    Never raises.
    """
    result: dict[str, Any] = {
        "overview": "", "concepts": [], "grounded": False, "provider": "",
    }
    if not _OVERVIEW_ENABLED or not agent:
        return result

    agent_id = agent.get("id") or ""
    meta = agent.get("meta") or {}

    # Pre-stored overview wins (lets a future batch job write meta.overview /
    # meta.key_concepts and skip the per-render LLM call entirely — the hot
    # book-hub path then has zero generation latency). Lazy gen below is the
    # fallback that fills on first crawl when nothing is pre-stored.
    stored = (meta.get("overview") or "").strip()
    if stored:
        concepts = meta.get("key_concepts") or []
        if not isinstance(concepts, list):
            concepts = []
        return {
            "overview": stored,
            "concepts": [c for c in concepts if isinstance(c, dict) and c.get("term") and c.get("note")][:_CONCEPT_MAX],
            "grounded": bool(meta.get("overview_grounded")),
            "provider": "stored",
        }

    title = (meta.get("title") or agent.get("name") or "").strip()
    if not title:
        return result
    author = (meta.get("author") or agent.get("source") or "").strip()
    category = (meta.get("category") or "").strip()
    subtitle = ""
    outline = meta.get("outline") or {}
    if isinstance(outline, dict):
        subtitle = (outline.get("subtitle") or "").strip()

    # ── Try to ground in the book's own passages ───────────────────────
    passages: list[dict[str, Any]] = []
    try:
        query = f"{title}: central argument, main themes, and key ideas"
        passages = retrieve(agent_id, query, top_k=_OVERVIEW_RAG_TOP_K)
    except Exception as exc:
        log.warning("overview retrieve failed for %s: %s", agent_id, exc)
        passages = []

    by = f" by {author}" if author else ""
    if passages:
        context = build_context(passages)
        system = (
            "You write concise, accurate, SPECIFIC book overviews for a reading "
            "app. Use ONLY the provided passages — do not invent claims they "
            "don't support. Lead with the book's actual central argument in "
            "concrete terms and name its real ideas, models, and terms, so a "
            "reader learns something only THIS book offers. Avoid generic "
            "filler — never write phrases like 'explores the fundamental "
            "principle', 'delves into', 'provides a framework for', 'in today's "
            "world', or 'Readers engage with this book to…'. Neutral, "
            "informative tone. Begin immediately, no preamble."
        )
        user = (
            f'Book: "{title}"{by}\n'
            f"Passages from the book:\n{context}\n\n"
            "Write the output in exactly this format:\n"
            "OVERVIEW:\n<2 short paragraphs (120-200 words). Open with the "
            "book's central argument stated concretely, then its main themes "
            "and what a reader takes away — all grounded in the passages>\n\n"
            "CONCEPTS:\n- <Specific idea/model/term>: <one-sentence "
            "explanation>\n"
            "- <Specific idea/model/term>: <one-sentence explanation>\n"
            "(4-6 concepts, each a real, specifically-named idea from the "
            "passages — not a generic theme.)"
        )
        grounded = True
    else:
        # Stub: no indexed text. Lean on the model's knowledge of this real,
        # published book, with a hard guard against fabrication.
        cat = f" It is generally shelved under {category}." if category else ""
        system = (
            "You write concise, accurate, SPECIFIC overviews of real published "
            "books. If you are confident about the exact book, state its actual "
            "central thesis and name its real key ideas — be concrete, not "
            "generic. If you are NOT confident about this exact title, do NOT "
            "invent specifics — instead describe the subject area in general "
            "terms. Avoid filler — never write phrases like 'explores the "
            "fundamental principle', 'delves into', 'provides a framework for', "
            "'in today's world', or 'Readers engage with this book to…'. "
            "Neutral tone. Begin immediately, no preamble."
        )
        user = (
            f'Book: "{title}"{by}.{cat}\n\n'
            "Write the output in exactly this format:\n"
            "OVERVIEW:\n<2 short paragraphs (120-200 words). Open with the "
            "book's central thesis stated concretely (if you know it), then its "
            "main ideas and what a reader takes away>\n\n"
            "CONCEPTS:\n- <Specific idea/term>: <one-sentence explanation>\n"
            "- <Specific idea/term>: <one-sentence explanation>\n"
            "(4-6 concepts, specifically named. If unsure about the exact book, "
            "make these about the subject area, not invented plot/claims.)"
        )
        grounded = False

    if subtitle:
        user += f'\n\n(The book\'s own subtitle/description: "{subtitle}")'

    try:
        chat_result, provider_obj = bulk_chat(system=system, user=user)
        text = (chat_result.content or "").strip()
        provider_name = getattr(provider_obj, "name", "") or ""
    except ProviderError as exc:
        log.warning("overview gen failed for %s: %s", agent_id, exc)
        return result
    except Exception as exc:
        log.warning("overview gen unexpected error %s: %s", agent_id, exc)
        return result

    if not text:
        return result

    parsed = _parse(text)
    if not parsed["overview"]:
        return result
    parsed["grounded"] = grounded
    parsed["provider"] = provider_name
    return parsed


def prestore_overviews(batch_size: int = 6) -> tuple[int, int, list[dict[str, Any]]]:
    """Generate + persist overviews for ready books that lack one. Returns
    (stored, remaining, details) — details carries per-book timing/provider/
    error so the caller (cron response → drain-loop logs) is self-diagnosing.

    Runs on Vercel (the cron) because grounded mode embeds the RAG query via
    Gemini, which is geoblocked from the dev machine — the embed-minds
    constraint. Bounded per call to stay inside the function timeout; each
    stored overview is permanent (generate_book_overview short-circuits on
    meta.overview), so the daily schedule self-fills new books and a manual
    loop drains a backlog. Empty generations (transient LLM failure) are NOT
    stored and retry on the next run."""
    import time as _time
    from concurrent.futures import ThreadPoolExecutor, TimeoutError as _FTimeout
    from app.core.db import get_agent, list_agents_missing_overview, update_agent_meta

    _PER_BOOK_TIMEOUT_S = 25.0   # hard cap per generation — a hung provider
    _TIME_BUDGET_S = 40.0        # stop starting new books past this elapsed
    #                              (the first drain attempt hung indefinitely
    #                              inside one generation and the whole call
    #                              died at the platform limit storing nothing)

    started = _time.time()
    ids, total = list_agents_missing_overview(limit=batch_size)
    stored = 0
    details: list[dict[str, Any]] = []
    with ThreadPoolExecutor(max_workers=1) as pool:
        for agent_id in ids:
            if _time.time() - started > _TIME_BUDGET_S:
                details.append({"id": agent_id[:8], "skipped": "time budget"})
                break
            t0 = _time.time()
            agent = get_agent(agent_id)
            if not agent:
                details.append({"id": agent_id[:8], "err": "not found"})
                continue
            fut = pool.submit(generate_book_overview, agent)
            try:
                result = fut.result(timeout=_PER_BOOK_TIMEOUT_S)
            except _FTimeout:
                # Abandon this book for now (the worker thread is left to
                # finish/die with the invocation); the next run retries it.
                details.append({"id": agent_id[:8], "err": "timeout",
                                "ms": int((_time.time() - t0) * 1000)})
                break  # a hung provider would just eat the remaining budget
            except Exception as exc:  # generate never raises, but belt+braces
                details.append({"id": agent_id[:8], "err": str(exc)[:80]})
                continue
            ms = int((_time.time() - t0) * 1000)
            text = (result.get("overview") or "").strip()
            if not text:
                details.append({"id": agent_id[:8], "err": "empty", "ms": ms,
                                "provider": result.get("provider", "")})
                continue
            update_agent_meta(agent_id, {
                "overview": text,
                "key_concepts": result.get("concepts") or [],
                "overview_grounded": bool(result.get("grounded")),
            })
            stored += 1
            details.append({"id": agent_id[:8], "ok": True, "ms": ms,
                            "grounded": bool(result.get("grounded")),
                            "provider": result.get("provider", "")})
    return stored, max(0, total - stored), details


_TOPIC_OVERVIEW_MAX_CHARS = 1200


def generate_topic_overview(topic: str) -> dict[str, Any]:
    """Return {overview, provider} — a unique 2-paragraph intro to a field for
    the /topic/{slug} hub, so the hub is a destination, not a bare link list.
    Never raises; empty degrades to the existing one-line intro."""
    result: dict[str, Any] = {"overview": "", "provider": ""}
    if not _OVERVIEW_ENABLED or not topic:
        return result

    system = (
        "You write concise, substantive introductions to fields of knowledge "
        "for a reading app where people chat with the canonical books and the "
        "great thinkers of each field. Neutral, informative. Begin immediately, "
        "no preamble."
    )
    user = (
        f'Field: "{topic}"\n\n'
        f"Write 2 short paragraphs (130-200 words total) introducing {topic} as "
        "a field: the central questions it asks, the tensions or schools that "
        "define it, and why a curious reader would explore its canon and its "
        "great thinkers. Do NOT list specific book titles or author names — "
        "those are shown separately on the page. No headings."
    )
    try:
        chat_result, provider_obj = bulk_chat(system=system, user=user)
        text = (chat_result.content or "").strip()
        provider_name = getattr(provider_obj, "name", "") or ""
    except ProviderError as exc:
        log.warning("topic overview failed for %s: %s", topic, exc)
        return result
    except Exception as exc:
        log.warning("topic overview unexpected error %s: %s", topic, exc)
        return result

    if not text:
        return result
    if len(text) > _TOPIC_OVERVIEW_MAX_CHARS:
        cut = text[:_TOPIC_OVERVIEW_MAX_CHARS]
        # Prefer ending on a sentence boundary so the intro doesn't trail off
        # mid-thought ("…applicable to…"); fall back to a word boundary + ellipsis.
        end = max(cut.rfind(". "), cut.rfind("! "), cut.rfind("? "))
        text = cut[:end + 1] if end > _TOPIC_OVERVIEW_MAX_CHARS // 2 else cut.rsplit(" ", 1)[0] + "…"
    result["overview"] = text
    result["provider"] = provider_name
    return result
