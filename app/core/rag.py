from __future__ import annotations

from typing import Any

import numpy as np

import logging

from .config import TOP_K
from .db import get_chunks, get_chunks_batch, keyword_search_chunks, list_agents
from .providers import get_provider, pick_provider, ProviderError

log = logging.getLogger(__name__)

RRF_K = 60
_EXPAND_MIN_AGENTS = 3


def _bytes_to_vector(blob: bytes, dim: int) -> np.ndarray:
    return np.frombuffer(blob, dtype=np.float32, count=dim)


def _rrf_fuse(keyword_results: list[dict], vector_results: list[dict]) -> list[dict]:
    """Reciprocal Rank Fusion: combine two ranked lists."""
    scores: dict[str, float] = {}
    items: dict[str, dict] = {}

    for rank, item in enumerate(keyword_results):
        cid = item["id"]
        scores[cid] = scores.get(cid, 0.0) + 1.0 / (RRF_K + rank + 1)
        items[cid] = item

    for rank, item in enumerate(vector_results):
        cid = item["id"]
        scores[cid] = scores.get(cid, 0.0) + 1.0 / (RRF_K + rank + 1)
        if cid not in items:
            items[cid] = item

    ranked = sorted(scores.items(), key=lambda x: x[1], reverse=True)
    return [{**items[cid], "score": score} for cid, score in ranked]


def _expand_query(query: str) -> list[str]:
    """Generate alternative search phrasings via a cheap LLM call."""
    try:
        provider = pick_provider("chat")
        prompt = (
            "Generate 2-3 alternative search queries for the following question. "
            "Return ONLY the queries, one per line, no numbering.\n\n"
            f"Original: {query}"
        )
        from .providers import chat_with_fallback
        result, _ = chat_with_fallback(
            system="You are a search query reformulator. Return only queries, one per line.",
            user=prompt,
            max_tokens=150,
        )
        return [line.strip() for line in result.content.strip().split("\n") if line.strip()][:3]
    except Exception as exc:
        log.debug("Query expansion failed: %s", exc)
        return []


def retrieve(agent_id: str, query: str, top_k: int | None = None, provider_name: str | None = None) -> list[dict[str, Any]]:
    top_k = top_k or TOP_K
    if provider_name:
        embedder = get_provider(provider_name)
        if not embedder.supports_embeddings():
            raise ProviderError(f"Provider {provider_name} does not support embeddings")
    else:
        embedder = pick_provider("embed")

    query_vec_list = embedder.embed_texts([query], task_type="RETRIEVAL_QUERY")
    query_vec = np.array(query_vec_list[0], dtype=np.float32)
    query_norm = np.linalg.norm(query_vec)
    if query_norm == 0.0:
        query_norm = 1.0

    rows = get_chunks(agent_id)
    vector_results = []
    for row in rows:
        vec = _bytes_to_vector(row["vector"], row["dim"])
        denom = float(query_norm * row["norm"]) or 1.0
        score = float(np.dot(query_vec, vec) / denom)
        vector_results.append(
            {
                "id": row["id"],
                "chunk_index": row["chunk_index"],
                "text": row["text"],
                "score": score,
            }
        )

    vector_results.sort(key=lambda x: x["score"], reverse=True)

    # Hybrid: fuse with keyword search if available
    kw_results = keyword_search_chunks(query, agent_ids=[agent_id], limit=top_k * 3)
    if kw_results:
        kw_formatted = [{"id": r["id"], "chunk_index": r["chunk_index"], "text": r["text"], "score": 0.0} for r in kw_results]
        fused = _rrf_fuse(kw_formatted, vector_results)
        return fused[:top_k]

    return vector_results[:top_k]


def _score_rows(rows: list[dict], ready_agents: dict, query_vec: np.ndarray, query_norm: float) -> list[dict]:
    """Score chunk rows against a query vector."""
    results = []
    for row in rows:
        agent_id = row["agent_id"]
        agent = ready_agents.get(agent_id)
        if not agent:
            continue
        vec = _bytes_to_vector(row["vector"], row["dim"])
        denom = float(query_norm * row["norm"]) or 1.0
        score = float(np.dot(query_vec, vec) / denom)
        results.append({
            "id": row["id"], "agent_id": agent_id, "agent_name": agent["name"],
            "chunk_index": row["chunk_index"], "text": row["text"], "score": score,
        })
    return results


def retrieve_cross_book(query: str, top_k: int | None = None, agent_ids: list[str] | None = None, expand: bool = True) -> list[dict[str, Any]]:
    """Retrieve chunks across ready agents for global chat. Optionally filter by agent_ids."""
    top_k = top_k or TOP_K
    embedder = pick_provider("embed")

    all_agents = list_agents()
    ready_agents = {a["id"]: a for a in all_agents if a["status"] == "ready"}
    if agent_ids:
        ready_agents = {k: v for k, v in ready_agents.items() if k in agent_ids}

    ready_ids = list(ready_agents.keys())
    rows = get_chunks_batch(ready_ids)

    # Multi-query expansion: generate alternative queries when the library is large enough
    queries = [query]
    if expand and top_k >= 3 and len(ready_agents) > _EXPAND_MIN_AGENTS:
        queries.extend(_expand_query(query))

    # Score all queries and merge (dedup by chunk id, keep highest score)
    all_scored: dict[str, dict] = {}
    for q in queries:
        q_vec_list = embedder.embed_texts([q], task_type="RETRIEVAL_QUERY")
        q_vec = np.array(q_vec_list[0], dtype=np.float32)
        q_norm = float(np.linalg.norm(q_vec)) or 1.0
        for item in _score_rows(rows, ready_agents, q_vec, q_norm):
            cid = item["id"]
            if cid not in all_scored or item["score"] > all_scored[cid]["score"]:
                all_scored[cid] = item

    vector_results = sorted(all_scored.values(), key=lambda x: x["score"], reverse=True)

    # Hybrid: fuse with keyword search if available
    kw_results = keyword_search_chunks(query, agent_ids=ready_ids or None, limit=top_k * 3)
    if kw_results:
        kw_formatted = []
        for r in kw_results:
            aid = r["agent_id"]
            agent = ready_agents.get(aid)
            if not agent:
                continue
            kw_formatted.append({
                "id": r["id"], "agent_id": aid, "agent_name": agent["name"],
                "chunk_index": r["chunk_index"], "text": r["text"], "score": 0.0,
            })
        scored = _rrf_fuse(kw_formatted, vector_results)
    else:
        scored = vector_results

    # Per-agent dedup: keep best chunk per agent first, then backfill
    best_per_agent: dict[str, dict] = {}
    overflow: list[dict] = []
    for item in scored:
        aid = item["agent_id"]
        if aid not in best_per_agent:
            best_per_agent[aid] = item
        else:
            overflow.append(item)

    deduped = sorted(best_per_agent.values(), key=lambda x: x["score"], reverse=True)
    deduped.extend(overflow)
    return deduped[:top_k]


def build_context(chunks: list[dict[str, Any]]) -> str:
    lines = []
    for idx, chunk in enumerate(chunks, start=1):
        source = chunk.get("agent_name", "")
        label = f"[Passage {idx}] (from \"{source}\")" if source else f"[Passage {idx}]"
        lines.append(f"{label}\n{chunk['text']}")
    return "\n\n".join(lines)
