"""Live AI output indexing — Phase 8 of the SEO/GEO plan.

Mines the AI's responses from real chat sessions and surfaces them as
standalone SEO/GEO pages. The unique content supply we add to the
internet: aggregated AI-mediated commentary on books and great minds,
shaped by what real readers actually ask, refreshed continuously.

Privacy posture (must hold — see docs/seo-geo-master-plan.md Section 3.5
Type 4 for the full rationale):

  * Extraction only pulls ``role = 'assistant'`` rows. User queries
    are never touched by this module.
  * Sanitization strips user-context echoes from each AI response so
    the rendered text reads as standalone commentary, not as a reply
    to a specific person.
  * Aggregate-only display — the render layer mixes many sessions; no
    single chat is identifiable from a rendered page.
  * No user opt-in needed — nothing user-generated is being published.
    (Document this in the privacy policy when shipping.)

Implementation is intentionally MVP-shaped (Phase 8.1):

  * No topic clustering yet (Phase 8.2 will add that).
  * No LLM synthesis layer yet (Phase 8.3 will add that).
  * The MVP renders the N most-recent sanitized AI messages per entity
    so we can ship and observe quality before investing in the heavier
    aggregation layers.
"""
from __future__ import annotations

import os
import re
from typing import Any


# Module-level kill switch in case sanitization quality regresses or
# something unexpected leaks in production. Default ON because, unlike
# the LLM-cost-bearing features (ENABLE_QA_LLM / ENABLE_MIND_ESSAY),
# this only renders data we already have — there's no per-page cost.
_INSIGHTS_ENABLED = os.getenv("ENABLE_AI_INSIGHTS", "true").strip().lower() not in (
    "0", "false", "no", "off",
)


def is_enabled() -> bool:
    return _INSIGHTS_ENABLED


# ─── Sanitization ─────────────────────────────────────────────────────
#
# The patterns below catch the common ways an LLM response references
# the user's specific question or situation. Conservative — better to
# over-strip than leak. Sentences that match are removed; the remaining
# text must still read coherently as standalone commentary.

# Each pattern matches a meta-reference clause. The terminator class
# includes commas and colons in addition to sentence-enders so we
# strip the clause "As you asked about X," without consuming the
# substantive answer that follows.
_CLAUSE_END = r"[^.!?,:\n]*[.!?,:\n]"

_USER_ECHO_PATTERNS = [
    # "as you asked / mentioned / noted / said / put it / described, …"
    re.compile(
        r"\b(?:as\s+you\s+(?:asked|mentioned|noted|said|put\s+it|described|wrote|shared|pointed\s+out))\b" + _CLAUSE_END,
        re.IGNORECASE,
    ),
    # "your question about X is…"  / "your inquiry on X is…"
    re.compile(
        r"\byour\s+(?:question|inquiry|point|concern|interest|curiosity|query)\s+(?:about|on|regarding|of|in|with)\b" + _CLAUSE_END,
        re.IGNORECASE,
    ),
    # "the situation / scenario / case / context you described, …"
    re.compile(
        r"\bthe\s+(?:situation|scenario|case|context|example|story)\s+you\s+(?:described|outlined|mentioned|shared|gave|provided|presented)\b" + _CLAUSE_END,
        re.IGNORECASE,
    ),
    # Polite acknowledgments
    re.compile(
        r"\b(?:thanks?|thank\s+you)\s+for\s+(?:your\s+)?(?:question|inquiry|interest|point|comment|message|the\s+question)\b" + _CLAUSE_END,
        re.IGNORECASE,
    ),
    # "to (address|answer|respond to) your X, …"
    re.compile(
        r"\bto\s+(?:address|answer|respond\s+to|tackle|engage\s+with)\s+your\b" + _CLAUSE_END,
        re.IGNORECASE,
    ),
    # "in response to (what|your) X, …"
    re.compile(
        r"\bin\s+response\s+to\s+(?:what|your)\b" + _CLAUSE_END,
        re.IGNORECASE,
    ),
    # Opening "Great question" / "Good question" / "Interesting question"
    re.compile(
        r"\b(?:great|good|interesting|fascinating|excellent|thoughtful)\s+question\b" + _CLAUSE_END,
        re.IGNORECASE,
    ),
    # "I understand you're asking / wondering / curious about, …"
    re.compile(
        r"\bI\s+(?:understand|see|gather)\s+(?:that\s+)?you(?:'re|\s+are)\s+(?:asking|wondering|curious|interested|looking)\b" + _CLAUSE_END,
        re.IGNORECASE,
    ),
    # Sentences starting with "You …" — these address the user directly.
    # Still uses the full sentence terminator (not comma), because if a
    # sentence begins addressing the user, the entire sentence is
    # user-facing rather than substantive commentary.
    re.compile(
        r"(?:^|(?<=[.!?\n]))\s*You(?:'re|\s+are|\s+were|\s+have|\s+will|\s+should|\s+might|\s+may|\s+can|\s+could|\s+would|\s+know|\s+see|\s+seem|\s+want|\s+need|\s+ask|\s+mention)\b[^.!?\n]*[.!?]",
    ),
]

# Bullet/numbered lines that start "You": some LLM responses use bullet lists
# addressing the user. Strip the whole line.
_USER_ADDRESS_LINE = re.compile(
    r"^\s*(?:[-*•]|\d+[\).])\s*You(?:'re|\s+are|\s+have|\s+can|\s+may|\s+might|\s+should|\s+would)\b[^\n]*\n?",
    re.IGNORECASE | re.MULTILINE,
)


def sanitize_assistant_message(text: str) -> str:
    """Strip user-context echoes from an assistant message. Returns the
    cleaned text, or empty string if the result is too short / empty to
    be useful (caller should then skip rendering)."""
    if not text:
        return ""
    out = text
    for pat in _USER_ECHO_PATTERNS:
        out = pat.sub(" ", out)
    out = _USER_ADDRESS_LINE.sub("", out)
    # Collapse whitespace introduced by removals
    out = re.sub(r"\n{3,}", "\n\n", out)
    out = re.sub(r"[ \t]{2,}", " ", out)
    out = re.sub(r"\s+\n", "\n", out)
    return out.strip()


# Minimum length post-sanitization. Below this, the response is
# probably either a stub ("Sorry, I don't know.") or sanitization
# stripped too much.
_MIN_INSIGHT_CHARS = 200

# Patterns that mark low-information openings — skip even if length OK.
_LOW_QUALITY_OPENERS = (
    "sorry", "i don't know", "i don't have", "i'm not sure",
    "i apologize", "i cannot", "i can't",
    "unfortunately", "no information", "no specific",
)


def is_publishable_insight(text: str) -> bool:
    """Quality gate: should this sanitized message be rendered as a
    public insight? Conservative — we'd rather render fewer high-quality
    snippets than a wall of low-substance text."""
    if not text or len(text) < _MIN_INSIGHT_CHARS:
        return False
    head = text[:80].lower()
    if any(head.startswith(p) for p in _LOW_QUALITY_OPENERS):
        return False
    return True


def select_publishable(messages: list[dict[str, Any]], limit: int = 10) -> list[dict[str, Any]]:
    """Take raw assistant messages, sanitize each, filter to publishable
    ones, dedupe identical results, and cap at ``limit``.

    Two-pass sanitization for defense in depth:
      1. ``sanitize_assistant_message`` strips user-context echoes
         ("as you asked", "your question about X", etc.).
      2. ``ugc.scrub_pii_for_public_display`` redacts emails, phone
         numbers, URLs, and @handles — in case the AI ever echoed any
         user-supplied PII back in its response. Same scrubber the
         Phase 6 /discussions pages use, so behavior is consistent.

    Returns a list of {text, created_at} dicts ready for render.
    Session IDs are intentionally dropped — the render must NOT be
    traceable to a single session.
    """
    # Local import to avoid a top-level circular: ugc imports nothing
    # from insights, but seo.py imports both — keeping this lazy means
    # insights.py stays leaf-importable.
    from . import ugc

    seen_prefixes: set[str] = set()
    out: list[dict[str, Any]] = []
    for m in messages:
        raw = m.get("content") or ""
        sanitized = sanitize_assistant_message(raw)
        sanitized = ugc.scrub_pii_for_public_display(sanitized)
        if not is_publishable_insight(sanitized):
            continue
        # Cheap near-duplicate guard: bucket on first 120 chars
        head = sanitized[:120].strip().lower()
        if head in seen_prefixes:
            continue
        seen_prefixes.add(head)
        out.append({
            "text": sanitized,
            "created_at": m.get("created_at", ""),
        })
        if len(out) >= limit:
            break
    return out
