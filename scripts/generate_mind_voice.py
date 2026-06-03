"""Generate a first-person "voice" self-introduction for each mind, stored in
minds.meta_json.voice — the Feynman-native first-person About on the mind page.

WHY first-person: a third-person bio ("X was a philosopher who…") reads like
Wikipedia. A first-person voice ("I read the mind as a historian reads an era…")
makes it unmistakably a persona you can think WITH. Clearly labelled as an
imagined synthesis on the page.

Idempotent: skips minds that already have meta.voice. Re-run to fill new minds.

Usage:
  python -m scripts.generate_mind_voice --dry-run
  python -m scripts.generate_mind_voice --apply --no-init --sleep 0.3
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import time

from app.core import config  # noqa: F401 — ensures env is loaded
from app.core.db import get_conn, _q, _execute, _fetchall, init_db, probe_pgvector
from app.core.providers import bulk_chat

SYSTEM = (
    "You ARE the named historical thinker, speaking in the FIRST person to a "
    "curious person who is about to think WITH you. Voice: distinctive, confident, "
    "grounded in your real work and era. Never break character."
)


def build_prompt(name: str, domain: str, bio: str, style: str) -> str:
    return (
        f"Introduce yourself as {name} ({domain or 'a great thinker'}) in the FIRST "
        "person — 2 to 3 sentences, 40-65 words. Say how you see your field and the "
        "one thing you most want a newcomer to grasp. Use 'I'. Make it an invitation "
        "to think together — NOT a resume, NO birth/death dates, never 'I was a …'. "
        "Do NOT open with a greeting (no 'Ah', 'Hello', 'Greetings', 'Welcome', "
        "'Hi', 'Hail') — open directly with your name or an idea. "
        f"Ground it in:\n{(bio or '')[:380]}\n{(style or '')[:280]}"
    )


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--no-init", action="store_true")
    ap.add_argument("--sleep", type=float, default=0.3)
    ap.add_argument("--limit", type=int, default=None)
    args = ap.parse_args()

    if args.no_init:
        probe_pgvector()
    else:
        init_db()

    with get_conn() as conn:
        rows = _fetchall(conn, "SELECT id, name, domain, bio_summary, thinking_style, meta_json FROM minds")
    # (Re)generate if there's no voice OR the voice opens with a canned greeting
    # ("Ah, greetings!" repeated across minds = a templated tell to kill).
    greet = re.compile(r"^\s*(ah\b|hello\b|greetings\b|welcome\b|hi\b|hail\b)", re.I)
    def needs(r) -> bool:
        v = (json.loads(r.get("meta_json") or "{}").get("voice") or "").strip()
        return (not v) or bool(greet.match(v))
    todo = [r for r in rows if needs(r)]
    print(f"{len(todo)} minds need a voice (of {len(rows)})", file=sys.stderr)

    done = failed = 0
    for r in todo:
        if args.limit is not None and done >= args.limit:
            break
        try:
            res, _ = bulk_chat(
                system=SYSTEM,
                user=build_prompt(r["name"], r.get("domain"), r.get("bio_summary"), r.get("thinking_style")),
            )
            voice = (res.content or "").strip().strip('"').strip()
            if len(voice) < 30:
                failed += 1
                print(f"  FAIL {r['name']!r}: too short", file=sys.stderr)
                continue
            if not args.apply:
                done += 1
                if done <= 6:
                    print(f"  [dry] {r['name']}: {voice[:90]}", file=sys.stderr)
                continue
            meta = json.loads(r.get("meta_json") or "{}")
            meta["voice"] = voice
            with get_conn() as conn:
                _execute(conn, _q("UPDATE minds SET meta_json = ? WHERE id = ?"),
                         (json.dumps(meta), r["id"]))
            done += 1
            print(f"  OK   {r['name']}: {voice[:70]}", file=sys.stderr)
        except Exception as exc:
            failed += 1
            print(f"  FAIL {r['name']!r}: {exc}", file=sys.stderr)
        time.sleep(args.sleep)

    print(f"--- done: voiced={done} failed={failed} ---", file=sys.stderr)
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
