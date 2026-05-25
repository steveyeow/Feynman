"""Backfill the `questions` table for books indexed before
`indexer.generate_questions()` was wired into the indexing pipeline.

Why this exists
---------------
The Phase 0+1+2 SEO work surfaces a book's auto-generated study questions
on its /book/{id} landing page (and Phase 4A turns each question into its
own /book/{id}/q/{slug} compound URL). New books get questions filled
automatically during indexing. Old books — anything indexed before that
hook landed — have an empty `questions` row and render without the
Popular Questions section. This script fills the gap.

Usage
-----
  python -m scripts.backfill_questions             # backfill every eligible book
  python -m scripts.backfill_questions --dry-run   # report what would change
  python -m scripts.backfill_questions --limit 10  # process at most 10 books
  python -m scripts.backfill_questions --agent ID  # one specific book

Required env vars
-----------------
  DATABASE_URL    Same string the app uses to reach Supabase Postgres.
  GEMINI_API_KEY  (or whichever provider is configured) — needed for the
                  LLM call inside `generate_questions`.

Properties
----------
- **Idempotent.** Skips agents that already have questions. Re-running
  picks up wherever it left off; safe to interrupt and resume.
- **Bounded cost.** ~1 LLM round trip per book (5 questions in one call).
  At Gemini Flash rates, the whole 750-book backfill costs roughly $1.
- **Non-destructive.** Never deletes or overwrites existing questions.
- **Read-egress conscious.** Pulls only the first ~3 chunks per book to
  keep the prompt small. The legacy text-sample slicing is identical to
  what the live indexer uses.

Operational notes
-----------------
- Run from the project root: `python -m scripts.backfill_questions`.
- The script connects to whichever DB `DATABASE_URL` points at — point
  it at production Supabase to backfill prod, at a local DB to backfill
  locally. There's no Supabase-side execution; this is just a Python
  process holding a DB connection.
- Always `--dry-run` first to eyeball the count and sample picks.
"""
from __future__ import annotations

import argparse
import logging
import sys
import time

from app.core import config  # noqa: F401  — ensures env is loaded
from app.core.db import (
    get_chunks_text_only,
    get_agent,
    init_db,
    list_agents,
    list_questions,
)
from app.core.questions import generate_questions

log = logging.getLogger("backfill_questions")


# Match what app/core/indexer.py uses when first generating questions —
# keep the input window identical so backfilled questions are stylistically
# consistent with the ones that come out of the live pipeline.
_PROMPT_SAMPLE_CHARS = 3000


def _eligible(agent: dict) -> tuple[bool, str]:
    """Return (eligible, reason). Eligible = ready agent with chunks and
    no existing questions."""
    if agent.get("status") != "ready":
        return False, f"status={agent.get('status')!r}"
    agent_id = agent["id"]
    if list_questions(agent_id):
        return False, "questions_exist"
    return True, ""


def _process_one(agent: dict, dry_run: bool) -> tuple[bool, str]:
    """Generate questions for one agent. Returns (ok, message)."""
    agent_id = agent["id"]
    name = (agent.get("name") or "")[:80]
    try:
        chunks = get_chunks_text_only(agent_id)
    except Exception as exc:
        return False, f"chunks fetch failed: {exc}"
    if not chunks:
        return False, "no chunks (cannot generate questions)"

    text_sample = "\n\n".join(c["text"] for c in chunks[:3])[:_PROMPT_SAMPLE_CHARS]
    if not text_sample.strip():
        return False, "chunks empty"

    if dry_run:
        return True, f"[dry-run] would generate questions ({len(text_sample)} chars sample)"

    try:
        questions = generate_questions(agent_id, text_sample)
    except Exception as exc:
        return False, f"generate_questions failed: {exc}"
    if not questions:
        return False, "LLM returned no questions"
    return True, f"generated {len(questions)} questions"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true",
                        help="Show what would change without making LLM calls or writing.")
    parser.add_argument("--limit", type=int, default=None,
                        help="Process at most this many eligible books.")
    parser.add_argument("--agent", type=str, default=None,
                        help="Process only this agent id.")
    parser.add_argument("--verbose", "-v", action="store_true",
                        help="Print per-skip detail in addition to processed books.")
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.INFO if args.verbose else logging.WARNING,
        format="%(asctime)s %(levelname)s %(message)s",
    )

    print(f"--- backfill_questions (dry_run={args.dry_run}) ---", file=sys.stderr)
    init_db()

    if args.agent:
        a = get_agent(args.agent)
        if not a:
            print(f"agent not found: {args.agent}", file=sys.stderr)
            return 2
        targets = [a]
    else:
        targets = list(list_agents(limit=10000))

    print(f"scanning {len(targets)} agents", file=sys.stderr)

    processed = ok = failed = skipped = 0
    start = time.time()
    for agent in targets:
        eligible, reason = _eligible(agent)
        if not eligible:
            skipped += 1
            if args.verbose:
                print(f"  skip {agent['id'][:8]} {agent.get('name','')[:40]!r:<42} ({reason})", file=sys.stderr)
            continue
        if args.limit is not None and processed >= args.limit:
            break
        processed += 1
        success, msg = _process_one(agent, dry_run=args.dry_run)
        marker = "OK " if success else "FAIL"
        print(f"  {marker} {agent['id'][:8]} {agent.get('name','')[:60]!r:<62} — {msg}", file=sys.stderr)
        if success:
            ok += 1
        else:
            failed += 1

    elapsed = time.time() - start
    print(
        f"--- done in {elapsed:.1f}s: processed={processed} ok={ok} "
        f"failed={failed} skipped={skipped} ---",
        file=sys.stderr,
    )
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
