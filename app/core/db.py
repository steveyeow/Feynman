from __future__ import annotations

import json
import sqlite3
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

from .config import DB_PATH, DATA_DIR


def _utcnow() -> str:
    return datetime.now(timezone.utc).isoformat()


def _ensure_dirs() -> None:
    Path(DATA_DIR).mkdir(parents=True, exist_ok=True)


def get_conn() -> sqlite3.Connection:
    _ensure_dirs()
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db() -> None:
    with get_conn() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS agents (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                type TEXT NOT NULL,
                source TEXT,
                status TEXT NOT NULL,
                meta_json TEXT,
                created_at TEXT NOT NULL
            )
            """
        )
        conn.execute(
            """
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
            """
        )
        conn.execute("CREATE INDEX IF NOT EXISTS idx_chunks_agent_id ON chunks(agent_id)")
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS messages (
                id TEXT PRIMARY KEY,
                agent_id TEXT NOT NULL,
                role TEXT NOT NULL,
                content TEXT NOT NULL,
                created_at TEXT NOT NULL,
                FOREIGN KEY(agent_id) REFERENCES agents(id)
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS questions (
                id TEXT PRIMARY KEY,
                agent_id TEXT NOT NULL,
                text TEXT NOT NULL,
                created_at TEXT NOT NULL,
                FOREIGN KEY(agent_id) REFERENCES agents(id)
            )
            """
        )
        conn.execute("CREATE INDEX IF NOT EXISTS idx_questions_agent_id ON questions(agent_id)")
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS votes (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                count INTEGER NOT NULL DEFAULT 1,
                created_at TEXT NOT NULL
            )
            """
        )


        # ─── Minds tables ───
        conn.execute(
            """
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
            """
        )
        conn.execute("CREATE INDEX IF NOT EXISTS idx_minds_name ON minds(LOWER(name))")
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS mind_works (
                mind_id TEXT NOT NULL,
                agent_id TEXT NOT NULL,
                PRIMARY KEY (mind_id, agent_id),
                FOREIGN KEY (mind_id) REFERENCES minds(id),
                FOREIGN KEY (agent_id) REFERENCES agents(id)
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS mind_memories (
                id TEXT PRIMARY KEY,
                mind_id TEXT NOT NULL,
                user_id TEXT,
                summary TEXT NOT NULL,
                topic TEXT,
                created_at TEXT NOT NULL,
                FOREIGN KEY (mind_id) REFERENCES minds(id)
            )
            """
        )
        conn.execute("CREATE INDEX IF NOT EXISTS idx_mind_memories_mind ON mind_memories(mind_id)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_mind_memories_user ON mind_memories(mind_id, user_id)")


def create_agent(name: str, agent_type: str, source: str | None, meta: dict[str, Any]) -> str:
    agent_id = str(uuid.uuid4())
    with get_conn() as conn:
        conn.execute(
            "INSERT INTO agents (id, name, type, source, status, meta_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (agent_id, name, agent_type, source, "indexing", json.dumps(meta), _utcnow()),
        )
    return agent_id


def update_agent_status(agent_id: str, status: str, meta: dict[str, Any] | None = None) -> None:
    with get_conn() as conn:
        if meta is None:
            conn.execute("UPDATE agents SET status = ? WHERE id = ?", (status, agent_id))
        else:
            conn.execute(
                "UPDATE agents SET status = ?, meta_json = ? WHERE id = ?",
                (status, json.dumps(meta), agent_id),
            )


def get_agent(agent_id: str) -> dict[str, Any] | None:
    with get_conn() as conn:
        row = conn.execute("SELECT * FROM agents WHERE id = ?", (agent_id,)).fetchone()
        if not row:
            return None
        return _row_to_agent(row)


def list_agents() -> list[dict[str, Any]]:
    with get_conn() as conn:
        rows = conn.execute("SELECT * FROM agents ORDER BY created_at DESC").fetchall()
        return [_row_to_agent(r) for r in rows]


def _row_to_agent(row: sqlite3.Row) -> dict[str, Any]:
    meta_json = row["meta_json"] or "{}"
    return {
        "id": row["id"],
        "name": row["name"],
        "type": row["type"],
        "source": row["source"],
        "status": row["status"],
        "meta": json.loads(meta_json),
        "created_at": row["created_at"],
    }


def add_chunks(agent_id: str, chunk_records: Iterable[dict[str, Any]]) -> None:
    with get_conn() as conn:
        conn.executemany(
            """
            INSERT INTO chunks (id, agent_id, chunk_index, text, vector, dim, norm)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            [
                (
                    rec["id"],
                    agent_id,
                    rec["chunk_index"],
                    rec["text"],
                    rec["vector"],
                    rec["dim"],
                    rec["norm"],
                )
                for rec in chunk_records
            ],
        )


def get_chunks(agent_id: str) -> list[sqlite3.Row]:
    with get_conn() as conn:
        return conn.execute(
            "SELECT id, chunk_index, text, vector, dim, norm FROM chunks WHERE agent_id = ? ORDER BY chunk_index ASC",
            (agent_id,),
        ).fetchall()


def add_message(agent_id: str, role: str, content: str) -> None:
    with get_conn() as conn:
        conn.execute(
            "INSERT INTO messages (id, agent_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)",
            (str(uuid.uuid4()), agent_id, role, content, _utcnow()),
        )


def list_messages(agent_id: str, limit: int = 50) -> list[dict[str, Any]]:
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT role, content, created_at FROM messages WHERE agent_id = ? ORDER BY created_at DESC LIMIT ?",
            (agent_id, limit),
        ).fetchall()
        return [dict(r) for r in reversed(rows)]


# ─── Questions CRUD ───

def add_questions(agent_id: str, questions: list[str]) -> None:
    with get_conn() as conn:
        conn.executemany(
            "INSERT INTO questions (id, agent_id, text, created_at) VALUES (?, ?, ?, ?)",
            [(str(uuid.uuid4()), agent_id, q, _utcnow()) for q in questions],
        )


def list_questions(agent_id: str) -> list[str]:
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT text FROM questions WHERE agent_id = ? ORDER BY created_at ASC",
            (agent_id,),
        ).fetchall()
        return [r["text"] for r in rows]


# ─── Votes CRUD ───

def create_vote(title: str) -> dict[str, Any]:
    with get_conn() as conn:
        # Check if title already exists (case-insensitive)
        existing = conn.execute(
            "SELECT id, title, count, created_at FROM votes WHERE LOWER(title) = LOWER(?)",
            (title,),
        ).fetchone()
        if existing:
            conn.execute("UPDATE votes SET count = count + 1 WHERE id = ?", (existing["id"],))
            return {"id": existing["id"], "title": existing["title"], "count": existing["count"] + 1}
        vote_id = str(uuid.uuid4())
        conn.execute(
            "INSERT INTO votes (id, title, count, created_at) VALUES (?, ?, 1, ?)",
            (vote_id, title, _utcnow()),
        )
        return {"id": vote_id, "title": title, "count": 1}


def upvote(vote_id: str) -> dict[str, Any] | None:
    with get_conn() as conn:
        row = conn.execute("SELECT id, title, count FROM votes WHERE id = ?", (vote_id,)).fetchone()
        if not row:
            return None
        conn.execute("UPDATE votes SET count = count + 1 WHERE id = ?", (vote_id,))
        return {"id": row["id"], "title": row["title"], "count": row["count"] + 1}


def delete_agent(agent_id: str) -> bool:
    with get_conn() as conn:
        conn.execute("DELETE FROM chunks WHERE agent_id = ?", (agent_id,))
        conn.execute("DELETE FROM messages WHERE agent_id = ?", (agent_id,))
        conn.execute("DELETE FROM questions WHERE agent_id = ?", (agent_id,))
        cur = conn.execute("DELETE FROM agents WHERE id = ?", (agent_id,))
        return cur.rowcount > 0


def list_votes() -> list[dict[str, Any]]:
    with get_conn() as conn:
        rows = conn.execute("SELECT id, title, count, created_at FROM votes ORDER BY count DESC").fetchall()
        return [dict(r) for r in rows]


# ─── Catalog agent helpers ───

def ensure_catalog_agents(catalog: list[dict[str, Any]]) -> None:
    """Idempotently seed catalog books as agents. Skips titles that already exist."""
    with get_conn() as conn:
        existing = {
            row["name"].lower()
            for row in conn.execute("SELECT name FROM agents").fetchall()
        }
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
            conn.execute(
                "INSERT INTO agents (id, name, type, source, status, meta_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
                (agent_id, book["title"], "catalog", book.get("author", ""), "catalog", json.dumps(meta), _utcnow()),
            )


def update_agent_meta(agent_id: str, updates: dict[str, Any]) -> None:
    """Merge updates into agent's meta_json without overwriting other keys."""
    with get_conn() as conn:
        row = conn.execute("SELECT meta_json FROM agents WHERE id = ?", (agent_id,)).fetchone()
        if not row:
            return
        meta = json.loads(row["meta_json"] or "{}")
        meta.update(updates)
        conn.execute("UPDATE agents SET meta_json = ? WHERE id = ?", (json.dumps(meta), agent_id))


def find_agent_by_name(name: str) -> dict[str, Any] | None:
    """Find an agent by name (case-insensitive)."""
    with get_conn() as conn:
        row = conn.execute(
            "SELECT * FROM agents WHERE LOWER(name) = LOWER(?)", (name,)
        ).fetchone()
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
        conn.execute(
            "INSERT INTO agents (id, name, type, source, status, meta_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (agent_id, title, "catalog", author, "catalog", json.dumps(meta), _utcnow()),
        )
    return agent_id


# ─── Minds CRUD ───

def create_mind(data: dict[str, Any]) -> str:
    """Insert a new mind agent. Returns mind_id."""
    mind_id = str(uuid.uuid4())
    with get_conn() as conn:
        conn.execute(
            """INSERT INTO minds
               (id, name, era, domain, bio_summary, persona, thinking_style,
                typical_phrases, works, avatar_seed, version, chat_count, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?)""",
            (
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
            ),
        )
    return mind_id


def get_mind(mind_id: str) -> dict[str, Any] | None:
    with get_conn() as conn:
        row = conn.execute("SELECT * FROM minds WHERE id = ?", (mind_id,)).fetchone()
        if not row:
            return None
        return _row_to_mind(row)


def find_mind_by_name(name: str) -> dict[str, Any] | None:
    with get_conn() as conn:
        row = conn.execute(
            "SELECT * FROM minds WHERE LOWER(name) = LOWER(?)", (name,)
        ).fetchone()
        if not row:
            return None
        return _row_to_mind(row)


def list_minds() -> list[dict[str, Any]]:
    with get_conn() as conn:
        rows = conn.execute("SELECT * FROM minds ORDER BY chat_count DESC, created_at ASC").fetchall()
        return [_row_to_mind(r) for r in rows]


def _row_to_mind(row: sqlite3.Row) -> dict[str, Any]:
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


def increment_mind_chat_count(mind_id: str) -> None:
    with get_conn() as conn:
        conn.execute("UPDATE minds SET chat_count = chat_count + 1 WHERE id = ?", (mind_id,))


def link_mind_work(mind_id: str, agent_id: str) -> None:
    with get_conn() as conn:
        conn.execute(
            "INSERT OR IGNORE INTO mind_works (mind_id, agent_id) VALUES (?, ?)",
            (mind_id, agent_id),
        )


def get_mind_work_ids(mind_id: str) -> list[str]:
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT agent_id FROM mind_works WHERE mind_id = ?", (mind_id,)
        ).fetchall()
        return [r["agent_id"] for r in rows]


# ─── Mind memories ───

def add_mind_memory(mind_id: str, summary: str, topic: str = "", user_id: str | None = None) -> None:
    with get_conn() as conn:
        conn.execute(
            "INSERT INTO mind_memories (id, mind_id, user_id, summary, topic, created_at) VALUES (?, ?, ?, ?, ?, ?)",
            (str(uuid.uuid4()), mind_id, user_id, summary, topic, _utcnow()),
        )


def list_mind_memories(mind_id: str, user_id: str | None = None, limit: int = 20) -> list[dict[str, Any]]:
    with get_conn() as conn:
        if user_id:
            rows = conn.execute(
                """SELECT summary, topic, created_at FROM mind_memories
                   WHERE mind_id = ? AND (user_id IS NULL OR user_id = ?)
                   ORDER BY created_at DESC LIMIT ?""",
                (mind_id, user_id, limit),
            ).fetchall()
        else:
            rows = conn.execute(
                """SELECT summary, topic, created_at FROM mind_memories
                   WHERE mind_id = ? AND user_id IS NULL
                   ORDER BY created_at DESC LIMIT ?""",
                (mind_id, limit),
            ).fetchall()
        return [dict(r) for r in rows]

