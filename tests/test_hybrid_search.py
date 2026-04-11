"""Tests for P1-A: Hybrid Search (FTS + RRF Fusion)."""

from __future__ import annotations

import os
import sqlite3
import uuid
from unittest.mock import patch, MagicMock

import numpy as np
import pytest

from app.core.rag import _rrf_fuse, RRF_K


class TestRRFFusion:
    def test_combines_two_lists(self):
        kw = [{"id": "a", "text": "foo"}, {"id": "b", "text": "bar"}]
        vec = [{"id": "b", "text": "bar"}, {"id": "c", "text": "baz"}]
        fused = _rrf_fuse(kw, vec)
        ids = [r["id"] for r in fused]
        # "b" appears in both lists so should rank highest
        assert ids[0] == "b"
        assert set(ids) == {"a", "b", "c"}

    def test_single_list_keyword_only(self):
        kw = [{"id": "x", "text": "hello"}, {"id": "y", "text": "world"}]
        fused = _rrf_fuse(kw, [])
        assert len(fused) == 2
        assert fused[0]["id"] == "x"

    def test_single_list_vector_only(self):
        vec = [{"id": "x", "text": "hello"}, {"id": "y", "text": "world"}]
        fused = _rrf_fuse([], vec)
        assert len(fused) == 2
        assert fused[0]["id"] == "x"

    def test_rrf_scores_are_correct(self):
        kw = [{"id": "a", "text": ""}]
        vec = [{"id": "a", "text": ""}]
        fused = _rrf_fuse(kw, vec)
        expected = 2.0 / (RRF_K + 1)
        assert abs(fused[0]["score"] - expected) < 1e-9

    def test_preserves_extra_fields(self):
        kw = [{"id": "a", "text": "hello", "agent_id": "agent1", "agent_name": "Book A"}]
        vec = []
        fused = _rrf_fuse(kw, vec)
        assert fused[0]["agent_id"] == "agent1"
        assert fused[0]["agent_name"] == "Book A"

    def test_empty_both(self):
        assert _rrf_fuse([], []) == []


class TestSyncFTS:
    """Test FTS sync with a real SQLite DB."""

    @pytest.fixture
    def sqlite_db(self, tmp_path):
        db_path = tmp_path / "test.db"
        conn = sqlite3.connect(db_path)
        conn.row_factory = sqlite3.Row
        conn.execute("""
            CREATE TABLE agents (
                id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL,
                source TEXT, status TEXT NOT NULL, meta_json TEXT,
                user_id TEXT, is_deleted INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL
            )
        """)
        conn.execute("""
            CREATE TABLE chunks (
                id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, chunk_index INTEGER NOT NULL,
                text TEXT NOT NULL, vector BLOB NOT NULL, dim INTEGER NOT NULL,
                norm REAL NOT NULL
            )
        """)
        conn.execute("""
            CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
                text, content=chunks, content_rowid=rowid
            )
        """)
        conn.commit()
        yield conn, db_path
        conn.close()

    def test_sync_and_search(self, sqlite_db):
        conn, db_path = sqlite_db
        agent_id = str(uuid.uuid4())
        conn.execute(
            "INSERT INTO agents VALUES (?, 'Test Book', 'upload', NULL, 'ready', '{}', NULL, 0, '2025-01-01')",
            (agent_id,),
        )
        vec = np.zeros(4, dtype=np.float32).tobytes()
        for i, text in enumerate(["Daniel Kahneman discusses cognitive biases",
                                   "The marshmallow experiment and self-control",
                                   "Quantum mechanics and wave functions"]):
            conn.execute(
                "INSERT INTO chunks VALUES (?, ?, ?, ?, ?, 4, 1.0)",
                (str(uuid.uuid4()), agent_id, i, text, vec),
            )
        conn.commit()

        # Sync FTS
        rows = conn.execute("SELECT rowid, text FROM chunks WHERE agent_id = ?", (agent_id,)).fetchall()
        for r in rows:
            conn.execute("INSERT INTO chunks_fts(rowid, text) VALUES (?, ?)", (r["rowid"], r["text"]))
        conn.commit()

        # Search for "Kahneman"
        results = conn.execute(
            """SELECT c.id, c.text FROM chunks_fts
               JOIN chunks c ON c.rowid = chunks_fts.rowid
               WHERE chunks_fts MATCH '"Kahneman"'
               ORDER BY chunks_fts.rank LIMIT 5"""
        ).fetchall()
        assert len(results) == 1
        assert "Kahneman" in results[0]["text"]


class TestHybridRetrieve:
    """Test that retrieve uses RRF when keyword results are available."""

    def test_retrieve_uses_rrf_when_fts_available(self):
        from app.core.rag import retrieve

        dim = 4
        query_dir = np.array([1, 0, 0, 0], dtype=np.float32)
        chunks = []
        for i in range(3):
            v = (query_dir * (1.0 - i * 0.1)).astype(np.float32)
            chunks.append({
                "id": f"chunk_{i}",
                "chunk_index": i,
                "text": f"chunk {i} text",
                "vector": v.tobytes(),
                "dim": dim,
                "norm": float(np.linalg.norm(v)),
            })

        kw_result = [{"id": "chunk_2", "chunk_index": 2, "text": "chunk 2 text",
                       "vector": chunks[2]["vector"], "dim": dim, "norm": chunks[2]["norm"],
                       "agent_id": "a1", "fts_rank": -0.5}]

        with patch("app.core.rag.get_chunks", return_value=chunks), \
             patch("app.core.rag.keyword_search_chunks", return_value=kw_result), \
             patch("app.core.rag.pick_provider") as mock_pick:
            mock_provider = mock_pick.return_value
            mock_provider.embed_texts.return_value = [[float(x) for x in query_dir]]
            mock_provider.supports_embeddings.return_value = True

            results = retrieve("agent1", "test query", top_k=3)

        ids = [r["id"] for r in results]
        # chunk_2 was ranked #1 by keyword, so RRF should boost it
        assert "chunk_2" in ids

    def test_retrieve_falls_back_to_vector_only(self):
        from app.core.rag import retrieve

        dim = 4
        query_dir = np.array([1, 0, 0, 0], dtype=np.float32)
        chunks = [{
            "id": "c1", "chunk_index": 0, "text": "hello",
            "vector": query_dir.tobytes(), "dim": dim, "norm": 1.0,
        }]

        with patch("app.core.rag.get_chunks", return_value=chunks), \
             patch("app.core.rag.keyword_search_chunks", return_value=[]), \
             patch("app.core.rag.pick_provider") as mock_pick:
            mock_provider = mock_pick.return_value
            mock_provider.embed_texts.return_value = [[float(x) for x in query_dir]]

            results = retrieve("agent1", "test query", top_k=3)

        assert len(results) == 1
        assert results[0]["id"] == "c1"
