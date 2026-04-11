"""Tests for P0-A: cross-book per-agent dedup in retrieve_cross_book."""

from __future__ import annotations

import uuid
from unittest.mock import patch

import numpy as np
import pytest

from app.core.rag import retrieve_cross_book


def _make_agent(name: str, status: str = "ready") -> dict:
    return {"id": str(uuid.uuid4()), "name": name, "status": status, "type": "upload",
            "source": "", "meta": {}, "user_id": None, "is_deleted": False,
            "created_at": "2025-01-01"}


def _make_chunk(agent_id: str, index: int, vec: np.ndarray) -> dict:
    blob = vec.astype(np.float32).tobytes()
    return {
        "id": str(uuid.uuid4()),
        "agent_id": agent_id,
        "chunk_index": index,
        "text": f"chunk {index} for {agent_id[:8]}",
        "vector": blob,
        "dim": len(vec),
        "norm": float(np.linalg.norm(vec)),
    }


@pytest.fixture
def three_agents():
    return [_make_agent("Book A"), _make_agent("Book B"), _make_agent("Book C")]


def test_dedup_returns_chunks_from_multiple_agents(three_agents):
    """Top results should span at least 2 different agents, not all from the same one."""
    a, b, c = three_agents
    dim = 8
    query_dir = np.array([1, 0, 0, 0, 0, 0, 0, 0], dtype=np.float32)

    # Agent A: 5 chunks, all very close to query direction
    chunks = []
    for i in range(5):
        v = query_dir + np.random.default_rng(i).normal(0, 0.01, dim).astype(np.float32)
        chunks.append(_make_chunk(a["id"], i, v))

    # Agent B: 1 chunk, slightly less aligned
    v_b = query_dir * 0.9 + np.array([0, 0.1, 0, 0, 0, 0, 0, 0], dtype=np.float32)
    chunks.append(_make_chunk(b["id"], 0, v_b))

    # Agent C: 1 chunk, slightly less aligned
    v_c = query_dir * 0.85 + np.array([0, 0, 0.15, 0, 0, 0, 0, 0], dtype=np.float32)
    chunks.append(_make_chunk(c["id"], 0, v_c))

    fake_embed = [[float(x) for x in query_dir]]

    with patch("app.core.rag.list_agents", return_value=three_agents), \
         patch("app.core.rag.get_chunks_batch", return_value=chunks), \
         patch("app.core.rag.pick_provider") as mock_pick:
        mock_provider = mock_pick.return_value
        mock_provider.embed_texts.return_value = fake_embed

        results = retrieve_cross_book("test query", top_k=5)

    agent_ids_in_results = {r["agent_id"] for r in results}
    assert len(agent_ids_in_results) >= 2, (
        f"Expected chunks from >=2 agents but got {len(agent_ids_in_results)}: {agent_ids_in_results}"
    )


def test_dedup_best_per_agent_first(three_agents):
    """The first N results (where N = number of agents) should each be from a distinct agent."""
    a, b, c = three_agents
    dim = 4
    query_dir = np.array([1, 0, 0, 0], dtype=np.float32)

    chunks = []
    # 3 chunks from agent A (high scores)
    for i in range(3):
        v = query_dir * (1.0 - i * 0.01)
        chunks.append(_make_chunk(a["id"], i, v))
    # 1 chunk from agent B (medium score)
    chunks.append(_make_chunk(b["id"], 0, query_dir * 0.8))
    # 1 chunk from agent C (lower score)
    chunks.append(_make_chunk(c["id"], 0, query_dir * 0.6))

    fake_embed = [[float(x) for x in query_dir]]

    with patch("app.core.rag.list_agents", return_value=three_agents), \
         patch("app.core.rag.get_chunks_batch", return_value=chunks), \
         patch("app.core.rag.pick_provider") as mock_pick:
        mock_provider = mock_pick.return_value
        mock_provider.embed_texts.return_value = fake_embed

        results = retrieve_cross_book("test query", top_k=5)

    # First 3 results should be one from each agent
    first_three_agents = [r["agent_id"] for r in results[:3]]
    assert len(set(first_three_agents)) == 3, (
        f"First 3 results should be from 3 distinct agents, got: {first_three_agents}"
    )


def test_dedup_preserves_score_order_within_overflow(three_agents):
    """Overflow chunks (2nd+ from same agent) should maintain score order."""
    a, b = three_agents[:2]
    dim = 4
    query_dir = np.array([1, 0, 0, 0], dtype=np.float32)

    chunks = [
        _make_chunk(a["id"], 0, query_dir * 1.0),
        _make_chunk(a["id"], 1, query_dir * 0.9),
        _make_chunk(a["id"], 2, query_dir * 0.5),
        _make_chunk(b["id"], 0, query_dir * 0.7),
    ]

    fake_embed = [[float(x) for x in query_dir]]

    with patch("app.core.rag.list_agents", return_value=three_agents[:2]), \
         patch("app.core.rag.get_chunks_batch", return_value=chunks), \
         patch("app.core.rag.pick_provider") as mock_pick:
        mock_provider = mock_pick.return_value
        mock_provider.embed_texts.return_value = fake_embed

        results = retrieve_cross_book("test query", top_k=4)

    assert results[0]["agent_id"] == a["id"], "Best overall chunk should be from A"
    assert results[1]["agent_id"] == b["id"], "Best from B should come next (dedup)"
    # Overflow from A should follow
    assert results[2]["agent_id"] == a["id"]
