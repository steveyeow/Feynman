"""LLM referrer tracking — Phase 7.3 of the SEO/GEO plan.

Detect when an inbound request came from an LLM-based search surface
(ChatGPT, Perplexity, Claude, Gemini, Copilot, You.com, Phind) and
record the hit. This is the only way to measure "is our SEO/GEO work
actually translating into LLM-cited traffic" — Google Analytics et al.
don't distinguish LLM referrals from ordinary web traffic.

Storage model: a small append-only table ``llm_referrals``. We log
only:

  * ``url_path`` — what page got the hit (no query string, no
    user-identifying details).
  * ``referer_host`` — which LLM service sent them (or the bare host).
  * ``ua_class`` — coarse user-agent bucket (bot vs human-browser),
    to distinguish crawler hits from human follow-throughs.
  * ``created_at`` — timestamp.

We do NOT log: full URLs (privacy), cookies, IP, full UA string,
user IDs. Aggregate-only analytics.

The middleware is fail-open: any error in tracking gets swallowed so
a logging issue can never break a page load.
"""
from __future__ import annotations

import logging
import re
from typing import Any

log = logging.getLogger(__name__)


# Hosts that mean "the user got here from an LLM-based search/chat surface."
# Sorted by relevance — most-used first to short-circuit faster on hits.
_LLM_REFERER_HOSTS: dict[str, str] = {
    "chatgpt.com": "chatgpt",
    "chat.openai.com": "chatgpt",
    "perplexity.ai": "perplexity",
    "www.perplexity.ai": "perplexity",
    "claude.ai": "claude",
    "gemini.google.com": "gemini",
    "bard.google.com": "gemini",
    "copilot.microsoft.com": "copilot",
    "you.com": "you",
    "phind.com": "phind",
    "kagi.com": "kagi",
    "duckduckgo.com": "duckduckgo",  # DDG now uses LLM answers
}

# User-agent fragments that mark LLM crawlers — included so we can also
# log when an LLM bot fetches our content (the precursor to citations).
# Lowercased substring match.
_LLM_BOT_UA_FRAGMENTS: dict[str, str] = {
    "gptbot": "chatgpt",
    "chatgpt-user": "chatgpt",
    "claudebot": "claude",
    "claude-web": "claude",
    "anthropic-ai": "claude",
    "perplexitybot": "perplexity",
    "perplexity-user": "perplexity",
    "google-extended": "gemini",
    "googleother": "gemini",
    "applebot-extended": "apple-ai",
    "cohere-ai": "cohere",
    "ccbot": "common-crawl",  # used by many LLM training pipelines
}


def _extract_host(url: str) -> str:
    """Pull just the host out of a Referer header value. Returns empty
    string if the URL is malformed (we never parse-fail aloud)."""
    if not url:
        return ""
    try:
        # strip scheme
        rest = url.split("://", 1)[-1] if "://" in url else url
        host = rest.split("/", 1)[0].split("?", 1)[0].lower()
        return host
    except Exception:
        return ""


def classify_referer(referer: str) -> str | None:
    """Returns the LLM source name (``"chatgpt"``, ``"perplexity"``, …)
    if the referer is an LLM surface, else None. Cheap — pure string
    ops, runnable in middleware on every request."""
    host = _extract_host(referer)
    if not host:
        return None
    return _LLM_REFERER_HOSTS.get(host)


def classify_user_agent(ua: str) -> str | None:
    """Returns the LLM bot family if the UA is a recognized AI crawler,
    else None. Lowercases the UA once and substring-matches."""
    if not ua:
        return None
    ua_lower = ua.lower()
    for fragment, family in _LLM_BOT_UA_FRAGMENTS.items():
        if fragment in ua_lower:
            return family
    return None


def classify_request(referer: str, user_agent: str) -> tuple[str | None, str]:
    """Combined classifier. Returns (source, ua_class).

    ``source`` is the LLM family name or None if neither header signals
    LLM origin. ``ua_class`` is ``"bot"`` if the UA matches a known
    LLM crawler, ``"human"`` if not (the referer is from a chat surface
    but the UA is a regular browser — i.e. a user clicking through),
    or ``"unknown"`` if we couldn't classify.
    """
    via_ua = classify_user_agent(user_agent)
    via_referer = classify_referer(referer)
    if via_ua:
        return (via_ua, "bot")
    if via_referer:
        return (via_referer, "human")
    return (None, "unknown")
