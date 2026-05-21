"""Backfill the pgvector `chunks.embedding` halfvec column from the legacy
`chunks.vector` bytea column, one agent at a time.

Why this exists
---------------
`app/core/rag.py` takes the SQL-side ANN path only for agents whose meta has
`pgvector_ready = true`. New agents (indexed after the pgvector migration
landed) flip this automatically via `app/core/indexer.py`. Existing agents
need a one-time backfill of their stored float32 vectors into the halfvec
column. This script does that.

Usage
-----
  python -m scripts.backfill_pgvector           # backfill all eligible agents
  python -m scripts.backfill_pgvector --dry-run # report what would change
  python -m scripts.backfill_pgvector --limit 5 # process at most 5 agents
  python -m scripts.backfill_pgvector --agent <id>  # one specific agent

Properties
----------
- **Idempotent.** Skips agents already marked `pgvector_ready`. Re-running
  picks up wherever it left off.
- **Per-agent atomic.** Writes all of an agent's halfvec rows first, then
  flips the meta flag last. If the script crashes mid-agent, that agent
  stays on the legacy path until next run.
- **Dim-checked.** Only writes halfvec for chunks whose `dim` matches
  `config.EMBED_DIM` (default 3072, Gemini). Off-dim agents are reported
  and skipped — re-embed them at the target dim if you need ANN coverage.
- **Egress-conscious.** Streams a fixed batch of chunks per round
  (`--batch-size`, default 200) instead of pulling whole books at once.
  The total egress is bounded by your existing chunk volume.
"""

from __future__ import annotations

import argparse
import logging
import sys
from typing import Iterable

import numpy as np

from app.core import config
from app.core import db as db_mod
from app.core.db import _USE_PG, _HAS_PGVECTOR, _halfvec_literal, _pg, get_conn, init_db


log = logging.getLogger("backfill_pgvector")


def _bytes_to_floats(blob: bytes, dim: int) -> list[float]:
    return np.frombuffer(blob, dtype=np.float32, count=dim).tolist()


def _list_target_agents(only_agent: str | None) -> list[dict]:
    """Agents that are ready, not deleted, and not already backfilled."""
    sql = (
        "SELECT id, name, meta_json, status FROM agents "
        "WHERE is_deleted = FALSE AND status = 'ready'"
    )
    params: tuple = ()
    if only_agent:
        sql += " AND id = %s"
        params = (only_agent,)
    sql += " ORDER BY created_at ASC"

    with get_conn() as conn:
        cur = conn.cursor(cursor_factory=_pg().extras.RealDictCursor)
        cur.execute(sql, params)
        rows = [dict(r) for r in cur.fetchall()]

    out: list[dict] = []
    import json
    for r in rows:
        meta = json.loads(r["meta_json"] or "{}")
        if meta.get("pgvector_ready"):
            continue
        r["meta"] = meta
        out.append(r)
    return out


def _agent_dims(agent_id: str) -> tuple[int, set[int]]:
    """Return (chunk_count, distinct_dims) for an agent."""
    with get_conn() as conn:
        cur = conn.cursor()
        cur.execute(
            "SELECT COUNT(*), array_agg(DISTINCT dim) FROM chunks WHERE agent_id = %s",
            (agent_id,),
        )
        row = cur.fetchone()
        if not row or row[0] == 0:
            return 0, set()
        return int(row[0]), set(int(d) for d in (row[1] or []))


def _backfill_agent(agent_id: str, batch_size: int, dry_run: bool) -> tuple[int, int]:
    """Backfill one agent. Returns (rows_written, rows_skipped_off_dim)."""
    written = 0
    skipped = 0

    while True:
        with get_conn() as conn:
            cur = conn.cursor(cursor_factory=_pg().extras.RealDictCursor)
            cur.execute(
                "SELECT id, vector, dim FROM chunks "
                "WHERE agent_id = %s AND embedding IS NULL "
                "ORDER BY chunk_index LIMIT %s",
                (agent_id, batch_size),
            )
            batch = [dict(r) for r in cur.fetchall()]

        if not batch:
            break

        updates: list[tuple[str, str]] = []
        for row in batch:
            if row["dim"] != config.EMBED_DIM:
                skipped += 1
                continue
            floats = _bytes_to_floats(bytes(row["vector"]), row["dim"])
            updates.append((_halfvec_literal(floats), row["id"]))

        if updates and not dry_run:
            with get_conn() as conn:
                cur = conn.cursor()
                for lit, cid in updates:
                    cur.execute(
                        "UPDATE chunks SET embedding = %s::halfvec WHERE id = %s",
                        (lit, cid),
                    )
        written += len(updates)

        # If this batch had only off-dim rows we'd loop forever — guard.
        if not updates and skipped == len(batch):
            log.warning("agent %s: all remaining chunks are off-dim, stopping", agent_id)
            break

    return written, skipped


def _mark_ready(agent_id: str, meta: dict) -> None:
    import json
    meta = {**meta, "pgvector_ready": True}
    with get_conn() as conn:
        cur = conn.cursor()
        cur.execute(
            "UPDATE agents SET meta_json = %s WHERE id = %s",
            (json.dumps(meta), agent_id),
        )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true",
                        help="Report what would happen; do not write.")
    parser.add_argument("--limit", type=int, default=None,
                        help="Process at most N agents.")
    parser.add_argument("--agent", type=str, default=None,
                        help="Backfill a single agent id.")
    parser.add_argument("--batch-size", type=int, default=200,
                        help="Chunks read per round (default 200).")
    parser.add_argument("--verbose", action="store_true")
    args = parser.parse_args(argv)

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
    )

    init_db()  # Ensures pgvector migration has run; flips _HAS_PGVECTOR.

    if not _USE_PG:
        log.error("Backfill only applies to Postgres deployments; SQLite has no pgvector.")
        return 1
    if not _HAS_PGVECTOR:
        log.error("pgvector column is not available. Check Supabase pgvector + halfvec version.")
        return 1

    agents = _list_target_agents(args.agent)
    if args.limit:
        agents = agents[: args.limit]

    log.info("Found %d agents needing backfill (EMBED_DIM=%d)", len(agents), config.EMBED_DIM)

    totals = {"written": 0, "skipped": 0, "agents_done": 0, "agents_off_dim": 0}
    for i, agent in enumerate(agents, 1):
        aid = agent["id"]
        name = agent["name"][:60]
        count, dims = _agent_dims(aid)

        if not count:
            log.info("[%d/%d] %s (%s) — no chunks, skipping", i, len(agents), name, aid)
            continue

        if config.EMBED_DIM not in dims:
            log.warning(
                "[%d/%d] %s (%s) — all %d chunks off-dim (have %s, need %d); skipping",
                i, len(agents), name, aid, count, sorted(dims), config.EMBED_DIM,
            )
            totals["agents_off_dim"] += 1
            continue

        log.info("[%d/%d] %s (%s) — %d chunks, dims=%s", i, len(agents), name, aid, count, sorted(dims))
        written, skipped = _backfill_agent(aid, args.batch_size, args.dry_run)
        log.info("  → wrote %d, skipped %d off-dim", written, skipped)
        totals["written"] += written
        totals["skipped"] += skipped

        if written > 0 and not args.dry_run:
            _mark_ready(aid, agent["meta"])
            totals["agents_done"] += 1

    log.info(
        "Done. agents_done=%d agents_off_dim=%d rows_written=%d rows_skipped=%d%s",
        totals["agents_done"], totals["agents_off_dim"],
        totals["written"], totals["skipped"],
        " (DRY RUN)" if args.dry_run else "",
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
