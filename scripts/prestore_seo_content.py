"""Pre-generate Type-1 (grounded Q&A) + Type-2 (imagined-perspective essay) SEO
content into the DB, so the live `/q/` and `/on/` endpoints serve it WITHOUT a
per-crawl LLM call — and so each page flips from `noindex` (thin-content gate,
#49) to indexable the moment its content exists.

WHY THIS EXISTS (master-plan P0 #1)
-----------------------------------
`/q/` and `/on/` were lazy-generated on every cache miss with NO persistent
store — minds 50→1000 = ~15K essays each hitting Gemini on crawl = quota
blowout + slow crawl. This script (with the new `meta.essays` / `meta.qa`
check-first cache in qa.py) pre-fills that store off-Vercel, so the hot path is
free and Google sees real content immediately.

CHEAP NOW
---------
Generation runs through `bulk_chat` (Gemini thinking OFF, optional
`GEMINI_BULK_CHAT_MODEL=gemini-2.5-flash-lite`) — ~3–10× cheaper than the old
default. The whole programmatic surface is roughly $12–45 of Gemini depending on
those levers.

Usage
-----
  python -m scripts.prestore_seo_content                  # DRY-RUN: count what's missing
  python -m scripts.prestore_seo_content --apply
  python -m scripts.prestore_seo_content --apply --essays-only --limit 200
  python -m scripts.prestore_seo_content --apply --qa-only --max-questions 5
  python -m scripts.prestore_seo_content --apply --no-init   # against PROD (schema app-managed)

Properties
----------
- **Idempotent.** The check-first wrappers skip anything already stored, so
  re-runs only fill gaps. Safe to interrupt/resume.
- **Quota-friendly.** ~1 LLM round trip per NEW essay/answer; --limit / --sleep
  spread the run across the Gemini window; run in chunks over days if needed.
- **Off-Vercel / Hobby-safe.** Zero Vercel CPU — the live site just serves the
  stored rows. Against PROD, export the prod DATABASE_URL + pass --no-init
  (see scripts/backfill_mind_sameas.py header).

Required env: DATABASE_URL, GEMINI_API_KEY (or the configured provider).
"""
from __future__ import annotations

import argparse
import sys
import time

from app.core import config  # noqa: F401 — ensures env is loaded
from app.core.catalog import TOPIC_TAGS
from app.core.db import (
    get_mind_essay,
    init_db,
    list_agents,
    list_minds,
    list_questions,
)
from app.core.qa import (
    get_or_generate_grounded_answer,
    get_or_generate_mind_essay,
    is_mind_topic_relevant,
)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true",
                        help="Generate + store (default: dry-run, counts what's missing, no LLM).")
    parser.add_argument("--limit", type=int, default=None,
                        help="Generate at most this many NEW items this run (quota control).")
    parser.add_argument("--sleep", type=float, default=0.5,
                        help="Seconds between generations (throttle the provider).")
    parser.add_argument("--essays-only", action="store_true", help="Type-2 essays only.")
    parser.add_argument("--qa-only", action="store_true", help="Type-1 Q&A only.")
    parser.add_argument("--max-questions", type=int, default=None,
                        help="Cap questions pre-stored per book.")
    parser.add_argument("--no-init", action="store_true",
                        help="Skip init_db() — use against PROD (schema is app-managed).")
    args = parser.parse_args()

    do_essays = not args.qa_only
    do_qa = not args.essays_only

    print(f"--- prestore_seo_content (apply={args.apply}) ---", file=sys.stderr)
    if not args.no_init:
        init_db()

    made = skipped = failed = 0

    def _cap_hit() -> bool:
        return args.limit is not None and made >= args.limit

    # ── Type-2 essays: minds × RELEVANT topics (the same gate the sitemap +
    #    the /on endpoint use, so we only fill what's actually served). ──────
    if do_essays:
        minds = list(list_minds(limit=10000))
        print(f"essays: {len(minds)} minds × relevant topics", file=sys.stderr)
        for m in minds:
            mid = m.get("id")
            if not mid:
                continue
            for topic in TOPIC_TAGS:
                if not is_mind_topic_relevant(m, topic):
                    continue
                if get_mind_essay(mid, topic):
                    skipped += 1
                    continue
                if _cap_hit():
                    break
                if not args.apply:
                    made += 1  # dry-run: would-generate count
                    continue
                try:
                    res = get_or_generate_mind_essay(m, topic)
                    if res.get("essay"):
                        made += 1
                        print(f"  essay OK  {m.get('name')!r} × {topic}", file=sys.stderr)
                    else:
                        failed += 1
                except Exception as exc:
                    failed += 1
                    print(f"  essay FAIL {m.get('name')!r} × {topic}: {exc}", file=sys.stderr)
                time.sleep(args.sleep)
            if _cap_hit():
                break

    # ── Type-1 Q&A: READY books × their curated questions. ─────────────────
    if do_qa and not _cap_hit():
        books = [a for a in list_agents(limit=10000) if a.get("status") in ("ready", "indexing")]
        print(f"qa: {len(books)} ready/indexing books × questions", file=sys.stderr)
        for a in books:
            aid = a.get("id")
            if not aid:
                continue
            stored = ((a.get("meta") or {}).get("qa") or {})
            questions = list_questions(aid) or []
            if args.max_questions is not None:
                questions = questions[: args.max_questions]
            for q in questions:
                if stored.get(q, {}).get("answer"):
                    skipped += 1
                    continue
                if _cap_hit():
                    break
                if not args.apply:
                    made += 1
                    continue
                try:
                    res = get_or_generate_grounded_answer(aid, q, book_title=a.get("name", ""))
                    if res.get("answer"):
                        made += 1
                        print(f"  qa OK  {a.get('name')!r}: {q[:50]}", file=sys.stderr)
                    else:
                        failed += 1
                except Exception as exc:
                    failed += 1
                    print(f"  qa FAIL {a.get('name')!r}: {exc}", file=sys.stderr)
                time.sleep(args.sleep)
            if _cap_hit():
                break

    verb = "generated" if args.apply else "would generate"
    print(f"--- done: {verb}={made} already_stored={skipped} failed={failed} ---", file=sys.stderr)
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
