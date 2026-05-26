"""IndexNow ping — Phase 7.2 of the SEO/GEO plan.

IndexNow is a Bing/Yandex/Naver-supported protocol for proactively
notifying search engines about new or updated URLs. Faster than waiting
for the next crawl cycle (typically days → minutes).

Protocol (https://www.indexnow.org/documentation):

  1. Generate a random key string (lowercase alphanumeric, 8-128 chars).
  2. Host the key as plain text at ``https://<host>/<key>.txt``. The
     body of that file MUST be exactly the key string.
  3. POST a URL list to ``https://api.indexnow.org/IndexNow`` with the
     key + keyLocation in the body.
  4. Engines verify the key file exists, then crawl the URLs.

We expose the key file via a FastAPI route and call ``ping_urls`` from
a cron endpoint (daily). The cron sends the URLs of entities created
or updated in the last 24 hours; this gives a steady drip without
overwhelming the IndexNow rate limits (10,000 URLs per submission max).

Failure semantics: ping_urls returns a status dict but never raises.
If IndexNow is down or returns an error, the next cron run picks up
the same URLs again (idempotent — re-submitting is fine).
"""
from __future__ import annotations

import json
import logging
import os
from typing import Any
from urllib.error import URLError
from urllib.request import Request, urlopen

log = logging.getLogger(__name__)


# The key is content-addressed verification: bingbot fetches
# /<key>.txt and must get the key string back. Production should set
# INDEXNOW_KEY explicitly so it's stable across deploys (rotating
# breaks the verification file ↔ submission mapping). Dev fallback
# is a fixed string that's not secret (anyone can pick a key).
_DEFAULT_KEY = "feynman-indexnow-2026-05-26-7f3a"
INDEXNOW_KEY = os.getenv("INDEXNOW_KEY", _DEFAULT_KEY).strip().lower()

# IndexNow submission endpoint. Single endpoint serves Bing, Yandex,
# Naver (they share the protocol).
_INDEXNOW_URL = "https://api.indexnow.org/IndexNow"

# Per-submission URL count cap (protocol max is 10,000; we stay well
# under to avoid request-size issues).
_MAX_URLS_PER_PING = 1000


def get_key_file_content() -> str:
    """Plain-text body of /<key>.txt — must be exactly the key."""
    return INDEXNOW_KEY


def get_key_file_name() -> str:
    """The filename portion of the verification URL: '<key>.txt'."""
    return f"{INDEXNOW_KEY}.txt"


def ping_urls(urls: list[str], host: str, timeout: float = 5.0) -> dict[str, Any]:
    """Submit a batch of URLs to IndexNow.

    ``host`` is the bare domain (e.g. ``"feynman.wiki"``) — the protocol
    requires it explicitly so a key can't be misused across sites.

    Returns ``{"status": "ok" | "error" | "skipped", "submitted": N,
    "http_status": code, "detail": str}``. Never raises.
    """
    if not urls:
        return {"status": "skipped", "submitted": 0, "detail": "no urls"}
    if not INDEXNOW_KEY or not host:
        return {"status": "skipped", "submitted": 0, "detail": "missing key or host"}

    capped = urls[:_MAX_URLS_PER_PING]
    body = {
        "host": host,
        "key": INDEXNOW_KEY,
        "keyLocation": f"https://{host}/{INDEXNOW_KEY}.txt",
        "urlList": capped,
    }
    data = json.dumps(body).encode("utf-8")
    req = Request(
        _INDEXNOW_URL,
        data=data,
        headers={
            "Content-Type": "application/json; charset=utf-8",
            "User-Agent": "Feynman/1.0 (+https://feynman.wiki)",
        },
        method="POST",
    )
    try:
        with urlopen(req, timeout=timeout) as resp:
            status = resp.status
        # IndexNow returns 200 on success, 202 on accepted-for-processing,
        # 4xx on bad input. 200/202 both mean "we accepted it."
        if status in (200, 202):
            return {
                "status": "ok",
                "submitted": len(capped),
                "http_status": status,
                "detail": "accepted",
            }
        return {
            "status": "error",
            "submitted": 0,
            "http_status": status,
            "detail": f"unexpected status {status}",
        }
    except URLError as exc:
        log.warning("IndexNow ping failed (URLError): %s", exc)
        return {"status": "error", "submitted": 0, "detail": f"urlerror: {exc}"}
    except Exception as exc:
        log.warning("IndexNow ping unexpected error: %s", exc)
        return {"status": "error", "submitted": 0, "detail": str(exc)}
