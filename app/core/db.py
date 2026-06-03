from __future__ import annotations

import json
import logging
import os
import re
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from typing import Any, Iterable

log = logging.getLogger(__name__)

from .config import DB_PATH, DATA_DIR

_RAW_DATABASE_URL = os.getenv("DATABASE_URL", "") or os.getenv("POSTGRES_URL", "")


def _clean_dsn(url: str) -> str:
    """Strip query params psycopg2 doesn't understand (e.g. pgbouncer=true)."""
    if "?" in url:
        base, qs = url.split("?", 1)
        from urllib.parse import parse_qs, urlencode
        params = parse_qs(qs)
        params.pop("pgbouncer", None)
        clean_qs = urlencode(params, doseq=True)
        return f"{base}?{clean_qs}" if clean_qs else base
    return url


DATABASE_URL = _clean_dsn(_RAW_DATABASE_URL)

_USE_PG = bool(DATABASE_URL)

# Set after init_db() runs the pgvector migration. True iff:
#   1. PostgreSQL is in use, and
#   2. The `vector` extension is installed, and
#   3. The `chunks.embedding` halfvec column exists.
# Read by rag.py to decide between SQL ANN and legacy in-Python scoring.
_HAS_PGVECTOR = False


def probe_pgvector() -> bool:
    """Set ``_HAS_PGVECTOR`` from a single information_schema lookup.

    ``init_db()`` is the canonical way to flip this flag, but it runs the
    full migration sequence (CREATE EXTENSION, ALTER TABLE, …) which hangs
    on Supabase's pgbouncer pooler when called from a backfill script that
    shares the pool with the live web tier. Backfill scripts pass
    ``--skip-init-db`` to dodge that hang — but then ``_HAS_PGVECTOR``
    stays at its False default, ``add_chunks`` takes the legacy BYTEA
    path, and ``embedding`` (halfvec) never gets written. Resulting chunks
    are invisible to ``rag.ann_topk`` and ``/q/`` answers regress to
    "the passages don't contain the information."

    This probe is read-only (no DDL, no transaction) so it works through
    pgbouncer. Call it whenever you skip ``init_db()`` but still want the
    pgvector write path enabled.
    """
    global _HAS_PGVECTOR
    if not _USE_PG:
        _HAS_PGVECTOR = False
        return False
    try:
        with get_conn() as conn:
            row = _fetchone(conn,
                "SELECT 1 FROM information_schema.columns "
                "WHERE table_name = 'chunks' AND column_name = 'embedding'")
            _HAS_PGVECTOR = bool(row)
    except Exception as exc:
        log.warning("probe_pgvector failed, leaving _HAS_PGVECTOR=False: %s", exc)
        _HAS_PGVECTOR = False
    return _HAS_PGVECTOR


def _utcnow() -> str:
    return datetime.now(timezone.utc).isoformat()


def _ensure_dirs() -> None:
    if not _USE_PG:
        from pathlib import Path
        Path(DATA_DIR).mkdir(parents=True, exist_ok=True)


def _pg():
    """Lazy import psycopg2 only when PostgreSQL is used."""
    import psycopg2
    import psycopg2.extras
    return psycopg2

@contextmanager
def get_conn():
    if _USE_PG:
        pg = _pg()
        conn = pg.connect(DATABASE_URL)
        conn.autocommit = False
        try:
            yield conn
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()
    else:
        import sqlite3
        _ensure_dirs()
        conn = sqlite3.connect(DB_PATH)
        conn.row_factory = sqlite3.Row
        try:
            yield conn
            conn.commit()
        finally:
            conn.close()


def _fetchone(conn, query: str, params: tuple = ()) -> dict[str, Any] | None:
    if _USE_PG:
        import psycopg2.extras
        cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        cur.execute(query, params)
        row = cur.fetchone()
        return dict(row) if row else None
    else:
        row = conn.execute(query, params).fetchone()
        return dict(row) if row else None


def _fetchall(conn, query: str, params: tuple = ()) -> list[dict[str, Any]]:
    if _USE_PG:
        import psycopg2.extras
        cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        cur.execute(query, params)
        return [dict(r) for r in cur.fetchall()]
    else:
        rows = conn.execute(query, params).fetchall()
        return [dict(r) for r in rows]


def _execute(conn, query: str, params: tuple = ()):
    if _USE_PG:
        cur = conn.cursor()
        cur.execute(query, params)
        return cur
    else:
        return conn.execute(query, params)


def _executemany(conn, query: str, params_list: list[tuple]):
    if _USE_PG:
        cur = conn.cursor()
        for p in params_list:
            cur.execute(query, p)
    else:
        conn.executemany(query, params_list)


def _q(query: str) -> str:
    """Convert ? placeholders to %s for PostgreSQL."""
    if _USE_PG:
        return query.replace("?", "%s")
    return query


def _conflict_ignore(query: str) -> str:
    """Convert INSERT OR IGNORE to ON CONFLICT DO NOTHING for PostgreSQL."""
    if _USE_PG:
        return query.replace("INSERT OR IGNORE", "INSERT") + " ON CONFLICT DO NOTHING"
    return query


def init_db() -> None:
    with get_conn() as conn:
        if _USE_PG:
            # ── Create tables (schema matches the latest version) ──
            # NOTE: CREATE TABLE IF NOT EXISTS won't alter existing tables,
            # so columns added later (user_id, is_deleted) may be missing
            # in old deployments.  Migrations below handle that.
            _execute(conn, """
                CREATE TABLE IF NOT EXISTS agents (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    type TEXT NOT NULL,
                    source TEXT,
                    status TEXT NOT NULL,
                    meta_json TEXT,
                    user_id TEXT,
                    is_deleted BOOLEAN NOT NULL DEFAULT FALSE,
                    created_at TEXT NOT NULL
                )
            """)
            _execute(conn, """
                CREATE TABLE IF NOT EXISTS chunks (
                    id TEXT PRIMARY KEY,
                    agent_id TEXT NOT NULL REFERENCES agents(id),
                    chunk_index INTEGER NOT NULL,
                    text TEXT NOT NULL,
                    vector BYTEA NOT NULL,
                    dim INTEGER NOT NULL,
                    norm REAL NOT NULL
                )
            """)
            _execute(conn, "CREATE INDEX IF NOT EXISTS idx_chunks_agent_id ON chunks(agent_id)")
            # Migration: add tsvector column for full-text search
            try:
                _execute(conn, "SAVEPOINT sp_chunks_search_vec")
                _execute(conn, "ALTER TABLE chunks ADD COLUMN search_vector tsvector")
                _execute(conn, """
                    CREATE INDEX IF NOT EXISTS idx_chunks_search
                    ON chunks USING gin(search_vector)
                """)
                _execute(conn, "RELEASE SAVEPOINT sp_chunks_search_vec")
            except Exception:
                _execute(conn, "ROLLBACK TO SAVEPOINT sp_chunks_search_vec")

            # Migration: add pgvector halfvec column for SQL-side ANN retrieval.
            # Avoids pulling every chunk's raw vector blob into the app per chat —
            # the dominant source of Supabase egress. See app/core/rag.py.
            # Defensive: any failure (no pgvector ext, no halfvec type, dim too
            # large for ext version) is swallowed; callers fall back to the
            # legacy in-Python scoring path via _HAS_PGVECTOR=False.
            global _HAS_PGVECTOR
            from .config import EMBED_DIM
            try:
                _execute(conn, "SAVEPOINT sp_chunks_pgvec")
                _execute(conn, "CREATE EXTENSION IF NOT EXISTS vector")
                _execute(conn, f"ALTER TABLE chunks ADD COLUMN embedding halfvec({EMBED_DIM})")
                _execute(conn, "RELEASE SAVEPOINT sp_chunks_pgvec")
                _HAS_PGVECTOR = True
            except Exception as exc:
                _execute(conn, "ROLLBACK TO SAVEPOINT sp_chunks_pgvec")
                # Column may already exist from a prior boot — re-check to
                # avoid disabling the path on rerun.
                try:
                    row = _fetchone(conn,
                        "SELECT 1 FROM information_schema.columns "
                        "WHERE table_name = 'chunks' AND column_name = 'embedding'")
                    _HAS_PGVECTOR = bool(row)
                    if not _HAS_PGVECTOR:
                        log.info("pgvector migration skipped: %s", exc)
                except Exception:
                    _HAS_PGVECTOR = False
            _execute(conn, """
                CREATE TABLE IF NOT EXISTS messages (
                    id TEXT PRIMARY KEY,
                    agent_id TEXT NOT NULL REFERENCES agents(id),
                    user_id TEXT,
                    role TEXT NOT NULL,
                    content TEXT NOT NULL,
                    created_at TEXT NOT NULL
                )
            """)
            _execute(conn, """
                CREATE TABLE IF NOT EXISTS questions (
                    id TEXT PRIMARY KEY,
                    agent_id TEXT NOT NULL REFERENCES agents(id),
                    text TEXT NOT NULL,
                    created_at TEXT NOT NULL
                )
            """)
            _execute(conn, "CREATE INDEX IF NOT EXISTS idx_questions_agent_id ON questions(agent_id)")
            _execute(conn, """
                CREATE TABLE IF NOT EXISTS votes (
                    id TEXT PRIMARY KEY,
                    title TEXT NOT NULL,
                    count INTEGER NOT NULL DEFAULT 1,
                    created_at TEXT NOT NULL
                )
            """)
            _execute(conn, """
                CREATE TABLE IF NOT EXISTS minds (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL UNIQUE,
                    era TEXT,
                    domain TEXT,
                    bio_summary TEXT,
                    persona TEXT NOT NULL,
                    thinking_style TEXT,
                    typical_phrases TEXT,
                    works TEXT,
                    avatar_seed TEXT,
                    version INTEGER DEFAULT 1,
                    chat_count INTEGER DEFAULT 0,
                    created_at TEXT NOT NULL
                )
            """)
            _execute(conn, "CREATE INDEX IF NOT EXISTS idx_minds_name ON minds(LOWER(name))")
            _execute(conn, """
                CREATE TABLE IF NOT EXISTS mind_works (
                    mind_id TEXT NOT NULL REFERENCES minds(id),
                    agent_id TEXT NOT NULL REFERENCES agents(id),
                    PRIMARY KEY (mind_id, agent_id)
                )
            """)
            _execute(conn, """
                CREATE TABLE IF NOT EXISTS mind_memories (
                    id TEXT PRIMARY KEY,
                    mind_id TEXT NOT NULL REFERENCES minds(id),
                    user_id TEXT,
                    summary TEXT NOT NULL,
                    topic TEXT,
                    created_at TEXT NOT NULL
                )
            """)
            _execute(conn, "CREATE INDEX IF NOT EXISTS idx_mind_memories_mind ON mind_memories(mind_id)")

            # Chat sessions
            _execute(conn, """
                CREATE TABLE IF NOT EXISTS chat_sessions (
                    id TEXT PRIMARY KEY,
                    user_id TEXT,
                    title TEXT NOT NULL DEFAULT 'New chat',
                    session_type TEXT NOT NULL DEFAULT 'chat',
                    mind_id TEXT,
                    meta_json TEXT,
                    updated_at TEXT NOT NULL,
                    created_at TEXT NOT NULL
                )
            """)
            _execute(conn, """
                CREATE TABLE IF NOT EXISTS session_messages (
                    id TEXT PRIMARY KEY,
                    session_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
                    role TEXT NOT NULL,
                    content TEXT NOT NULL DEFAULT '',
                    meta_json TEXT,
                    created_at TEXT NOT NULL
                )
            """)
            _execute(conn, "CREATE INDEX IF NOT EXISTS idx_session_messages_session ON session_messages(session_id)")

            # AI-generated books
            _execute(conn, """
                CREATE TABLE IF NOT EXISTS ai_books (
                    id TEXT PRIMARY KEY,
                    agent_id TEXT NOT NULL REFERENCES agents(id),
                    user_id TEXT NOT NULL,
                    status TEXT NOT NULL DEFAULT 'outlining',
                    title TEXT NOT NULL,
                    description TEXT NOT NULL DEFAULT '',
                    outline_json TEXT NOT NULL DEFAULT '[]',
                    content_json TEXT NOT NULL DEFAULT '{}',
                    preferences_json TEXT NOT NULL DEFAULT '{}',
                    chapters_total INTEGER DEFAULT 0,
                    chapters_written INTEGER DEFAULT 0,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                )
            """)
            _execute(conn, "CREATE INDEX IF NOT EXISTS idx_ai_books_user ON ai_books(user_id)")
            _execute(conn, "CREATE INDEX IF NOT EXISTS idx_ai_books_agent ON ai_books(agent_id)")

            # ── Migrations: add columns that may be missing in old deployments ──
            # Run these BEFORE creating indexes on those columns.

            # Migration: add user_id to agents table
            try:
                _execute(conn, "SAVEPOINT sp_agents_uid")
                _execute(conn, "ALTER TABLE agents ADD COLUMN user_id TEXT")
                _execute(conn, "RELEASE SAVEPOINT sp_agents_uid")
            except Exception:
                _execute(conn, "ROLLBACK TO SAVEPOINT sp_agents_uid")

            # Migration: add is_deleted to agents table
            try:
                _execute(conn, "SAVEPOINT sp_agents_del")
                _execute(conn, "ALTER TABLE agents ADD COLUMN is_deleted BOOLEAN NOT NULL DEFAULT FALSE")
                _execute(conn, "RELEASE SAVEPOINT sp_agents_del")
            except Exception:
                _execute(conn, "ROLLBACK TO SAVEPOINT sp_agents_del")

            # Migration: add descriptive URL slug to agents table
            try:
                _execute(conn, "SAVEPOINT sp_agents_slug")
                _execute(conn, "ALTER TABLE agents ADD COLUMN slug TEXT")
                _execute(conn, "RELEASE SAVEPOINT sp_agents_slug")
            except Exception:
                _execute(conn, "ROLLBACK TO SAVEPOINT sp_agents_slug")

            # Migration: add user_id to messages table
            try:
                _execute(conn, "SAVEPOINT sp_messages_uid")
                _execute(conn, "ALTER TABLE messages ADD COLUMN user_id TEXT")
                _execute(conn, "DELETE FROM messages WHERE user_id IS NULL")
                _execute(conn, "RELEASE SAVEPOINT sp_messages_uid")
            except Exception:
                _execute(conn, "ROLLBACK TO SAVEPOINT sp_messages_uid")

            # Migration: add user_id to mind_memories table
            try:
                _execute(conn, "SAVEPOINT sp_mind_memories_uid")
                _execute(conn, "ALTER TABLE mind_memories ADD COLUMN user_id TEXT")
                _execute(conn, "RELEASE SAVEPOINT sp_mind_memories_uid")
            except Exception:
                _execute(conn, "ROLLBACK TO SAVEPOINT sp_mind_memories_uid")

            # Migration: add memory_type to mind_memories
            try:
                _execute(conn, "SAVEPOINT sp_mem_type")
                _execute(conn, "ALTER TABLE mind_memories ADD COLUMN memory_type TEXT NOT NULL DEFAULT 'interaction'")
                _execute(conn, "RELEASE SAVEPOINT sp_mem_type")
            except Exception:
                _execute(conn, "ROLLBACK TO SAVEPOINT sp_mem_type")

            # Migration: add embedding columns to minds table; plus Wikidata/
            # Wikipedia identity URLs (for Person JSON-LD sameAs — the
            # Knowledge-Graph / LLM entity signal on every expanded mind).
            for col, col_type in [("embedding", "BLOB"), ("embedding_dim", "INTEGER"), ("embedding_norm", "REAL"), ("wikidata_url", "TEXT"), ("wikipedia_url", "TEXT"), ("meta_json", "TEXT"), ("slug", "TEXT")]:
                try:
                    _execute(conn, f"SAVEPOINT sp_minds_{col}")
                    _execute(conn, f"ALTER TABLE minds ADD COLUMN {col} {col_type}")
                    _execute(conn, f"RELEASE SAVEPOINT sp_minds_{col}")
                except Exception:
                    _execute(conn, f"ROLLBACK TO SAVEPOINT sp_minds_{col}")

            # Migration: add user_id to chat_sessions
            try:
                _execute(conn, "SAVEPOINT sp_chat_sessions_uid")
                _execute(conn, "ALTER TABLE chat_sessions ADD COLUMN user_id TEXT")
                _execute(conn, """
                    DELETE FROM session_messages WHERE session_id IN (
                        SELECT id FROM chat_sessions WHERE user_id IS NULL
                    )
                """)
                _execute(conn, "DELETE FROM chat_sessions WHERE user_id IS NULL")
                _execute(conn, "RELEASE SAVEPOINT sp_chat_sessions_uid")
            except Exception:
                _execute(conn, "ROLLBACK TO SAVEPOINT sp_chat_sessions_uid")

            # Migration: UGC / public-discussions columns on chat_sessions.
            # All additive + defaulted to the most private value so existing
            # rows keep their privacy. The whole feature surface is gated
            # in main.py by ENABLE_PUBLIC_DISCUSSIONS (default False), so
            # adding these columns does NOT expose any conversation until
            # both (a) a user opts in via the /share API AND (b) the env
            # flag is flipped.
            for col, col_type, default in [
                ("public_status", "TEXT", "'private'"),
                ("public_handle", "TEXT", "NULL"),
                ("public_title", "TEXT", "NULL"),
                ("consent_at", "TIMESTAMPTZ", "NULL"),
                ("approved_at", "TIMESTAMPTZ", "NULL"),
                ("approved_by", "TEXT", "NULL"),
            ]:
                try:
                    _execute(conn, f"SAVEPOINT sp_cs_{col}")
                    null_clause = "" if default == "NULL" else f" NOT NULL DEFAULT {default}"
                    _execute(conn, f"ALTER TABLE chat_sessions ADD COLUMN {col} {col_type}{null_clause}")
                    _execute(conn, f"RELEASE SAVEPOINT sp_cs_{col}")
                except Exception:
                    _execute(conn, f"ROLLBACK TO SAVEPOINT sp_cs_{col}")

            # ── Now safe to create indexes on migrated columns ──
            _execute(conn, "CREATE INDEX IF NOT EXISTS idx_agents_user ON agents(user_id)")
            _execute(conn, "CREATE INDEX IF NOT EXISTS idx_messages_user ON messages(agent_id, user_id)")
            _execute(conn, "CREATE INDEX IF NOT EXISTS idx_mind_memories_user ON mind_memories(mind_id, user_id)")
            _execute(conn, "CREATE INDEX IF NOT EXISTS idx_chat_sessions_user ON chat_sessions(user_id)")

            # Pro tables
            _execute(conn, """
                CREATE TABLE IF NOT EXISTS users (
                    id UUID PRIMARY KEY,
                    email TEXT NOT NULL,
                    tier TEXT DEFAULT 'free',
                    subscription_status TEXT DEFAULT 'none',
                    subscription_ended_at TIMESTAMPTZ,
                    stripe_customer_id TEXT,
                    stripe_subscription_id TEXT,
                    created_at TIMESTAMPTZ DEFAULT NOW()
                )
            """)
            # Migration: add subscription_status and subscription_ended_at
            try:
                _execute(conn, "SAVEPOINT sp_users_substatus")
                _execute(conn, "ALTER TABLE users ADD COLUMN subscription_status TEXT DEFAULT 'none'")
                _execute(conn, "RELEASE SAVEPOINT sp_users_substatus")
            except Exception:
                _execute(conn, "ROLLBACK TO SAVEPOINT sp_users_substatus")
            try:
                _execute(conn, "SAVEPOINT sp_users_subended")
                _execute(conn, "ALTER TABLE users ADD COLUMN subscription_ended_at TIMESTAMPTZ")
                _execute(conn, "RELEASE SAVEPOINT sp_users_subended")
            except Exception:
                _execute(conn, "ROLLBACK TO SAVEPOINT sp_users_subended")

            # Migration: dedupe rows that share an email, then enforce PRIMARY KEY(id)
            # and UNIQUE(email). Legacy tables created before these constraints were
            # declared in the schema may have neither — CREATE TABLE IF NOT EXISTS
            # won't add constraints to a pre-existing table. As a result two rows
            # could share the same id, and DELETE WHERE id = X would wipe both.
            # We use ctid (Postgres physical row identity) to delete one row at a time.
            try:
                _execute(conn, "SAVEPOINT sp_users_email_dedupe")
                dup_emails = _fetchall(conn, """
                    SELECT email FROM users
                    WHERE email IS NOT NULL AND email <> ''
                    GROUP BY email
                    HAVING COUNT(*) > 1
                """)
                for de in dup_emails:
                    em = de["email"]
                    rows = _fetchall(conn, """
                        SELECT id, ctid::text AS ctid FROM users
                        WHERE email = %s
                        ORDER BY created_at ASC, ctid ASC
                    """, (em,))
                    keeper_id = rows[0]["id"]
                    for r in rows[1:]:
                        dup_id = r["id"]
                        dup_ctid = r["ctid"]
                        # Only repoint FKs when the dup is a genuinely separate user
                        # (different id). If the rows happen to share an id, FKs
                        # already point at the surviving row.
                        if dup_id != keeper_id:
                            for tbl in ("agents", "chat_sessions", "ai_books", "messages", "mind_memories"):
                                _execute(conn,
                                    f'UPDATE "{tbl}" SET user_id = %s WHERE user_id = %s',
                                    (keeper_id, dup_id))
                            _execute(conn,
                                "UPDATE usage SET user_id = %s WHERE user_id = %s",
                                (keeper_id, dup_id))
                        _execute(conn,
                            "DELETE FROM users WHERE ctid = %s::tid",
                            (dup_ctid,))
                _execute(conn, "RELEASE SAVEPOINT sp_users_email_dedupe")
            except Exception as e:
                _execute(conn, "ROLLBACK TO SAVEPOINT sp_users_email_dedupe")
                log.warning("users email dedupe migration skipped: %s", e)

            # Add PRIMARY KEY on id if the legacy table is missing it
            try:
                _execute(conn, "SAVEPOINT sp_users_pk")
                _execute(conn, "ALTER TABLE users ADD CONSTRAINT users_pkey PRIMARY KEY (id)")
                _execute(conn, "RELEASE SAVEPOINT sp_users_pk")
            except Exception:
                _execute(conn, "ROLLBACK TO SAVEPOINT sp_users_pk")

            try:
                _execute(conn, "SAVEPOINT sp_users_email_unique")
                _execute(conn, "ALTER TABLE users ADD CONSTRAINT users_email_unique UNIQUE (email)")
                _execute(conn, "RELEASE SAVEPOINT sp_users_email_unique")
            except Exception:
                _execute(conn, "ROLLBACK TO SAVEPOINT sp_users_email_unique")

            # Surface (don't auto-merge) any existing stripe_customer_id
            # collisions before attempting the unique index. Picking the
            # "real" subscriber when two users share a customer id is not
            # safe to do automatically.
            try:
                dup_customers = _fetchall(conn, """
                    SELECT stripe_customer_id, COUNT(*) AS n
                    FROM users
                    WHERE stripe_customer_id IS NOT NULL AND stripe_customer_id <> ''
                    GROUP BY stripe_customer_id
                    HAVING COUNT(*) > 1
                """)
                for dc in dup_customers:
                    log.error(
                        "Duplicate stripe_customer_id %s on %s users — manual reconciliation required before users_stripe_customer_unique can be enforced",
                        dc["stripe_customer_id"], dc["n"])
            except Exception as e:
                log.warning("stripe_customer_id duplicate scan failed: %s", e)

            # Partial unique index lets multiple free users coexist with NULL
            # customer ids while still enforcing uniqueness for paying users.
            try:
                _execute(conn, "SAVEPOINT sp_users_stripe_unique")
                _execute(conn,
                    "CREATE UNIQUE INDEX IF NOT EXISTS users_stripe_customer_unique "
                    "ON users (stripe_customer_id) "
                    "WHERE stripe_customer_id IS NOT NULL")
                _execute(conn, "RELEASE SAVEPOINT sp_users_stripe_unique")
            except Exception as e:
                _execute(conn, "ROLLBACK TO SAVEPOINT sp_users_stripe_unique")
                log.warning("users_stripe_customer_unique not created: %s", e)

            _execute(conn, """
                CREATE TABLE IF NOT EXISTS usage (
                    id SERIAL PRIMARY KEY,
                    user_id UUID REFERENCES users(id),
                    action TEXT NOT NULL,
                    tokens_used INTEGER DEFAULT 0,
                    created_at TIMESTAMPTZ DEFAULT NOW()
                )
            """)
            _execute(conn, "CREATE INDEX IF NOT EXISTS idx_usage_user_action ON usage(user_id, action, created_at)")

            # Reset sequence to avoid UniqueViolation after DB restores/migrations
            _execute(conn, "SELECT setval(pg_get_serial_sequence('usage', 'id'), COALESCE((SELECT MAX(id) FROM usage), 0) + 1, false)")

            # Cleanup: purge usage records older than 30 days (must run after table creation)
            _execute(conn, "DELETE FROM usage WHERE created_at < NOW() - INTERVAL '30 days'")

            # Stripe webhook idempotency: track processed event ids so re-deliveries
            # don't double-apply tier changes / overwrite subscription timestamps.
            _execute(conn, """
                CREATE TABLE IF NOT EXISTS stripe_webhook_events (
                    event_id TEXT PRIMARY KEY,
                    processed_at TIMESTAMPTZ DEFAULT NOW()
                )
            """)
            # Best-effort cleanup of old idempotency records (keep 30 days for replay window)
            _execute(conn, "DELETE FROM stripe_webhook_events WHERE processed_at < NOW() - INTERVAL '30 days'")

            # Phase 7.3 — LLM referrer tracking. Append-only, aggregate-only
            # (no IP, no user id, no full UA). Indexed for the admin
            # aggregate query.
            _execute(conn, """
                CREATE TABLE IF NOT EXISTS llm_referrals (
                    id BIGSERIAL PRIMARY KEY,
                    url_path TEXT NOT NULL,
                    source TEXT NOT NULL,
                    ua_class TEXT NOT NULL DEFAULT 'unknown',
                    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                )
            """)
            _execute(conn, "CREATE INDEX IF NOT EXISTS idx_llm_referrals_source_time ON llm_referrals(source, created_at DESC)")
            _execute(conn, "CREATE INDEX IF NOT EXISTS idx_llm_referrals_time ON llm_referrals(created_at DESC)")

            # Backfill PRIMARY KEY constraints on legacy tables. CREATE TABLE
            # IF NOT EXISTS does not add constraints to a pre-existing table,
            # so deployments that pre-date the current schema may have id
            # columns with no uniqueness enforced (the same root cause that
            # let two users coexist with the same UUID and that the dedupe
            # bug then collapsed). We attempt the ALTER per table; if a PK
            # already exists or duplicates block creation, we just log it
            # and move on — auto-deduping these tables is unsafe because the
            # right keep-row choice is table-specific.
            _legacy_pks = [
                ("agents", "id"),
                ("chunks", "id"),
                ("messages", "id"),
                ("questions", "id"),
                ("votes", "id"),
                ("minds", "id"),
                ("mind_memories", "id"),
                ("chat_sessions", "id"),
                ("session_messages", "id"),
                ("ai_books", "id"),
            ]
            for _tbl, _col in _legacy_pks:
                _sp = f"sp_{_tbl}_pk"
                try:
                    _execute(conn, f"SAVEPOINT {_sp}")
                    _execute(conn,
                        f'ALTER TABLE "{_tbl}" ADD CONSTRAINT "{_tbl}_pkey" PRIMARY KEY ({_col})')
                    _execute(conn, f"RELEASE SAVEPOINT {_sp}")
                except Exception as _e:
                    _execute(conn, f"ROLLBACK TO SAVEPOINT {_sp}")
                    msg = str(_e).lower()
                    # "already" → constraint already exists (silent, expected on healthy schemas).
                    # "duplicate"/"unique" → real duplicate values blocking the PK.
                    if "duplicate" in msg or ("unique" in msg and "already" not in msg):
                        log.error(
                            "PK on %s.%s blocked by duplicate values — manual cleanup needed: %s",
                            _tbl, _col, _e)

            # mind_works has a composite PK
            try:
                _execute(conn, "SAVEPOINT sp_mind_works_pk")
                _execute(conn,
                    'ALTER TABLE mind_works ADD CONSTRAINT mind_works_pkey PRIMARY KEY (mind_id, agent_id)')
                _execute(conn, "RELEASE SAVEPOINT sp_mind_works_pk")
            except Exception as _e:
                _execute(conn, "ROLLBACK TO SAVEPOINT sp_mind_works_pk")
                msg = str(_e).lower()
                if "duplicate" in msg or ("unique" in msg and "already" not in msg):
                    log.error(
                        "PK on mind_works(mind_id, agent_id) blocked by duplicates: %s", _e)
        else:
            _execute(conn, """
                CREATE TABLE IF NOT EXISTS agents (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    type TEXT NOT NULL,
                    source TEXT,
                    status TEXT NOT NULL,
                    meta_json TEXT,
                    user_id TEXT,
                    is_deleted INTEGER NOT NULL DEFAULT 0,
                    created_at TEXT NOT NULL
                )
            """)
            _execute(conn, """
                CREATE TABLE IF NOT EXISTS chunks (
                    id TEXT PRIMARY KEY,
                    agent_id TEXT NOT NULL,
                    chunk_index INTEGER NOT NULL,
                    text TEXT NOT NULL,
                    vector BLOB NOT NULL,
                    dim INTEGER NOT NULL,
                    norm REAL NOT NULL,
                    FOREIGN KEY(agent_id) REFERENCES agents(id)
                )
            """)
            _execute(conn, "CREATE INDEX IF NOT EXISTS idx_chunks_agent_id ON chunks(agent_id)")
            # FTS5 full-text search index for hybrid search
            _execute(conn, """
                CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
                    text, content=chunks, content_rowid=rowid
                )
            """)
            _execute(conn, """
                CREATE TABLE IF NOT EXISTS messages (
                    id TEXT PRIMARY KEY,
                    agent_id TEXT NOT NULL,
                    user_id TEXT,
                    role TEXT NOT NULL,
                    content TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    FOREIGN KEY(agent_id) REFERENCES agents(id)
                )
            """)
            _execute(conn, "CREATE INDEX IF NOT EXISTS idx_messages_user ON messages(agent_id, user_id)")
            _execute(conn, """
                CREATE TABLE IF NOT EXISTS questions (
                    id TEXT PRIMARY KEY,
                    agent_id TEXT NOT NULL,
                    text TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    FOREIGN KEY(agent_id) REFERENCES agents(id)
                )
            """)
            _execute(conn, "CREATE INDEX IF NOT EXISTS idx_questions_agent_id ON questions(agent_id)")
            _execute(conn, """
                CREATE TABLE IF NOT EXISTS votes (
                    id TEXT PRIMARY KEY,
                    title TEXT NOT NULL,
                    count INTEGER NOT NULL DEFAULT 1,
                    created_at TEXT NOT NULL
                )
            """)
            _execute(conn, """
                CREATE TABLE IF NOT EXISTS minds (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL UNIQUE,
                    era TEXT,
                    domain TEXT,
                    bio_summary TEXT,
                    persona TEXT NOT NULL,
                    thinking_style TEXT,
                    typical_phrases TEXT,
                    works TEXT,
                    avatar_seed TEXT,
                    version INTEGER DEFAULT 1,
                    chat_count INTEGER DEFAULT 0,
                    created_at TEXT NOT NULL
                )
            """)
            _execute(conn, "CREATE INDEX IF NOT EXISTS idx_minds_name ON minds(LOWER(name))")
            _execute(conn, """
                CREATE TABLE IF NOT EXISTS mind_works (
                    mind_id TEXT NOT NULL,
                    agent_id TEXT NOT NULL,
                    PRIMARY KEY (mind_id, agent_id),
                    FOREIGN KEY (mind_id) REFERENCES minds(id),
                    FOREIGN KEY (agent_id) REFERENCES agents(id)
                )
            """)
            _execute(conn, """
                CREATE TABLE IF NOT EXISTS mind_memories (
                    id TEXT PRIMARY KEY,
                    mind_id TEXT NOT NULL,
                    user_id TEXT,
                    summary TEXT NOT NULL,
                    topic TEXT,
                    created_at TEXT NOT NULL,
                    FOREIGN KEY (mind_id) REFERENCES minds(id)
                )
            """)
            _execute(conn, "CREATE INDEX IF NOT EXISTS idx_mind_memories_mind ON mind_memories(mind_id)")
            _execute(conn, "CREATE INDEX IF NOT EXISTS idx_mind_memories_user ON mind_memories(mind_id, user_id)")

            # Chat sessions
            _execute(conn, """
                CREATE TABLE IF NOT EXISTS chat_sessions (
                    id TEXT PRIMARY KEY,
                    user_id TEXT,
                    title TEXT NOT NULL DEFAULT 'New chat',
                    session_type TEXT NOT NULL DEFAULT 'chat',
                    mind_id TEXT,
                    meta_json TEXT,
                    updated_at TEXT NOT NULL,
                    created_at TEXT NOT NULL
                )
            """)
            _execute(conn, "CREATE INDEX IF NOT EXISTS idx_chat_sessions_user ON chat_sessions(user_id)")
            _execute(conn, """
                CREATE TABLE IF NOT EXISTS session_messages (
                    id TEXT PRIMARY KEY,
                    session_id TEXT NOT NULL,
                    role TEXT NOT NULL,
                    content TEXT NOT NULL DEFAULT '',
                    meta_json TEXT,
                    created_at TEXT NOT NULL,
                    FOREIGN KEY (session_id) REFERENCES chat_sessions(id) ON DELETE CASCADE
                )
            """)
            _execute(conn, "CREATE INDEX IF NOT EXISTS idx_session_messages_session ON session_messages(session_id)")

            # AI-generated books
            _execute(conn, """
                CREATE TABLE IF NOT EXISTS ai_books (
                    id TEXT PRIMARY KEY,
                    agent_id TEXT NOT NULL,
                    user_id TEXT NOT NULL,
                    status TEXT NOT NULL DEFAULT 'outlining',
                    title TEXT NOT NULL,
                    description TEXT NOT NULL DEFAULT '',
                    outline_json TEXT NOT NULL DEFAULT '[]',
                    content_json TEXT NOT NULL DEFAULT '{}',
                    preferences_json TEXT NOT NULL DEFAULT '{}',
                    chapters_total INTEGER DEFAULT 0,
                    chapters_written INTEGER DEFAULT 0,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    FOREIGN KEY (agent_id) REFERENCES agents(id)
                )
            """)
            _execute(conn, "CREATE INDEX IF NOT EXISTS idx_ai_books_user ON ai_books(user_id)")
            _execute(conn, "CREATE INDEX IF NOT EXISTS idx_ai_books_agent ON ai_books(agent_id)")

            # Migration: add user_id column if missing (existing deployments)
            try:
                _execute(conn, "ALTER TABLE chat_sessions ADD COLUMN user_id TEXT")
                _execute(conn, "CREATE INDEX IF NOT EXISTS idx_chat_sessions_user ON chat_sessions(user_id)")
                # Purge orphaned sessions that have no user_id (pre-fix data leak)
                _execute(conn, """
                    DELETE FROM session_messages WHERE session_id IN (
                        SELECT id FROM chat_sessions WHERE user_id IS NULL
                    )
                """)
                _execute(conn, "DELETE FROM chat_sessions WHERE user_id IS NULL")
            except Exception:
                pass  # column already exists

            # Migration: UGC / public-discussions columns. Mirrors the PG
            # branch above. See that comment for the privacy + feature-flag
            # safety story.
            for col_sql in [
                "ALTER TABLE chat_sessions ADD COLUMN public_status TEXT NOT NULL DEFAULT 'private'",
                "ALTER TABLE chat_sessions ADD COLUMN public_handle TEXT",
                "ALTER TABLE chat_sessions ADD COLUMN public_title TEXT",
                "ALTER TABLE chat_sessions ADD COLUMN consent_at TEXT",
                "ALTER TABLE chat_sessions ADD COLUMN approved_at TEXT",
                "ALTER TABLE chat_sessions ADD COLUMN approved_by TEXT",
            ]:
                try:
                    _execute(conn, col_sql)
                except Exception:
                    pass  # column already exists

            # Migration: add user_id to messages table
            try:
                _execute(conn, "ALTER TABLE messages ADD COLUMN user_id TEXT")
                _execute(conn, "CREATE INDEX IF NOT EXISTS idx_messages_user ON messages(agent_id, user_id)")
                _execute(conn, "DELETE FROM messages WHERE user_id IS NULL")
            except Exception:
                pass

            # Migration: add user_id and is_deleted to agents table
            try:
                _execute(conn, "ALTER TABLE agents ADD COLUMN user_id TEXT")
                _execute(conn, "CREATE INDEX IF NOT EXISTS idx_agents_user ON agents(user_id)")
            except Exception:
                pass
            try:
                _execute(conn, "ALTER TABLE agents ADD COLUMN is_deleted INTEGER NOT NULL DEFAULT 0")
            except Exception:
                pass
            try:
                _execute(conn, "ALTER TABLE agents ADD COLUMN slug TEXT")
            except Exception:
                pass

            # Migration: add memory_type to mind_memories
            try:
                _execute(conn, "ALTER TABLE mind_memories ADD COLUMN memory_type TEXT NOT NULL DEFAULT 'interaction'")
            except Exception:
                pass

            # Migration: add embedding columns to minds table; plus Wikidata/
            # Wikipedia identity URLs for Person JSON-LD sameAs.
            for col, col_type in [("embedding", "BYTEA"), ("embedding_dim", "INTEGER"), ("embedding_norm", "DOUBLE PRECISION"), ("wikidata_url", "TEXT"), ("wikipedia_url", "TEXT"), ("meta_json", "TEXT"), ("slug", "TEXT")]:
                try:
                    _execute(conn, f"SAVEPOINT sp_minds_{col}")
                    _execute(conn, f"ALTER TABLE minds ADD COLUMN {col} {col_type}")
                    _execute(conn, f"RELEASE SAVEPOINT sp_minds_{col}")
                except Exception:
                    _execute(conn, f"ROLLBACK TO SAVEPOINT sp_minds_{col}")

            # Pro tables (SQLite)
            _execute(conn, """
                CREATE TABLE IF NOT EXISTS users (
                    id TEXT PRIMARY KEY,
                    email TEXT NOT NULL,
                    tier TEXT DEFAULT 'free',
                    subscription_status TEXT DEFAULT 'none',
                    subscription_ended_at TEXT,
                    stripe_customer_id TEXT,
                    stripe_subscription_id TEXT,
                    created_at TEXT NOT NULL DEFAULT (datetime('now'))
                )
            """)
            # Migration: add subscription_status and subscription_ended_at
            try:
                _execute(conn, "ALTER TABLE users ADD COLUMN subscription_status TEXT DEFAULT 'none'")
            except Exception:
                pass
            try:
                _execute(conn, "ALTER TABLE users ADD COLUMN subscription_ended_at TEXT")
            except Exception:
                pass
            _execute(conn, """
                CREATE TABLE IF NOT EXISTS usage (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id TEXT REFERENCES users(id),
                    action TEXT NOT NULL,
                    tokens_used INTEGER DEFAULT 0,
                    created_at TEXT NOT NULL DEFAULT (datetime('now'))
                )
            """)
            _execute(conn, "CREATE INDEX IF NOT EXISTS idx_usage_user_action ON usage(user_id, action, created_at)")

            # Cleanup: purge usage records older than 30 days (must run after table creation)
            _execute(conn, "DELETE FROM usage WHERE created_at < datetime('now', '-30 days')")

            # Stripe webhook idempotency: track processed event ids
            _execute(conn, """
                CREATE TABLE IF NOT EXISTS stripe_webhook_events (
                    event_id TEXT PRIMARY KEY,
                    processed_at TEXT NOT NULL
                )
            """)
            _execute(conn, "DELETE FROM stripe_webhook_events WHERE processed_at < datetime('now', '-30 days')")

            # Phase 7.3 — LLM referrer tracking (SQLite branch)
            _execute(conn, """
                CREATE TABLE IF NOT EXISTS llm_referrals (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    url_path TEXT NOT NULL,
                    source TEXT NOT NULL,
                    ua_class TEXT NOT NULL DEFAULT 'unknown',
                    created_at TEXT NOT NULL
                )
            """)
            _execute(conn, "CREATE INDEX IF NOT EXISTS idx_llm_referrals_source_time ON llm_referrals(source, created_at DESC)")
            _execute(conn, "CREATE INDEX IF NOT EXISTS idx_llm_referrals_time ON llm_referrals(created_at DESC)")

    # Migration: copy legacy messages → session_messages (runs once, idempotent)
    try:
        count = migrate_messages_to_sessions()
        if count:
            import logging as _log
            _log.getLogger(__name__).info("Migrated %d messages to session_messages", count)
    except Exception:
        pass


def create_agent(name: str, agent_type: str, source: str | None, meta: dict[str, Any], user_id: str | None = None) -> str:
    agent_id = str(uuid.uuid4())
    with get_conn() as conn:
        _execute(conn, _q(
            "INSERT INTO agents (id, name, type, source, status, meta_json, user_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
        ), (agent_id, name, agent_type, source, "indexing", json.dumps(meta), user_id, _utcnow()))
    return agent_id


def update_agent_status(agent_id: str, status: str, meta: dict[str, Any] | None = None) -> None:
    with get_conn() as conn:
        if meta is None:
            _execute(conn, _q("UPDATE agents SET status = ? WHERE id = ?"), (status, agent_id))
        else:
            _execute(conn, _q(
                "UPDATE agents SET status = ?, meta_json = ? WHERE id = ?"
            ), (status, json.dumps(meta), agent_id))


def get_agent(agent_id: str) -> dict[str, Any] | None:
    with get_conn() as conn:
        row = _fetchone(conn, _q("SELECT * FROM agents WHERE id = ?"), (agent_id,))
        if not row:
            return None
        return _row_to_agent(row)


def get_agent_by_slug(slug: str) -> dict[str, Any] | None:
    """Resolve a book by its descriptive URL slug (the slug→entity lookup behind
    /book/{slug})."""
    with get_conn() as conn:
        row = _fetchone(conn, _q(
            "SELECT * FROM agents WHERE slug = ? AND is_deleted = ?"
        ), (slug, False if _USE_PG else 0))
        return _row_to_agent(row) if row else None


def update_agent_slug(agent_id: str, slug: str) -> None:
    with get_conn() as conn:
        _execute(conn, _q("UPDATE agents SET slug = ? WHERE id = ?"), (slug, agent_id))


def list_agents(limit: int | None = None) -> list[dict[str, Any]]:
    """List all non-deleted agents.

    `limit` is a defensive cap to prevent unbounded reads from blowing through
    egress quotas when the table grows. Default None preserves existing
    behavior; callers that touch this on every request (sitemap, llms-full,
    cron loops, public endpoints) should always pass an explicit limit.
    """
    sql = "SELECT * FROM agents WHERE is_deleted = ? ORDER BY created_at DESC"
    params: tuple[Any, ...] = (False if _USE_PG else 0,)
    if limit is not None:
        sql += " LIMIT ?"
        params = params + (limit,)
    with get_conn() as conn:
        rows = _fetchall(conn, _q(sql), params)
        return [_row_to_agent(r) for r in rows]


def _row_to_agent(row: dict[str, Any]) -> dict[str, Any]:
    meta_json = row["meta_json"] or "{}"
    return {
        "id": row["id"],
        "name": row["name"],
        "slug": row.get("slug"),  # descriptive URL slug; None for un-backfilled rows
        "type": row["type"],
        "source": row["source"],
        "status": row["status"],
        "meta": json.loads(meta_json),
        "user_id": row.get("user_id"),
        "is_deleted": bool(row.get("is_deleted", False)),
        "created_at": row["created_at"],
    }


def _halfvec_literal(values: Iterable[float]) -> str:
    """Format a list of floats as a pgvector text literal: '[v1,v2,...]'.

    pgvector accepts this form for both `vector` and `halfvec` (it casts to
    the column type). Half-precision rounding happens server-side, so we
    don't need to convert here.
    """
    return "[" + ",".join(f"{float(v):.6g}" for v in values) + "]"


def decode_vector_blob(blob: Any, dim: int):
    """Decode a chunks.vector bytea cell into a numpy float32 array.

    Production data has two storage formats:

    1. **Raw float32 little-endian** — what indexer.py writes via numpy
       ``array.tobytes()``. Length is exactly ``dim * 4`` bytes.

    2. **JSON-serialized Node.js Buffer** —
       ``{"type":"Buffer","data":[12,34,...]}`` as raw UTF-8 bytes stored
       in the bytea column. Present in chunks inserted via a historical
       write path (a JS client that passed ``JSON.stringify(buffer)`` to
       the Supabase REST API, which stored the JSON text in the bytea
       column verbatim). Length is ~4-5× larger than format 1.

    Without this decoder, format-2 rows were producing a constant first
    component of ``7.92262e+34`` (the float32 reading of ASCII bytes
    ``{"ty``) and garbage subsequent values, silently degrading legacy
    cosine retrieval to near-random for those chunks. Hybrid FTS masked
    the issue. Detection is by length first, then magic prefix.
    """
    import numpy as np

    raw = bytes(blob) if not isinstance(blob, (bytes, bytearray)) else bytes(blob)
    expected = dim * 4

    if len(raw) == expected:
        return np.frombuffer(raw, dtype=np.float32, count=dim)

    if raw[:2] == b'{"':
        import json as _json
        try:
            obj = _json.loads(raw.decode("utf-8"))
        except Exception as exc:
            raise ValueError(f"vector blob looks like JSON but failed to parse: {exc}") from exc
        data = obj.get("data") if isinstance(obj, dict) else None
        if not isinstance(data, list) or len(data) != expected:
            raise ValueError(
                f"JSON Buffer data has length {len(data) if isinstance(data, list) else 'N/A'}, expected {expected}"
            )
        return np.frombuffer(bytes(data), dtype=np.float32, count=dim)

    raise ValueError(
        f"unknown vector blob format: len={len(raw)}, expected {expected}, "
        f"first 8 bytes={raw[:8]!r}"
    )


def add_chunks(agent_id: str, chunk_records: Iterable[dict[str, Any]]) -> None:
    """Insert chunks. Dual-writes to pgvector `embedding` column when available
    and the chunk's dim matches EMBED_DIM. Off-dim chunks leave embedding NULL
    and fall back to the legacy in-Python scoring path at retrieval time.

    Each record needs id, chunk_index, text, vector (bytes), dim, norm. May
    optionally include `embedding_floats` (list[float]) — when present and the
    pgvector path is live, it's written to the halfvec column. The indexer
    passes this in so we don't redundantly reparse vector bytes.
    """
    from .config import EMBED_DIM

    records = list(chunk_records)
    write_pgvec = _USE_PG and _HAS_PGVECTOR

    with get_conn() as conn:
        if write_pgvec:
            # Skip writing the legacy BYTEA `vector` column when halfvec
            # is being written for this row — the pgvector ANN path
            # never reads BYTEA, and once halfvec is populated the
            # agent's meta.pgvector_ready=true flag makes RAG go
            # straight to the SQL-side ANN. BYTEA was costing ~50KB
            # per chunk in production (50MB chunks table → 22MB after
            # NULLing existing rows). The fallback safety net is
            # only needed when halfvec is NOT being written for this
            # record (off-dim chunk, dim mismatch), in which case we
            # keep the BYTEA so the legacy in-Python scoring path
            # still works.
            params_list = []
            for rec in records:
                halfvec = None
                if (rec.get("embedding_floats") is not None
                        and rec["dim"] == EMBED_DIM):
                    halfvec = _halfvec_literal(rec["embedding_floats"])
                # Only carry BYTEA when halfvec is absent (fallback path needed)
                if halfvec is None:
                    bytea_val = _pg().Binary(rec["vector"])
                else:
                    bytea_val = None
                params_list.append((
                    rec["id"],
                    agent_id,
                    rec["chunk_index"],
                    rec["text"],
                    bytea_val,
                    rec["dim"],
                    rec["norm"],
                    halfvec,
                ))
            _executemany(conn, _q(
                "INSERT INTO chunks (id, agent_id, chunk_index, text, vector, dim, norm, embedding) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
            ), params_list)
        else:
            params_list = [
                (
                    rec["id"],
                    agent_id,
                    rec["chunk_index"],
                    rec["text"],
                    rec["vector"] if not _USE_PG else _pg().Binary(rec["vector"]),
                    rec["dim"],
                    rec["norm"],
                )
                for rec in records
            ]
            _executemany(conn, _q(
                "INSERT INTO chunks (id, agent_id, chunk_index, text, vector, dim, norm) VALUES (?, ?, ?, ?, ?, ?, ?)"
            ), params_list)


def delete_chunks_for_agent(agent_id: str) -> int:
    """Delete every chunk row for ``agent_id`` and return the count deleted.

    ``index_text(..., force=True)`` does NOT clear existing chunks before
    inserting new ones — it always appends. That's fine for the first
    indexing of a fresh agent, but re-indexing a catalog stub through
    Gutenberg (where the old chunks were a 3-line OL blurb and the new
    chunks are 300 pages of Plato) ends up with both sets coexisting,
    same agent_id, with overlapping chunk_index values. RAG then scores
    the stale stub against the user's query alongside the real text.

    Backfill scripts call this immediately before ``index_text(force=True)``
    to make the re-index behave like a true replace.
    """
    with get_conn() as conn:
        cur = _execute(conn, _q("DELETE FROM chunks WHERE agent_id = ?"), (agent_id,))
        # rowcount is available on both psycopg2 and sqlite3 cursors
        try:
            return int(cur.rowcount or 0)
        except Exception:
            return 0


def get_chunks(agent_id: str) -> list[dict[str, Any]]:
    with get_conn() as conn:
        return _fetchall(conn, _q(
            "SELECT id, chunk_index, text, vector, dim, norm FROM chunks WHERE agent_id = ? ORDER BY chunk_index ASC"
        ), (agent_id,))


def embedded_agent_ids(min_chunks: int = 1) -> set[str]:
    """Agent IDs that have >= ``min_chunks`` real (non-NULL) embedding vectors.

    A chunk counts if it has a real vector in EITHER store: the pgvector
    ``embedding`` column (post-migration — the vast majority) or the legacy
    BYTEA ``vector`` column. Thin catalog stubs carry a single placeholder chunk
    that is NULL in both and can't be RAG-retrieved, so bulk passes (e.g. Q&A
    pre-store) skip them with ``min_chunks=1``. Pass ``min_chunks=5`` to mirror
    the sitemap's ``_MIN_CHUNKS_FOR_Q_URLS`` gate (only books substantial enough
    to get indexable /q pages). The ``embedding`` column is Postgres-only, so
    guard for SQLite dev DBs."""
    cond = "vector IS NOT NULL OR embedding IS NOT NULL" if _USE_PG else "vector IS NOT NULL"
    with get_conn() as conn:
        if min_chunks <= 1:
            q = f"SELECT DISTINCT agent_id FROM chunks WHERE {cond}"
        else:
            q = (f"SELECT agent_id FROM chunks WHERE {cond} "
                 f"GROUP BY agent_id HAVING count(*) >= {int(min_chunks)}")
        return {r["agent_id"] for r in _fetchall(conn, q)}


def get_chunks_text_only(agent_id: str) -> list[dict[str, Any]]:
    """Lightweight variant that skips vector/dim/norm — for the reader.

    WARNING: returns EVERY chunk for the agent. A 300-chunk Gutenberg
    book is ~300KB of text egress per call. Only call this when you
    genuinely need the full book (e.g. the reader at /api/agents/{id}/read).
    For sample-passage rendering on the SSR detail page, use
    ``get_sample_chunks_text(agent_id, limit=3)`` instead — same query
    shape with LIMIT, ~99% less egress per request.

    This single call from book_page's SSR rendering was the primary
    driver of the 2026-05-28 Supabase egress overage: crawlers hitting
    /book/{id} were pulling the full text just to render 2-3 sample
    passages. Fixed by switching that call site to the limited helper.
    """
    with get_conn() as conn:
        return _fetchall(conn, _q(
            "SELECT id, chunk_index, text FROM chunks WHERE agent_id = ? ORDER BY chunk_index ASC"
        ), (agent_id,))


def get_sample_chunks_text(agent_id: str, limit: int = 3) -> list[dict[str, Any]]:
    """Pull just the first ``limit`` chunks for a book — enough for the
    SSR detail page's Sample Passages section without dragging the
    whole book over the wire.

    Picks the leading chunks (lowest chunk_index) rather than random
    samples on purpose: the opening passages of a book are usually the
    most representative for a reader-facing preview, and the deterministic
    pick keeps the rendered HTML cache-stable so Vercel's edge cache
    hits properly between crawlers.
    """
    with get_conn() as conn:
        return _fetchall(conn, _q(
            "SELECT id, chunk_index, text FROM chunks WHERE agent_id = ? "
            "ORDER BY chunk_index ASC LIMIT ?"
        ), (agent_id, limit))


def get_mid_chunks_text(agent_id: str, limit: int = 8) -> list[dict[str, Any]]:
    """Chunk text sampled from the MIDDLE of the book (skips the first ~25%).

    The opening chunks of a Project Gutenberg book are headers, the title page,
    and transcription notes ("italics marked with _", "Greek words transliterated",
    margin-note conventions). Feeding those to LLM question-generation produces
    questions about typography/printing/e-text artifacts instead of the actual
    content. Sampling from the middle gives real prose to ask about."""
    with get_conn() as conn:
        total = _fetchall(conn, _q(
            "SELECT count(*) AS c FROM chunks WHERE agent_id = ?"), (agent_id,))[0]["c"]
        skip = max(0, int(total) // 4)
        return _fetchall(conn, _q(
            "SELECT chunk_index, text FROM chunks WHERE agent_id = ? "
            "ORDER BY chunk_index ASC LIMIT ? OFFSET ?"
        ), (agent_id, limit, skip))


def get_chunks_batch(agent_ids: list[str]) -> list[dict[str, Any]]:
    """Fetch chunks for multiple agents in a single query."""
    if not agent_ids:
        return []
    placeholders = ",".join(["?"] * len(agent_ids))
    with get_conn() as conn:
        return _fetchall(conn, _q(
            f"SELECT id, agent_id, chunk_index, text, vector, dim, norm FROM chunks WHERE agent_id IN ({placeholders}) ORDER BY agent_id, chunk_index ASC"
        ), tuple(agent_ids))


def ann_topk(agent_id: str, query_floats: Iterable[float], top_k: int) -> list[dict[str, Any]]:
    """SQL-side ANN: return the top-K chunks for an agent, ordered by cosine
    similarity to query_floats. Returns id/chunk_index/text/score only — no
    vector bytes cross the wire.

    Requires pgvector + halfvec column populated for this agent's chunks.
    Caller (rag.py) decides whether to take this path via agent.meta.
    Raises if pgvector is unavailable; caller must catch and fall back.
    """
    if not _USE_PG or not _HAS_PGVECTOR:
        raise RuntimeError("ann_topk requires pgvector")
    qvec = _halfvec_literal(query_floats)
    # `<=>` is the cosine-distance operator in pgvector (0 = identical, 2 =
    # opposite). We convert to similarity (1 - distance/2 ≈ cosine sim) to
    # match the legacy in-Python scoring scale.
    with get_conn() as conn:
        return _fetchall(conn,
            """SELECT id, chunk_index, text,
                      1.0 - (embedding <=> %s::halfvec) / 2.0 AS score
               FROM chunks
               WHERE agent_id = %s AND embedding IS NOT NULL
               ORDER BY embedding <=> %s::halfvec
               LIMIT %s""",
            (qvec, agent_id, qvec, top_k))


def ann_topk_batch(agent_ids: list[str], query_floats: Iterable[float], top_k: int) -> list[dict[str, Any]]:
    """SQL-side ANN across multiple agents. Returns id/agent_id/chunk_index/
    text/score, top-K by cosine similarity. Used by cross-book retrieve.
    """
    if not _USE_PG or not _HAS_PGVECTOR:
        raise RuntimeError("ann_topk_batch requires pgvector")
    if not agent_ids:
        return []
    qvec = _halfvec_literal(query_floats)
    placeholders = ",".join(["%s"] * len(agent_ids))
    with get_conn() as conn:
        return _fetchall(conn,
            f"""SELECT id, agent_id, chunk_index, text,
                       1.0 - (embedding <=> %s::halfvec) / 2.0 AS score
                FROM chunks
                WHERE agent_id IN ({placeholders}) AND embedding IS NOT NULL
                ORDER BY embedding <=> %s::halfvec
                LIMIT %s""",
            (qvec, *agent_ids, qvec, top_k))


def keyword_search_chunks(query: str, agent_ids: list[str] | None = None, limit: int = 30) -> list[dict[str, Any]]:
    """FTS keyword search over chunks. Returns [] if FTS is unavailable."""
    with get_conn() as conn:
        if _USE_PG:
            where_agent = ""
            params: list = [query, query, limit]
            if agent_ids:
                placeholders = ",".join(["%s"] * len(agent_ids))
                where_agent = f"AND c.agent_id IN ({placeholders})"
                params = [query, query] + agent_ids + [limit]
            try:
                rows = _fetchall(conn,
                    f"""SELECT c.id, c.agent_id, c.chunk_index, c.text, c.vector, c.dim, c.norm,
                               ts_rank(c.search_vector, plainto_tsquery('english', %s)) AS fts_rank
                        FROM chunks c
                        WHERE c.search_vector @@ plainto_tsquery('english', %s)
                        {where_agent}
                        ORDER BY fts_rank DESC LIMIT %s""",
                    tuple(params))
                return rows
            except Exception:
                return []
        else:
            try:
                tokens = query.strip().split()
                fts_q = " OR ".join('"' + t.replace('"', '""') + '"' for t in tokens) if tokens else '""'
                if agent_ids:
                    placeholders = ",".join(["?"] * len(agent_ids))
                    rows = _fetchall(conn, _q(
                        f"""SELECT c.id, c.agent_id, c.chunk_index, c.text, c.vector, c.dim, c.norm,
                                   chunks_fts.rank AS fts_rank
                            FROM chunks_fts
                            JOIN chunks c ON c.rowid = chunks_fts.rowid
                            WHERE chunks_fts MATCH ?
                              AND c.agent_id IN ({placeholders})
                            ORDER BY chunks_fts.rank LIMIT ?"""
                    ), (fts_q, *agent_ids, limit))
                else:
                    rows = _fetchall(conn, _q(
                        """SELECT c.id, c.agent_id, c.chunk_index, c.text, c.vector, c.dim, c.norm,
                                  chunks_fts.rank AS fts_rank
                           FROM chunks_fts
                           JOIN chunks c ON c.rowid = chunks_fts.rowid
                           WHERE chunks_fts MATCH ?
                           ORDER BY chunks_fts.rank LIMIT ?"""
                    ), (fts_q, limit))
                return rows
            except Exception:
                return []


def sync_fts(agent_id: str) -> None:
    """Populate FTS index for an agent's chunks (SQLite only)."""
    if _USE_PG:
        return
    with get_conn() as conn:
        rows = _fetchall(conn, "SELECT rowid, text FROM chunks WHERE agent_id = ?", (agent_id,))
        for r in rows:
            try:
                _execute(conn, "INSERT INTO chunks_fts(rowid, text) VALUES (?, ?)", (r["rowid"], r["text"]))
            except Exception:
                pass


def _get_or_create_book_session(agent_id: str, user_id: str) -> str:
    """Find or create a book-type chat session for the given agent + user."""
    with get_conn() as conn:
        row = _fetchone(conn, _q(
            "SELECT id FROM chat_sessions WHERE session_type = 'book' AND mind_id = ? AND user_id = ?"
        ), (agent_id, user_id))
        if row:
            return row["id"]
        session_id = str(uuid.uuid4())
        now = _utcnow()
        agent = _fetchone(conn, _q("SELECT name FROM agents WHERE id = ?"), (agent_id,))
        title = agent["name"] if agent else "Book Chat"
        _execute(conn, _q(
            "INSERT INTO chat_sessions (id, user_id, title, session_type, mind_id, meta_json, updated_at, created_at) VALUES (?, ?, ?, 'book', ?, ?, ?, ?)"
        ), (session_id, user_id, title, agent_id, json.dumps({"agent_id": agent_id}), now, now))
        return session_id


def add_message(agent_id: str, role: str, content: str, user_id: str | None = None) -> None:
    if not user_id:
        return
    session_id = _get_or_create_book_session(agent_id, user_id)
    with get_conn() as conn:
        msg_id = str(uuid.uuid4())
        now = _utcnow()
        _execute(conn, _q(
            "INSERT INTO session_messages (id, session_id, role, content, meta_json, created_at) VALUES (?, ?, ?, ?, ?, ?)"
        ), (msg_id, session_id, role, content, json.dumps({}), now))
        _execute(conn, _q("UPDATE chat_sessions SET updated_at = ? WHERE id = ?"),
                 (now, session_id))


def list_messages(agent_id: str, limit: int = 50, user_id: str | None = None) -> list[dict[str, Any]]:
    if not user_id:
        return []
    with get_conn() as conn:
        row = _fetchone(conn, _q(
            "SELECT id FROM chat_sessions WHERE session_type = 'book' AND mind_id = ? AND user_id = ?"
        ), (agent_id, user_id))
        if not row:
            return []
        rows = _fetchall(conn, _q(
            "SELECT role, content, created_at FROM session_messages WHERE session_id = ? ORDER BY created_at DESC LIMIT ?"
        ), (row["id"], limit))
        return list(reversed(rows))


# ─── Questions CRUD ───

def add_questions(agent_id: str, questions: list[str]) -> None:
    with get_conn() as conn:
        _executemany(conn, _q(
            "INSERT INTO questions (id, agent_id, text, created_at) VALUES (?, ?, ?, ?)"
        ), [(str(uuid.uuid4()), agent_id, q, _utcnow()) for q in questions])


def clear_questions(agent_id: str) -> None:
    """Delete all stored questions for an agent. Used to regenerate genuinely
    book-specific questions over the generic LLM-failed fallback set (the 5
    templated questions that, duplicated across books, read as thin/mass-produced
    to search engines)."""
    with get_conn() as conn:
        _execute(conn, _q("DELETE FROM questions WHERE agent_id = ?"), (agent_id,))


def list_questions(agent_id: str) -> list[str]:
    with get_conn() as conn:
        rows = _fetchall(conn, _q(
            "SELECT text FROM questions WHERE agent_id = ? ORDER BY created_at ASC"
        ), (agent_id,))
        return [r["text"] for r in rows]


# ─── Votes CRUD ───

def create_vote(title: str) -> dict[str, Any]:
    with get_conn() as conn:
        existing = _fetchone(conn, _q(
            "SELECT id, title, count, created_at FROM votes WHERE LOWER(title) = LOWER(?)"
        ), (title,))
        if existing:
            _execute(conn, _q("UPDATE votes SET count = count + 1 WHERE id = ?"), (existing["id"],))
            return {"id": existing["id"], "title": existing["title"], "count": existing["count"] + 1}
        vote_id = str(uuid.uuid4())
        _execute(conn, _q(
            "INSERT INTO votes (id, title, count, created_at) VALUES (?, ?, 1, ?)"
        ), (vote_id, title, _utcnow()))
        return {"id": vote_id, "title": title, "count": 1}


def upvote(vote_id: str) -> dict[str, Any] | None:
    with get_conn() as conn:
        row = _fetchone(conn, _q("SELECT id, title, count FROM votes WHERE id = ?"), (vote_id,))
        if not row:
            return None
        _execute(conn, _q("UPDATE votes SET count = count + 1 WHERE id = ?"), (vote_id,))
        return {"id": row["id"], "title": row["title"], "count": row["count"] + 1}


def delete_agent(agent_id: str, user_id: str | None = None) -> bool:
    """Soft-delete: mark agent as deleted. Only the uploader (owner) may delete."""
    with get_conn() as conn:
        agent = _fetchone(conn, _q("SELECT user_id FROM agents WHERE id = ?"), (agent_id,))
        if not agent:
            return False
        if agent["user_id"] and user_id != agent["user_id"]:
            return False
        deleted_val = True if _USE_PG else 1
        cur = _execute(conn, _q(
            "UPDATE agents SET is_deleted = ? WHERE id = ?"
        ), (deleted_val, agent_id))
        return cur.rowcount > 0


def list_votes() -> list[dict[str, Any]]:
    with get_conn() as conn:
        return _fetchall(conn, "SELECT id, title, count, created_at FROM votes ORDER BY count DESC")


# ─── Catalog agent helpers ───

def ensure_catalog_agents(catalog: list[dict[str, Any]]) -> None:
    """Idempotently seed catalog books as agents. Skips titles that already exist."""
    with get_conn() as conn:
        existing_rows = _fetchall(conn, "SELECT name FROM agents")
        existing = {row["name"].lower() for row in existing_rows}
        for book in catalog:
            if book["title"].lower() in existing:
                continue
            agent_id = str(uuid.uuid4())
            meta = {
                "title": book["title"],
                "author": book.get("author", ""),
                "isbn": book.get("isbn"),
                "category": book.get("category", ""),
                "description": book.get("description", ""),
            }
            _execute(conn, _q(
                "INSERT INTO agents (id, name, type, source, status, meta_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
            ), (agent_id, book["title"], "catalog", book.get("author", ""), "catalog", json.dumps(meta), _utcnow()))


def rename_agent(agent_id: str, new_name: str) -> None:
    """Rename an agent (book title). Also syncs ai_books.title and meta_json.title."""
    with get_conn() as conn:
        row = _fetchone(conn, _q("SELECT meta_json FROM agents WHERE id = ?"), (agent_id,))
        if not row:
            return
        meta = json.loads(row["meta_json"] or "{}")
        meta["title"] = new_name
        _execute(conn, _q(
            "UPDATE agents SET name = ?, meta_json = ? WHERE id = ?"
        ), (new_name, json.dumps(meta), agent_id))
        _execute(conn, _q(
            "UPDATE ai_books SET title = ?, updated_at = ? WHERE agent_id = ?"
        ), (new_name, _utcnow(), agent_id))


def update_agent_meta(agent_id: str, updates: dict[str, Any]) -> None:
    """Merge updates into agent's meta_json without overwriting other keys."""
    with get_conn() as conn:
        row = _fetchone(conn, _q("SELECT meta_json FROM agents WHERE id = ?"), (agent_id,))
        if not row:
            return
        meta = json.loads(row["meta_json"] or "{}")
        meta.update(updates)
        _execute(conn, _q("UPDATE agents SET meta_json = ? WHERE id = ?"), (json.dumps(meta), agent_id))


def find_agent_by_name(name: str) -> dict[str, Any] | None:
    """Find an agent by name (case-insensitive)."""
    with get_conn() as conn:
        row = _fetchone(conn, _q(
            "SELECT * FROM agents WHERE LOWER(name) = LOWER(?)"
        ), (name,))
        if not row:
            return None
        return _row_to_agent(row)


def find_existing_upload(name: str) -> dict[str, Any] | None:
    """Find a non-deleted, non-error upload/topic agent by name (case-insensitive)."""
    with get_conn() as conn:
        row = _fetchone(conn, _q(
            "SELECT * FROM agents WHERE LOWER(name) = LOWER(?) "
            "AND is_deleted = ? AND status != 'error'"
        ), (name, False if _USE_PG else 0))
        if not row:
            return None
        return _row_to_agent(row)


_TITLE_SUBTITLE = re.compile(r"[:—]|\s-\s")
_TITLE_PUNCT = re.compile(r"[.,;:!?'\"()]")
_TITLE_WS = re.compile(r"\s+")


def _norm_title(title: str) -> str:
    """lowercase, drop punctuation, collapse whitespace — subtitle KEPT. Mirrors
    the frontend `filterBooksByTopic` normalization so display and data agree."""
    t = _TITLE_PUNCT.sub("", (title or "").lower())
    return _TITLE_WS.sub(" ", t).strip()


def title_stem(title: str) -> str:
    """The main title with any subtitle dropped (everything after the first ':',
    '—', or ' - '), normalized like `_norm_title`. The shared 'same book' key;
    `scripts/dedup_catalog.py` mirrors it. 'Good to Great', 'Good to Great: Why
    Some Companies…', and 'A World Brewed,' all collapse to one stem."""
    head = _TITLE_SUBTITLE.split((title or ""), maxsplit=1)[0]
    return _norm_title(head)


def same_book(a: str, b: str) -> bool:
    """Do two titles denote the SAME book? True when they're equal once
    normalized, OR one is the other plus a subtitle (a prefix at a ':' / '—' /
    ' - ' boundary): 'Good to Great' ≡ 'Good to Great: Why Some Companies…',
    'A World Brewed' ≡ 'A World Brewed,'. Crucially, two DIFFERENT subtitles of a
    shared subject stay distinct — 'Wittgenstein: Mind and Will (Vol 4)' is NOT
    'Wittgenstein: Rules and Grammar (Vol 1)' — which a bare stem-equality check
    would wrongly merge (and delete a real volume)."""
    fa, fb = _norm_title(a), _norm_title(b)
    if not fa or not fb:
        return False
    if fa == fb:
        return True
    # one side is the bare main title of the other (short ≡ short+subtitle)
    return title_stem(a) == fb or title_stem(b) == fa


def _agent_author(a: dict[str, Any]) -> str:
    """An agent's author, normalized for comparison. meta.author is canonical;
    `source` is the fallback (older catalog rows stashed the author there)."""
    return (((a.get("meta") or {}).get("author")) or a.get("source") or "").strip().lower()


def find_agent_by_normalized_name(title: str, author: str = "") -> dict[str, Any] | None:
    """Dedup-at-SOURCE: find an existing, non-deleted agent that is the SAME BOOK
    as `title` modulo subtitle / punctuation (via `same_book`) — so the catalog
    stops minting subtitle/comma variants of one book as separate rows. Prefers a
    ready/indexing record over a writing one over a bare catalog stub.

    `author` guards against merging two genuinely different books that share a
    title stem ("Leadership" by X vs by Y): a candidate is rejected only when
    BOTH it and the incoming book name a (different) author — an empty author on
    either side (the common catalog-stub case) still merges. Returns None if no
    such book exists yet.

    Mint is not a hot path (discovery is a background batch; chat book-context is
    per-conversation), so a lightweight stem-scan is fine — only the handful of
    stem matches are hydrated. Revisit with a stored stem column if the catalog
    grows large."""
    if not _norm_title(title):
        return None
    new_author = (author or "").strip().lower()
    with get_conn() as conn:
        rows = _fetchall(conn, _q(
            "SELECT id, name, status FROM agents WHERE is_deleted = ?"
        ), (False if _USE_PG else 0,))
    cand_ids = [r["id"] for r in rows if same_book(title, r["name"] or "")]

    best: dict[str, Any] | None = None
    best_rank = -1
    for cid in cand_ids:
        a = get_agent(cid)
        if not a:
            continue
        a_author = _agent_author(a)
        if new_author and a_author and new_author != a_author:
            continue  # same title, different known author → a different book
        s = a.get("status") or ""
        rank = 2 if s in ("ready", "indexing") else 1 if s == "writing" else 0
        if rank > best_rank:
            best, best_rank = a, rank
    return best


def create_catalog_agent(title: str, author: str = "", isbn: str | None = None,
                         category: str = "", description: str = "") -> str:
    """Create a new catalog agent for a dynamically discovered book. Returns
    agent_id. Deduplicates at the SOURCE: if the same book already exists under
    any subtitle/punctuation variant, returns that row instead of minting a new
    one (this is the chokepoint every catalog mint funnels through)."""
    existing = find_agent_by_normalized_name(title, author) or find_agent_by_name(title)
    if existing:
        return existing["id"]
    meta = {"title": title, "author": author, "isbn": isbn, "category": category, "description": description}
    agent_id = str(uuid.uuid4())
    with get_conn() as conn:
        _execute(conn, _q(
            "INSERT INTO agents (id, name, type, source, status, meta_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
        ), (agent_id, title, "catalog", author, "catalog", json.dumps(meta), _utcnow()))
    return agent_id


# ─── Minds CRUD ───

def create_mind(data: dict[str, Any]) -> str:
    """Insert a new mind agent. Returns mind_id."""
    mind_id = str(uuid.uuid4())
    with get_conn() as conn:
        _execute(conn, _q(
            """INSERT INTO minds
               (id, name, era, domain, bio_summary, persona, thinking_style,
                typical_phrases, works, avatar_seed, version, chat_count, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?)"""
        ), (
            mind_id,
            data["name"],
            data.get("era", ""),
            data.get("domain", ""),
            data.get("bio_summary", ""),
            data["persona"],
            data.get("thinking_style", ""),
            json.dumps(data.get("typical_phrases", [])),
            json.dumps(data.get("works", [])),
            data.get("avatar_seed", data["name"].lower().replace(" ", "-")),
            _utcnow(),
        ))
    return mind_id


def get_mind(mind_id: str) -> dict[str, Any] | None:
    with get_conn() as conn:
        row = _fetchone(conn, _q("SELECT * FROM minds WHERE id = ?"), (mind_id,))
        if not row:
            return None
        return _row_to_mind(row)


def find_mind_by_name(name: str) -> dict[str, Any] | None:
    with get_conn() as conn:
        row = _fetchone(conn, _q(
            "SELECT * FROM minds WHERE LOWER(name) = LOWER(?)"
        ), (name,))
        if not row:
            return None
        return _row_to_mind(row)


def get_mind_by_slug(slug: str) -> dict[str, Any] | None:
    """Resolve a mind by its descriptive URL slug (behind /mind/{slug})."""
    with get_conn() as conn:
        row = _fetchone(conn, _q("SELECT * FROM minds WHERE slug = ?"), (slug,))
        return _row_to_mind(row) if row else None


def update_mind_slug(mind_id: str, slug: str) -> None:
    with get_conn() as conn:
        _execute(conn, _q("UPDATE minds SET slug = ? WHERE id = ?"), (slug, mind_id))


def ensure_slug_columns() -> None:
    """Idempotently add the slug column to agents + minds. For off-Vercel backfill
    scripts that run with --no-init against PROD (where init_db is skipped, so the
    init_db migration never runs)."""
    with get_conn() as conn:
        for table in ("agents", "minds"):
            try:
                if _USE_PG:
                    _execute(conn, f"SAVEPOINT sp_{table}_slug_ens")
                    _execute(conn, f"ALTER TABLE {table} ADD COLUMN slug TEXT")
                    _execute(conn, f"RELEASE SAVEPOINT sp_{table}_slug_ens")
                else:
                    _execute(conn, f"ALTER TABLE {table} ADD COLUMN slug TEXT")
            except Exception:
                if _USE_PG:
                    try:
                        _execute(conn, f"ROLLBACK TO SAVEPOINT sp_{table}_slug_ens")
                    except Exception:
                        pass


def list_minds(limit: int | None = None) -> list[dict[str, Any]]:
    """List all minds, ordered by popularity.

    `limit` is a defensive cap (see `list_agents` rationale).
    """
    sql = (
        "SELECT id, name, slug, era, domain, bio_summary, persona, thinking_style, "
        "typical_phrases, works, avatar_seed, wikidata_url, wikipedia_url, "
        "version, chat_count, created_at "
        "FROM minds ORDER BY chat_count DESC, created_at ASC"
    )
    params: tuple[Any, ...] = ()
    if limit is not None:
        sql += " LIMIT ?"
        params = (limit,)
    with get_conn() as conn:
        rows = _fetchall(conn, _q(sql), params)
        return [_row_to_mind(r) for r in rows]


def _row_to_mind(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": row["id"],
        "name": row["name"],
        "slug": row.get("slug"),  # descriptive URL slug; None for un-backfilled rows
        "era": row["era"] or "",
        "domain": row["domain"] or "",
        "bio_summary": row["bio_summary"] or "",
        "persona": row["persona"],
        "thinking_style": row["thinking_style"] or "",
        "typical_phrases": json.loads(row["typical_phrases"] or "[]"),
        "works": json.loads(row["works"] or "[]"),
        "avatar_seed": row["avatar_seed"] or "",
        # Wikidata/Wikipedia identity links (sameAs). `.get` — older rows
        # predate the migration; absent → "".
        "wikidata_url": row.get("wikidata_url") or "",
        "wikipedia_url": row.get("wikipedia_url") or "",
        "version": row["version"],
        "chat_count": row["chat_count"],
        "created_at": row["created_at"],
    }


def update_mind_embedding(mind_id: str, vector_bytes: bytes, dim: int, norm: float) -> None:
    blob = _pg().Binary(vector_bytes) if _USE_PG else vector_bytes
    with get_conn() as conn:
        _execute(conn, _q(
            "UPDATE minds SET embedding = ?, embedding_dim = ?, embedding_norm = ? WHERE id = ?"
        ), (blob, dim, norm, mind_id))


def update_mind_links(mind_id: str, wikidata_url: str | None = None, wikipedia_url: str | None = None) -> None:
    """Store a mind's Wikidata/Wikipedia identity URLs — the canonical entity
    signal rendered into the Person JSON-LD `sameAs` (Knowledge Graph + LLM
    grounding). Empty strings are normalized to NULL so a blank candidate field
    never overwrites a previously-resolved link with junk."""
    with get_conn() as conn:
        _execute(conn, _q(
            "UPDATE minds SET wikidata_url = ?, wikipedia_url = ? WHERE id = ?"
        ), (wikidata_url or None, wikipedia_url or None, mind_id))


def get_mind_meta(mind_id: str) -> dict[str, Any]:
    """A mind's PRIVATE meta dict — pre-stored SEO content (Type-2 essays under
    `essays`). Deliberately NOT surfaced by `_row_to_mind` / the public mind API,
    so it never leaks; read it explicitly where needed."""
    with get_conn() as conn:
        row = _fetchone(conn, _q("SELECT meta_json FROM minds WHERE id = ?"), (mind_id,))
    if not row:
        return {}
    try:
        return json.loads(row.get("meta_json") or "{}") or {}
    except Exception:
        return {}


def get_mind_essay(mind_id: str, topic: str) -> str | None:
    """A pre-stored Type-2 essay for (mind, topic), or None — the check-first
    half of the lazy-gen+cache pattern (mirrors overview's meta.overview)."""
    essay = (get_mind_meta(mind_id).get("essays") or {}).get(topic)
    return essay or None


def save_mind_essay(mind_id: str, topic: str, essay: str) -> None:
    """Persist a generated Type-2 essay into the mind's meta so the hot path
    serves it without re-generating (read-modify-write of meta.essays)."""
    if not (essay or "").strip():
        return
    meta = get_mind_meta(mind_id)
    essays = meta.get("essays") or {}
    essays[topic] = essay
    meta["essays"] = essays
    with get_conn() as conn:
        _execute(conn, _q("UPDATE minds SET meta_json = ? WHERE id = ?"), (json.dumps(meta), mind_id))


def list_minds_with_embeddings() -> list[dict[str, Any]]:
    with get_conn() as conn:
        try:
            rows = _fetchall(conn, _q("SELECT id, name, era, domain, embedding, embedding_dim, embedding_norm FROM minds WHERE embedding IS NOT NULL"))
            return [dict(r) for r in rows]
        except Exception:
            return []


def list_minds_missing_embeddings() -> list[dict[str, Any]]:
    with get_conn() as conn:
        try:
            rows = _fetchall(conn, _q(
                "SELECT id, name, era, domain, bio_summary, persona, thinking_style, "
                "typical_phrases, works, avatar_seed, version, chat_count, created_at "
                "FROM minds WHERE embedding IS NULL"
            ))
            return [_row_to_mind(r) for r in rows]
        except Exception:
            return []


def increment_mind_chat_count(mind_id: str) -> None:
    with get_conn() as conn:
        _execute(conn, _q("UPDATE minds SET chat_count = chat_count + 1 WHERE id = ?"), (mind_id,))


def link_mind_work(mind_id: str, agent_id: str) -> None:
    with get_conn() as conn:
        _execute(conn, _conflict_ignore(_q(
            "INSERT OR IGNORE INTO mind_works (mind_id, agent_id) VALUES (?, ?)"
        )), (mind_id, agent_id))


def get_mind_work_ids(mind_id: str) -> list[str]:
    with get_conn() as conn:
        rows = _fetchall(conn, _q(
            "SELECT agent_id FROM mind_works WHERE mind_id = ?"
        ), (mind_id,))
        return [r["agent_id"] for r in rows]


# ─── SEO/landing-page helpers (cheap read-only queries used by SSR) ───
#
# These power the per-entity landing pages (/book/{id}, /mind/{id}). They are
# called on every crawler/share visit, so they must stay O(small) and avoid
# vector blob egress. All queries are bounded by an explicit LIMIT.

def list_minds_for_agent(agent_id: str, limit: int = 12) -> list[dict[str, Any]]:
    """Minds whose work corpus includes this book — used to render the
    "Discussed by Great Minds" section on /book/{id} and drive internal
    PageRank from book pages → mind pages."""
    with get_conn() as conn:
        rows = _fetchall(conn, _q(
            """SELECT m.id, m.name, m.era, m.domain
               FROM mind_works mw
               JOIN minds m ON m.id = mw.mind_id
               WHERE mw.agent_id = ?
               ORDER BY m.name ASC
               LIMIT ?"""
        ), (agent_id, limit))
        return [dict(r) for r in rows]


def list_minds_active_for_agent(
    agent_id: str, since_days: int = 60, min_count: int = 1,
) -> dict[str, dict[str, Any]]:
    """Community-emergent activity signal: which minds have actually
    spoken in chat sessions where this book was in context.

    Returns ``{mind_name_lower: {count, last_seen}}`` so the renderer
    can look up by mind name. Mind name is the only stable join key —
    the SPA writes ``mindName`` into role='mind' message meta_json
    (see app/static/app.js ``_queueSessionMessage`` flow) and writes
    ``contextBooks: [{id, title}]`` into role='user' message meta_json
    on the same session. We co-join within session_id.

    Derivation chain (PG-only — relies on JSONB operators):
      1. user messages where meta_json.contextBooks contains agent_id
      2. JOIN their session to mind messages in the SAME session
      3. GROUP by mindName, count distinct sessions

    ``since_days`` bounds the lookback so old chats don't dominate as
    the corpus grows. ``min_count`` filters out one-off invocations
    so the badge represents real activity, not noise.

    Pairs with ``list_minds_for_agent`` (the curated layer): renderer
    overlays the activity dict on top of the mind_works cards, badging
    minds with measurable real-chat activity. Cold-start safe — returns
    empty dict if no signal yet, in which case the curated layer
    renders unchanged.

    Empty in SQLite path (no JSONB operators); returns {} as a no-op.
    """
    if not _USE_PG:
        return {}
    with get_conn() as conn:
        try:
            rows = _fetchall(conn,
                """
                WITH book_sessions AS (
                    SELECT DISTINCT sm.session_id
                    FROM session_messages sm
                    WHERE sm.role = 'user'
                      AND sm.created_at::timestamp
                          > NOW() - INTERVAL '1 day' * %s
                      AND sm.meta_json::jsonb -> 'contextBooks' @>
                          jsonb_build_array(jsonb_build_object('id', %s::text))
                )
                SELECT LOWER(sm.meta_json::jsonb->>'mindName') AS mind_name,
                       COUNT(DISTINCT sm.session_id) AS session_count,
                       MAX(sm.created_at) AS last_seen
                FROM session_messages sm
                JOIN book_sessions bs ON bs.session_id = sm.session_id
                WHERE sm.role = 'mind'
                  AND sm.meta_json::jsonb->>'mindName' IS NOT NULL
                GROUP BY LOWER(sm.meta_json::jsonb->>'mindName')
                HAVING COUNT(DISTINCT sm.session_id) >= %s
                ORDER BY session_count DESC
                """, (since_days, agent_id, min_count))
            return {
                r["mind_name"]: {
                    "count": int(r["session_count"]),
                    "last_seen": r.get("last_seen") or "",
                }
                for r in rows if r.get("mind_name")
            }
        except Exception as exc:
            log.warning("list_minds_active_for_agent failed: %s", exc)
            return {}


def list_mind_recent_topics(
    mind_id: str, limit: int = 8, min_topic_chars: int = 4,
) -> list[dict[str, Any]]:
    """Aggregated topic themes pulled from real chats with this mind agent.

    Source: ``mind_memories.topic`` rows where ``user_id IS NULL`` (the
    privacy-preserving anonymized aggregation that ``extract_and_save_memory``
    already writes alongside per-user private interaction memories — see
    ``app/core/minds.py:extract_and_save_memory``). Per-user memories with
    ``user_id`` set are NOT included; this query only surfaces topics that
    the mind has discussed across multiple users in non-private form.

    Each row is ``{topic, count, last_seen}`` so the renderer can size the
    UI by activity level (popular vs occasional) and show a freshness hint.

    Skips trivial topics:
      * shorter than ``min_topic_chars`` (e.g. blank, single word)
      * boilerplate strings that the memory extractor sometimes emits as
        topic labels for non-content turns (``user_profile``,
        ``conversation initiation``, ``philosophical self-introduction``)

    Used by the mind landing page's "Recent themes" hybrid section
    (curated TOPIC_TAGS via ``matching_topics`` is the navigational layer
    that drives ``/mind/{id}/on/{topic-slug}`` URLs; this is the
    community-emergent informational layer with no URL impact).
    """
    boilerplate = (
        "user_profile",
        "conversation initiation",
        "philosophical self-introduction",
    )
    boilerplate_placeholders = ",".join(["?"] * len(boilerplate))
    with get_conn() as conn:
        try:
            rows = _fetchall(conn, _q(
                f"""SELECT topic, COUNT(*) AS n, MAX(created_at) AS last_seen
                    FROM mind_memories
                    WHERE mind_id = ?
                      AND user_id IS NULL
                      AND topic IS NOT NULL
                      AND length(topic) >= ?
                      AND LOWER(topic) NOT IN ({boilerplate_placeholders})
                    GROUP BY topic
                    ORDER BY COUNT(*) DESC, MAX(created_at) DESC
                    LIMIT ?"""
            ), (mind_id, min_topic_chars, *boilerplate, limit))
            return [
                {"topic": r["topic"], "count": int(r["n"]),
                 "last_seen": r.get("last_seen") or ""}
                for r in rows
            ]
        except Exception:
            return []


def list_books_for_mind(mind_id: str, limit: int = 12) -> list[dict[str, Any]]:
    """Books in this mind's corpus, with enough fields to render link text
    on /mind/{id}. Filters to ready agents only — drafts shouldn't appear
    on a public landing page."""
    with get_conn() as conn:
        rows = _fetchall(conn, _q(
            """SELECT a.id, a.name, a.type, a.meta
               FROM mind_works mw
               JOIN agents a ON a.id = mw.agent_id
               WHERE mw.mind_id = ? AND a.status = 'ready'
               ORDER BY a.name ASC
               LIMIT ?"""
        ), (mind_id, limit))
        out = []
        for r in rows:
            meta_raw = r.get("meta") if isinstance(r, dict) else r["meta"]
            try:
                meta = json.loads(meta_raw) if isinstance(meta_raw, str) else (meta_raw or {})
            except Exception:
                meta = {}
            out.append({
                "id": r["id"],
                "name": r["name"],
                "type": r["type"],
                "author": meta.get("author", ""),
            })
        return out


def count_chunks_batch(agent_ids: list[str]) -> dict[str, int]:
    """One-shot count of chunks per agent — used by sitemap to gate
    /q/ compound URL inclusion. Agents with too few chunks tend to
    produce low-quality LLM answers (RAG retrieves the wrong things,
    or the book has been indexed with metadata that doesn't match the
    actual content). Excluding their /q/ URLs from sitemap protects
    site-wide quality score.

    Returns {agent_id: count}; agents with zero chunks are omitted."""
    if not agent_ids:
        return {}
    placeholders = ",".join(["?"] * len(agent_ids))
    with get_conn() as conn:
        rows = _fetchall(conn, _q(
            f"""SELECT agent_id, COUNT(*) AS n FROM chunks
                WHERE agent_id IN ({placeholders})
                GROUP BY agent_id"""
        ), tuple(agent_ids))
    return {r["agent_id"]: int(r["n"]) for r in rows}


def get_first_chunk_text(agent_id: str, max_chars: int = 400) -> str:
    """Pull the first chunk's text (truncated) — used by the
    quality-audit script to spot agent-content mismatches (e.g. agent
    named 'A World Brewed' but chunk[0] starts with content from a
    completely different book)."""
    with get_conn() as conn:
        row = _fetchone(conn, _q(
            """SELECT text FROM chunks
               WHERE agent_id = ?
               ORDER BY chunk_index ASC
               LIMIT 1"""
        ), (agent_id,))
        if not row:
            return ""
        text = (row["text"] or "").strip()
        return text[:max_chars] if len(text) > max_chars else text


def list_questions_batch(agent_ids: list[str]) -> dict[str, list[str]]:
    """Fetch the question texts for many agents in one query — used by
    sitemap rendering, which would otherwise issue N round-trips.

    Returns {agent_id: [question_text, ...]}. Agents with no questions
    are omitted from the result, so callers can `.get(id, [])` safely.
    """
    if not agent_ids:
        return {}
    placeholders = ",".join(["?"] * len(agent_ids))
    with get_conn() as conn:
        rows = _fetchall(conn, _q(
            f"""SELECT agent_id, text FROM questions
                WHERE agent_id IN ({placeholders})
                ORDER BY agent_id, created_at ASC"""
        ), tuple(agent_ids))
    out: dict[str, list[str]] = {}
    for r in rows:
        out.setdefault(r["agent_id"], []).append(r["text"])
    return out


def list_books_by_topic(topic: str, limit: int = 30) -> list[dict[str, Any]]:
    """Books tagged with a given topic via ``meta.category`` (set by
    ``create_catalog_agent`` during topic-driven discovery).

    Implementation note: agents.meta is JSON-stringified text, and we have
    no JSON-aware index on it. We could push the predicate down with
    ``json_extract`` / ``jsonb->>'category'`` but the corpus is small
    (~hundreds) and the call site is cached by the page handler with a
    long TTL, so an in-Python filter is fast enough and portable across
    SQLite/Postgres without dialect branching.
    """
    if not topic:
        return []
    out = []
    for agent in list_agents(limit=2000):
        if agent.get("status") not in ("ready", "catalog"):
            continue
        meta = agent.get("meta") or {}
        if not isinstance(meta, dict):
            continue
        if (meta.get("category") or "").strip().lower() == topic.strip().lower():
            out.append({
                "id": agent["id"],
                "name": agent.get("name", ""),
                "type": agent.get("type", ""),
                "author": meta.get("author", ""),
            })
            if len(out) >= limit:
                break
    return out


# ─── UGC / public-discussion queries (Phase 6) ───────────────────────
#
# All read helpers filter on `public_status = 'approved'` — they cannot
# return private or pending sessions even if a caller forgets to check
# the feature flag. The write helpers enforce session ownership for
# user-initiated state changes and only an admin caller (verified by
# the route handler) should hit `approve_chat_session_public`.

def get_chat_session_with_public_status(session_id: str) -> dict[str, Any] | None:
    """Fetch a chat session including the UGC columns. Used by the
    moderation API and ownership checks. Returns None if the session
    doesn't exist."""
    with get_conn() as conn:
        row = _fetchone(conn, _q(
            """SELECT id, user_id, title, session_type, mind_id,
                      public_status, public_handle, public_title,
                      consent_at, approved_at, approved_by,
                      updated_at, created_at
               FROM chat_sessions WHERE id = ?"""
        ), (session_id,))
        if not row:
            return None
        return dict(row)


def request_chat_session_share(
    session_id: str, user_id: str, handle: str | None = None,
    public_title: str | None = None,
    min_message_count: int = 3, daily_share_limit: int = 10,
) -> dict[str, Any] | str | None:
    """User opts in to making this session public.

    **Auto-publish model (Phase 6.1, 2026-05-27)**: sets status='approved'
    directly so the session becomes publicly visible immediately. The
    older 'opted_in → admin approves' flow is still available via the
    moderation endpoints (admin can reject/withdraw post-hoc), but the
    common path no longer blocks on human review. Industry-standard
    Reddit/Twitter model: auto-publish + PII scrub + community report
    + admin emergency takedown.

    Two gates run before the status flips, both returning a string
    error code instead of the row so the API layer can surface a
    sensible message:

      * ``too_few_messages`` — session has fewer than ``min_message_count``
        messages. Avoids publishing trivially-empty pages that would render
        as thin content and embarrass the user.
      * ``rate_limited`` — user has already shared ``daily_share_limit``
        sessions in the trailing 24h window. Spam / bulk-publish guard.

    Returns:
      * dict — the updated session row on success
      * str  — error code (``"not_found"``, ``"rejected"``,
        ``"too_few_messages"``, ``"rate_limited"``) for known failure modes
      * None — fallback for unknown failure (legacy callers handle this)
    """
    sess = get_chat_session_with_public_status(session_id)
    if not sess or sess.get("user_id") != user_id:
        return "not_found"
    # Rejected sessions can't re-share — admin already declined. User
    # can still chat in them; they just can't be public.
    if sess.get("public_status") == "rejected":
        return "rejected"

    with get_conn() as conn:
        # Quality gate: enough content to justify a public page.
        msg_count = _fetchone(conn, _q(
            "SELECT COUNT(*) AS n FROM session_messages WHERE session_id = ?"
        ), (session_id,))
        if (msg_count and int(msg_count.get("n", 0)) < min_message_count):
            return "too_few_messages"

        # Rate limit: trailing 24h window of approved/opted shares by user.
        # Counts sessions transitioned in the last day — not lifetime.
        if _USE_PG:
            recent = _fetchone(conn, _q(
                """SELECT COUNT(*) AS n FROM chat_sessions
                   WHERE user_id = ?
                     AND public_status IN ('approved', 'opted_in')
                     AND consent_at > NOW() - INTERVAL '1 day'"""
            ), (user_id,))
        else:
            # SQLite path: ISO timestamp string comparison vs 'now-1 day'.
            recent = _fetchone(conn, _q(
                """SELECT COUNT(*) AS n FROM chat_sessions
                   WHERE user_id = ?
                     AND public_status IN ('approved', 'opted_in')
                     AND consent_at > datetime('now', '-1 day')"""
            ), (user_id,))
        if recent and int(recent.get("n", 0)) >= daily_share_limit:
            return "rate_limited"

        now = _utcnow()
        # Auto-publish: write 'approved' + stamp approved_at in the same
        # statement so the session becomes immediately discoverable. The
        # approved_by column is left NULL on auto-publish — distinguishes
        # auto-approved rows from editorial-marked ones (where approved_by
        # carries the admin uuid).
        _execute(conn, _q(
            """UPDATE chat_sessions
               SET public_status = 'approved',
                   public_handle = ?,
                   public_title  = COALESCE(?, public_title),
                   consent_at    = ?,
                   approved_at   = ?
               WHERE id = ? AND user_id = ?"""
        ), (handle, public_title, now, now, session_id, user_id))
    return get_chat_session_with_public_status(session_id)


def withdraw_chat_session_share(
    session_id: str, user_id: str,
) -> dict[str, Any] | None:
    """User withdraws consent — flips status to 'withdrawn'. Works at
    any prior status (opted_in or already approved). Returns updated
    row or None if not found / not owned."""
    sess = get_chat_session_with_public_status(session_id)
    if not sess or sess.get("user_id") != user_id:
        return None
    with get_conn() as conn:
        _execute(conn, _q(
            "UPDATE chat_sessions SET public_status = 'withdrawn' WHERE id = ? AND user_id = ?"
        ), (session_id, user_id))
    return get_chat_session_with_public_status(session_id)


def approve_chat_session_public(
    session_id: str, admin_user_id: str, public_title: str | None = None,
) -> dict[str, Any] | None:
    """Admin approves an opted-in session for public display. Caller
    must have verified admin status (route handler responsibility).
    Sets status to 'approved' and stamps approval audit fields."""
    sess = get_chat_session_with_public_status(session_id)
    if not sess:
        return None
    # Only opted-in sessions can be approved. Won't accidentally
    # re-approve a withdrawn or rejected session.
    if sess.get("public_status") != "opted_in":
        return None
    with get_conn() as conn:
        _execute(conn, _q(
            """UPDATE chat_sessions
               SET public_status = 'approved',
                   approved_at = ?,
                   approved_by = ?,
                   public_title = COALESCE(?, public_title)
               WHERE id = ?"""
        ), (_utcnow(), admin_user_id, public_title, session_id))
    return get_chat_session_with_public_status(session_id)


def reject_chat_session_public(
    session_id: str, admin_user_id: str,
) -> dict[str, Any] | None:
    """Admin rejects an opted-in session. Status -> 'rejected'."""
    sess = get_chat_session_with_public_status(session_id)
    if not sess or sess.get("public_status") != "opted_in":
        return None
    with get_conn() as conn:
        _execute(conn, _q(
            """UPDATE chat_sessions
               SET public_status = 'rejected',
                   approved_at = ?,
                   approved_by = ?
               WHERE id = ?"""
        ), (_utcnow(), admin_user_id, session_id))
    return get_chat_session_with_public_status(session_id)


def list_public_sessions_for_agent(
    agent_id: str, limit: int = 12,
) -> list[dict[str, Any]]:
    """Approved public chat sessions for a book (session_type='book',
    `mind_id` column stores the agent id in this schema overload).
    Ordered by approval recency."""
    with get_conn() as conn:
        rows = _fetchall(conn, _q(
            """SELECT id, user_id, title, public_handle, public_title,
                      approved_at, created_at
               FROM chat_sessions
               WHERE session_type = 'book'
                 AND mind_id = ?
                 AND public_status = 'approved'
               ORDER BY approved_at DESC, created_at DESC
               LIMIT ?"""
        ), (agent_id, limit))
        return [dict(r) for r in rows]


def list_public_sessions_for_mind(
    mind_id: str, limit: int = 12,
) -> list[dict[str, Any]]:
    """Approved public chat sessions for a mind. Uses the canonical
    session_type='chat' + mind_id binding."""
    with get_conn() as conn:
        rows = _fetchall(conn, _q(
            """SELECT id, user_id, title, public_handle, public_title,
                      approved_at, created_at
               FROM chat_sessions
               WHERE session_type IN ('chat', 'mind')
                 AND mind_id = ?
                 AND public_status = 'approved'
               ORDER BY approved_at DESC, created_at DESC
               LIMIT ?"""
        ), (mind_id, limit))
        return [dict(r) for r in rows]


# ─── Phase 8 — Live AI Output Indexing reads ─────────────────────────
#
# These pull only role='assistant' rows and live behind the public
# /insights and /dialogues routes. The whole point is to surface the
# AI's accumulated commentary without ever returning user messages —
# the SQL filter on role is the hard privacy boundary.

# Per-agent (book) AI output lives in two tables historically:
#   * `messages`           — older per-agent direct chat path
#   * `session_messages`   — newer session-based path (joined via
#                            chat_sessions WHERE session_type='book'
#                            AND mind_id={agent_id})
# Both paths still write today depending on the client endpoint; for
# completeness we query both and merge in Python.


def list_assistant_messages_for_agent(
    agent_id: str, limit: int = 100, min_chars: int = 200,
) -> list[dict[str, Any]]:
    """Returns ``role='assistant'`` messages for a book agent, drawn
    from BOTH the messages table and the session_messages table.

    SAFETY: hard-coded role filter at SQL level. There is no code path
    in this function that returns user-role messages."""
    rows: list[dict[str, Any]] = []
    with get_conn() as conn:
        # Direct per-agent chat (messages table)
        try:
            direct = _fetchall(conn, _q(
                """SELECT id, content, created_at
                   FROM messages
                   WHERE agent_id = ?
                     AND role = 'assistant'
                     AND length(content) >= ?
                   ORDER BY created_at DESC
                   LIMIT ?"""
            ), (agent_id, min_chars, limit))
            for r in direct:
                rows.append({
                    "id": r["id"], "content": r["content"],
                    "created_at": r["created_at"], "source": "messages",
                })
        except Exception:
            pass

        # Session-based book chats (session_messages joined to chat_sessions)
        try:
            sess = _fetchall(conn, _q(
                """SELECT sm.id, sm.content, sm.created_at
                   FROM session_messages sm
                   JOIN chat_sessions cs ON cs.id = sm.session_id
                   WHERE cs.session_type = 'book'
                     AND cs.mind_id = ?
                     AND sm.role = 'assistant'
                     AND length(sm.content) >= ?
                   ORDER BY sm.created_at DESC
                   LIMIT ?"""
            ), (agent_id, min_chars, limit))
            for r in sess:
                rows.append({
                    "id": r["id"], "content": r["content"],
                    "created_at": r["created_at"], "source": "session_messages",
                })
        except Exception:
            pass

    # Merge + sort by created_at DESC, then cap to limit
    rows.sort(key=lambda r: r.get("created_at") or "", reverse=True)
    return rows[:limit]


def list_assistant_messages_for_mind(
    mind_id: str, limit: int = 100, min_chars: int = 200,
) -> list[dict[str, Any]]:
    """Returns ``role='assistant'`` messages from chat sessions bound
    to a mind. Mind chats only live in session_messages (no direct
    messages-table path for minds)."""
    with get_conn() as conn:
        try:
            rows = _fetchall(conn, _q(
                """SELECT sm.id, sm.content, sm.created_at
                   FROM session_messages sm
                   JOIN chat_sessions cs ON cs.id = sm.session_id
                   WHERE cs.session_type IN ('chat', 'mind')
                     AND cs.mind_id = ?
                     AND sm.role = 'assistant'
                     AND length(sm.content) >= ?
                   ORDER BY sm.created_at DESC
                   LIMIT ?"""
            ), (mind_id, min_chars, limit))
            return [{
                "id": r["id"], "content": r["content"],
                "created_at": r["created_at"], "source": "session_messages",
            } for r in rows]
        except Exception:
            return []


def count_approved_public_sessions_per_agent(
    agent_ids: list[str],
) -> dict[str, int]:
    """How many approved public chat sessions each book has — used by the
    sitemap to decide whether to include /book/{id}/discussions URLs.

    Without this gate, sitemap emits a /discussions URL for every ready
    book (754 of them in production as of 2026-05-28), most of which
    render an empty aggregation page because no user has actually
    shared a discussion yet. Google reads those as thin content and
    drags the site-wide quality score down. Gate at >=1 approved
    session, just like /insights gates at >=3 publishable messages.

    Schema: chat_sessions.session_type='book' sets mind_id to the
    book's agent_id (legacy column naming).
    """
    if not agent_ids:
        return {}
    placeholders = ",".join(["?"] * len(agent_ids))
    with get_conn() as conn:
        try:
            rows = _fetchall(conn, _q(
                f"""SELECT mind_id AS agent_id, COUNT(*) AS n
                    FROM chat_sessions
                    WHERE public_status = 'approved'
                      AND session_type = 'book'
                      AND mind_id IN ({placeholders})
                    GROUP BY mind_id"""
            ), tuple(agent_ids))
            return {r["agent_id"]: int(r["n"]) for r in rows}
        except Exception:
            return {}


def count_approved_public_sessions_per_mind(
    mind_ids: list[str],
) -> dict[str, int]:
    """How many approved public chat sessions each mind has — same
    rationale as the per-agent variant above. Schema:
    chat_sessions.session_type IN ('chat', 'mind') AND mind_id = mind.id.
    """
    if not mind_ids:
        return {}
    placeholders = ",".join(["?"] * len(mind_ids))
    with get_conn() as conn:
        try:
            rows = _fetchall(conn, _q(
                f"""SELECT mind_id, COUNT(*) AS n
                    FROM chat_sessions
                    WHERE public_status = 'approved'
                      AND session_type IN ('chat', 'mind')
                      AND mind_id IN ({placeholders})
                    GROUP BY mind_id"""
            ), tuple(mind_ids))
            return {r["mind_id"]: int(r["n"]) for r in rows}
        except Exception:
            return {}


def count_assistant_messages_batch(
    agent_ids: list[str], min_chars: int = 200,
) -> dict[str, int]:
    """One-shot count of assistant messages per agent across BOTH
    tables. Used by sitemap rendering to decide which /insights URLs
    are worth advertising (skip empty ones to avoid burning crawl
    budget on thin pages). Returns {agent_id: count}; agents with
    zero rows are omitted."""
    if not agent_ids:
        return {}
    placeholders = ",".join(["?"] * len(agent_ids))
    out: dict[str, int] = {}
    with get_conn() as conn:
        # messages table
        try:
            r1 = _fetchall(conn, _q(
                f"""SELECT agent_id, COUNT(*) AS n FROM messages
                    WHERE agent_id IN ({placeholders})
                      AND role = 'assistant'
                      AND length(content) >= ?
                    GROUP BY agent_id"""
            ), (*agent_ids, min_chars))
            for r in r1:
                out[r["agent_id"]] = out.get(r["agent_id"], 0) + int(r["n"])
        except Exception:
            pass
        # session_messages via chat_sessions
        try:
            r2 = _fetchall(conn, _q(
                f"""SELECT cs.mind_id AS agent_id, COUNT(*) AS n
                    FROM session_messages sm
                    JOIN chat_sessions cs ON cs.id = sm.session_id
                    WHERE cs.session_type = 'book'
                      AND cs.mind_id IN ({placeholders})
                      AND sm.role = 'assistant'
                      AND length(sm.content) >= ?
                    GROUP BY cs.mind_id"""
            ), (*agent_ids, min_chars))
            for r in r2:
                out[r["agent_id"]] = out.get(r["agent_id"], 0) + int(r["n"])
        except Exception:
            pass
    return out


def count_assistant_messages_for_minds_batch(
    mind_ids: list[str], min_chars: int = 200,
) -> dict[str, int]:
    """Same as count_assistant_messages_batch but for minds (only
    session_messages path applies)."""
    if not mind_ids:
        return {}
    placeholders = ",".join(["?"] * len(mind_ids))
    out: dict[str, int] = {}
    with get_conn() as conn:
        try:
            rows = _fetchall(conn, _q(
                f"""SELECT cs.mind_id, COUNT(*) AS n
                    FROM session_messages sm
                    JOIN chat_sessions cs ON cs.id = sm.session_id
                    WHERE cs.session_type IN ('chat', 'mind')
                      AND cs.mind_id IN ({placeholders})
                      AND sm.role = 'assistant'
                      AND length(sm.content) >= ?
                    GROUP BY cs.mind_id"""
            ), (*mind_ids, min_chars))
            for r in rows:
                out[r["mind_id"]] = int(r["n"])
        except Exception:
            pass
    return out


# ─── Phase 7.3 — LLM referrer tracking ──────────────────────────────
#
# Append-only log of LLM-sourced traffic. Written from main.py's
# middleware (fail-open). Read by the admin endpoint to answer "which
# pages get the most LLM citations." Schema kept minimal to make the
# privacy posture obvious — no IPs, no full UAs, no query strings.


def log_llm_referral(
    url_path: str, source: str, ua_class: str,
) -> None:
    """Append one row. Fail-open: a logging issue must never break the
    request being measured."""
    if not url_path or not source:
        return
    try:
        with get_conn() as conn:
            _execute(conn, _q(
                "INSERT INTO llm_referrals (url_path, source, ua_class, created_at) "
                "VALUES (?, ?, ?, ?)"
            ), (url_path[:500], source[:50], ua_class[:20], _utcnow()))
    except Exception:
        pass  # swallowed by design


def count_llm_referrals(
    since_iso: str | None = None, limit_per_source: int = 50,
) -> dict[str, Any]:
    """Aggregate counts for the admin dashboard. Returns:

    .. code-block:: python

        {
          "total": N,
          "by_source": {"chatgpt": 42, "perplexity": 18, ...},
          "by_ua_class": {"bot": 60, "human": 0, ...},
          "top_paths": [{"path": "/book/abc", "source": "chatgpt", "n": 12}, ...],
        }
    """
    where = ""
    params: tuple = ()
    if since_iso:
        where = "WHERE created_at >= ?"
        params = (since_iso,)
    out: dict[str, Any] = {
        "total": 0, "by_source": {}, "by_ua_class": {}, "top_paths": [],
    }
    with get_conn() as conn:
        try:
            r = _fetchone(conn, _q(
                f"SELECT COUNT(*) AS n FROM llm_referrals {where}"
            ), params)
            out["total"] = int(r["n"]) if r else 0
        except Exception:
            return out
        try:
            for r in _fetchall(conn, _q(
                f"SELECT source, COUNT(*) AS n FROM llm_referrals {where} GROUP BY source"
            ), params):
                out["by_source"][r["source"]] = int(r["n"])
        except Exception:
            pass
        try:
            for r in _fetchall(conn, _q(
                f"SELECT ua_class, COUNT(*) AS n FROM llm_referrals {where} GROUP BY ua_class"
            ), params):
                out["by_ua_class"][r["ua_class"]] = int(r["n"])
        except Exception:
            pass
        try:
            top = _fetchall(conn, _q(
                f"""SELECT url_path, source, COUNT(*) AS n FROM llm_referrals
                    {where}
                    GROUP BY url_path, source
                    ORDER BY n DESC
                    LIMIT ?"""
            ), (*params, limit_per_source))
            out["top_paths"] = [
                {"path": r["url_path"], "source": r["source"], "n": int(r["n"])}
                for r in top
            ]
        except Exception:
            pass
    return out


def list_messages_for_public_session(
    session_id: str, limit: int = 12,
) -> list[dict[str, Any]]:
    """Read messages for public display. SAFETY-CRITICAL:
    only returns rows if the session's public_status is 'approved'.
    Caller (the /discussions page renderer) must still PII-scrub the
    text before display — this function does not scrub, only gates."""
    with get_conn() as conn:
        # Single round-trip: gate on approved status by joining the
        # parent session row.
        rows = _fetchall(conn, _q(
            """SELECT sm.id, sm.role, sm.content, sm.created_at
               FROM session_messages sm
               JOIN chat_sessions cs ON cs.id = sm.session_id
               WHERE sm.session_id = ?
                 AND cs.public_status = 'approved'
               ORDER BY sm.created_at ASC
               LIMIT ?"""
        ), (session_id, limit))
        return [dict(r) for r in rows]


def count_pending_public_sessions() -> int:
    """How many sessions are awaiting moderation. Used by admin endpoints
    and dashboards (the moderation queue size)."""
    with get_conn() as conn:
        row = _fetchone(conn, _q(
            "SELECT COUNT(*) AS n FROM chat_sessions WHERE public_status = 'opted_in'"
        ))
        return int(row["n"]) if row else 0


def list_related_books(
    exclude_agent_id: str,
    topic: str = "",
    author: str = "",
    limit: int = 6,
) -> list[dict[str, Any]]:
    """Books related to one we're already rendering. Prefers same-topic,
    then same-author, excluding the source book itself. Used for the
    "Related Books" section on /book/{id} (Phase 5 — closes the
    book↔book half of the internal linking graph).

    Same in-Python filter pattern as list_books_by_topic — corpus is
    small, queries are cached at the page handler level."""
    if not exclude_agent_id:
        return []
    topic_lower = topic.strip().lower() if topic else ""
    author_lower = author.strip().lower() if author else ""

    # Two passes: topic matches first (higher relevance), then author
    # matches that we haven't already picked. Stable ordering by name
    # to keep the rendered list deterministic between cache misses.
    seen: set[str] = {exclude_agent_id}
    out: list[dict[str, Any]] = []

    def _push(agent: dict[str, Any]) -> None:
        if agent["id"] in seen:
            return
        meta = agent.get("meta") or {}
        if not isinstance(meta, dict):
            meta = {}
        out.append({
            "id": agent["id"],
            "name": agent.get("name", ""),
            "type": agent.get("type", ""),
            "author": meta.get("author", ""),
        })
        seen.add(agent["id"])

    all_agents = list_agents(limit=2000)

    if topic_lower:
        for a in all_agents:
            if len(out) >= limit:
                break
            if a.get("status") not in ("ready", "catalog"):
                continue
            meta = a.get("meta") or {}
            if not isinstance(meta, dict):
                continue
            if (meta.get("category") or "").strip().lower() == topic_lower:
                _push(a)

    if author_lower and len(out) < limit:
        for a in all_agents:
            if len(out) >= limit:
                break
            if a.get("status") not in ("ready", "catalog"):
                continue
            meta = a.get("meta") or {}
            if not isinstance(meta, dict):
                continue
            if (meta.get("author") or "").strip().lower() == author_lower:
                _push(a)

    return out


def list_minds_by_topic(topic: str, limit: int = 12) -> list[dict[str, Any]]:
    """Minds whose ``domain`` (comma-separated) contains the given topic
    as a substring. ``domain`` was designed for human-readable tag
    display; matching is intentionally loose so 'Economics' picks up
    'Economics, Moral Philosophy' too.
    """
    if not topic:
        return []
    with get_conn() as conn:
        rows = _fetchall(conn, _q(
            """SELECT id, name, era, domain
               FROM minds
               WHERE domain LIKE ?
               ORDER BY chat_count DESC, name ASC
               LIMIT ?"""
        ), (f"%{topic}%", limit))
        return [dict(r) for r in rows]


def list_related_minds(mind_id: str, domain: str, limit: int = 6) -> list[dict[str, Any]]:
    """Other minds sharing at least one domain tag with this mind. Domain is
    a comma-separated string in the schema, so we match by substring on any
    token. Excludes the mind itself."""
    if not domain:
        return []
    primary = domain.split(",")[0].strip()
    if not primary:
        return []
    with get_conn() as conn:
        rows = _fetchall(conn, _q(
            """SELECT id, name, era, domain
               FROM minds
               WHERE id <> ? AND domain LIKE ?
               ORDER BY chat_count DESC, name ASC
               LIMIT ?"""
        ), (mind_id, f"%{primary}%", limit))
        return [dict(r) for r in rows]


# ─── Mind memories ───

def add_mind_memory(mind_id: str, summary: str, topic: str = "", user_id: str | None = None) -> None:
    with get_conn() as conn:
        _execute(conn, _q(
            "INSERT INTO mind_memories (id, mind_id, user_id, summary, topic, created_at) VALUES (?, ?, ?, ?, ?, ?)"
        ), (str(uuid.uuid4()), mind_id, user_id, summary, topic, _utcnow()))


def upsert_compiled_memory(mind_id: str, user_id: str, summary: str, topic: str = "user_profile") -> None:
    """Update the compiled memory for a mind-user pair. Creates if doesn't exist."""
    with get_conn() as conn:
        existing = _fetchone(conn, _q(
            "SELECT id FROM mind_memories WHERE mind_id = ? AND user_id = ? AND memory_type = 'compiled'"
        ), (mind_id, user_id or ""))
        if existing:
            _execute(conn, _q(
                "UPDATE mind_memories SET summary = ?, topic = ?, created_at = ? WHERE id = ?"
            ), (summary, topic, _utcnow(), existing["id"]))
        else:
            _execute(conn, _q(
                "INSERT INTO mind_memories (id, mind_id, user_id, summary, topic, memory_type, created_at) VALUES (?, ?, ?, ?, ?, 'compiled', ?)"
            ), (str(uuid.uuid4()), mind_id, user_id or "", summary, topic, _utcnow()))


def list_mind_memories(mind_id: str, user_id: str | None = None, limit: int = 20) -> list[dict[str, Any]]:
    """Return memories for a mind.

    Privacy model:
    - Compiled memory (memory_type='compiled'): synthesized understanding of user,
      returned first as primary context.
    - Private memories (user_id matches): return full summary + topic.
    - Global topic tags (user_id IS NULL): return topic ONLY (no summary) to
      prevent leaking specific conversation content across users.
    """
    with get_conn() as conn:
        if user_id:
            # Compiled memory first (primary context)
            compiled = _fetchall(conn, _q(
                """SELECT summary, topic, created_at, user_id FROM mind_memories
                   WHERE mind_id = ? AND user_id = ? AND memory_type = 'compiled'
                   ORDER BY created_at DESC LIMIT 1"""
            ), (mind_id, user_id))
            # Then interaction memories (secondary context)
            private = _fetchall(conn, _q(
                """SELECT summary, topic, created_at, user_id FROM mind_memories
                   WHERE mind_id = ? AND user_id = ?
                   AND (memory_type = 'interaction' OR memory_type IS NULL)
                   ORDER BY created_at DESC LIMIT ?"""
            ), (mind_id, user_id, limit))
            global_tags = _fetchall(conn, _q(
                """SELECT topic, created_at FROM mind_memories
                   WHERE mind_id = ? AND user_id IS NULL AND topic != ''
                   ORDER BY created_at DESC LIMIT ?"""
            ), (mind_id, limit))
            rows = list(compiled) + list(private)
            for g in global_tags:
                rows.append({"summary": "", "topic": g["topic"],
                             "created_at": g["created_at"], "user_id": None})
            return rows
        else:
            rows = _fetchall(conn, _q(
                """SELECT topic, created_at FROM mind_memories
                   WHERE mind_id = ? AND user_id IS NULL AND topic != ''
                   ORDER BY created_at DESC LIMIT ?"""
            ), (mind_id, limit))
            return [{"summary": "", "topic": r["topic"],
                     "created_at": r["created_at"], "user_id": None} for r in rows]


def list_user_interest_profile(user_id: str, limit: int = 50) -> list[dict[str, Any]]:
    """Return aggregated topic tags for a user across all minds.

    Returns only anonymized topics — never conversation summaries.
    Useful for building user interest profiles and future user-matching.
    """
    with get_conn() as conn:
        rows = _fetchall(conn, _q(
            """SELECT topic, mind_id, COUNT(*) as freq
               FROM mind_memories
               WHERE user_id = ? AND topic != ''
               GROUP BY topic, mind_id
               ORDER BY freq DESC, topic ASC
               LIMIT ?"""
        ), (user_id, limit))
        return [{"topic": r["topic"], "mind_id": r["mind_id"],
                 "frequency": r["freq"]} for r in rows]


# ─── Chat sessions ───

def create_chat_session(title: str = "New chat", session_type: str = "chat",
                        mind_id: str | None = None, meta: dict[str, Any] | None = None,
                        user_id: str | None = None) -> dict[str, Any]:
    session_id = str(uuid.uuid4())
    now = _utcnow()
    with get_conn() as conn:
        _execute(conn, _q(
            "INSERT INTO chat_sessions (id, user_id, title, session_type, mind_id, meta_json, updated_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
        ), (session_id, user_id, title, session_type, mind_id, json.dumps(meta or {}), now, now))
    return {"id": session_id, "user_id": user_id, "title": title, "session_type": session_type,
            "mind_id": mind_id, "meta": meta or {}, "updated_at": now, "created_at": now}


def _user_filter(user_id: str | None) -> tuple[str, tuple]:
    """Return a SQL fragment + params that match the given user_id (or IS NULL)."""
    if user_id:
        return "user_id = ?", (user_id,)
    return "user_id IS NULL", ()


def list_chat_sessions(user_id: str | None = None) -> list[dict[str, Any]]:
    filt, params = _user_filter(user_id)
    with get_conn() as conn:
        rows = _fetchall(conn, _q(
            f"SELECT * FROM chat_sessions WHERE {filt} ORDER BY updated_at DESC"
        ), params)
        return [_row_to_session(r) for r in rows]


def get_chat_session(session_id: str, user_id: str | None = None) -> dict[str, Any] | None:
    filt, params = _user_filter(user_id)
    with get_conn() as conn:
        row = _fetchone(conn, _q(
            f"SELECT * FROM chat_sessions WHERE id = ? AND {filt}"
        ), (session_id, *params))
        if not row:
            return None
        return _row_to_session(row)


def update_chat_session(session_id: str, title: str | None = None,
                        meta: dict[str, Any] | None = None,
                        user_id: str | None = None) -> None:
    filt, params = _user_filter(user_id)
    with get_conn() as conn:
        session = _fetchone(conn, _q(
            f"SELECT id FROM chat_sessions WHERE id = ? AND {filt}"
        ), (session_id, *params))
        if not session:
            return
        if title is not None:
            _execute(conn, _q(f"UPDATE chat_sessions SET title = ?, updated_at = ? WHERE id = ? AND {filt}"),
                     (title, _utcnow(), session_id, *params))
        if meta is not None:
            _execute(conn, _q(f"UPDATE chat_sessions SET meta_json = ?, updated_at = ? WHERE id = ? AND {filt}"),
                     (json.dumps(meta), _utcnow(), session_id, *params))


def delete_chat_session(session_id: str, user_id: str | None = None) -> bool:
    filt, params = _user_filter(user_id)
    with get_conn() as conn:
        session = _fetchone(conn, _q(
            f"SELECT id FROM chat_sessions WHERE id = ? AND {filt}"
        ), (session_id, *params))
        if not session:
            return False
        _execute(conn, _q("DELETE FROM session_messages WHERE session_id = ?"), (session_id,))
        cur = _execute(conn, _q(f"DELETE FROM chat_sessions WHERE id = ? AND {filt}"), (session_id, *params))
        return cur.rowcount > 0


def _row_to_session(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": row["id"],
        "user_id": row.get("user_id"),
        "title": row["title"],
        "session_type": row.get("session_type", "chat"),
        "mind_id": row.get("mind_id"),
        "meta": json.loads(row.get("meta_json") or "{}"),
        "updated_at": row["updated_at"],
        "created_at": row["created_at"],
        # Public-share columns. Defaulted because legacy SQLite rows
        # pre-date the migration. Exposing them on the API row lets the
        # SPA show the public 🌐 dot and the "Manage share" button label
        # without an extra round-trip per session.
        "public_status": row.get("public_status") or "private",
        "public_handle": row.get("public_handle"),
        "public_title": row.get("public_title"),
    }


def add_session_message(session_id: str, role: str, content: str,
                        meta: dict[str, Any] | None = None,
                        user_id: str | None = None) -> dict[str, Any]:
    filt, params = _user_filter(user_id)
    msg_id = str(uuid.uuid4())
    now = _utcnow()
    with get_conn() as conn:
        session = _fetchone(conn, _q(
            f"SELECT id FROM chat_sessions WHERE id = ? AND {filt}"
        ), (session_id, *params))
        if not session:
            raise ValueError("Session not found or access denied")
        _execute(conn, _q(
            "INSERT INTO session_messages (id, session_id, role, content, meta_json, created_at) VALUES (?, ?, ?, ?, ?, ?)"
        ), (msg_id, session_id, role, content, json.dumps(meta or {}), now))
        _execute(conn, _q(f"UPDATE chat_sessions SET updated_at = ? WHERE id = ? AND {filt}"),
                 (now, session_id, *params))
    return {"id": msg_id, "role": role, "content": content, "meta": meta or {}, "created_at": now}


def list_session_messages(session_id: str, user_id: str | None = None) -> list[dict[str, Any]]:
    filt, params = _user_filter(user_id)
    with get_conn() as conn:
        session = _fetchone(conn, _q(
            f"SELECT id FROM chat_sessions WHERE id = ? AND {filt}"
        ), (session_id, *params))
        if not session:
            return []
        rows = _fetchall(conn, _q(
            "SELECT id, role, content, meta_json, created_at FROM session_messages WHERE session_id = ? ORDER BY created_at ASC"
        ), (session_id,))
        return [{"id": r["id"], "role": r["role"], "content": r["content"],
                 "meta": json.loads(r.get("meta_json") or "{}"), "created_at": r["created_at"]} for r in rows]


# ─── Pro: User & Usage helpers ───

def get_or_create_user(user_id: str, email: str) -> dict[str, Any]:
    """Get existing user or create a new free-tier user.

    If an old user record exists with the same email but a different id
    (e.g. after migrating to a new Supabase project), all data is
    re-linked from the old id to the new id automatically.
    """
    with get_conn() as conn:
        row = _fetchone(conn, _q("SELECT * FROM users WHERE id = ?"), (user_id,))
        if row:
            return row

        if email:
            old = _fetchone(conn, _q(
                "SELECT * FROM users WHERE email = ? AND id != ?"
            ), (email, user_id))
            if old:
                old_id = old["id"]
                for tbl in ("agents", "chat_sessions", "ai_books", "messages", "mind_memories"):
                    _execute(conn, _q(
                        f'UPDATE "{tbl}" SET user_id = ? WHERE user_id = ?'
                    ), (user_id, old_id))
                if _USE_PG:
                    # Free email on the old row so the new row can be inserted
                    # without tripping UNIQUE(email).
                    _execute(conn,
                        "UPDATE users SET email = NULL WHERE id = %s",
                        (old_id,))
                    _execute(conn, _q(
                        "INSERT INTO users (id, email, tier, stripe_customer_id, "
                        "stripe_subscription_id, subscription_status, "
                        "subscription_ended_at, created_at) "
                        "SELECT ?, ?, tier, stripe_customer_id, "
                        "stripe_subscription_id, subscription_status, "
                        "subscription_ended_at, created_at "
                        "FROM users WHERE id = ?"
                    ), (user_id, email, old_id))
                    _execute(conn,
                        "UPDATE usage SET user_id = %s WHERE user_id = %s",
                        (user_id, old_id))
                    _execute(conn, _q("DELETE FROM users WHERE id = ?"), (old_id,))
                else:
                    _execute(conn, _q(
                        "UPDATE usage SET user_id = ? WHERE user_id = ?"
                    ), (user_id, old_id))
                    _execute(conn, _q("UPDATE users SET id = ? WHERE id = ?"),
                             (user_id, old_id))
                row = _fetchone(conn, _q("SELECT * FROM users WHERE id = ?"), (user_id,))
                return row

        _execute(conn, _conflict_ignore(_q(
            "INSERT OR IGNORE INTO users (id, email, tier) VALUES (?, ?, 'free')"
        )), (user_id, email))
        row = _fetchone(conn, _q("SELECT * FROM users WHERE id = ?"), (user_id,))
        return row


def get_user(user_id: str) -> dict[str, Any] | None:
    with get_conn() as conn:
        return _fetchone(conn, _q("SELECT * FROM users WHERE id = ?"), (user_id,))


def update_user_tier(user_id: str, tier: str, stripe_customer_id: str | None = None,
                     stripe_subscription_id: str | None = None,
                     subscription_status: str | None = None,
                     subscription_ended_at: str | None = None) -> None:
    with get_conn() as conn:
        _execute(conn, _q("""
            UPDATE users SET tier = ?,
            stripe_customer_id = COALESCE(?, stripe_customer_id),
            stripe_subscription_id = COALESCE(?, stripe_subscription_id),
            subscription_status = COALESCE(?, subscription_status),
            subscription_ended_at = COALESCE(?, subscription_ended_at)
            WHERE id = ?
        """), (tier, stripe_customer_id, stripe_subscription_id,
               subscription_status, subscription_ended_at, user_id))


def find_user_by_stripe_customer(customer_id: str) -> dict[str, Any] | None:
    with get_conn() as conn:
        return _fetchone(conn, _q("SELECT * FROM users WHERE stripe_customer_id = ?"), (customer_id,))


def update_user_tier_by_stripe_customer(
    customer_id: str,
    tier: str | None = None,
    subscription_status: str | None = None,
    subscription_ended_at: str | None = None,
) -> dict[str, Any] | None:
    """Atomically locate a user by stripe_customer_id and apply tier updates
    in a single transaction. On Postgres the SELECT takes a row-level lock
    (FOR UPDATE) so concurrent webhooks for the same customer serialize
    instead of racing through SELECT-then-UPDATE with stale state.

    Returns the post-update user row, or None if no user matched.
    Pass None for fields that should remain unchanged (COALESCE semantics).
    """
    with get_conn() as conn:
        if _USE_PG:
            row = _fetchone(conn,
                "SELECT id FROM users WHERE stripe_customer_id = %s FOR UPDATE",
                (customer_id,))
        else:
            row = _fetchone(conn,
                "SELECT id FROM users WHERE stripe_customer_id = ?",
                (customer_id,))
        if not row:
            return None
        _execute(conn, _q("""
            UPDATE users SET
                tier = COALESCE(?, tier),
                subscription_status = COALESCE(?, subscription_status),
                subscription_ended_at = COALESCE(?, subscription_ended_at)
            WHERE id = ?
        """), (tier, subscription_status, subscription_ended_at, row["id"]))
        return _fetchone(conn, _q("SELECT * FROM users WHERE id = ?"), (row["id"],))


def mark_stripe_webhook_processed(event_id: str) -> bool:
    """Record a Stripe webhook event id. Returns True if newly recorded,
    False if the event was already processed (Stripe re-delivery)."""
    with get_conn() as conn:
        if _USE_PG:
            cur = _execute(conn,
                "INSERT INTO stripe_webhook_events (event_id) VALUES (%s) "
                "ON CONFLICT (event_id) DO NOTHING",
                (event_id,))
        else:
            cur = _execute(conn,
                "INSERT OR IGNORE INTO stripe_webhook_events (event_id, processed_at) "
                "VALUES (?, ?)",
                (event_id, _utcnow()))
        return (cur.rowcount or 0) > 0


def clear_stripe_webhook(event_id: str) -> None:
    """Forget a recorded webhook event so Stripe's retry can re-process it.
    Called when handler raised after the idempotency record was inserted."""
    try:
        with get_conn() as conn:
            _execute(conn,
                _q("DELETE FROM stripe_webhook_events WHERE event_id = ?"),
                (event_id,))
    except Exception as exc:
        log.warning("Failed to clear stripe webhook %s: %s", event_id, exc)


def record_usage(user_id: str, action: str, tokens_used: int = 0) -> None:
    """Record a usage event. Failures are logged at ERROR level (not raised)
    because record_usage is normally called AFTER a paid LLM response has
    already been generated; raising here would 500 the endpoint and prompt
    the user to retry, multiplying the cost we just incurred. The logged
    record (with tokens_used) is the source of truth for postmortem
    reconciliation when the database had a transient hiccup."""
    try:
        with get_conn() as conn:
            _execute(conn, _q("""
                INSERT INTO usage (user_id, action, tokens_used) VALUES (?, ?, ?)
            """), (user_id, action, tokens_used))
    except Exception as exc:
        log.error(
            "USAGE_RECORD_FAILED user=%s action=%s tokens=%s err=%s",
            user_id, action, tokens_used, exc,
            exc_info=True,
        )


def count_usage_today(user_id: str, action: str) -> int:
    with get_conn() as conn:
        row = _fetchone(conn, _q("""
            SELECT COUNT(*) as cnt FROM usage
            WHERE user_id = ? AND action = ?
            AND created_at >= CURRENT_DATE
        """), (user_id, action))
        return row["cnt"] if row else 0


def count_user_uploads(user_id: str) -> int:
    """Count non-deleted upload/topic agents owned by a user."""
    with get_conn() as conn:
        row = _fetchone(conn, _q("""
            SELECT COUNT(*) as cnt FROM agents
            WHERE user_id = ? AND is_deleted = ? AND type IN ('upload', 'topic')
        """), (user_id, False if _USE_PG else 0))
        return row["cnt"] if row else 0


def migrate_messages_to_sessions() -> int:
    """One-time migration: copy messages rows into session_messages via book sessions.

    Groups messages by (agent_id, user_id), creates a book session for each group,
    then copies messages into session_messages preserving created_at order.
    Returns the number of messages migrated. Skips if already migrated.
    """
    with get_conn() as conn:
        groups = _fetchall(conn, _q(
            "SELECT DISTINCT agent_id, user_id FROM messages WHERE user_id IS NOT NULL"
        ))
        if not groups:
            return 0

        migrated = 0
        for g in groups:
            agent_id, user_id = g["agent_id"], g["user_id"]
            existing = _fetchone(conn, _q(
                "SELECT id FROM chat_sessions WHERE session_type = 'book' AND mind_id = ? AND user_id = ?"
            ), (agent_id, user_id))
            if existing:
                continue

            session_id = str(uuid.uuid4())
            now = _utcnow()
            agent = _fetchone(conn, _q("SELECT name FROM agents WHERE id = ?"), (agent_id,))
            title = agent["name"] if agent else "Book Chat"
            _execute(conn, _q(
                "INSERT INTO chat_sessions (id, user_id, title, session_type, mind_id, meta_json, updated_at, created_at) VALUES (?, ?, ?, 'book', ?, ?, ?, ?)"
            ), (session_id, user_id, title, agent_id, json.dumps({"agent_id": agent_id}), now, now))

            msgs = _fetchall(conn, _q(
                "SELECT id, role, content, created_at FROM messages WHERE agent_id = ? AND user_id = ? ORDER BY created_at ASC"
            ), (agent_id, user_id))
            for m in msgs:
                _execute(conn, _q(
                    "INSERT INTO session_messages (id, session_id, role, content, meta_json, created_at) VALUES (?, ?, ?, ?, ?, ?)"
                ), (str(uuid.uuid4()), session_id, m["role"], m["content"], json.dumps({}), m["created_at"]))
                migrated += 1

        return migrated


# ─── AI Books CRUD ───

def count_ai_books_this_month(user_id: str) -> int:
    """Count AI books created by a user in the current calendar month."""
    if _USE_PG:
        sql = ("SELECT COUNT(*) as cnt FROM ai_books "
               "WHERE user_id = %s AND created_at::timestamptz >= date_trunc('month', CURRENT_TIMESTAMP)")
    else:
        sql = ("SELECT COUNT(*) as cnt FROM ai_books "
               "WHERE user_id = ? AND created_at >= date('now', 'start of month')")
    with get_conn() as conn:
        row = _fetchone(conn, sql, (user_id,))
        return row["cnt"] if row else 0


def create_ai_book(
    agent_id: str, user_id: str, title: str, description: str,
    outline: dict[str, Any], preferences: dict[str, Any],
) -> str:
    book_id = str(uuid.uuid4())
    now = _utcnow()
    chapters_total = len(outline.get("chapters", []))
    with get_conn() as conn:
        _execute(conn, _q(
            "INSERT INTO ai_books (id, agent_id, user_id, status, title, description, "
            "outline_json, content_json, preferences_json, chapters_total, chapters_written, "
            "created_at, updated_at) VALUES (?, ?, ?, 'outlining', ?, ?, ?, '{}', ?, ?, 0, ?, ?)"
        ), (book_id, agent_id, user_id, title, description,
            json.dumps(outline, ensure_ascii=False),
            json.dumps(preferences, ensure_ascii=False),
            chapters_total, now, now))
    return book_id


def get_ai_book(book_id: str) -> dict[str, Any] | None:
    with get_conn() as conn:
        row = _fetchone(conn, _q("SELECT * FROM ai_books WHERE id = ?"), (book_id,))
        if not row:
            return None
        return _row_to_ai_book(row)


def get_ai_book_status(book_id: str) -> dict[str, Any] | None:
    """Lightweight fetch — status/progress only, no content_json."""
    with get_conn() as conn:
        row = _fetchone(conn, _q(
            "SELECT id, agent_id, user_id, status, title, outline_json, "
            "chapters_total, chapters_written, updated_at FROM ai_books WHERE id = ?"
        ), (book_id,))
        if not row:
            return None
        result = dict(row)
        result["outline"] = json.loads(result.pop("outline_json", None) or "{}")
        return result


def get_ai_book_by_agent(agent_id: str) -> dict[str, Any] | None:
    with get_conn() as conn:
        row = _fetchone(conn, _q("SELECT * FROM ai_books WHERE agent_id = ?"), (agent_id,))
        if not row:
            return None
        return _row_to_ai_book(row)


def list_ai_books(user_id: str) -> list[dict[str, Any]]:
    with get_conn() as conn:
        rows = _fetchall(conn, _q(
            "SELECT * FROM ai_books WHERE user_id = ? ORDER BY updated_at DESC"
        ), (user_id,))
        return [_row_to_ai_book(r) for r in rows]


def update_ai_book_outline(book_id: str, outline: dict[str, Any]) -> None:
    now = _utcnow()
    chapters_total = len(outline.get("chapters", []))
    with get_conn() as conn:
        _execute(conn, _q(
            "UPDATE ai_books SET outline_json = ?, chapters_total = ?, "
            "title = ?, updated_at = ? WHERE id = ?"
        ), (json.dumps(outline, ensure_ascii=False), chapters_total,
            outline.get("title", "Untitled"), now, book_id))


def update_ai_book_status(book_id: str, status: str) -> None:
    now = _utcnow()
    with get_conn() as conn:
        _execute(conn, _q(
            "UPDATE ai_books SET status = ?, updated_at = ? WHERE id = ?"
        ), (status, now, book_id))
        # Sync agent status when book completes, fails, or is cancelled
        if status in ("completed", "failed", "cancelled"):
            row = _fetchone(conn, _q("SELECT agent_id, chapters_written FROM ai_books WHERE id = ?"), (book_id,))
            if row:
                if status == "completed":
                    agent_status = "ready"
                elif status in ("cancelled", "failed"):
                    agent_status = "ready" if row["chapters_written"] > 0 else "error"
                _execute(conn, _q("UPDATE agents SET status = ? WHERE id = ?"),
                         (agent_status, row["agent_id"]))


def update_ai_book_chapter(book_id: str, chapter_num: int, chapter_data: dict[str, Any]) -> None:
    now = _utcnow()
    with get_conn() as conn:
        row = _fetchone(conn, _q("SELECT content_json, chapters_written FROM ai_books WHERE id = ?"), (book_id,))
        if not row:
            return
        content = json.loads(row["content_json"] or "{}")
        content[str(chapter_num)] = chapter_data
        written = row["chapters_written"] + 1
        _execute(conn, _q(
            "UPDATE ai_books SET content_json = ?, chapters_written = ?, updated_at = ? WHERE id = ?"
        ), (json.dumps(content, ensure_ascii=False), written, now, book_id))


def _row_to_ai_book(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": row["id"],
        "agent_id": row["agent_id"],
        "user_id": row["user_id"],
        "status": row["status"],
        "title": row["title"],
        "description": row["description"],
        "outline": json.loads(row["outline_json"] or "{}"),
        "content": json.loads(row["content_json"] or "{}"),
        "preferences": json.loads(row["preferences_json"] or "{}"),
        "chapters_total": row["chapters_total"],
        "chapters_written": row["chapters_written"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }
