"""Lightweight operational alerting via Resend (stdlib-only, no new deps).

Sends to ALERT_EMAIL (default shuqi.yeow@gmail.com). The `from` address must be a
Resend-verified sender — set ALERT_FROM to a verified one (default assumes the
feynman.wiki domain is verified). Never raises: a failed alert must not break the
caller (it's a watchdog, not a critical path)."""

from __future__ import annotations

import json
import logging
import os
import urllib.request

log = logging.getLogger(__name__)

_DEFAULT_TO = "shuqi.yeow@gmail.com"
_DEFAULT_FROM = "Feynman Alerts <alerts@feynman.wiki>"


def send_alert_email(subject: str, html: str, to: str | None = None) -> bool:
    """POST an email via Resend. Returns True on 2xx, False otherwise (logged)."""
    api_key = os.getenv("RESEND_API_KEY")
    if not api_key:
        log.warning("send_alert_email: RESEND_API_KEY not set — skipping")
        return False
    to_addr = to or os.getenv("ALERT_EMAIL", _DEFAULT_TO)
    from_addr = os.getenv("ALERT_FROM", _DEFAULT_FROM)
    payload = json.dumps(
        {"from": from_addr, "to": [to_addr], "subject": subject, "html": html}
    ).encode("utf-8")
    req = urllib.request.Request(
        "https://api.resend.com/emails",
        data=payload,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            # Resend sits behind Cloudflare, which 1010-bans urllib's default UA
            # ("Python-urllib/x") — the request fails before reaching Resend.
            # A normal browser UA avoids the block (verified: default UA → CF 1010,
            # this UA → proper Resend response).
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            ok = 200 <= resp.status < 300
            if not ok:
                log.error("send_alert_email: Resend returned %s", resp.status)
            return ok
    except Exception as exc:  # noqa: BLE001 — watchdog must never raise
        body = ""
        try:
            body = exc.read().decode("utf-8")[:300]  # type: ignore[attr-defined]
        except Exception:
            pass
        log.error("send_alert_email: Resend send failed: %s %s", exc, body)
        return False
