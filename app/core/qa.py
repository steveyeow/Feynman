"""Grounded Q&A generation for /book/{id}/q/{slug} compound pages.

The compound URL pattern (Phase 4A of the SEO/GEO plan) creates one
indexable URL per popular question per book — 5 questions × hundreds of
books = thousands of new long-tail entry points. Each page needs an
answer that's:

  * Grounded in the book's own chunks (no hallucination — every claim
    traces back to a retrieved passage).
  * Cheap enough to generate at crawler request time without bankrupting
    us if Googlebot decides to enumerate everything in a day.
  * Cacheable across requests so the second hit on a popular page is free.

We use the existing RAG `retrieve()` pipeline to fetch the top passages,
then call the LLM with a strict "synthesize ONLY from these passages"
prompt. Answers are cached in-process; a missed cache (cold start, new
URL) costs ~1 LLM round trip. Cache key is content-addressable on
(agent_id, question) so renaming a question naturally invalidates the
old answer.
"""
from __future__ import annotations

import logging
import os
import re
from typing import Any

from .providers import bulk_chat, ProviderError
from .rag import retrieve, build_context

log = logging.getLogger(__name__)


# Kill switch — set ENABLE_QA_LLM=false in env to render Q&A pages with
# passages only (no synthesized answer). Useful if cost gets unexpectedly
# high or if we want to A/B test the LLM contribution to ranking.
_QA_LLM_ENABLED = os.getenv("ENABLE_QA_LLM", "true").strip().lower() not in (
    "0", "false", "no", "off",
)

# Maximum chunks fed to the answer-synthesis prompt. Keep small to bound
# both token cost and the chance the model wanders off into adjacent
# material that doesn't address the question.
_QA_RAG_TOP_K = 5

# Hard cap on synthesized answer length so we don't render an essay where
# we promised a paragraph.
_QA_ANSWER_MAX_CHARS = 1200


def is_llm_enabled() -> bool:
    """Whether the module will attempt LLM synthesis. Handlers should still
    render passages even if this is False — the page degrades to a
    "question + sources" view, which is also valuable."""
    return _QA_LLM_ENABLED


# Kill switch for the mind-on-topic generator (Phase 4B). Separate flag
# from QA so we can run book Q&A in prod and stage mind essays behind
# an opt-in until we're confident about quality.
_MIND_ESSAY_ENABLED = os.getenv("ENABLE_MIND_ESSAY", "true").strip().lower() not in (
    "0", "false", "no", "off",
)

_MIND_ESSAY_MAX_CHARS = 1800
_MIND_ESSAY_MIN_DOMAIN_OVERLAP_CHARS = 3


def is_mind_essay_enabled() -> bool:
    return _MIND_ESSAY_ENABLED


def _morphological_stem(word: str) -> str:
    """Lightweight suffix-stripping so 'Economics' ↔ 'Economy' ↔
    'Economic' all collapse to a common 'econom' base. Not a real
    stemmer — enough for the 15 hand-picked TOPIC_TAGS vs the ~50
    hand-curated mind domains. False positives are acceptable; we'd
    rather generate one borderline-relevant essay than skip a real
    match."""
    w = word.lower()
    for suffix in ("ical", "ics", "ing", "ed", "al", "ly", "es", "s", "y"):
        if len(w) > len(suffix) + 3 and w.endswith(suffix):
            return w[: -len(suffix)]
    return w


def is_mind_topic_relevant(mind: dict[str, Any], topic: str) -> bool:
    """Cheap pre-flight check: does this mind have any plausible connection
    to this topic? Skips generation for nonsensical pairs (e.g. Confucius
    on Computer Science) before we spend an LLM call on slop.

    Matching is morphologically loose: 'Economics' picks up 'Political
    Economy', 'Philosophy' picks up 'Philosophical', etc. False positives
    are acceptable — the LLM essay prompt will still produce something
    coherent for a borderline match — but obvious mismatches still 404.
    """
    if not mind or not topic:
        return False
    domain = (mind.get("domain") or "").lower()
    if not domain:
        return False
    # Stem each domain token once
    domain_stems = [_morphological_stem(t) for t in re.split(r"[,\s]+", domain) if t]
    domain_blob = " ".join(domain_stems)

    topic_lower = topic.lower()
    # Whole-topic substring check on raw text — fast path for exact matches
    if topic_lower in domain:
        return True

    # Tokenize topic, stem each, check against the stemmed domain blob.
    skip = {"and", "the", "of", "in", "on", "for", "to", "&"}
    for raw_token in re.split(r"[,\s&]+", topic_lower):
        if len(raw_token) < _MIND_ESSAY_MIN_DOMAIN_OVERLAP_CHARS or raw_token in skip:
            continue
        stem = _morphological_stem(raw_token)
        if len(stem) < _MIND_ESSAY_MIN_DOMAIN_OVERLAP_CHARS:
            continue
        if stem in domain_blob:
            return True
    return False


def generate_mind_on_topic_essay(
    mind: dict[str, Any], topic: str
) -> dict[str, Any]:
    """Generate a short essay framed as the mind's perspective on the
    topic. Grounded in the mind's persona / thinking_style / typical
    phrases, not free-form invention.

    Returns {essay, provider}. essay may be empty if disabled or failed —
    callers should not render an empty essay (handle 404 or fall back).
    """
    result: dict[str, Any] = {"essay": "", "provider": ""}
    if not _MIND_ESSAY_ENABLED:
        return result
    if not mind or not topic:
        return result
    if not is_mind_topic_relevant(mind, topic):
        return result

    name = (mind.get("name") or "").strip()
    bio = (mind.get("bio_summary") or "").strip()
    thinking_style = (mind.get("thinking_style") or "").strip()
    persona = (mind.get("persona") or "").strip()[:1500]
    phrases = mind.get("typical_phrases") or []
    if not isinstance(phrases, list):
        phrases = []
    phrases_str = "\n".join(f"- \"{p}\"" for p in phrases[:5] if p)

    system = (
        "You are writing a short imagined-perspective essay in the voice "
        "of a specific historical or contemporary thinker. Stay strictly "
        "in their authentic frame — use the methods, values, and concerns "
        "their actual work exhibits. Do not put modern slang or modern "
        "specific facts in their mouth they could not know. Begin "
        "immediately with the essay — no preamble like 'Sure, here is...'."
    )
    user = (
        f"Thinker: {name}\n"
        f"Brief bio: {bio}\n"
        f"Thinking style: {thinking_style}\n"
        f"Characteristic phrases:\n{phrases_str}\n"
        f"Persona notes:\n{persona}\n\n"
        f"Write a 200-350 word essay imagining how {name} would approach "
        f"the topic of \"{topic}\". Stay in their voice and methodology. "
        f"If their era didn't have this framing, address it through the "
        f"underlying problem they would have recognized."
    )
    try:
        chat_result, provider_obj = bulk_chat(system=system, user=user)
        text = (chat_result.content or "").strip()
        provider_name = getattr(provider_obj, "name", "") or ""
    except ProviderError as exc:
        log.warning("Mind essay failed for %s on %s: %s", name, topic, exc)
        return result
    except Exception as exc:
        log.warning("Mind essay unexpected error %s/%s: %s", name, topic, exc)
        return result

    if not text:
        return result
    if len(text) > _MIND_ESSAY_MAX_CHARS:
        text = text[:_MIND_ESSAY_MAX_CHARS].rsplit(" ", 1)[0] + "…"
    result["essay"] = text
    result["provider"] = provider_name
    return result


def generate_grounded_answer(
    agent_id: str,
    question: str,
    *,
    book_title: str = "",
) -> dict[str, Any]:
    """Synthesize a short answer to ``question`` using only RAG-retrieved
    chunks from the given book.

    Returns a dict with:
      * ``answer``    — string (may be empty if generation failed or
                         LLM disabled; caller decides whether to render).
      * ``passages``  — list of chunk dicts {chunk_index, text} used as
                         sources; always populated when chunks exist.
      * ``provider``  — name of the provider that answered, or "".

    Never raises — failures degrade to empty answer + whatever passages
    we did manage to retrieve. The Q&A page handler decides how to render."""
    result: dict[str, Any] = {"answer": "", "passages": [], "provider": ""}
    if not question or not agent_id:
        return result

    # ── Retrieve grounding passages ────────────────────────────────
    try:
        passages = retrieve(agent_id, question, top_k=_QA_RAG_TOP_K)
    except Exception as exc:
        log.warning("QA retrieve failed for agent=%s: %s", agent_id, exc)
        passages = []
    # Strip vector/score fields we don't need downstream
    result["passages"] = [
        {"chunk_index": p.get("chunk_index"), "text": (p.get("text") or "").strip()}
        for p in passages
        if (p.get("text") or "").strip()
    ]
    if not result["passages"]:
        return result

    if not _QA_LLM_ENABLED:
        return result

    # ── Synthesize answer ───────────────────────────────────────────
    context = build_context(passages)
    title_hint = f" from the book \"{book_title}\"" if book_title else ""
    system = (
        "You are a careful reader who answers questions strictly using the "
        "provided book passages. If the passages do not contain the answer, "
        "say so plainly. Never invent details. Never reference outside "
        "sources. Cite chapter numbers using the bracket notation [n] that "
        "appears in the passages."
    )
    user = (
        f"Question{title_hint}:\n{question}\n\n"
        f"Passages:\n{context}\n\n"
        "Write a concise answer (2-3 short paragraphs, max ~250 words). "
        "Ground every claim in the passages and use [n] citations. "
        "If the passages don't contain enough to answer the question fully, "
        "say what they do say and what's missing."
    )
    try:
        chat_result, provider_obj = bulk_chat(system=system, user=user)
        text = (chat_result.content or "").strip()
        provider_name = getattr(provider_obj, "name", "") or ""
    except ProviderError as exc:
        log.warning("QA chat failed for agent=%s: %s", agent_id, exc)
        return result
    except Exception as exc:
        log.warning("QA chat unexpected error agent=%s: %s", agent_id, exc)
        return result

    if not text:
        return result
    if len(text) > _QA_ANSWER_MAX_CHARS:
        text = text[:_QA_ANSWER_MAX_CHARS].rsplit(" ", 1)[0] + "…"
    result["answer"] = text
    result["provider"] = provider_name
    return result
