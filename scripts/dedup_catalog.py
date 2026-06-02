"""Dedupe duplicate book agents in the catalog.

The catalog mints the SAME book as multiple agent rows — a full-title `catalog`
stub plus a short-title `ready` record ("Competitive Strategy: Techniques…" vs
"Competitive Strategy"), and sometimes two stubs differing only in punctuation
("Good to Great …and" vs "…And") or a trailing comma ("A World Brewed" vs
"A World Brewed,"). The frontend dedupes for display (filterBooksByTopic), but
the duplicate rows still waste indexing + overview generation and pollute the
library / sitemap. This collapses each duplicate group to one canonical row.

Grouping = normalized title (subtitle after colon/dash stripped, punctuation
removed, CJK kept) + author. Within a group the KEEetainer is the row with the
best (status, chunk_count): ready/indexing > writing > catalog, then most
chunks (the keeper). The losers' chunks + agent rows are deleted.

Usage
-----
  python -m scripts.dedup_catalog                 # DRY-RUN: report duplicate groups
  python -m scripts.dedup_catalog --apply         # actually delete the losers
  python -m scripts.dedup_catalog --apply --limit 20

SAFETY: dry-run is the default and read-only. `--apply` deletes agent rows +
their chunks (delete_agent / delete_chunks_for_agent) — irreversible. Always
dry-run first and eyeball the keep/delete picks.

Required env: DATABASE_URL (same as the app). No LLM calls.
"""
from __future__ import annotations

import argparse
import re
import sys

from app.core import config  # noqa: F401 — ensures env is loaded
from app.core.db import (
    count_chunks_batch,
    delete_agent,
    delete_chunks_for_agent,
    init_db,
    list_agents,
)

_PUNCT = re.compile(r"[.,;:!?'\"()]")
_WS = re.compile(r"\s+")


def _norm(name: str) -> str:
    """Normalized title stem for grouping — must mirror the frontend
    filterBooksByTopic dedupe so display + data agree."""
    stem = re.split(r"[:—]|\s-\s", (name or "").lower())[0]
    stem = _PUNCT.sub("", stem)
    return _WS.sub(" ", stem).strip()


def _rank(a: dict) -> int:
    s = a.get("status")
    if s in ("ready", "indexing"):
        return 2
    if s == "writing":
        return 1
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true",
                        help="Delete the duplicate losers (default: dry-run, read-only).")
    parser.add_argument("--limit", type=int, default=None,
                        help="Process at most this many duplicate GROUPS.")
    args = parser.parse_args()

    print(f"--- dedup_catalog (apply={args.apply}) ---", file=sys.stderr)
    init_db()

    agents = list(list_agents(limit=10000))
    # Author lives in meta; key on title-stem + author so different books that
    # share a title prefix aren't merged.
    groups: dict[str, list[dict]] = {}
    for a in agents:
        author = ((a.get("meta") or {}).get("author") or "").strip().lower()
        key = f"{_norm(a.get('name') or '') or a['id']}|{author}"
        groups.setdefault(key, []).append(a)

    dup_groups = [g for g in groups.values() if len(g) > 1]
    print(f"{len(agents)} agents → {len(dup_groups)} duplicate groups", file=sys.stderr)

    chunk_counts = count_chunks_batch([a["id"] for g in dup_groups for a in g]) or {}

    processed = deleted = skipped_owned = 0
    for g in dup_groups:
        if args.limit is not None and processed >= args.limit:
            break
        processed += 1
        # Winner = best (rank, chunks); the rest are losers.
        g_sorted = sorted(g, key=lambda a: (_rank(a), chunk_counts.get(a["id"], 0)), reverse=True)
        winner, losers = g_sorted[0], g_sorted[1:]
        print(
            f"\n  KEEP {winner['id'][:8]} [{winner.get('status')}/"
            f"{chunk_counts.get(winner['id'],0)}ch] {str(winner.get('name'))[:50]!r}",
            file=sys.stderr,
        )
        for L in losers:
            print(
                f"    {'DELETE' if args.apply else 'would delete'} "
                f"{L['id'][:8]} [{L.get('status')}/{chunk_counts.get(L['id'],0)}ch] "
                f"{str(L.get('name'))[:50]!r}",
                file=sys.stderr,
            )
            if args.apply:
                try:
                    delete_chunks_for_agent(L["id"])
                    # delete_agent is a SOFT delete (is_deleted=True) gated to the
                    # owner — it returns False for owner-mismatched rows (which
                    # list_agents/sitemap then still exclude only by status). Count
                    # honestly + flag the ones it couldn't soft-delete.
                    if delete_agent(L["id"]):
                        deleted += 1
                    else:
                        skipped_owned += 1
                        print(f"      SKIP {L['id'][:8]} (owned/not soft-deletable)", file=sys.stderr)
                except Exception as exc:
                    print(f"      FAIL deleting {L['id'][:8]}: {exc}", file=sys.stderr)

    if args.apply:
        print(f"\n--- done: groups={processed} deleted={deleted} skipped_owned={skipped_owned} ---",
              file=sys.stderr)
    else:
        print(f"\n--- done: groups={processed} "
              f"would_delete={sum(len(g) - 1 for g in dup_groups[:processed])} ---",
              file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
