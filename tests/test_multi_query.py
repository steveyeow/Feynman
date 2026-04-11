"""Tests for P2-A: Multi-query expansion."""

from __future__ import annotations

import uuid
from unittest.mock import patch, MagicMock

import numpy as np
import pytest

from app.core.rag import _expand_query, retrieve_cross_book


class TestExpandQuery:
    def test_returns_list_of_strings(self):
        mock_result = MagicMock()
        mock_result.content = "What defines genius?\nHow do great minds think?\nNature of brilliance"

        with patch("app.core.providers.chat_with_fallback", return_value=(mock_result, MagicMock())):
            queries = _expand_query("What makes someone a genius?")

        assert isinstance(queries, list)
        assert len(queries) == 3
        assert all(isinstance(q, str) for q in queries)

    def test_limits_to_three(self):
        mock_result = MagicMock()
        mock_result.content = "q1\nq2\nq3\nq4\nq5"

        with patch("app.core.providers.chat_with_fallback", return_value=(mock_result, MagicMock())):
            queries = _expand_query("test")

        assert len(queries) <= 3

    def test_returns_empty_on_failure(self):
        with patch("app.core.providers.chat_with_fallback", side_effect=Exception("API error")):
            queries = _expand_query("test")

        assert queries == []

    def test_strips_empty_lines(self):
        mock_result = MagicMock()
        mock_result.content = "query one\n\n\nquery two\n"

        with patch("app.core.providers.chat_with_fallback", return_value=(mock_result, MagicMock())):
            queries = _expand_query("test")

        assert len(queries) == 2
        assert all(q.strip() for q in queries)


class TestMultiQueryInRetrieveCrossBook:
    def _make_agent(self, name):
        return {"id": str(uuid.uuid4()), "name": name, "status": "ready",
                "type": "upload", "source": "", "meta": {}, "user_id": None,
                "is_deleted": False, "created_at": "2025-01-01"}

    def test_expansion_disabled_via_flag(self):
        """expand=False should skip query expansion entirely."""
        agents = [self._make_agent(f"Book {i}") for i in range(5)]
        dim = 4
        query_dir = np.array([1, 0, 0, 0], dtype=np.float32)

        chunks = []
        for a in agents:
            v = query_dir * 0.9
            chunks.append({
                "id": str(uuid.uuid4()), "agent_id": a["id"], "chunk_index": 0,
                "text": f"chunk from {a['name']}", "vector": v.astype(np.float32).tobytes(),
                "dim": dim, "norm": float(np.linalg.norm(v)),
            })

        fake_embed = [[float(x) for x in query_dir]]

        with patch("app.core.rag.list_agents", return_value=agents), \
             patch("app.core.rag.get_chunks_batch", return_value=chunks), \
             patch("app.core.rag.keyword_search_chunks", return_value=[]), \
             patch("app.core.rag._expand_query") as mock_expand, \
             patch("app.core.rag.pick_provider") as mock_pick:
            mock_provider = mock_pick.return_value
            mock_provider.embed_texts.return_value = fake_embed
            mock_expand.return_value = []

            retrieve_cross_book("test", top_k=5, expand=False)

        mock_expand.assert_not_called()

    def test_expansion_skipped_when_few_agents(self):
        """Should not expand when there are <= _EXPAND_MIN_AGENTS ready agents."""
        agents = [self._make_agent(f"Book {i}") for i in range(2)]
        dim = 4
        query_dir = np.array([1, 0, 0, 0], dtype=np.float32)

        chunks = [{
            "id": str(uuid.uuid4()), "agent_id": agents[0]["id"], "chunk_index": 0,
            "text": "chunk", "vector": query_dir.tobytes(), "dim": dim, "norm": 1.0,
        }]

        with patch("app.core.rag.list_agents", return_value=agents), \
             patch("app.core.rag.get_chunks_batch", return_value=chunks), \
             patch("app.core.rag.keyword_search_chunks", return_value=[]), \
             patch("app.core.rag._expand_query") as mock_expand, \
             patch("app.core.rag.pick_provider") as mock_pick:
            mock_provider = mock_pick.return_value
            mock_provider.embed_texts.return_value = [[float(x) for x in query_dir]]

            retrieve_cross_book("test", top_k=5, expand=True)

        mock_expand.assert_not_called()

    def test_expansion_called_when_many_agents(self):
        """Should call _expand_query when library has > _EXPAND_MIN_AGENTS agents."""
        agents = [self._make_agent(f"Book {i}") for i in range(5)]
        dim = 4
        query_dir = np.array([1, 0, 0, 0], dtype=np.float32)

        chunks = []
        for a in agents:
            chunks.append({
                "id": str(uuid.uuid4()), "agent_id": a["id"], "chunk_index": 0,
                "text": f"chunk from {a['name']}", "vector": query_dir.tobytes(),
                "dim": dim, "norm": 1.0,
            })

        with patch("app.core.rag.list_agents", return_value=agents), \
             patch("app.core.rag.get_chunks_batch", return_value=chunks), \
             patch("app.core.rag.keyword_search_chunks", return_value=[]), \
             patch("app.core.rag._expand_query", return_value=["alternative query"]) as mock_expand, \
             patch("app.core.rag.pick_provider") as mock_pick:
            mock_provider = mock_pick.return_value
            mock_provider.embed_texts.return_value = [[float(x) for x in query_dir]]

            results = retrieve_cross_book("test", top_k=5, expand=True)

        mock_expand.assert_called_once_with("test")
        assert len(results) <= 5
