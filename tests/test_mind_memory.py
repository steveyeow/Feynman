"""Tests for P2-B: Mind Memory Structure (compiled + interaction)."""

from __future__ import annotations

import json
import sqlite3
import uuid
from unittest.mock import patch, MagicMock

import pytest


class TestUpsertCompiledMemory:
    """Test compiled memory upsert logic with real SQLite."""

    @pytest.fixture
    def db(self, tmp_path):
        db_path = tmp_path / "test.db"
        conn = sqlite3.connect(db_path)
        conn.row_factory = sqlite3.Row
        conn.execute("""
            CREATE TABLE mind_memories (
                id TEXT PRIMARY KEY,
                mind_id TEXT NOT NULL,
                user_id TEXT,
                summary TEXT NOT NULL,
                topic TEXT,
                memory_type TEXT NOT NULL DEFAULT 'interaction',
                created_at TEXT NOT NULL
            )
        """)
        conn.commit()
        yield conn, db_path
        conn.close()

    def test_creates_compiled_memory(self, db):
        conn, db_path = db
        mind_id = str(uuid.uuid4())
        user_id = "user1"

        with patch("app.core.db.DB_PATH", db_path), \
             patch("app.core.db._USE_PG", False):
            from app.core.db import upsert_compiled_memory
            upsert_compiled_memory(mind_id, user_id, "User is interested in philosophy.")

        row = conn.execute(
            "SELECT * FROM mind_memories WHERE mind_id = ? AND user_id = ? AND memory_type = 'compiled'",
            (mind_id, user_id),
        ).fetchone()
        assert row is not None
        assert "philosophy" in row["summary"]

    def test_updates_existing_compiled_memory(self, db):
        conn, db_path = db
        mind_id = str(uuid.uuid4())
        user_id = "user1"
        mem_id = str(uuid.uuid4())

        conn.execute(
            "INSERT INTO mind_memories VALUES (?, ?, ?, ?, ?, 'compiled', '2025-01-01')",
            (mem_id, mind_id, user_id, "Old understanding", "user_profile"),
        )
        conn.commit()

        with patch("app.core.db.DB_PATH", db_path), \
             patch("app.core.db._USE_PG", False):
            from app.core.db import upsert_compiled_memory
            upsert_compiled_memory(mind_id, user_id, "New understanding of user.")

        rows = conn.execute(
            "SELECT * FROM mind_memories WHERE mind_id = ? AND user_id = ? AND memory_type = 'compiled'",
            (mind_id, user_id),
        ).fetchall()
        assert len(rows) == 1
        assert "New understanding" in rows[0]["summary"]


class TestExtractAndSaveMemoryCompiled:
    """Test that extract_and_save_memory triggers compiled memory synthesis."""

    def test_calls_update_compiled_when_user_id_present(self):
        mock_result = MagicMock()
        mock_result.content = json.dumps({"summary": "Discussed free will.", "topic": "free will"})

        with patch("app.core.minds.chat_with_fallback", return_value=(mock_result, MagicMock())), \
             patch("app.core.minds.add_mind_memory"), \
             patch("app.core.minds._update_compiled_memory") as mock_compiled:
            from app.core.minds import extract_and_save_memory
            extract_and_save_memory("mind1", "Is free will real?", "Great question...", user_id="user1")

        mock_compiled.assert_called_once_with("mind1", "user1")

    def test_skips_compiled_when_no_user_id(self):
        mock_result = MagicMock()
        mock_result.content = json.dumps({"summary": "Discussed physics.", "topic": "physics"})

        with patch("app.core.minds.chat_with_fallback", return_value=(mock_result, MagicMock())), \
             patch("app.core.minds.add_mind_memory"), \
             patch("app.core.minds._update_compiled_memory") as mock_compiled:
            from app.core.minds import extract_and_save_memory
            extract_and_save_memory("mind1", "What is gravity?", "Gravity is...", user_id=None)

        mock_compiled.assert_not_called()


class TestUpdateCompiledMemory:
    """Test _update_compiled_memory logic."""

    def test_skips_when_fewer_than_two_interactions(self):
        memories = [{"summary": "One interaction", "topic": "test", "user_id": "u1", "created_at": "2025-01-01"}]

        with patch("app.core.minds.list_mind_memories", return_value=memories), \
             patch("app.core.minds.chat_with_fallback") as mock_chat, \
             patch("app.core.minds.upsert_compiled_memory") as mock_upsert:
            from app.core.minds import _update_compiled_memory
            _update_compiled_memory("mind1", "u1")

        mock_chat.assert_not_called()
        mock_upsert.assert_not_called()

    def test_synthesizes_when_enough_interactions(self):
        memories = [
            {"summary": "Discussed epistemology", "topic": "epistemology", "user_id": "u1", "created_at": "2025-01-01"},
            {"summary": "Asked about consciousness", "topic": "consciousness", "user_id": "u1", "created_at": "2025-01-02"},
            {"summary": "Explored free will", "topic": "free will", "user_id": "u1", "created_at": "2025-01-03"},
        ]

        mock_result = MagicMock()
        mock_result.content = "User is deeply interested in philosophy of mind, particularly consciousness and free will."

        with patch("app.core.minds.list_mind_memories", return_value=memories), \
             patch("app.core.minds.chat_with_fallback", return_value=(mock_result, MagicMock())), \
             patch("app.core.minds.upsert_compiled_memory") as mock_upsert:
            from app.core.minds import _update_compiled_memory
            _update_compiled_memory("mind1", "u1")

        mock_upsert.assert_called_once()
        args = mock_upsert.call_args[0]
        assert args[0] == "mind1"
        assert args[1] == "u1"
        assert "philosophy" in args[2].lower() or "consciousness" in args[2].lower() or len(args[2]) > 10
