from __future__ import annotations

from fastapi import HTTPException, Request

from ..core.db import count_usage_today, count_user_uploads, count_ai_books_this_month, record_usage

QUOTA_LIMITS = {
    "free": {
        "chat": 15,
        "mind_chat": 5,
        "discover": 3,
        "generate_mind": 0,
        "upload": 2,
        "custom_minds": 0,
        "ai_book": 0,
    },
    "pro": {
        "chat": 200,
        "mind_chat": 100,
        "discover": 50,
        "generate_mind": 30,
        "upload": 30,
        "custom_minds": 30,
        "ai_book": 3,
    },
}

AI_BOOK_MONTHLY_LIMITS = {
    "free": 0,
    "pro": 3,
}

UPLOAD_TOTAL_LIMITS = {
    "free": 3,
    "pro": 50,
}


def check_quota(request: Request, action: str) -> None:
    """Check if the user has remaining quota for the given action.
    Raises HTTP 429 if quota exceeded. No-op if auth is not enabled."""
    user_id = getattr(request.state, "user_id", None)
    if not user_id:
        return

    tier = getattr(request.state, "tier", "free")
    limits = QUOTA_LIMITS.get(tier, QUOTA_LIMITS["free"])
    limit = limits.get(action, -1)

    if limit == -1:
        return

    used = count_usage_today(user_id, action)
    if used >= limit:
        messages = {
            "chat": "You've used all your daily chats. Upgrade to Pro for 200 chats/day.",
            "mind_chat": "You've reached your daily mind conversations limit. Upgrade to Pro for 100/day.",
            "generate_mind": "Great minds are waiting to join your discussions. Upgrade to Pro for unlimited mind suggestions.",
            "discover": "You've used all your daily discoveries. Upgrade to Pro to discover 50 books/day.",
        }
        raise HTTPException(
            status_code=429,
            detail={
                "code": "quota_exceeded",
                "action": action,
                "limit": limit,
                "used": used,
                "tier": tier,
                "message": messages.get(action, f"Daily {action} limit reached ({limit}). Upgrade to Pro for higher limits."),
            },
        )


def check_upload_limit(request: Request) -> None:
    """Check total upload limit (lifetime, not daily). Raises HTTP 429 if exceeded."""
    user_id = getattr(request.state, "user_id", None)
    if not user_id:
        return

    tier = getattr(request.state, "tier", "free")
    limit = UPLOAD_TOTAL_LIMITS.get(tier, UPLOAD_TOTAL_LIMITS["free"])
    used = count_user_uploads(user_id)
    if used >= limit:
        raise HTTPException(
            status_code=429,
            detail={
                "code": "upload_limit_reached",
                "action": "upload",
                "limit": limit,
                "used": used,
                "tier": tier,
                "message": f"Upload limit reached ({used}/{limit} books). Upgrade to Pro to upload more.",
            },
        )


def check_ai_book_quota(request: Request) -> None:
    """Check monthly AI book creation limit. Free users cannot create books."""
    user_id = getattr(request.state, "user_id", None)
    if not user_id:
        return

    tier = getattr(request.state, "tier", "free")
    limit = AI_BOOK_MONTHLY_LIMITS.get(tier, 0)

    if limit == 0:
        raise HTTPException(
            status_code=429,
            detail={
                "code": "quota_exceeded",
                "action": "ai_book",
                "limit": 0,
                "used": 0,
                "tier": tier,
                "message": "AI book writing is a Pro feature. Upgrade to create custom books.",
            },
        )

    used = count_ai_books_this_month(user_id)
    if used >= limit:
        raise HTTPException(
            status_code=429,
            detail={
                "code": "quota_exceeded",
                "action": "ai_book",
                "limit": limit,
                "used": used,
                "tier": tier,
                "message": f"Monthly AI book limit reached ({used}/{limit}). Limit resets next month.",
            },
        )


def track_usage(request: Request, action: str, tokens_used: int = 0) -> None:
    """Record usage for the current user. No-op if auth is not enabled."""
    user_id = getattr(request.state, "user_id", None)
    if not user_id:
        return
    record_usage(user_id, action, tokens_used)
