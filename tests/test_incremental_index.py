"""Tests for P1-B: Incremental indexing with content hash."""

from __future__ import annotations

from unittest.mock import patch, MagicMock

import pytest

from app.core.indexer import _content_hash, index_text


class TestContentHash:
    def test_deterministic(self):
        assert _content_hash("hello") == _content_hash("hello")

    def test_different_for_different_input(self):
        assert _content_hash("hello") != _content_hash("world")

    def test_sha256_format(self):
        h = _content_hash("test")
        assert len(h) == 64
        assert all(c in "0123456789abcdef" for c in h)


class TestIndexTextSkip:
    def test_skips_when_hash_matches(self):
        text = "Some book content that has already been indexed."
        h = _content_hash(text)
        existing_agent = {
            "id": "agent1",
            "meta": {"content_hash": h, "chunk_count": 5},
            "status": "ready",
        }

        with patch("app.core.indexer.get_agent", return_value=existing_agent):
            result = index_text("agent1", text)

        assert result["skipped"] is True
        assert result["reason"] == "content unchanged"

    def test_indexes_when_hash_differs(self):
        existing_agent = {
            "id": "agent1",
            "meta": {"content_hash": "oldhash123"},
            "status": "ready",
        }

        mock_embedder = MagicMock()
        mock_embedder.name = "test"
        mock_embedder.embed_model = "test-model"
        mock_embedder.embed_texts.return_value = [[0.1, 0.2, 0.3]]

        with patch("app.core.indexer.get_agent", return_value=existing_agent), \
             patch("app.core.indexer.pick_provider", return_value=mock_embedder), \
             patch("app.core.indexer.add_chunks"), \
             patch("app.core.indexer.generate_questions", return_value=[]), \
             patch("app.core.indexer.update_agent_status"), \
             patch("app.core.indexer.chunk_text", return_value=["chunk1"]):
            result = index_text("agent1", "new content")

        assert "skipped" not in result
        assert "content_hash" in result

    def test_force_reindex_ignores_hash(self):
        text = "Same content."
        h = _content_hash(text)
        existing_agent = {"id": "agent1", "meta": {"content_hash": h}, "status": "ready"}

        mock_embedder = MagicMock()
        mock_embedder.name = "test"
        mock_embedder.embed_model = "test-model"
        mock_embedder.embed_texts.return_value = [[0.1, 0.2, 0.3]]

        with patch("app.core.indexer.get_agent", return_value=existing_agent), \
             patch("app.core.indexer.pick_provider", return_value=mock_embedder), \
             patch("app.core.indexer.add_chunks"), \
             patch("app.core.indexer.generate_questions", return_value=[]), \
             patch("app.core.indexer.update_agent_status"), \
             patch("app.core.indexer.chunk_text", return_value=["chunk1"]):
            result = index_text("agent1", text, force=True)

        assert "skipped" not in result
        assert result["content_hash"] == h

    def test_indexes_new_agent_without_hash(self):
        existing_agent = {"id": "agent1", "meta": {}, "status": "indexing"}

        mock_embedder = MagicMock()
        mock_embedder.name = "test"
        mock_embedder.embed_model = "test-model"
        mock_embedder.embed_texts.return_value = [[0.1, 0.2, 0.3]]

        with patch("app.core.indexer.get_agent", return_value=existing_agent), \
             patch("app.core.indexer.pick_provider", return_value=mock_embedder), \
             patch("app.core.indexer.add_chunks"), \
             patch("app.core.indexer.generate_questions", return_value=[]), \
             patch("app.core.indexer.update_agent_status"), \
             patch("app.core.indexer.chunk_text", return_value=["chunk1"]):
            result = index_text("agent1", "new book text")

        assert "skipped" not in result
        assert "content_hash" in result
