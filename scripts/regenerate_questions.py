"""Regenerate genuinely book-specific study questions for books that fell back to
the 5 GENERIC templated questions at index time (the LLM call failed then).

WHY
---
The generic five — "What is the central thesis of this text?", "What evidence
does the author provide?", … — are stamped across dozens of books. Duplicated
like that, the resulting /q pages read as thin / mass-produced, so Google
discovers them but won't index them (the bulk of "Discovered – currently not
indexed"). Replacing them with concise, book-specific questions that name real
concepts from the text removes the templated-thin signal AND gives each /q page a
unique, keyword-bearing slug.

SCOPE
-----
Only books with >=5 real chunks — the indexable /q set, matching the sitemap's
_MIN_CHUNKS_FOR_Q_URLS gate — whose questions are ALL generic. The already
book-specific books are left alone.

AFTER
-----
Re-run the Q&A pre-store (prestore_seo_content --qa-only) so the NEW questions get
grounded answers; the orphaned generic answers in meta.qa are harmless.

Usage:
  python -m scripts.regenerate_questions --dry-run
  python -m scripts.regenerate_questions --apply --no-init --sleep 0.4
"""
from __future__ import annotations

import argparse
import re
import sys
import time

from app.core import config  # noqa: F401 — ensures env is loaded
from app.core.db import (
    add_questions,
    clear_questions,
    embedded_agent_ids,
    get_agent,
    get_mid_chunks_text,
    init_db,
    list_questions,
    probe_pgvector,
)
from app.core.providers import bulk_chat

GENERIC = {
    "What is the central thesis of this text?",
    "What evidence does the author provide?",
    "How would you explain the key concepts in your own words?",
    "What are the practical implications?",
    "What questions remain unanswered?",
}

SYSTEM = (
    "You write concise, specific reader questions about one particular book. Every "
    "question must be answerable from the book and must reference its actual ideas "
    "— never generic questions that could apply to any book."
)


def build_prompt(title: str, sample: str) -> str:
    return (
        f'Book: "{title}"\n\n'
        f"Excerpt:\n{sample[:3500]}\n\n"
        "Generate exactly 5 questions a curious reader would search for about THIS "
        "book specifically. Requirements:\n"
        "- Each names a concrete concept, claim, argument, or theme from the excerpt.\n"
        "- Concise: 6-12 words, phrased as a natural search query.\n"
        "- About the book's IDEAS, arguments, characters, and themes — NEVER about "
        "spelling, typography, printing, editions, page counts, formatting, or "
        "text-encoding artifacts (e.g. old 'u'/'v' spelling, OCR quirks, 'liue').\n"
        "- NOT generic (never 'what is the central thesis', 'what evidence does the "
        "author provide', 'what are the practical implications', etc.).\n"
        "Return ONLY the 5 questions, one per line, no numbering, no extra text."
    )


def parse_questions(text: str) -> list[str]:
    out: list[str] = []
    for line in (text or "").strip().split("\n"):
        q = line.strip().lstrip("0123456789.)-• ").strip().strip('"').strip()
        if len(q) > 8 and q.endswith("?"):
            out.append(q)
    return out[:5]


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--no-init", action="store_true")
    ap.add_argument("--sleep", type=float, default=0.4)
    ap.add_argument("--limit", type=int, default=None)
    args = ap.parse_args()

    if args.no_init:
        probe_pgvector()
    else:
        init_db()

    # Regenerate if the questions are all the generic fallback OR any question is
    # about a text/printing artifact (old-spelling Gutenberg front matter made the
    # first pass ask about 'liue', 'cliche', 'u'/'v' printing, etc. — junk for SEO).
    artifact = re.compile(
        r"(print|typograph|spell|liue|clich|folio|\bocr\b|margin[- ]?note|\bitalic"
        r"|e-?text|transcrib|gutenberg|page count|footnote)", re.I)
    big = embedded_agent_ids(min_chunks=5)
    targets = []
    for aid in big:
        qs = list_questions(aid)
        if not qs:
            continue
        if all(q in GENERIC for q in qs) or any(artifact.search(q) for q in qs):
            targets.append(aid)
    print(f"{len(targets)} books to (re)generate (of {len(big)} indexable)",
          file=sys.stderr)

    done = failed = 0
    for aid in targets:
        if args.limit is not None and done >= args.limit:
            break
        agent = get_agent(aid)
        if not agent:
            continue
        title = (agent.get("name") or "this book").strip()
        sample = "\n\n".join((c.get("text") or "") for c in get_mid_chunks_text(aid, limit=8))
        if not sample.strip():
            print(f"  SKIP {title!r}: no text", file=sys.stderr)
            continue
        if not args.apply:
            print(f"  [dry] would regenerate {title!r}", file=sys.stderr)
            done += 1
            continue
        try:
            res, _ = bulk_chat(system=SYSTEM, user=build_prompt(title, sample))
            qs = parse_questions(res.content)
            if len(qs) < 3 or any(q in GENERIC for q in qs):
                print(f"  FAIL {title!r}: weak/generic output ({len(qs)})", file=sys.stderr)
                failed += 1
                continue
            clear_questions(aid)
            add_questions(aid, qs)
            done += 1
            print(f"  OK   {title!r}: {qs[0]}", file=sys.stderr)
        except Exception as exc:
            failed += 1
            print(f"  FAIL {title!r}: {exc}", file=sys.stderr)
        time.sleep(args.sleep)

    print(f"--- done: regenerated={done} failed={failed} ---", file=sys.stderr)
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
