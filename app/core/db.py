from __future__ import annotations

import json
import logging
import os
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

            # Migration: add embedding columns to minds table
            for col, col_type in [("embedding", "BLOB"), ("embedding_dim", "INTEGER"), ("embedding_norm", "REAL")]:
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

            # Migration: add memory_type to mind_memories
            try:
                _execute(conn, "ALTER TABLE mind_memories ADD COLUMN memory_type TEXT NOT NULL DEFAULT 'interaction'")
            except Exception:
                pass

            # Migration: add embedding columns to minds table
            for col, col_type in [("embedding", "BYTEA"), ("embedding_dim", "INTEGER"), ("embedding_norm", "DOUBLE PRECISION")]:
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


def list_agents() -> list[dict[str, Any]]:
    with get_conn() as conn:
        rows = _fetchall(conn, _q(
            "SELECT * FROM agents WHERE is_deleted = ? ORDER BY created_at DESC"
        ), (False if _USE_PG else 0,))
        return [_row_to_agent(r) for r in rows]


def _row_to_agent(row: dict[str, Any]) -> dict[str, Any]:
    meta_json = row["meta_json"] or "{}"
    return {
        "id": row["id"],
        "name": row["name"],
        "type": row["type"],
        "source": row["source"],
        "status": row["status"],
        "meta": json.loads(meta_json),
        "user_id": row.get("user_id"),
        "is_deleted": bool(row.get("is_deleted", False)),
        "created_at": row["created_at"],
    }


def add_chunks(agent_id: str, chunk_records: Iterable[dict[str, Any]]) -> None:
    with get_conn() as conn:
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
            for rec in chunk_records
        ]
        _executemany(conn, _q(
            "INSERT INTO chunks (id, agent_id, chunk_index, text, vector, dim, norm) VALUES (?, ?, ?, ?, ?, ?, ?)"
        ), params_list)


def get_chunks(agent_id: str) -> list[dict[str, Any]]:
    with get_conn() as conn:
        return _fetchall(conn, _q(
            "SELECT id, chunk_index, text, vector, dim, norm FROM chunks WHERE agent_id = ? ORDER BY chunk_index ASC"
        ), (agent_id,))


def get_chunks_text_only(agent_id: str) -> list[dict[str, Any]]:
    """Lightweight variant that skips vector/dim/norm — for the reader."""
    with get_conn() as conn:
        return _fetchall(conn, _q(
            "SELECT id, chunk_index, text FROM chunks WHERE agent_id = ? ORDER BY chunk_index ASC"
        ), (agent_id,))


def get_chunks_batch(agent_ids: list[str]) -> list[dict[str, Any]]:
    """Fetch chunks for multiple agents in a single query."""
    if not agent_ids:
        return []
    placeholders = ",".join(["?"] * len(agent_ids))
    with get_conn() as conn:
        return _fetchall(conn, _q(
            f"SELECT id, agent_id, chunk_index, text, vector, dim, norm FROM chunks WHERE agent_id IN ({placeholders}) ORDER BY agent_id, chunk_index ASC"
        ), tuple(agent_ids))


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


def create_catalog_agent(title: str, author: str = "", isbn: str | None = None,
                         category: str = "", description: str = "") -> str:
    """Create a new catalog agent for a dynamically discovered book. Returns agent_id."""
    existing = find_agent_by_name(title)
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


def list_minds() -> list[dict[str, Any]]:
    with get_conn() as conn:
        rows = _fetchall(conn, (
            "SELECT id, name, era, domain, bio_summary, persona, thinking_style, "
            "typical_phrases, works, avatar_seed, version, chat_count, created_at "
            "FROM minds ORDER BY chat_count DESC, created_at ASC"
        ))
        return [_row_to_mind(r) for r in rows]


def _row_to_mind(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": row["id"],
        "name": row["name"],
        "era": row["era"] or "",
        "domain": row["domain"] or "",
        "bio_summary": row["bio_summary"] or "",
        "persona": row["persona"],
        "thinking_style": row["thinking_style"] or "",
        "typical_phrases": json.loads(row["typical_phrases"] or "[]"),
        "works": json.loads(row["works"] or "[]"),
        "avatar_seed": row["avatar_seed"] or "",
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


def record_usage(user_id: str, action: str, tokens_used: int = 0) -> None:
    try:
        with get_conn() as conn:
            _execute(conn, _q("""
                INSERT INTO usage (user_id, action, tokens_used) VALUES (?, ?, ?)
            """), (user_id, action, tokens_used))
    except Exception as exc:
        log.warning("Failed to record usage for user=%s action=%s: %s", user_id, action, exc)


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
