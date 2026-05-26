from __future__ import annotations

import hashlib
import uuid
from typing import Any

import numpy as np

from . import config
from . import db as db_mod
from .db import add_chunks, delete_chunks_for_agent, get_agent, update_agent_status
from .providers import pick_provider, ProviderError
from .questions import generate_questions
from .text_utils import chunk_text


def _vector_bytes(values: list[float]) -> tuple[bytes, int, float]:
    array = np.array(values, dtype=np.float32)
    norm = float(np.linalg.norm(array))
    if norm == 0.0:
        norm = 1.0
    return array.tobytes(), array.shape[0], norm


def _content_hash(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def index_text(agent_id: str, text: str, update_status: bool = True, force: bool = False, replace_existing: bool = False) -> dict[str, Any]:
    """Index text into chunks + embeddings.

    Args:
        update_status: If True (default), sets agent status to "ready" with meta.
            If False, only indexes and returns meta without changing status.
            Use False when the caller needs to merge additional data into meta first.
        force: If True, re-index even if content hash matches.
        replace_existing: If True, delete the agent's existing chunks before
            inserting new ones (so a re-index acts as a true replace instead of
            appending). The delete fires AFTER embeddings come back successfully
            — if the embedder 429s or otherwise fails, stale chunks survive
            untouched. Pass True when re-indexing on top of stub/partial data
            (Gutenberg backfill); leave False on first-time indexing.
    """
    content_hash = _content_hash(text)

    if not force:
        agent = get_agent(agent_id)
        if agent and agent.get("meta", {}).get("content_hash") == content_hash:
            return {"skipped": True, "reason": "content unchanged", **agent.get("meta", {})}

    chunks = chunk_text(text)
    if not chunks:
        raise ValueError("No text to index")

    embedder = pick_provider("embed")
    embeddings = embedder.embed_texts(chunks, task_type="RETRIEVAL_DOCUMENT")
    if len(embeddings) != len(chunks):
        raise ProviderError("Embedding count mismatch")

    records = []
    pgvec_eligible = True
    for idx, (chunk, emb) in enumerate(zip(chunks, embeddings)):
        vector_bytes, dim, norm = _vector_bytes(emb)
        if dim != config.EMBED_DIM:
            pgvec_eligible = False
        records.append(
            {
                "id": str(uuid.uuid4()),
                "chunk_index": idx,
                "text": chunk,
                "vector": vector_bytes,
                "dim": dim,
                "norm": norm,
                # Float list for dual-write to the pgvector halfvec column.
                # add_chunks() ignores this when the pgvector path is off or
                # the dim doesn't match EMBED_DIM.
                "embedding_floats": list(emb),
            }
        )

    # Replace-existing happens here, not earlier — if the embed call above
    # 429s or the network drops, the delete never fires and the agent keeps
    # whatever chunks it had. The window between delete and the executemany
    # below is microseconds (no I/O between them).
    if replace_existing:
        delete_chunks_for_agent(agent_id)

    add_chunks(agent_id, records)

    # Generate study questions from a sample of the text
    questions = generate_questions(agent_id, text)

    meta = {
        "chunk_count": len(chunks),
        "embed_provider": embedder.name,
        "embed_model": getattr(embedder, "embed_model", None),
        "questions": questions,
        "content_hash": content_hash,
        # Marks this agent's chunks as already populated in the pgvector
        # halfvec column, so rag.retrieve() can take the SQL ANN path
        # without an existence-check round-trip. Backfilled agents flip this
        # to True via scripts/backfill_pgvector.py.
        "pgvector_ready": bool(pgvec_eligible and db_mod._USE_PG and db_mod._HAS_PGVECTOR),
    }
    if update_status:
        update_agent_status(agent_id, "ready", meta)
    return meta
