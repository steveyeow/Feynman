"""Trending-topic source for the daily symposium cron.

Hacker News front page → the seed for the daily auto-generated symposiums. The
headlines are just a *spark*: an LLM (in debates.py) distills the enduring tension
underneath them into a TIMELESS question great minds can argue, never the
ephemeral news itself. HN skews to the AI / founder / product / science audience
we promote to on Twitter, and the Algolia API is open (no auth), so this runs
unattended on Vercel cron.

Kept deliberately thin — just the fetch. The distill→cast→generate pipeline lives
in debates.py (reusing the expand_symposiums machinery)."""
from __future__ import annotations

import json
import logging
import urllib.request
from typing import Any

log = logging.getLogger(__name__)

# Algolia's HN search returns the current front page in one call (no pagination,
# no auth). `query=` empty + tags=front_page = the live front page.
_HN_FRONT = "https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=40"


def fetch_hn_titles(n: int = 30, min_points: int = 0) -> list[str]:
    """Front-page HN story titles, most-discussed first. Best-effort: returns []
    on any network/parse failure so the cron degrades to a no-op rather than
    erroring. `min_points` optionally drops low-signal stories."""
    try:
        req = urllib.request.Request(
            _HN_FRONT,
            # A browser-ish UA — some CDNs 1010-ban urllib's default agent
            # (cf. the Resend/Cloudflare note in notify.py).
            headers={"User-Agent": "Mozilla/5.0 (compatible; feynman-trending/1.0)"},
        )
        with urllib.request.urlopen(req, timeout=10) as r:
            data: dict[str, Any] = json.loads(r.read().decode("utf-8"))
    except Exception as exc:
        log.warning("HN front-page fetch failed: %s", exc)
        return []
    titles: list[str] = []
    for h in data.get("hits", []):
        title = (h.get("title") or "").strip()
        if not title:
            continue
        if min_points and (h.get("points") or 0) < min_points:
            continue
        titles.append(title)
    return titles[:n]
