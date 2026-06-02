"""Pre-generate the "About this book" overview + key concepts into each book's
`meta`, so the /api/agents/{id}/overview endpoint serves them straight from the
DB instead of doing a RAG + LLM round trip on every crawl.

Why this exists
---------------
`overview.generate_book_overview()` was wired to lazily generate on first crawl
and cache (in-process + edge). That's fine functionally, but as Google re-crawls
the ~600 book hubs it means an LLM call per book per cache window — Gemini cost
(the project's stated bottleneck) and avoidable backend work. `overview.py`
already checks `meta.overview` FIRST and short-circuits with zero generation when
it's present. This script fills `meta.overview` / `meta.key_concepts` /
`meta.overview_grounded` ahead of time so the hot path never generates.

Usage
-----
  python -m scripts.backfill_overviews              # backfill every eligible book
  python -m scripts.backfill_overviews --dry-run    # report, no LLM calls / writes
  python -m scripts.backfill_overviews --limit 25   # at most 25 books (quota-friendly)
  python -m scripts.backfill_overviews --agent ID   # one specific book
  python -m scripts.backfill_overviews --sleep 1.5  # throttle between LLM calls

Required env vars
-----------------
  DATABASE_URL    Same string the app uses to reach Supabase Postgres.
  GEMINI_API_KEY  (or whichever provider is configured) — needed by
                  generate_book_overview's LLM call.

Properties
----------
- **Idempotent.** Skips agents that already have a stored `meta.overview`.
  Safe to interrupt and resume; re-running picks up where it left off.
- **Quota-friendly.** ~1 LLM round trip per book; use --limit / --sleep to
  spread the run across the Gemini quota window.
- **Non-destructive.** Only sets overview keys via update_agent_meta (merge);
  never touches other meta keys, status, or content.
"""
from __future__ import annotations

import argparse
import logging
import sys
import time

from app.core import config  # noqa: F401 — ensures env is loaded
from app.core import overview as overview_module
from app.core.db import get_agent, init_db, list_agents, update_agent_meta

log = logging.getLogger("backfill_overviews")


def _eligible(agent: dict) -> tuple[bool, str]:
    """Eligible = ready agent that doesn't already have a stored overview."""
    if agent.get("status") != "ready":
        return False, f"status={agent.get('status')!r}"
    if ((agent.get("meta") or {}).get("overview") or "").strip():
        return False, "overview_exists"
    return True, ""


def _process_one(agent: dict, dry_run: bool) -> tuple[bool, str]:
    agent_id = agent["id"]
    if dry_run:
        return True, "[dry-run] would generate + store overview"
    try:
        result = overview_module.generate_book_overview(agent)
    except Exception as exc:
        return False, f"generate_book_overview failed: {exc}"
    overview = (result.get("overview") or "").strip()
    if not overview:
        return False, "generator returned empty overview"
    try:
        update_agent_meta(agent_id, {
            "overview": overview,
            "key_concepts": result.get("concepts") or [],
            "overview_grounded": bool(result.get("grounded")),
        })
    except Exception as exc:
        return False, f"update_agent_meta failed: {exc}"
    return True, f"stored overview ({len(overview)} chars, {len(result.get('concepts') or [])} concepts, grounded={result.get('grounded')})"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true",
                        help="Show what would change without LLM calls or writes.")
    parser.add_argument("--limit", type=int, default=None,
                        help="Process at most this many eligible books.")
    parser.add_argument("--agent", type=str, default=None,
                        help="Process only this agent id.")
    parser.add_argument("--sleep", type=float, default=0.0,
                        help="Seconds to sleep between LLM calls (throttle quota).")
    parser.add_argument("--verbose", "-v", action="store_true",
                        help="Print per-skip detail in addition to processed books.")
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.INFO if args.verbose else logging.WARNING,
        format="%(asctime)s %(levelname)s %(message)s",
    )

    print(f"--- backfill_overviews (dry_run={args.dry_run}) ---", file=sys.stderr)
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
        if args.sleep and not args.dry_run:
            time.sleep(args.sleep)

    elapsed = time.time() - start
    print(
        f"--- done in {elapsed:.1f}s: processed={processed} ok={ok} "
        f"failed={failed} skipped={skipped} ---",
        file=sys.stderr,
    )
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
