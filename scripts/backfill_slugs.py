"""Backfill descriptive URL slugs for books (agents) + minds — Stage 1 of the
UUID→slug migration.

Idempotently adds the slug column and assigns a unique, STABLE slug to every
entity that doesn't have one yet: slugify(title/name), de-duplicated with -2/-3.
Existing slugs are NEVER changed (URLs stay stable); only NULL-slug rows are
touched, so re-runs are safe and pick up newly-created entities.

Slug namespaces are per-table (/book/{slug} vs /mind/{slug}), so a book and a
mind may share a slug — dedup is within each table.

Usage:
  python -m scripts.backfill_slugs --dry-run
  python -m scripts.backfill_slugs --apply --no-init
"""
from __future__ import annotations

import argparse
import sys

from app.core import config  # noqa: F401 — ensures env is loaded
from app.core.db import (
    ensure_slug_columns,
    init_db,
    list_agents,
    list_minds,
    probe_pgvector,
    update_agent_slug,
    update_mind_slug,
)
from app.core.seo import slugify


def backfill(label: str, rows: list, update_fn, apply: bool) -> int:
    used = {r["slug"] for r in rows if r.get("slug")}
    assigned = 0
    # Oldest first → dedup suffixes are deterministic and stable across re-runs.
    for r in sorted(rows, key=lambda x: x.get("created_at") or ""):
        if r.get("slug"):
            continue
        base = slugify(r.get("name") or "", max_len=60) or "untitled"
        slug, k = base, 2
        while slug in used:
            slug = f"{base}-{k}"
            k += 1
        used.add(slug)
        assigned += 1
        if not apply:
            if assigned <= 8:
                print(f"  [dry] {label}: {(r.get('name') or '')[:42]!r} -> {slug}", file=sys.stderr)
        else:
            update_fn(r["id"], slug)
    return assigned


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--no-init", action="store_true")
    args = ap.parse_args()

    if args.no_init:
        probe_pgvector()
    else:
        init_db()
    # Always — the list_minds SELECT references the slug column, so it must exist
    # before we read. Adding a NULL column is harmless on a dry run.
    ensure_slug_columns()

    agents = list_agents(limit=100000)
    minds = list_minds(limit=100000)
    print(f"loaded {len(agents)} agents, {len(minds)} minds", file=sys.stderr)
    na = backfill("book", agents, update_agent_slug, args.apply)
    nm = backfill("mind", minds, update_mind_slug, args.apply)
    verb = "assigned" if args.apply else "would assign"
    print(f"--- {verb}: books={na} minds={nm} ---", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
