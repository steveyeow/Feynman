from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()

BASE_DIR = Path(__file__).resolve().parents[2]
DATA_DIR = Path(os.getenv("DATA_DIR", BASE_DIR / "data"))
_default_upload = "/tmp/uploads" if os.getenv("VERCEL") else str(DATA_DIR / "uploads")
UPLOAD_DIR = Path(os.getenv("UPLOAD_DIR", _default_upload))
DB_PATH = Path(os.getenv("DB_PATH", DATA_DIR / "chatbook.db"))

APP_NAME = os.getenv("APP_NAME", "Feynman")
APP_TITLE = os.getenv("APP_TITLE", "Feynman")

# Bump (or set env OG_IMAGE_CACHE_VERSION) when OG card artwork changes so social crawlers see a new URL.
OG_IMAGE_CACHE_VERSION = os.getenv("OG_IMAGE_CACHE_VERSION", "10").strip() or "10"

PROVIDER_ORDER = [p.strip().lower() for p in os.getenv("PROVIDER_ORDER", "deepseek,gemini,openai,novita,kimi,anthropic").split(",") if p.strip()]

CHAT_PROVIDER = os.getenv("CHAT_PROVIDER", "auto").lower()
EMBED_PROVIDER = os.getenv("EMBED_PROVIDER", "auto").lower()

OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "").strip()
OPENAI_BASE_URL = os.getenv("OPENAI_BASE_URL", "https://api.openai.com/v1").strip()
OPENAI_CHAT_MODEL = os.getenv("OPENAI_CHAT_MODEL", "gpt-4o-mini").strip()
OPENAI_EMBED_MODEL = os.getenv("OPENAI_EMBED_MODEL", "text-embedding-3-small").strip()

# Gemini supports comma-separated keys for quota stacking across Google accounts.
# When one key hits its quota or fails, we automatically rotate to the next.
# Example: GEMINI_API_KEY=AIzaSy...key1,AIzaSy...key2
GEMINI_API_KEYS = [k.strip() for k in os.getenv("GEMINI_API_KEY", "").split(",") if k.strip()]
GEMINI_API_KEY = GEMINI_API_KEYS[0] if GEMINI_API_KEYS else ""
GEMINI_BASE_URL = os.getenv("GEMINI_BASE_URL", "https://generativelanguage.googleapis.com/v1beta").strip()
GEMINI_CHAT_MODEL = os.getenv("GEMINI_CHAT_MODEL", "gemini-2.5-flash").strip()
GEMINI_EMBED_MODEL = os.getenv("GEMINI_EMBED_MODEL", "gemini-embedding-001").strip()

KIMI_API_KEY = os.getenv("KIMI_API_KEY", "").strip()
KIMI_BASE_URL = os.getenv("KIMI_BASE_URL", "https://api.moonshot.cn/v1").strip()
KIMI_CHAT_MODEL = os.getenv("KIMI_CHAT_MODEL", "moonshot-v1-8k").strip()
KIMI_EMBED_MODEL = os.getenv("KIMI_EMBED_MODEL", "").strip()

DEEPSEEK_API_KEY = os.getenv("DEEPSEEK_API_KEY", "").strip()
DEEPSEEK_BASE_URL = os.getenv("DEEPSEEK_BASE_URL", "https://api.deepseek.com/v1").strip()
DEEPSEEK_CHAT_MODEL = os.getenv("DEEPSEEK_CHAT_MODEL", "deepseek-chat").strip()

ANTHROPIC_API_KEY = os.getenv("ANTHROPIC_API_KEY", "").strip()
ANTHROPIC_BASE_URL = os.getenv("ANTHROPIC_BASE_URL", "https://api.anthropic.com").strip()
ANTHROPIC_CHAT_MODEL = os.getenv("ANTHROPIC_CHAT_MODEL", "claude-sonnet-4-5-20250929").strip()

NOVITA_API_KEY = os.getenv("NOVITA_API_KEY", "").strip()
NOVITA_BASE_URL = os.getenv("NOVITA_BASE_URL", "https://api.novita.ai/openai").strip()
NOVITA_CHAT_MODEL = os.getenv("NOVITA_CHAT_MODEL", "deepseek/deepseek-v3.2").strip()
NOVITA_EMBED_MODEL = os.getenv("NOVITA_EMBED_MODEL", "qwen/qwen3-embedding-0.6b").strip()

MAX_CHUNK_CHARS = int(os.getenv("MAX_CHUNK_CHARS", "1200"))
CHUNK_OVERLAP = int(os.getenv("CHUNK_OVERLAP", "120"))
TOP_K = int(os.getenv("TOP_K", "5"))
