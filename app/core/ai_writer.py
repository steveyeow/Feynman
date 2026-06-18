from __future__ import annotations

import json
import logging
import re
import threading
from typing import Any

from .providers import ChatResult, ProviderError, chat_with_fallback

log = logging.getLogger(__name__)

_write_full_book_lock = threading.Lock()
_write_full_book_inflight: set[str] = set()

_OUTLINE_SYSTEM = (
    "You are a professional book author and editor. The user wants you to create a custom book. "
    "Based on their description, research the topic thoroughly and create a detailed book outline.\n\n"
    "Return ONLY a JSON object (no markdown fences) with these keys:\n"
    "- title: string (the book title)\n"
    "- subtitle: string (a short subtitle)\n"
    "- category: string (one broad subject category, e.g. 'History', 'Biography', 'Science', 'Philosophy', 'Business', 'Technology', 'Health', 'Art', 'Religion', 'Politics', 'Psychology', 'Literature', 'Economics', 'Cooking', 'Travel')\n"
    "- chapters: array of objects, each with:\n"
    "  - number: int\n"
    "  - title: string\n"
    "  - summary: string (1-2 sentences describing the chapter)\n"
    "  - key_points: array of strings (3-5 key topics covered)\n"
    "  - estimated_words: int\n\n"
    "Create between 6-15 chapters depending on the requested length. "
    "Make the outline compelling, well-structured, and tailored to the user's specific interests."
)

_REFINE_SYSTEM = (
    "You are a professional book author and editor helping a user refine their book outline. "
    "The current outline is provided below. The user wants to modify it.\n\n"
    "IMPORTANT: After your conversational response, you MUST include an updated outline as a JSON block. "
    "Wrap the JSON in ```json and ``` markers. The JSON must have the same structure: "
    "{title, subtitle, category, chapters: [{number, title, summary, key_points, estimated_words}]}.\n\n"
    "If the user's request doesn't require outline changes, return the outline unchanged. "
    "Always respond in the same language as the user."
)

_CHAPTER_SYSTEM = (
    "You are a professional book author writing a chapter for a custom book. "
    "Write engaging, well-researched content based on the provided outline and context.\n\n"
    "Guidelines:\n"
    "- Write in the style and tone specified by the user's preferences\n"
    "- Be thorough and informative, using real facts and examples\n"
    "- Maintain narrative flow and connection to previous chapters\n"
    "- Target the estimated word count for this chapter\n"
    "- Write in the language specified by the user\n"
    "- Do NOT include the chapter title as a heading (it's already known)\n"
    "- Output ONLY the chapter content text, no metadata"
)


def _parse_json_from_text(text: str) -> dict[str, Any] | None:
    """Extract JSON from text, handling markdown fences."""
    # Try direct parse first
    try:
        return json.loads(text.strip())
    except (json.JSONDecodeError, ValueError):
        pass
    # Try extracting from markdown code fences
    m = re.search(r"```(?:json)?\s*\n?(.*?)\n?```", text, re.DOTALL)
    if m:
        try:
            return json.loads(m.group(1).strip())
        except (json.JSONDecodeError, ValueError):
            pass
    # Try finding first { ... } block
    m = re.search(r"\{.*\}", text, re.DOTALL)
    if m:
        try:
            return json.loads(m.group(0))
        except (json.JSONDecodeError, ValueError):
            pass
    return None


def generate_outline(
    description: str,
    preferences: dict[str, Any] | None = None,
    language: str = "en",
) -> tuple[dict[str, Any], str, dict[str, int]]:
    """Generate a book outline from a user description.

    Returns (outline_dict, ai_message, usage_dict).
    """
    prefs = preferences or {}
    style = prefs.get("style", "conversational")
    length = prefs.get("length", "medium")

    length_guide = {"short": "6-8 chapters, ~20 pages total", "medium": "8-12 chapters, ~60 pages total", "long": "12-15 chapters, ~120 pages total"}
    lang_names = {"en": "English", "zh": "Chinese", "ja": "Japanese", "ko": "Korean", "es": "Spanish", "fr": "French", "de": "German"}

    user_prompt = (
        f"Create a book outline based on this description:\n\n{description}\n\n"
        f"Writing style: {style}\n"
        f"Target length: {length_guide.get(length, length_guide['medium'])}\n"
        f"Language: {lang_names.get(language, language)}\n"
    )
    if prefs.get("focus_areas"):
        user_prompt += f"Focus areas: {', '.join(prefs['focus_areas'])}\n"

    result, _ = chat_with_fallback(
        system=_OUTLINE_SYSTEM, user=user_prompt, use_grounding=True,
    )

    outline = _parse_json_from_text(result.content)
    if not outline or "chapters" not in outline:
        raise ProviderError("Failed to generate a valid outline. Please try again.")

    usage = _extract_usage(result)

    ai_message = (
        f"I've created an outline for **\"{outline.get('title', 'Your Book')}\"** — "
        f"{outline.get('subtitle', '')}. "
        f"It has {len(outline['chapters'])} chapters. "
        "Take a look and let me know if you'd like to adjust anything — "
        "reorder chapters, add new topics, change the focus, or modify the depth."
    )

    return outline, ai_message, usage


def refine_outline(
    current_outline: dict[str, Any],
    user_message: str,
    history: list[dict[str, str]] | None = None,
) -> tuple[dict[str, Any], str, dict[str, int]]:
    """Refine an outline based on user feedback.

    Returns (updated_outline, ai_response_text, usage_dict).
    """
    outline_str = json.dumps(current_outline, ensure_ascii=False, indent=2)
    system = f"{_REFINE_SYSTEM}\n\nCurrent outline:\n{outline_str}"

    # No grounding here: restructuring an existing outline needs no fresh web
    # research, and the Gemini google_search round-trips were the main cause of
    # refine timing out (→ all-providers-failed → 503). thinking_budget=0 keeps
    # this structural transform cheap + fast. A wider budget (45s × up to ~3
    # providers, vs the default 30/50 that only reaches ~2) routes around a slow
    # or hung first provider instead of dying before the healthy ones are tried.
    result, _ = chat_with_fallback(
        system=system, user=user_message, history=history,
        use_grounding=False, thinking_budget=0,
        timeout=45, max_total_seconds=120,
    )

    updated = _parse_json_from_text(result.content)
    if updated and "chapters" in updated:
        outline = updated
    else:
        outline = current_outline

    # Extract the conversational part (before the JSON block)
    response_text = result.content
    json_block = re.search(r"```(?:json)?\s*\n?.*?\n?```", response_text, re.DOTALL)
    if json_block:
        response_text = response_text[:json_block.start()].strip()
    if not response_text:
        response_text = "I've updated the outline based on your feedback."

    return outline, response_text, _extract_usage(result)


def write_chapter(
    outline: dict[str, Any],
    chapter: dict[str, Any],
    previous_summaries: list[str],
    preferences: dict[str, Any] | None = None,
    language: str = "en",
) -> tuple[str, dict[str, int]]:
    """Write a single chapter. Returns (chapter_content, usage_dict)."""
    prefs = preferences or {}
    style = prefs.get("style", "conversational")
    lang_names = {"en": "English", "zh": "Chinese", "ja": "Japanese", "ko": "Korean", "es": "Spanish", "fr": "French", "de": "German"}

    book_context = (
        f"Book: \"{outline.get('title', 'Untitled')}\" — {outline.get('subtitle', '')}\n"
        f"Total chapters: {len(outline.get('chapters', []))}\n"
        f"Writing style: {style}\n"
        f"Language: {lang_names.get(language, language)}\n"
    )

    if previous_summaries:
        prev_ctx = "\n".join(f"Ch.{i+1}: {s}" for i, s in enumerate(previous_summaries))
        book_context += f"\nPrevious chapters summary:\n{prev_ctx}\n"

    ch_outline = "\n".join(f"  {i+1}. {c['title']}: {c['summary']}" for i, c in enumerate(outline.get("chapters", [])))
    book_context += f"\nFull outline:\n{ch_outline}\n"

    user_prompt = (
        f"{book_context}\n"
        f"Now write Chapter {chapter['number']}: \"{chapter['title']}\"\n"
        f"Summary: {chapter['summary']}\n"
        f"Key points to cover: {', '.join(chapter.get('key_points', []))}\n"
        f"Target length: ~{chapter.get('estimated_words', 2000)} words\n"
    )

    # Chapter writing is a BACKGROUND task that emits a long (~2000-word),
    # grounded generation — routinely well over the 30s/50s interactive default,
    # which made a single slow chapter time out across the ~2 providers the
    # budget allowed and fail the whole book (it always died on the first
    # heavier chapter). Give it a background-sized budget so a long generation
    # has room and the fallback can reach every provider. Grounding stays on —
    # factual books benefit from it, and 120s accommodates the search latency.
    result, _ = chat_with_fallback(
        system=_CHAPTER_SYSTEM, user=user_prompt, use_grounding=True,
        timeout=120, max_total_seconds=300,
    )

    return result.content.strip(), _extract_usage(result)


def all_outline_chapters_have_content(book: dict[str, Any]) -> bool:
    """True when every chapter in the outline has saved body text."""
    outline = book.get("outline") or {}
    chapters = outline.get("chapters") or []
    if not chapters:
        return False
    content = book.get("content") or {}
    for ch in chapters:
        data = content.get(str(ch["number"]), {})
        if not (data.get("content") or "").strip():
            return False
    return True


def write_full_book(book_id: str) -> None:
    """Background task: write all chapters for an ai_book, then index it."""
    with _write_full_book_lock:
        if book_id in _write_full_book_inflight:
            log.debug("write_full_book already running for %s, skip duplicate", book_id)
            return
        _write_full_book_inflight.add(book_id)
    try:
        _write_full_book_impl(book_id)
    finally:
        with _write_full_book_lock:
            _write_full_book_inflight.discard(book_id)


def _write_full_book_impl(book_id: str) -> None:
    from .db import (
        get_ai_book,
        update_ai_book_chapter,
        update_ai_book_status,
        get_agent,
    )
    from .indexer import index_text

    book = get_ai_book(book_id)
    if not book or book["status"] not in ("confirmed", "writing", "failed"):
        return

    update_ai_book_status(book_id, "writing")

    outline = book["outline"]
    preferences = book["preferences"]
    language = preferences.get("language", "en")
    chapters = outline.get("chapters", [])
    previous_summaries: list[str] = []

    existing_content = book.get("content") or {}

    for ch in chapters:
        # Check for cancellation before starting each chapter
        current = get_ai_book(book_id)
        if not current or current["status"] == "cancelled":
            log.info("Book %s was cancelled, stopping at chapter %d", book_id, ch["number"])
            _index_partial_book(book_id)
            return

        ch_key = str(ch["number"])
        if existing_content.get(ch_key, {}).get("content"):
            previous_summaries.append(ch["summary"])
            log.info("Skipping already-written chapter %d for book %s", ch["number"], book_id)
            continue

        try:
            content, usage = write_chapter(
                outline, ch, previous_summaries,
                preferences=preferences, language=language,
            )
            word_count = len(content.split())
            update_ai_book_chapter(book_id, ch["number"], {
                "title": ch["title"],
                "content": content,
                "word_count": word_count,
            })
            previous_summaries.append(ch["summary"])
            log.info("Wrote chapter %d/%d for book %s", ch["number"], len(chapters), book_id)
        except Exception as exc:
            log.error("Failed writing chapter %d for book %s: %s", ch["number"], book_id, exc)
            update_ai_book_status(book_id, "failed", error=f"Chapter {ch['number']}: {exc}")
            return

    # Combine all chapters into full text for indexing
    book = get_ai_book(book_id)
    content_data = book["content"]
    full_text_parts = [f"# {outline.get('title', 'Untitled')}\n\n{outline.get('subtitle', '')}\n"]
    for ch in chapters:
        ch_key = str(ch["number"])
        ch_data = content_data.get(ch_key, {})
        if ch_data.get("content"):
            full_text_parts.append(f"\n## Chapter {ch['number']}: {ch['title']}\n\n{ch_data['content']}")

    full_text = "\n".join(full_text_parts)

    try:
        agent_id = book["agent_id"]
        index_text(agent_id, full_text)
        update_ai_book_status(book_id, "completed")
        log.info("Book %s completed and indexed (%s)", book_id, outline.get("title"))
    except Exception as exc:
        log.error("Indexing failed for book %s: %s", book_id, exc)
        update_ai_book_status(book_id, "failed", error=f"Indexing: {exc}")


def _index_partial_book(book_id: str) -> None:
    """Index whatever chapters have been written so far (for cancelled books)."""
    from .db import get_ai_book
    from .indexer import index_text

    book = get_ai_book(book_id)
    if not book:
        return
    outline = book["outline"]
    content_data = book.get("content") or {}
    chapters = outline.get("chapters", [])

    parts = [f"# {outline.get('title', 'Untitled')}\n\n{outline.get('subtitle', '')}\n"]
    has_content = False
    for ch in chapters:
        ch_data = content_data.get(str(ch["number"]), {})
        if ch_data.get("content"):
            parts.append(f"\n## Chapter {ch['number']}: {ch['title']}\n\n{ch_data['content']}")
            has_content = True

    if has_content:
        try:
            index_text(book["agent_id"], "\n".join(parts))
            log.info("Indexed partial book %s (%d chapters)", book_id, book.get("chapters_written", 0))
        except Exception as exc:
            log.error("Failed indexing partial book %s: %s", book_id, exc)


def _extract_usage(result: ChatResult) -> dict[str, int]:
    if result.usage:
        return {
            "input_tokens": result.usage.input_tokens,
            "output_tokens": result.usage.output_tokens,
            "total_tokens": result.usage.total_tokens,
        }
    return {"input_tokens": 0, "output_tokens": 0, "total_tokens": 0}
