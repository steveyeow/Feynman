"""Backfill Wikidata/Wikipedia `sameAs` links onto EXISTING minds by name.

WHY A SEPARATE SCRIPT (not expand_minds)
----------------------------------------
expand_minds only ever sees the top-N candidates per domain that Wikidata's
SPARQL endpoint returns — it cannot reach an arbitrary mind already in the
roster (one ranked #60 in its domain, or minted from a chat). This closes that
gap: for every mind missing a `wikidata_url` it resolves the entity through
Wikidata's MediaWiki *action* API (wbsearchentities -> wbgetentities), which is
a DIFFERENT service from the flaky / outage-prone SPARQL endpoint — so it works
even while WDQS is rate-limiting.

CORRECTNESS OVER COVERAGE
-------------------------
A WRONG `sameAs` is worse than none — it tells search engines and LLMs the mind
IS some other real person. So a match is accepted ONLY when the resolved entity
is `P31=Q5` (an instance of human) AND has an English Wikipedia article. The
top relevance-ranked hit that clears both gates wins; ambiguous, non-person, or
article-less names are skipped and left unlinked. The famous-25 already render
their curated sameAs via the frontend's mindSameAs() regardless, so skipping
here only ever leaves a mind exactly as it was.

Usage
-----
  python -m scripts.backfill_mind_sameas                  # DRY-RUN: report matches
  python -m scripts.backfill_mind_sameas --apply
  python -m scripts.backfill_mind_sameas --apply --limit 20 --sleep 0.4
  python -m scripts.backfill_mind_sameas --apply --force  # re-resolve linked minds too

Required env: DATABASE_URL (same as the app). No LLM / Gemini quota. Off-Vercel,
so zero Vercel CPU — the live site just serves the resulting links.
"""
from __future__ import annotations

import argparse
import sys
import time

from app.core import config  # noqa: F401 — ensures env is loaded
from app.core.db import init_db, list_minds, update_mind_links
from app.core.sources_wikidata import _http_get

_API = "https://www.wikidata.org/w/api.php"


def _search_qids(name: str, limit: int) -> list[str]:
    """Top candidate QIDs for a name label, in Wikidata relevance order
    (exact label matches rank first)."""
    data = _http_get(_API, params={
        "action": "wbsearchentities", "search": name, "language": "en",
        "type": "item", "limit": str(limit), "format": "json",
    }) or {}
    return [h.get("id") for h in data.get("search", []) if h.get("id")]


def _resolve_person(qid: str) -> tuple[str, str] | None:
    """(wikidata_url, wikipedia_url) iff `qid` is a human (P31=Q5) WITH an
    English Wikipedia article — else None. This pair of gates is what keeps a
    same-name non-person (a band, a book, a place) from being mislinked."""
    data = _http_get(_API, params={
        "action": "wbgetentities", "ids": qid,
        "props": "claims|sitelinks/urls", "languages": "en",
        "sitefilter": "enwiki", "format": "json",
    }) or {}
    ent = (data.get("entities") or {}).get(qid) or {}
    p31 = (ent.get("claims") or {}).get("P31") or []
    is_human = any(
        ((((c.get("mainsnak") or {}).get("datavalue") or {}).get("value") or {}).get("id") == "Q5")
        for c in p31
    )
    if not is_human:
        return None
    wp = ((ent.get("sitelinks") or {}).get("enwiki") or {}).get("url") or ""
    if not wp:
        return None
    return (f"https://www.wikidata.org/wiki/{qid}", wp)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true",
                        help="Write the links (default: dry-run, read-only).")
    parser.add_argument("--limit", type=int, default=None,
                        help="Process at most this many minds this run.")
    parser.add_argument("--sleep", type=float, default=0.4,
                        help="Seconds between Wikidata API calls (be polite).")
    parser.add_argument("--force", action="store_true",
                        help="Re-resolve minds that already have a wikidata_url.")
    parser.add_argument("--max-candidates", type=int, default=5,
                        help="Search hits to consider per name before giving up.")
    args = parser.parse_args()

    print(f"--- backfill_mind_sameas (apply={args.apply}) ---", file=sys.stderr)
    init_db()

    minds = list(list_minds(limit=10000))
    todo = [m for m in minds if args.force or not (m.get("wikidata_url") or "").strip()]
    print(f"{len(minds)} minds, {len(todo)} need resolving", file=sys.stderr)

    linked = skipped = failed = 0
    for m in todo:
        if args.limit is not None and (linked + skipped + failed) >= args.limit:
            break
        name = (m.get("name") or "").strip()
        if not name:
            continue
        try:
            resolved = None
            for qid in _search_qids(name, args.max_candidates):
                resolved = _resolve_person(qid)
                if resolved:
                    break
                time.sleep(args.sleep)
            if not resolved:
                skipped += 1
                print(f"  skip   {name!r} (no human+enwiki match)", file=sys.stderr)
                continue
            wd, wp = resolved
            if args.apply:
                update_mind_links(m["id"], wd, wp)
            print(f"  {'LINK' if args.apply else 'would link'} {name!r} → {wd}", file=sys.stderr)
            linked += 1
        except Exception as exc:
            failed += 1
            print(f"  FAIL {name!r}: {exc}", file=sys.stderr)
        time.sleep(args.sleep)

    print(f"--- done: linked={linked} skipped={skipped} failed={failed} ---", file=sys.stderr)
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
