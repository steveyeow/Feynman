"""Tests for the pgvector ANN retrieval path added to reduce Supabase egress.

These tests run on SQLite (no pgvector). They verify:
- The pgvector module-level flag stays False on SQLite, so retrieve() takes
  the legacy in-Python path and behaviour is unchanged.
- `_halfvec_literal` formats float arrays in the form pgvector accepts.
- `ann_topk` / `ann_topk_batch` refuse to run when pgvector isn't available
  (callers must catch this and fall back).
- `_agent_pgvector_ready` returns False when the flag is unset, even if PG
  were enabled — guards against routing un-backfilled agents to ANN.
- `retrieve()` integration: with the flag off, results match the legacy
  scoring exactly.
"""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import numpy as np
import pytest

from app.core import db as db_mod
from app.core.db import _halfvec_literal, ann_topk, ann_topk_batch


class TestHalfvecLiteral:
    def test_basic_format(self):
        assert _halfvec_literal([1.0, 2.0, 3.0]) == "[1,2,3]"

    def test_handles_floats(self):
        out = _halfvec_literal([0.123456789, -1.5])
        # Six significant figures
        assert out.startswith("[")
        assert out.endswith("]")
        parts = out[1:-1].split(",")
        assert len(parts) == 2
        assert float(parts[0]) == pytest.approx(0.123457, abs=1e-5)
        assert float(parts[1]) == -1.5

    def test_empty(self):
        assert _halfvec_literal([]) == "[]"

    def test_accepts_numpy_array(self):
        arr = np.array([1.0, 2.0, 3.0], dtype=np.float32)
        out = _halfvec_literal(arr)
        assert out == "[1,2,3]"


class TestANNGuards:
    """ann_topk/ann_topk_batch must refuse when pgvector isn't available so
    callers fall back to the legacy path rather than blow up."""

    def test_ann_topk_raises_without_pgvector(self):
        # _USE_PG is False on SQLite test runs by default.
        with pytest.raises(RuntimeError, match="pgvector"):
            ann_topk("agent-1", [0.1, 0.2, 0.3], 5)

    def test_ann_topk_batch_raises_without_pgvector(self):
        with pytest.raises(RuntimeError, match="pgvector"):
            ann_topk_batch(["agent-1"], [0.1, 0.2, 0.3], 5)

    def test_ann_topk_batch_empty_ids_returns_empty_without_check(self):
        """Empty agent list is a no-op even without pgvector — matches the
        get_chunks_batch behaviour. Guarded by patching to simulate PG."""
        with patch.object(db_mod, "_USE_PG", True), \
             patch.object(db_mod, "_HAS_PGVECTOR", True):
            assert ann_topk_batch([], [0.1], 5) == []


class TestAgentPgvectorReady:
    """The per-agent ready flag controls whether retrieve() takes the ANN
    path. Default must be False — un-backfilled agents must keep working."""

    def test_returns_false_on_sqlite(self):
        from app.core.rag import _agent_pgvector_ready
        # SQLite test environment — pgvector unavailable.
        assert _agent_pgvector_ready("any-id") is False

    def test_returns_false_when_meta_flag_unset(self):
        from app.core.rag import _agent_pgvector_ready
        with patch.object(db_mod, "_USE_PG", True), \
             patch.object(db_mod, "_HAS_PGVECTOR", True), \
             patch("app.core.rag.get_agent",
                   return_value={"id": "a", "meta": {}}):
            assert _agent_pgvector_ready("a") is False

    def test_returns_true_only_when_all_three_conditions_met(self):
        from app.core.rag import _agent_pgvector_ready
        with patch.object(db_mod, "_USE_PG", True), \
             patch.object(db_mod, "_HAS_PGVECTOR", True), \
             patch("app.core.rag.get_agent",
                   return_value={"id": "a", "meta": {"pgvector_ready": True}}):
            assert _agent_pgvector_ready("a") is True

    def test_returns_false_when_get_agent_raises(self):
        from app.core.rag import _agent_pgvector_ready
        with patch.object(db_mod, "_USE_PG", True), \
             patch.object(db_mod, "_HAS_PGVECTOR", True), \
             patch("app.core.rag.get_agent",
                   side_effect=RuntimeError("db down")):
            assert _agent_pgvector_ready("a") is False


class TestRetrieveLegacyPathUnchanged:
    """retrieve() with pgvector_ready=False must produce identical results to
    the pre-refactor behaviour — pulls all chunks, scores in Python, fuses
    with FTS via RRF."""

    def test_legacy_path_runs_when_flag_off(self):
        from app.core.rag import retrieve

        # Mock embedder returning a known query vector.
        mock_embedder = MagicMock()
        mock_embedder.supports_embeddings.return_value = True
        mock_embedder.name = "test"
        mock_embedder.embed_texts.return_value = [[1.0, 0.0, 0.0]]

        # Two chunks: one matches query direction, one orthogonal.
        match_vec = np.array([1.0, 0.0, 0.0], dtype=np.float32).tobytes()
        orth_vec = np.array([0.0, 1.0, 0.0], dtype=np.float32).tobytes()
        rows = [
            {"id": "c1", "chunk_index": 0, "text": "match", "vector": match_vec, "dim": 3, "norm": 1.0},
            {"id": "c2", "chunk_index": 1, "text": "ortho", "vector": orth_vec, "dim": 3, "norm": 1.0},
        ]

        with patch("app.core.rag.pick_provider", return_value=mock_embedder), \
             patch("app.core.rag.get_chunks", return_value=rows), \
             patch("app.core.rag.keyword_search_chunks", return_value=[]), \
             patch("app.core.rag._agent_pgvector_ready", return_value=False):
            results = retrieve("agent-x", "query", top_k=2)

        # Legacy path scores [1,0,0] vs match=[1,0,0]→1.0 and ortho=[0,1,0]→0.0
        assert results[0]["id"] == "c1"
        assert results[0]["score"] == pytest.approx(1.0, abs=1e-5)
        assert results[1]["id"] == "c2"
        assert results[1]["score"] == pytest.approx(0.0, abs=1e-5)

    def test_pgvec_path_taken_when_flag_on(self):
        """When the agent is pgvector_ready, retrieve() should call ann_topk
        and NOT call get_chunks (the wasteful legacy fetch)."""
        from app.core.rag import retrieve

        mock_embedder = MagicMock()
        mock_embedder.supports_embeddings.return_value = True
        mock_embedder.embed_texts.return_value = [[1.0, 0.0, 0.0]]

        ann_rows = [
            {"id": "c1", "chunk_index": 0, "text": "match", "score": 0.99},
            {"id": "c2", "chunk_index": 1, "text": "ortho", "score": 0.50},
        ]

        with patch("app.core.rag.pick_provider", return_value=mock_embedder), \
             patch("app.core.rag._agent_pgvector_ready", return_value=True), \
             patch("app.core.rag.ann_topk", return_value=ann_rows) as ann_mock, \
             patch("app.core.rag.get_chunks") as legacy_mock, \
             patch("app.core.rag.keyword_search_chunks", return_value=[]):
            results = retrieve("agent-x", "query", top_k=2)

        ann_mock.assert_called_once()
        legacy_mock.assert_not_called()
        assert [r["id"] for r in results] == ["c1", "c2"]

    def test_pgvec_path_falls_back_on_error(self):
        """If ann_topk throws (e.g., halfvec dim mismatch surfaces at runtime),
        retrieve() must transparently fall back to the legacy path."""
        from app.core.rag import retrieve

        mock_embedder = MagicMock()
        mock_embedder.supports_embeddings.return_value = True
        mock_embedder.embed_texts.return_value = [[1.0, 0.0, 0.0]]

        match_vec = np.array([1.0, 0.0, 0.0], dtype=np.float32).tobytes()
        rows = [
            {"id": "c1", "chunk_index": 0, "text": "match", "vector": match_vec, "dim": 3, "norm": 1.0},
        ]

        with patch("app.core.rag.pick_provider", return_value=mock_embedder), \
             patch("app.core.rag._agent_pgvector_ready", return_value=True), \
             patch("app.core.rag.ann_topk", side_effect=RuntimeError("dim mismatch")), \
             patch("app.core.rag.get_chunks", return_value=rows), \
             patch("app.core.rag.keyword_search_chunks", return_value=[]):
            results = retrieve("agent-x", "query", top_k=1)

        # Got results via the legacy path despite ann_topk error.
        assert len(results) == 1
        assert results[0]["id"] == "c1"


class TestIndexerSetsPgvectorReadyFlag:
    """index_text must mark new agents pgvector_ready when conditions hold."""

    def test_flag_false_on_sqlite(self):
        """On SQLite (no pgvector), the flag must be False so retrieve() takes
        the legacy path. Otherwise we'd route ANN queries to a column that
        doesn't exist."""
        from app.core.indexer import index_text

        mock_embedder = MagicMock()
        mock_embedder.name = "test"
        mock_embedder.embed_model = "test-model"
        mock_embedder.embed_texts.return_value = [[1.0, 0.0, 0.0]]

        with patch("app.core.indexer.get_agent", return_value=None), \
             patch("app.core.indexer.pick_provider", return_value=mock_embedder), \
             patch("app.core.indexer.chunk_text", return_value=["chunk-a"]), \
             patch("app.core.indexer.add_chunks"), \
             patch("app.core.indexer.generate_questions", return_value=[]), \
             patch("app.core.indexer.update_agent_status") as mock_status:
            index_text("agent-x", "some text content")

        called_meta = mock_status.call_args[0][2]
        assert called_meta["pgvector_ready"] is False
