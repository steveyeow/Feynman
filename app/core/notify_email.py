"""Resend-backed email notifications.

Three call sites only — keep this module narrow.

  1. ``send_admin_alert(subject, body)``           — supabase-usage-monitor
     fires this on YELLOW/RED so the operator (us) sees free-tier risk
     even when the chat client isn't open.
  2. ``send_welcome_email(user_email, user_name)`` — first sign-in, gated
     by ``users.welcome_sent_at`` so it never double-fires.
  3. ``send_admin_report_email(session_id, reporter_id, reason)`` — when
     a logged-in user reports an approved public discussion. Lets us
     react inside the day rather than after the fact.

Design notes:
  - Resend API; no SMTP. One HTTP POST per email.
  - **Never raises.** All paths return False on failure so the caller's
    main work (user signup, monitor report, report submission) keeps
    succeeding. Errors go to stdout/logger.
  - If ``RESEND_API_KEY`` is unset (e.g. local dev), every call is a
    no-op that returns False — caller doesn't need to special-case env.
  - Until ``feynman.wiki`` is verified at resend.com/domains, the
    Resend test mode rejects sends to anything other than the account
    email (stevetianqi@gmail.com). We send from ``onboarding@resend.dev``
    in that mode. Once verified the operator should set
    ``RESEND_FROM`` to ``noreply@feynman.wiki`` (we keep the var
    overridable so the switch is one env update, zero code).
"""

from __future__ import annotations

import logging
import os
from typing import Any

import httpx

logger = logging.getLogger(__name__)

RESEND_API = "https://api.resend.com/emails"
DEFAULT_FROM = "Feynman <onboarding@resend.dev>"
DEFAULT_ADMIN = "shuqi.yeow@gmail.com"


def _send(to: str | list[str], subject: str, html: str, *,
          from_addr: str | None = None, text: str | None = None) -> bool:
    """POST one email to Resend. Returns True iff Resend accepted it.

    Never raises; on any failure (no key, network error, 4xx/5xx) we
    log and return False so callers don't have to wrap this in try.
    """
    api_key = os.getenv("RESEND_API_KEY", "").strip()
    if not api_key:
        # Local dev or env not configured — silently skip.
        return False

    sender = from_addr or os.getenv("RESEND_FROM", "").strip() or DEFAULT_FROM
    payload: dict[str, Any] = {
        "from": sender,
        "to": to if isinstance(to, list) else [to],
        "subject": subject,
        "html": html,
    }
    if text:
        payload["text"] = text

    try:
        resp = httpx.post(
            RESEND_API,
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            },
            json=payload,
            timeout=10.0,
        )
    except Exception as exc:
        logger.warning("Resend request failed: %s", exc)
        return False

    if resp.status_code == 200:
        return True

    # 403 in test mode (to address != Resend-account email) is expected
    # until domain is verified; downgrade to info so it doesn't look
    # like a real error.
    level = logging.INFO if resp.status_code == 403 else logging.WARNING
    logger.log(level, "Resend %s -> %s: %s",
               payload["to"], resp.status_code, resp.text[:200])
    return False


# ─── 1. Admin alert (free-tier usage monitor) ─────────────────────────

def send_admin_alert(subject: str, body: str) -> bool:
    """Email the operator when usage monitor flags YELLOW/RED.

    ``body`` is plain text (the monitor's natural format); we wrap it in
    a ``<pre>`` so quota tables render legibly. Subject gets a tag
    prefix so threading groups them in the inbox.
    """
    to = os.getenv("ADMIN_EMAIL", "").strip() or DEFAULT_ADMIN
    safe_subject = f"[Feynman] {subject}"
    # Escape minimally for HTML; the body is operator-only so we don't
    # need full sanitisation, just enough that '<' doesn't eat content.
    escaped = (body.replace("&", "&amp;")
                   .replace("<", "&lt;")
                   .replace(">", "&gt;"))
    html = (
        '<div style="font-family:-apple-system,BlinkMacSystemFont,sans-serif">'
        f'<pre style="white-space:pre-wrap;font-family:ui-monospace,monospace;'
        f'background:#f6f8fa;padding:12px;border-radius:6px">{escaped}</pre>'
        '</div>'
    )
    return _send(to, safe_subject, html, text=body)


# ─── 2. Welcome email (first sign-in) ─────────────────────────────────

WELCOME_HTML = """\
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#1a1a1a">
  <p style="font-size:16px;line-height:1.55">Hi {greeting},</p>
  <p style="font-size:16px;line-height:1.55">
    Welcome to <strong>Feynman</strong>. You can now:
  </p>
  <ul style="font-size:15px;line-height:1.7;padding-left:20px">
    <li><strong>Chat with any book.</strong> Pick a book from the library and ask anything — Feynman reads the full text and answers in context.</li>
    <li><strong>Invite great minds to join.</strong> Add Einstein, Munger, Buffett or any thinker into the conversation; each replies in their own voice.</li>
    <li><strong>Chat with a great mind directly.</strong> Skip the book and talk to the person.</li>
  </ul>
  <p style="font-size:16px;line-height:1.55">
    Start here:
    <a href="https://feynman.wiki/" style="color:#2563eb;text-decoration:none">feynman.wiki</a>
  </p>
  <p style="font-size:13px;line-height:1.5;color:#6b7280;margin-top:32px">
    You're receiving this because you signed up for Feynman.
    If this wasn't you, reply to this email and we'll remove the account.
  </p>
</div>"""

WELCOME_TEXT = """\
Hi {greeting},

Welcome to Feynman. You can now:

  - Chat with any book. Pick one from the library and ask anything;
    Feynman reads the full text and answers in context.
  - Invite great minds to join. Add Einstein, Munger, Buffett or any
    thinker; each replies in their own voice.
  - Chat with a great mind directly. Skip the book and talk to the
    person.

Start here: https://feynman.wiki/

You're receiving this because you signed up for Feynman. If this
wasn't you, reply and we'll remove the account.
"""


def send_welcome_email(user_email: str, user_name: str | None = None) -> bool:
    """First-sign-in welcome. Caller is responsible for idempotency.

    Returns False (no-op) if email is empty or Resend isn't configured.
    """
    user_email = (user_email or "").strip()
    if not user_email or "@" not in user_email:
        return False

    # Greeting: prefer first name, else local-part of email, else "there".
    greeting = "there"
    if user_name:
        greeting = user_name.strip().split()[0] or greeting
    elif "@" in user_email:
        greeting = user_email.split("@", 1)[0] or greeting

    html = WELCOME_HTML.format(greeting=greeting)
    text = WELCOME_TEXT.format(greeting=greeting)
    return _send(user_email, "Welcome to Feynman", html, text=text)


# ─── 3. Public-discussion report alert ────────────────────────────────

def send_admin_report_email(session_id: str, reporter_id: str,
                            reason: str | None = None) -> bool:
    """Notify operator when a logged-in user reports a public discussion.

    Reports are rare enough that one email per is fine; we don't need
    digesting. Include the session URL so triage is one click.
    """
    to = os.getenv("ADMIN_EMAIL", "").strip() or DEFAULT_ADMIN
    url = f"https://feynman.wiki/discussions/{session_id}"
    subject = f"[Feynman] Public discussion reported: {session_id[:8]}"
    reason_line = (
        f'<p><strong>Reason:</strong> {reason}</p>' if reason else ""
    )
    html = (
        '<div style="font-family:-apple-system,sans-serif;max-width:560px">'
        f'<p>A user reported a public discussion.</p>'
        f'<p><strong>Discussion:</strong> '
        f'<a href="{url}">{url}</a></p>'
        f'<p><strong>Reporter:</strong> {reporter_id}</p>'
        f'{reason_line}'
        '<p style="margin-top:24px;font-size:13px;color:#6b7280">'
        'Review and unpublish via /admin if needed.</p>'
        '</div>'
    )
    text = (
        f"A user reported a public discussion.\n\n"
        f"Discussion: {url}\nReporter: {reporter_id}\n"
        f"{('Reason: ' + reason + chr(10)) if reason else ''}\n"
        f"Review and unpublish via /admin if needed."
    )
    return _send(to, subject, html, text=text)
