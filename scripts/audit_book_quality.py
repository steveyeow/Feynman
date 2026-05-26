"""Audit book-agent data quality — find books whose indexed content
doesn't actually match what their landing page claims.

Why this exists
---------------
Real example from production (2026-05-26): the page
``feynman.wiki/book/{id}/q/{question}`` for an agent named "A World
Brewed" returned an LLM answer saying *"The provided passages do not
contain information about 'A World Brewed.' The only passage given
details a different book: 'CAMRAs Essential Home Brewing'"*.

The code worked correctly — the LLM honestly admitted the data
mismatch. But that page is now a low-quality result in Google's eyes
and degrades the site-wide quality score. The root cause is upstream
data: the agent row's ``name`` doesn't match the chunks loaded under
its ``agent_id``.

This script scans every ready/catalog book agent and classifies it
into one of four buckets:

  HIGH    — substantial content (>= 1000 words) AND >= 10 chunks
            AND has questions AND first-chunk text mentions the book name
  MEDIUM  — moderate content (>= 200 words) AND >= 3 chunks
  LOW     — minimal content (>= 1 chunk but below MEDIUM bar)
  STUB    — zero chunks (catalog stub only; chat-only capable)
  MISMATCH — first chunk text mentions a DIFFERENT book title than the
            agent name (high-confidence data corruption)

Output is a CSV-style report to stdout plus a summary to stderr. Use
the output to decide which books to re-index, delete, or exclude from
indexing pipelines.

Usage
-----
  python -m scripts.audit_book_quality                # full audit
  python -m scripts.audit_book_quality --limit 50    # first 50 only
  python -m scripts.audit_book_quality --only-bad    # MISMATCH + LOW only
  python -m scripts.audit_book_quality --csv         # CSV header row included

Required env vars
-----------------
  DATABASE_URL    Same connection string the app uses.

Properties
----------
- Read-only: never modifies the database. Safe to run against prod.
- Bounded: stops at --limit if provided, else processes all agents.
- No LLM calls: pure SQL + string heuristics. Costs $0.
"""
from __future__ import annotations

import argparse
import csv
import re
import sys
from typing import Any

from app.core import config  # noqa: F401  — loads env
from app.core.db import (
    get_ai_book_by_agent,
    get_first_chunk_text,
    init_db,
    list_agents,
    list_questions,
    count_chunks_batch,
)


# ─── Classification thresholds ────────────────────────────────────────
_HIGH_MIN_WORDS = 1000
_HIGH_MIN_CHUNKS = 10
_MED_MIN_WORDS = 200
_MED_MIN_CHUNKS = 3

# A book name is at least this many chars before we try fuzzy matching
# it against chunk content (shorter names like "X" or "If" generate
# noise).
_NAME_MATCH_MIN_CHARS = 5


def _normalize(s: str) -> str:
    """Lowercase + strip punctuation for loose substring matching."""
    return re.sub(r"[^a-z0-9 ]+", " ", s.lower()).strip()


def _name_appears_in_chunk(agent_name: str, chunk_text: str) -> bool:
    """Loose check: does the agent name (or its longest 2-word phrase)
    appear in the first chunk's first 400 chars? False positives are
    OK — false negatives just bump the book to MISMATCH for human review."""
    if not agent_name or not chunk_text:
        return False
    if len(agent_name) < _NAME_MATCH_MIN_CHARS:
        return True  # too short to discriminate; assume OK
    a_norm = _normalize(agent_name)
    c_norm = _normalize(chunk_text)
    # Full-name match wins
    if a_norm in c_norm:
        return True
    # Try the longest 2-word phrase from the name
    words = [w for w in a_norm.split() if len(w) >= 4]
    for i in range(len(words) - 1):
        phrase = words[i] + " " + words[i + 1]
        if phrase in c_norm:
            return True
    # Single distinctive word match (>= 6 chars to avoid common words)
    for w in words:
        if len(w) >= 6 and w in c_norm:
            return True
    return False


def _classify(
    agent: dict[str, Any], chunk_count: int, book_row: dict[str, Any] | None,
    first_chunk: str, question_count: int,
) -> str:
    if chunk_count == 0:
        return "STUB"
    total_words = 0
    if book_row:
        total_words = int(book_row.get("total_words") or 0)
    if not total_words:
        # Rough estimate from first chunk × chunk_count (assumes uniform)
        total_words = len(first_chunk.split()) * chunk_count if first_chunk else 0

    agent_name = agent.get("name", "")
    if not _name_appears_in_chunk(agent_name, first_chunk):
        return "MISMATCH"

    if total_words >= _HIGH_MIN_WORDS and chunk_count >= _HIGH_MIN_CHUNKS and question_count > 0:
        return "HIGH"
    if total_words >= _MED_MIN_WORDS and chunk_count >= _MED_MIN_CHUNKS:
        return "MEDIUM"
    return "LOW"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--limit", type=int, default=None,
                        help="Process at most this many books.")
    parser.add_argument("--only-bad", action="store_true",
                        help="Only report MISMATCH and LOW (skip OK books).")
    parser.add_argument("--csv", action="store_true",
                        help="Emit CSV header row before data.")
    args = parser.parse_args()

    print("--- audit_book_quality ---", file=sys.stderr)
    init_db()
    all_agents = list_agents(limit=10000)
    # Focus on book-type agents; minds and other types skip
    book_agents = [
        a for a in all_agents
        if a.get("type") in ("ai_book", "catalog", "upload", "url")
        and a.get("status") in ("ready", "catalog")
    ]
    if args.limit is not None:
        book_agents = book_agents[: args.limit]
    print(f"scanning {len(book_agents)} book agents", file=sys.stderr)

    # Batch chunk-counts so we issue one query instead of N
    chunk_counts = count_chunks_batch([a["id"] for a in book_agents])

    writer = csv.writer(sys.stdout)
    if args.csv:
        writer.writerow([
            "verdict", "agent_id", "name", "type", "status",
            "chunks", "total_words", "questions", "first_chunk_head",
        ])

    counts: dict[str, int] = {}
    for agent in book_agents:
        aid = agent["id"]
        chunk_count = chunk_counts.get(aid, 0)
        first_chunk = get_first_chunk_text(aid, max_chars=400) if chunk_count else ""
        try:
            book_row = get_ai_book_by_agent(aid) if agent.get("type") == "ai_book" else None
        except Exception:
            book_row = None
        try:
            q_count = len(list_questions(aid) or [])
        except Exception:
            q_count = 0

        verdict = _classify(agent, chunk_count, book_row, first_chunk, q_count)
        counts[verdict] = counts.get(verdict, 0) + 1

        if args.only_bad and verdict not in ("MISMATCH", "LOW"):
            continue

        head = (first_chunk[:120] + "…") if len(first_chunk) > 120 else first_chunk
        head = head.replace("\n", " ").replace("\r", " ")
        total_words = (book_row.get("total_words") if book_row else 0) or 0
        writer.writerow([
            verdict, aid, (agent.get("name") or "")[:80],
            agent.get("type", ""), agent.get("status", ""),
            chunk_count, total_words, q_count, head,
        ])

    print(
        "--- summary: " + ", ".join(f"{k}={v}" for k, v in sorted(counts.items())) + " ---",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
