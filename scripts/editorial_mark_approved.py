"""Editorial showcase — mark hand-picked sessions as publicly approved.

Phase 6.1 of the SEO/GEO master plan: bypass the user-opt-in flow and
let the team (you) directly publish curated best-of conversations to
seed the /book/{id}/discussions and /mind/{id}/discussions surfaces.

Why this exists
---------------
The Phase 6 UGC pipeline shipped with a two-step gate by default:
  1. User opts in via POST /api/chat-sessions/{id}/share → status='opted_in'
  2. Admin approves via POST /api/admin/.../approve     → status='approved'

For the editorial-showcase launch path, the user-opt-in step is
unnecessary — you (the editor) are picking the sessions yourself.
This script writes status='approved' directly, skipping step 1.

Prerequisites
-------------
- ENABLE_PUBLIC_DISCUSSIONS=true set in Vercel env (otherwise the
  /discussions routes return 404 to the public).
- ADMIN_USER_IDS contains your Supabase UUID (recorded in approved_by
  for audit).
- Each session you mark must already exist and have at least one
  message (otherwise the discussion page renders empty).

Usage
-----
  python -m scripts.editorial_mark_approved --session-ids "id1,id2,id3"
  python -m scripts.editorial_mark_approved --session-ids "id1" --title "Marx on AI labor"
  python -m scripts.editorial_mark_approved --dry-run --session-ids "id1,id2"
  python -m scripts.editorial_mark_approved --list-recent          # discover candidates
  python -m scripts.editorial_mark_approved --unmark "id1"         # rollback

Safety
------
- --dry-run prints what would change without writing.
- Each marked session shows current status + new status; refuses to
  re-approve already-approved sessions (idempotent).
- Stores --title under public_title and your --handle under
  public_handle so the rendered page can show attribution and a
  human-friendly headline.
"""
from __future__ import annotations

import argparse
import sys
from typing import Any

from app.core import config  # noqa: F401 — loads env
from app.core.db import get_conn, _fetchall, _q


# Your editorial UUID. Lives here as the default so you don't have to
# remember it on every run; can override via --admin-id.
EDITORIAL_ADMIN_ID = "60eb16ed-5b16-46c5-a5bc-54c18b2bd84b"


def _fetch_session(conn, session_id: str) -> dict[str, Any] | None:
    rows = _fetchall(conn, _q(
        """SELECT id, user_id, title, session_type, mind_id,
                  public_status, public_handle, public_title,
                  consent_at, approved_at, approved_by, updated_at
           FROM chat_sessions WHERE id = ?"""
    ), (session_id,))
    return rows[0] if rows else None


def _count_messages(conn, session_id: str) -> int:
    rows = _fetchall(conn, _q(
        "SELECT COUNT(*) AS n FROM session_messages WHERE session_id = ?"
    ), (session_id,))
    return int(rows[0]["n"]) if rows else 0


def mark_approved(
    session_ids: list[str], admin_id: str, dry_run: bool,
    title: str | None = None, handle: str | None = None,
) -> int:
    """Returns count of sessions actually changed."""
    changed = 0
    with get_conn() as conn:
        for sid in session_ids:
            sess = _fetch_session(conn, sid)
            if not sess:
                print(f"  ✗ {sid[:8]}…  NOT FOUND", file=sys.stderr)
                continue
            current = sess.get("public_status") or "private"
            msgs = _count_messages(conn, sid)
            label = (sess.get("title") or "(untitled)")[:50]
            if current == "approved":
                print(f"  · {sid[:8]}…  already approved   {label!r:<52}", file=sys.stderr)
                continue
            if msgs < 2:
                print(f"  ⚠ {sid[:8]}…  only {msgs} messages — skipped (would render empty)   {label!r}",
                      file=sys.stderr)
                continue
            arrow = "would mark" if dry_run else "marking"
            print(f"  → {sid[:8]}…  {current} → approved ({arrow})   {label!r:<52}  [{msgs} msgs]",
                  file=sys.stderr)
            if not dry_run:
                set_clauses = [
                    "public_status = 'approved'",
                    "approved_at = NOW()",
                    "approved_by = ?",
                ]
                params: list = [admin_id]
                if title:
                    set_clauses.append("public_title = ?")
                    params.append(title)
                if handle:
                    set_clauses.append("public_handle = ?")
                    params.append(handle)
                params.append(sid)
                cur = conn.cursor()
                cur.execute(_q(
                    f"UPDATE chat_sessions SET {', '.join(set_clauses)} WHERE id = ?"
                ), tuple(params))
            changed += 1
    return changed


def unmark(session_ids: list[str], dry_run: bool) -> int:
    """Revert approved → private. Use to remove a published showcase."""
    changed = 0
    with get_conn() as conn:
        for sid in session_ids:
            sess = _fetch_session(conn, sid)
            if not sess:
                print(f"  ✗ {sid[:8]}…  NOT FOUND", file=sys.stderr)
                continue
            current = sess.get("public_status") or "private"
            if current != "approved":
                print(f"  · {sid[:8]}…  status={current} (already private)", file=sys.stderr)
                continue
            arrow = "would revert" if dry_run else "reverting"
            print(f"  ← {sid[:8]}…  approved → private ({arrow})", file=sys.stderr)
            if not dry_run:
                cur = conn.cursor()
                cur.execute(_q(
                    "UPDATE chat_sessions SET public_status = 'private', "
                    "approved_at = NULL, approved_by = NULL WHERE id = ?"
                ), (sid,))
            changed += 1
    return changed


def list_recent_candidates(limit: int = 30) -> None:
    """Print recent sessions with message counts to help pick what to feature."""
    with get_conn() as conn:
        rows = _fetchall(conn, _q(
            """SELECT cs.id, cs.title, cs.session_type, cs.public_status,
                      cs.updated_at,
                      (SELECT COUNT(*) FROM session_messages sm
                       WHERE sm.session_id = cs.id) AS msg_count
               FROM chat_sessions cs
               WHERE cs.user_id IS NOT NULL
               ORDER BY cs.updated_at DESC
               LIMIT ?"""
        ), (limit,))
    print(f"{'id':<10} {'msgs':>5} {'status':<10} {'type':<8}  title", file=sys.stderr)
    for r in rows:
        sid = r["id"][:8] + "…"
        n = int(r.get("msg_count") or 0)
        status = (r.get("public_status") or "private")
        stype = r.get("session_type") or ""
        title = (r.get("title") or "")[:60]
        print(f"  {sid:<10} {n:>5} {status:<10} {stype:<8}  {title!r}", file=sys.stderr)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--session-ids", type=str, default="",
                        help="Comma-separated list of session UUIDs to mark approved.")
    parser.add_argument("--unmark", type=str, default="",
                        help="Comma-separated list of session UUIDs to revert to private.")
    parser.add_argument("--list-recent", action="store_true",
                        help="Print recent sessions with message counts to help pick.")
    parser.add_argument("--dry-run", action="store_true",
                        help="Print what would change, write nothing.")
    parser.add_argument("--admin-id", type=str, default=EDITORIAL_ADMIN_ID,
                        help=f"Editor user_id stamped as approved_by (default: {EDITORIAL_ADMIN_ID}).")
    parser.add_argument("--title", type=str, default=None,
                        help="Optional public_title override (rendered as the discussion headline).")
    parser.add_argument("--handle", type=str, default=None,
                        help="Optional public_handle for attribution byline (e.g. @yourname).")
    args = parser.parse_args()

    if args.list_recent:
        list_recent_candidates()
        return 0

    if args.unmark:
        ids = [s.strip() for s in args.unmark.split(",") if s.strip()]
        n = unmark(ids, args.dry_run)
        print(f"--- {'would revert' if args.dry_run else 'reverted'} {n} session(s) ---", file=sys.stderr)
        return 0

    if not args.session_ids:
        print("error: --session-ids or --unmark or --list-recent required", file=sys.stderr)
        return 2

    ids = [s.strip() for s in args.session_ids.split(",") if s.strip()]
    if not ids:
        print("error: no valid ids parsed from --session-ids", file=sys.stderr)
        return 2
    print(f"--- editorial mark (dry_run={args.dry_run}, admin={args.admin_id[:8]}…) ---",
          file=sys.stderr)
    n = mark_approved(ids, args.admin_id, args.dry_run, args.title, args.handle)
    print(f"--- {'would mark' if args.dry_run else 'marked'} {n} session(s) approved ---",
          file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
