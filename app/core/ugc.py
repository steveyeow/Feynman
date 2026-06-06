"""User-generated content pipeline for public-discussion pages
(Phase 6 of the SEO/GEO plan).

Privacy model — read this before changing anything in this module:

  * **Opt-in only.** A chat session is private by default
    (`public_status = 'private'`). It only becomes a candidate for public
    display after the owning user explicitly calls the /share API, which
    sets `public_status = 'opted_in'` and stamps `consent_at`.
  * **Moderation required.** Opted-in sessions are still not public until
    an admin sets `public_status = 'approved'` (and stamps `approved_at` +
    `approved_by`). This module's read helpers filter on this status —
    nothing else does, so leaking is hard.
  * **Right to withdraw.** Owners can flip status to `'withdrawn'` at any
    time. Withdrawn sessions never render even if previously approved.
  * **PII scrubbing.** ``scrub_pii_for_public_display`` redacts email
    addresses, phone numbers, and explicit URLs before any content is
    rendered. Conservative — better to over-redact than leak.
  * **Anonymous by default.** ``public_handle`` is optional; when absent
    we display "Anonymous". User-supplied handles are themselves PII so
    we cap length and reject anything that contains an `@` or a digit
    pattern that looks like a phone number.
  * **Feature flag.** ``ENABLE_PUBLIC_DISCUSSIONS`` gates the entire
    surface. Default OFF means even if migrations have populated columns
    and a user has somehow opted in, the public render route + opt-in
    API return 404. Don't flip the flag until product/legal sign off
    AND the SPA opt-in UI ships.

Status values:
  ``private``    - default, never displayed (also covers brand-new sessions)
  ``opted_in``   - user consented, awaiting moderation. NOT displayed.
  ``approved``   - admin approved. RENDERED on /book/{id}/discussions etc.
  ``rejected``   - admin rejected (content unsuitable / failed PII review).
  ``withdrawn``  - user withdrew consent post-approval. Stops rendering.
"""
from __future__ import annotations

import os
import re
from typing import Any

# Module-level kill switch. Read at import time — restart-required if
# you change it. That's intentional: a runtime flip would mean the
# next request after deployment could be the first time the surface
# is live, with no warm-up. Restart-required keeps the activation
# observable in the deploy log.
_PUBLIC_DISCUSSIONS_ENABLED = os.getenv(
    "ENABLE_PUBLIC_DISCUSSIONS", "false"
).strip().lower() in ("1", "true", "yes", "on")


def is_enabled() -> bool:
    return _PUBLIC_DISCUSSIONS_ENABLED


# ─── PII scrubbing ────────────────────────────────────────────────────
#
# All public content passes through scrub_pii_for_public_display before
# rendering. Conservative: catch the obvious shapes, accept some false
# positives (e.g. a string that looks like a phone number but isn't).
# Anything more sophisticated (named-entity recognition for personal
# names, geo addresses, etc.) is out of v1 scope — the per-conversation
# admin review serves as the human backstop for those.

# Emails — RFC-ish, broad enough to catch user.name+tag@sub.example.co
_EMAIL_RE = re.compile(
    r"\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b"
)

# Phone-ish digit runs: 7+ digits with optional separators and an
# optional country prefix. Catches "(415) 555-1234", "+86 138 0013 8000",
# "415-555-1234", "4155551234". May false-positive on long numeric IDs;
# that's acceptable for v1.
_PHONE_RE = re.compile(
    r"(?<!\d)(?:\+?\d{1,3}[\s\-.])?(?:\(?\d{2,4}\)?[\s\-.]?)?\d{3}[\s\-.]?\d{3,4}(?!\d)"
)

# URLs — broad, including bare domains. Strips them entirely rather
# than rewriting because we don't want personalized URLs surfaced
# (github.com/{user}, linkedin.com/in/{handle}, etc).
_URL_RE = re.compile(
    r"\bhttps?://[^\s<>\"']+",
    re.IGNORECASE,
)

# Handles like @username and #hashtags often carry identity. Strip.
_AT_HANDLE_RE = re.compile(r"(?<!\w)@[A-Za-z0-9_]{2,30}\b")

# Markdown links whose target is a dangerous URL scheme. The public renderers
# run scrubbed text through a markdown→HTML pass, so a crafted
# ``[x](javascript:…)`` would otherwise become a clickable script link on a
# PUBLIC page. Strip the scheme (keeping the link text) — XSS hardening.
_DANGEROUS_LINK_RE = re.compile(
    r"(?i)(\]\(\s*)(?:javascript|data|vbscript|file)\s*:"
)


def scrub_pii_for_public_display(text: str) -> str:
    """Run the four redactors. Returns the sanitized string. The
    "[redacted]" marker stays in human-readable English regardless of
    source language because it doubles as a visible accountability cue
    on the rendered page."""
    if not text:
        return ""
    out = _EMAIL_RE.sub("[email redacted]", text)
    out = _URL_RE.sub("[link redacted]", out)
    out = _PHONE_RE.sub("[phone redacted]", out)
    out = _AT_HANDLE_RE.sub("[handle redacted]", out)
    out = _DANGEROUS_LINK_RE.sub(r"\1", out)
    return out


# ─── Public handle validation ─────────────────────────────────────────

_HANDLE_MAX_LEN = 40
_HANDLE_DIGIT_RUN_RE = re.compile(r"\d{4,}")


def validate_public_handle(raw: str) -> tuple[str, str | None]:
    """Returns (cleaned_handle, error). Cleaned handle is empty if the
    input is rejected. The error message is meant for the API response.

    Rules:
      * Trim whitespace.
      * Max ``_HANDLE_MAX_LEN`` chars after trim.
      * Reject anything containing '@' (looks like email).
      * Reject a run of 4+ digits (looks like a phone number).
      * Reject empty after trim (caller should fall back to "Anonymous").
    """
    if raw is None:
        return ("", None)  # Anonymous — not an error
    handle = raw.strip()
    if not handle:
        return ("", None)
    if "@" in handle:
        return ("", "Handle cannot contain '@'")
    if _HANDLE_DIGIT_RUN_RE.search(handle):
        return ("", "Handle cannot contain a long run of digits")
    if len(handle) > _HANDLE_MAX_LEN:
        return ("", f"Handle too long (max {_HANDLE_MAX_LEN} characters)")
    return (handle, None)


# ─── JSON-LD for public discussions ───────────────────────────────────

def discussion_forum_jsonld(
    *,
    posts: list[dict[str, Any]],
    page_url: str,
    headline: str,
    about_url: str,
    about_type: str = "CreativeWork",
    about_name: str = "",
) -> dict[str, Any]:
    """Schema.org/DiscussionForumPosting — Google added rich-result
    support for this in 2024. Each post is a Comment with an
    anonymized author. Posts in are expected to be already PII-scrubbed.

    ``posts`` items have keys: handle, body, created_at, session_id.
    ``about_type`` is "Book" for /book/{id}/discussions, "Person" for
    /mind/{id}/discussions.
    """
    comments = []
    for i, p in enumerate(posts):
        comments.append({
            "@type": "Comment",
            "position": i + 1,
            "author": {
                "@type": "Person",
                "name": p.get("handle") or "Anonymous",
            },
            "text": p.get("body", ""),
            "dateCreated": p.get("created_at", ""),
        })
    return {
        "@context": "https://schema.org",
        "@type": "DiscussionForumPosting",
        "headline": headline,
        "url": page_url,
        "about": {
            "@type": about_type,
            "name": about_name,
            "url": about_url,
        },
        "commentCount": len(comments),
        "comment": comments,
    }
