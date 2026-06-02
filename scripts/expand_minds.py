"""Expand the great-minds roster from Wikidata — the Task-2 entity-scale lever
(master plan P1: 50 → 1000 minds, which unlocks ~20K Type-2 "how X approaches Y"
pages Wikipedia structurally can't have).

WHY THIS IS A SCRIPT (and not a cron)
-------------------------------------
This is deliberately OFF-Vercel. Creating a mind = a Wikidata/Wikipedia fetch +
an LLM persona generation + an embedding. Run as a scheduled Vercel function it
would burn the Hobby 4h Active-CPU cap and the 60s function timeout. Run as a
local/CI batch it costs only your Gemini quota and your machine's CPU — Vercel
stays flat. The live site just SERVES the resulting minds (cheap DB reads).

Usage
-----
  python -m scripts.expand_minds --dry-run                 # list candidates, no writes/LLM
  python -m scripts.expand_minds --per-domain 30 --limit 50 --sleep 1.5
  python -m scripts.expand_minds --no-embed                # skip the embedding backfill pass

Required env vars
-----------------
  DATABASE_URL    Same string the app uses to reach Supabase Postgres.
  GEMINI_API_KEY  (or whichever provider is configured) — persona generation.

Properties
----------
- **Idempotent.** Skips Wikidata candidates whose name already exists as a mind.
  Safe to interrupt/resume; re-run picks up where it left off.
- **Quota-friendly.** ~1 LLM round trip per NEW mind. --limit / --sleep spread
  the run across the Gemini quota window; run it in chunks over days if needed.
- **Hobby-CPU-safe.** Zero Vercel involvement. `link_works=False` by default so
  it does NOT trigger book discovery/indexing (the CPU-heavy path) — work-linking
  is a separate, optional pass.
"""
from __future__ import annotations

import argparse
import logging
import sys
import time

from app.core import config  # noqa: F401 — ensures env is loaded
from app.core.db import init_db, list_minds
from app.core.minds import backfill_mind_embeddings, get_or_create_mind
from app.core.sources_wikidata import discover_candidates

log = logging.getLogger("expand_minds")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true",
                        help="List candidates without LLM calls or writes.")
    parser.add_argument("--per-domain", type=int, default=30,
                        help="Wikidata candidates to pull per topic domain (15 domains).")
    parser.add_argument("--limit", type=int, default=None,
                        help="Create at most this many NEW minds this run (quota control).")
    parser.add_argument("--sleep", type=float, default=1.0,
                        help="Seconds to sleep between mind creations (throttle Gemini).")
    parser.add_argument("--link-works", action="store_true",
                        help="Link existing catalog books to each mind (off by default — "
                             "avoid until you want the extra cross-links).")
    parser.add_argument("--no-embed", action="store_true",
                        help="Skip the embedding backfill pass at the end.")
    parser.add_argument("--verbose", "-v", action="store_true")
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.INFO if args.verbose else logging.WARNING,
        format="%(asctime)s %(levelname)s %(message)s",
    )

    print(f"--- expand_minds (dry_run={args.dry_run}) ---", file=sys.stderr)
    init_db()

    existing = {(m.get("name") or "").strip().lower() for m in list_minds(limit=10000)}
    print(f"have {len(existing)} minds; querying Wikidata candidates…", file=sys.stderr)

    try:
        candidates = discover_candidates(per_domain_limit=args.per_domain)
    except Exception as exc:
        print(f"Wikidata discovery failed: {exc}", file=sys.stderr)
        return 2

    fresh = [c for c in candidates if (c.get("name") or "").strip().lower() not in existing]
    print(f"{len(candidates)} candidates, {len(fresh)} new", file=sys.stderr)

    created = failed = 0
    start = time.time()
    for c in fresh:
        if args.limit is not None and created >= args.limit:
            break
        name = (c.get("name") or "").strip()
        domain = (c.get("domain") or "").strip()
        if not name:
            continue
        if args.dry_run:
            print(f"  [dry-run] would create {name!r} [{domain}]", file=sys.stderr)
            created += 1
            continue
        try:
            get_or_create_mind(name, era=c.get("era", ""), domain=domain,
                               link_works=args.link_works)
            created += 1
            print(f"  OK   {name!r} [{domain}]", file=sys.stderr)
        except Exception as exc:
            failed += 1
            print(f"  FAIL {name!r}: {exc}", file=sys.stderr)
        time.sleep(args.sleep)

    # Embedding backfill so the new minds join the similarity graph (related
    # minds / topic clustering). Off-Vercel, looped until drained.
    embedded = 0
    if not args.dry_run and not args.no_embed and created:
        print("backfilling embeddings…", file=sys.stderr)
        while True:
            n = backfill_mind_embeddings(batch_size=25)
            if not n:
                break
            embedded += n
            print(f"  embedded {embedded}…", file=sys.stderr)

    elapsed = time.time() - start
    print(
        f"--- done in {elapsed:.1f}s: created={created} failed={failed} "
        f"embedded={embedded} ---",
        file=sys.stderr,
    )
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
