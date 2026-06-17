"""Local content-backfill fetcher — approach B (fetch local, embed on Vercel).

Runs on the dev box (network to Gutenberg/Wikisource/IA/arXiv is fine here; the
Gemini EMBEDDER is geoblocked locally, which is why embedding happens on Vercel
via GET /api/cron/index-pending-content). For each 0-chunk "real" book (one
with a real AI overview — a legit chattable entity that just lacks full text),
run the sources chain and STAGE the fetched full text in `pending_content`. The
Vercel cron then indexes + embeds it and clears the row.

This keeps the heavy, slow fetch OFF Vercel — only the unavoidable Gemini embed
runs there (cf. dev-resource discipline: heavy lifting local, embed on Vercel).

Usage (against prod):
  export DATABASE_URL=$POSTGRES_URL_NON_POOLING   # from .env.production.local
  source .env                                     # provider keys if needed
  python -m scripts.backfill_content --dry-run [--limit N]
  python -m scripts.backfill_content --apply [--limit N] [--workers 6]
"""
from __future__ import annotations

import argparse
import concurrent.futures as cf
import logging
import sys

from app.core import config  # noqa: F401 — loads env (DATABASE_URL etc.)
from app.core import db
from app.core.sources import fetch_book_content_sourced

_MIN_FULLTEXT = 4000  # >= this = real full text (metadata-only is < 2000)


def _targets(limit: int | None) -> list[tuple[str, str, str]]:
    """0-chunk, not-deleted, real-overview books not already staged."""
    sql = """
        SELECT a.id, a.name, a.meta_json::jsonb->>'author'
        FROM agents a
        LEFT JOIN (SELECT agent_id, COUNT(*) n FROM chunks GROUP BY agent_id) ch
               ON ch.agent_id = a.id
        WHERE NOT a.is_deleted
          AND COALESCE(ch.n, 0) = 0
          AND length(coalesce(a.meta_json::jsonb->>'overview', '')) > 200
          AND a.id NOT IN (SELECT agent_id FROM pending_content)
        ORDER BY a.id
    """
    if limit:
        sql += f" LIMIT {int(limit)}"
    with db.get_conn() as conn:
        cur = db._execute(conn, sql)
        rows = cur.fetchall()
    return [(r[0], r[1] or "", (r[2] or "").strip()) for r in rows]


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--limit", type=int, default=None)
    ap.add_argument("--workers", type=int, default=6)
    args = ap.parse_args()
    logging.disable(logging.WARNING)

    db.ensure_pending_content_table()
    targets = _targets(args.limit)
    print(f"{len(targets)} candidate 0-chunk books", file=sys.stderr)

    staged = miss = 0
    by_source: dict[str, int] = {}

    def work(t: tuple[str, str, str]):
        aid, name, author = t
        try:
            txt, src = fetch_book_content_sourced(name, author)
        except Exception:
            return (0, "")
        if len(txt) >= _MIN_FULLTEXT:
            if args.apply:
                db.stage_pending_content(aid, txt, src)
            return (len(txt), src)
        return (0, "")

    with cf.ThreadPoolExecutor(max_workers=args.workers) as ex:
        for i, (n, src) in enumerate(ex.map(work, targets), 1):
            if n >= _MIN_FULLTEXT:
                staged += 1
                by_source[src] = by_source.get(src, 0) + 1
            else:
                miss += 1
            if i % 50 == 0:
                print(f"  ...{i}/{len(targets)}  staged={staged}", file=sys.stderr)

    print(f"\ndone: full-text {staged}, miss {miss}", file=sys.stderr)
    print(f"by source: {by_source}", file=sys.stderr)
    print(f"pending_content now: {db.count_pending_content()}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
