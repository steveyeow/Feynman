from __future__ import annotations

import os
import logging

import jwt
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse

from ..core.db import get_or_create_user

log = logging.getLogger(__name__)

SUPABASE_JWT_SECRET = os.getenv("SUPABASE_JWT_SECRET", "").strip()
JWT_ALGORITHMS = ["HS256"]

PUBLIC_PATHS = {
    "/", "/api/health",
    "/api/pro/config",
    "/api/pro/webhook",
    "/api/topics",
    "/api/agents",
    "/api/votes",
    "/api/minds",
    "/favicon.ico",
}
PUBLIC_PREFIXES = ("/static/",)


class AuthMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        path = request.url.path
        is_public = path in PUBLIC_PATHS or any(path.startswith(p) for p in PUBLIC_PREFIXES)
        is_get_api = request.method == "GET" and path.startswith("/api/")

        if is_public:
            return await call_next(request)

        auth_header = request.headers.get("authorization", "")
        has_token = auth_header.startswith("Bearer ")

        if not has_token:
            if is_get_api:
                return await call_next(request)
            return JSONResponse(
                {"detail": "Authentication required", "code": "auth_required"},
                status_code=401,
            )

        token = auth_header[7:]
        try:
            payload = jwt.decode(
                token, SUPABASE_JWT_SECRET,
                algorithms=JWT_ALGORITHMS,
                audience="authenticated",
            )
        except jwt.ExpiredSignatureError:
            if is_get_api:
                return await call_next(request)
            return JSONResponse({"detail": "Token expired", "code": "token_expired"}, status_code=401)
        except jwt.InvalidTokenError as e:
            log.warning("JWT validation failed: %s", e)
            if is_get_api:
                return await call_next(request)
            return JSONResponse({"detail": "Invalid token", "code": "invalid_token"}, status_code=401)

        user_id = payload.get("sub", "")
        email = payload.get("email", "")

        if not user_id:
            if is_get_api:
                return await call_next(request)
            return JSONResponse({"detail": "Invalid token claims"}, status_code=401)

        user = get_or_create_user(user_id, email)

        request.state.user_id = user_id
        request.state.email = email
        request.state.tier = user.get("tier", "free") if user else "free"

        return await call_next(request)
