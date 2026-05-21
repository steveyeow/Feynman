from __future__ import annotations

from typing import Any

import numpy as np

import logging

from .config import TOP_K
from . import db as db_mod
from .db import (
    ann_topk,
    ann_topk_batch,
    decode_vector_blob,
    get_agent,
    get_chunks,
    get_chunks_batch,
    keyword_search_chunks,
    list_agents,
)
from .providers import get_provider, pick_provider, ProviderError

log = logging.getLogger(__name__)

RRF_K = 60
_EXPAND_MIN_AGENTS = 3

# When taking the pgvector ANN path we cap candidates rather than scoring the
# whole corpus. Set well above TOP_K so RRF still has range to fuse meaningful
# ranks, but small enough that egress stays in KB territory (not MB).
_ANN_CANDIDATE_MULT = 20


def _bytes_to_vector(blob, dim: int) -> np.ndarray:
    """Decode a stored vector blob into a numpy float32 array.

    Delegates to db.decode_vector_blob, which handles both raw float32 bytes
    (what indexer.py writes) and the historical JSON-Buffer format some
    chunks have. Without that branch, legacy retrieval silently returned
    garbage cosine scores for JSON-format rows.
    """
    return decode_vector_blob(blob, dim)


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


def _agent_pgvector_ready(agent_id: str) -> bool:
    """Whether an agent's chunks have been populated in the pgvector column.

    The flag is set by indexer.py for new agents and by the backfill script
    for existing ones. Reading agent meta is a cheap single-row query and
    avoids needing a per-chunk existence check on every retrieval.
    """
    if not db_mod._USE_PG or not db_mod._HAS_PGVECTOR:
        return False
    try:
        agent = get_agent(agent_id)
    except Exception:
        return False
    return bool((agent or {}).get("meta", {}).get("pgvector_ready"))


def retrieve(agent_id: str, query: str, top_k: int | None = None, provider_name: str | None = None) -> list[dict[str, Any]]:
    top_k = top_k or TOP_K
    if provider_name:
        embedder = get_provider(provider_name)
        if not embedder.supports_embeddings():
            raise ProviderError(f"Provider {provider_name} does not support embeddings")
    else:
        embedder = pick_provider("embed")

    query_vec_list = embedder.embed_texts([query], task_type="RETRIEVAL_QUERY")
    query_floats = query_vec_list[0]

    use_pgvec = _agent_pgvector_ready(agent_id)

    if use_pgvec:
        # SQL-side ANN: pgvector does the scoring + sorting; we only get the
        # top candidates back. Cuts the vector blob egress to zero on the
        # hot path. Falls through to legacy on any error (defensive).
        try:
            ann_rows = ann_topk(agent_id, query_floats, top_k * _ANN_CANDIDATE_MULT)
            vector_results = [
                {"id": r["id"], "chunk_index": r["chunk_index"], "text": r["text"], "score": float(r["score"])}
                for r in ann_rows
            ]
        except Exception as exc:
            log.warning("ann_topk failed for agent %s, falling back: %s", agent_id, exc)
            use_pgvec = False

    if not use_pgvec:
        # Legacy path: pull all chunks (vectors + text) and score in Python.
        # Kept for agents not yet backfilled and for non-pgvector deployments.
        query_vec = np.array(query_floats, dtype=np.float32)
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

    # Split agents into pgvec-ready and legacy. Cross-book is the heaviest
    # retrieval path — sending all chunks across the wire for hundreds of
    # books was the single biggest egress driver before this refactor.
    pgvec_ids = (
        [aid for aid in ready_ids if (ready_agents[aid].get("meta") or {}).get("pgvector_ready")]
        if db_mod._USE_PG and db_mod._HAS_PGVECTOR else []
    )
    legacy_ids = [aid for aid in ready_ids if aid not in set(pgvec_ids)]

    legacy_rows = get_chunks_batch(legacy_ids) if legacy_ids else []

    # Multi-query expansion: generate alternative queries when the library is large enough
    queries = [query]
    if expand and top_k >= 3 and len(ready_agents) > _EXPAND_MIN_AGENTS:
        queries.extend(_expand_query(query))

    candidate_n = max(top_k * _ANN_CANDIDATE_MULT, top_k * 3)

    # Score all queries and merge (dedup by chunk id, keep highest score)
    all_scored: dict[str, dict] = {}
    for q in queries:
        q_vec_list = embedder.embed_texts([q], task_type="RETRIEVAL_QUERY")
        q_floats = q_vec_list[0]

        # pgvector path — SQL ANN, no vector blobs cross the wire.
        if pgvec_ids:
            try:
                ann_rows = ann_topk_batch(pgvec_ids, q_floats, candidate_n)
                for r in ann_rows:
                    aid = r["agent_id"]
                    agent = ready_agents.get(aid)
                    if not agent:
                        continue
                    item = {
                        "id": r["id"], "agent_id": aid, "agent_name": agent["name"],
                        "chunk_index": r["chunk_index"], "text": r["text"],
                        "score": float(r["score"]),
                    }
                    cid = item["id"]
                    if cid not in all_scored or item["score"] > all_scored[cid]["score"]:
                        all_scored[cid] = item
            except Exception as exc:
                log.warning("ann_topk_batch failed (%s), processing pgvec agents via legacy path", exc)
                # On error, fold pgvec_ids into legacy path for this query
                legacy_rows = legacy_rows + get_chunks_batch(pgvec_ids)
                pgvec_ids = []

        # Legacy in-Python scoring for any agents not on pgvec.
        if legacy_rows:
            q_vec = np.array(q_floats, dtype=np.float32)
            q_norm = float(np.linalg.norm(q_vec)) or 1.0
            for item in _score_rows(legacy_rows, ready_agents, q_vec, q_norm):
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
