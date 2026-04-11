from __future__ import annotations

import os
import logging
import time

import jwt
import httpx
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse

from ..core.db import get_or_create_user

log = logging.getLogger(__name__)

SUPABASE_JWT_SECRET = os.getenv("SUPABASE_JWT_SECRET", "").strip()
SUPABASE_URL = os.getenv("SUPABASE_URL", "").strip()

_JWKS_CACHE: list | None = None
_JWKS_CACHE_TIME: float = 0
_JWKS_TTL = 600

PUBLIC_PATHS = {
    "/", "/api/health",
    "/api/pro/config",
    "/api/pro/webhook",
    "/api/topics",
    "/api/agents",
    "/api/votes",
    "/api/minds",
    "/favicon.ico",
    "/terms",
    "/privacy",
    "/robots.txt",
    "/sitemap",
    "/sitemap.xml",
    "/llms.txt",
    "/llms-full.txt",
}
PUBLIC_PREFIXES = ("/static/", "/share/", "/book/", "/mind/", "/api/public/")

# GET requests to these paths require authentication (user-specific data)
PRIVATE_GET_PREFIXES = (
    "/api/sessions",
    "/api/ai-books",
    "/api/users/",
    "/api/pro/subscription",
)
PRIVATE_GET_SUFFIXES = ("/read", "/messages", "/questions")


def _get_jwks_keys() -> list:
    """Fetch and cache JWKS keys from Supabase."""
    global _JWKS_CACHE, _JWKS_CACHE_TIME
    now = time.monotonic()
    if _JWKS_CACHE is not None and (now - _JWKS_CACHE_TIME) < _JWKS_TTL:
        return _JWKS_CACHE
    if not SUPABASE_URL:
        return _JWKS_CACHE or []
    jwks_url = f"{SUPABASE_URL.rstrip('/')}/auth/v1/.well-known/jwks.json"
    try:
        resp = httpx.get(jwks_url, timeout=5)
        resp.raise_for_status()
        keys = resp.json().get("keys", [])
        _JWKS_CACHE = [jwt.PyJWK(k) for k in keys]
        _JWKS_CACHE_TIME = now
        log.info("Fetched %d JWKS keys from %s", len(_JWKS_CACHE), jwks_url)
    except Exception as e:
        log.warning("JWKS fetch failed: %s", e)
    return _JWKS_CACHE or []


def _decode_token(token: str) -> dict:
    """Decode a Supabase JWT. Supports HS256 (legacy) and ES256 (JWKS)."""
    header = jwt.get_unverified_header(token)
    alg = header.get("alg", "")

    if alg == "HS256":
        return jwt.decode(
            token, SUPABASE_JWT_SECRET,
            algorithms=["HS256"],
            audience="authenticated",
        )

    if alg == "ES256":
        kid = header.get("kid", "")
        for jwk in _get_jwks_keys():
            if jwk.key_id == kid:
                return jwt.decode(
                    token, jwk.key,
                    algorithms=["ES256"],
                    audience="authenticated",
                )
        raise jwt.InvalidTokenError(f"No JWKS key found for kid={kid}")

    raise jwt.InvalidTokenError(f"Unsupported algorithm: {alg}")


class AuthMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        path = request.url.path
        is_public = path in PUBLIC_PATHS or any(path.startswith(p) for p in PUBLIC_PREFIXES)
        is_get_api = request.method == "GET" and path.startswith("/api/")

        if is_public:
            return await call_next(request)

        auth_header = request.headers.get("authorization", "")
        has_token = auth_header.startswith("Bearer ")

        is_private_get = is_get_api and (
            any(path.startswith(p) for p in PRIVATE_GET_PREFIXES)
            or any(path.endswith(s) for s in PRIVATE_GET_SUFFIXES)
        )

        if not has_token:
            if is_get_api and not is_private_get:
                return await call_next(request)
            return JSONResponse(
                {"detail": "Authentication required", "code": "auth_required"},
                status_code=401,
            )

        token = auth_header[7:]
        try:
            payload = _decode_token(token)
        except jwt.ExpiredSignatureError:
            if is_get_api and not is_private_get:
                return await call_next(request)
            return JSONResponse({"detail": "Token expired", "code": "token_expired"}, status_code=401)
        except jwt.InvalidTokenError as e:
            log.warning("JWT validation failed: %s", e)
            if is_get_api and not is_private_get:
                return await call_next(request)
            return JSONResponse({"detail": "Invalid token", "code": "invalid_token"}, status_code=401)

        user_id = payload.get("sub", "")
        email = payload.get("email", "")

        if not user_id:
            if is_get_api and not is_private_get:
                return await call_next(request)
            return JSONResponse({"detail": "Invalid token claims"}, status_code=401)

        try:
            user = get_or_create_user(user_id, email)
        except Exception as e:
            log.error("get_or_create_user failed for %s: %s", user_id, e)
            user = None

        request.state.user_id = user_id
        request.state.email = email
        request.state.tier = user.get("tier", "free") if user else "free"

        return await call_next(request)
