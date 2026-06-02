"""Dedupe duplicate book agents in the catalog.

The catalog mints the SAME book as multiple agent rows — a full-title `catalog`
stub plus a short-title `ready` record ("Competitive Strategy: Techniques…" vs
"Competitive Strategy"), and sometimes two stubs differing only in punctuation
("Good to Great …and" vs "…And") or a trailing comma ("A World Brewed" vs
"A World Brewed,"). The frontend dedupes for display (filterBooksByTopic), but
the duplicate rows still waste indexing + overview generation and pollute the
library / sitemap. This collapses each duplicate group to one canonical row.

Grouping = connected components of `db.same_book()` within author-compatible
buckets — two rows merge when their titles are equal or one is the other plus a
subtitle ("Good to Great" ≡ "Good to Great: Why…"), but NOT when they're distinct
subtitles of a shared subject (the Wittgenstein volumes stay separate). This is
the SAME relation the minting path (`find_agent_by_normalized_name`) uses, so the
cleanup and the source-dedup never disagree. Within a group the retained row is
the best (status, chunk_count): ready/indexing > writing > catalog, then most
chunks. The losers' chunks + agent rows are deleted.

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
import sys

from app.core import config  # noqa: F401 — ensures env is loaded
from app.core.db import (
    count_chunks_batch,
    delete_agent,
    delete_chunks_for_agent,
    init_db,
    list_agents,
    same_book,
)


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
    # Group by CONNECTED COMPONENTS of same_book(), within author-compatible
    # buckets. same_book() only links a title to itself-plus-a-subtitle, so the
    # Wittgenstein volumes (distinct subtitles, no bare stem) stay SEPARATE —
    # a flat title-stem key used to merge (and delete) them. O(n²) over the
    # roster; fine for a manual review tool at today's scale.
    def _author(a: dict) -> str:
        return ((a.get("meta") or {}).get("author") or a.get("source") or "").strip().lower()

    names = [a.get("name") or "" for a in agents]
    authors = [_author(a) for a in agents]
    parent = list(range(len(agents)))

    def _find(i: int) -> int:
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    for i in range(len(agents)):
        for j in range(i + 1, len(agents)):
            if authors[i] and authors[j] and authors[i] != authors[j]:
                continue  # different known authors → different books
            if same_book(names[i], names[j]):
                parent[_find(i)] = _find(j)

    comps: dict[int, list[dict]] = {}
    for i, a in enumerate(agents):
        comps.setdefault(_find(i), []).append(a)
    dup_groups = [g for g in comps.values() if len(g) > 1]
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
