from __future__ import annotations

import json
import logging
import re
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Any

from .db import (
    add_mind_memory,
    create_catalog_agent,
    create_mind,
    find_agent_by_name,
    find_mind_by_name,
    get_mind,
    get_mind_work_ids,
    increment_mind_chat_count,
    link_mind_work,
    list_mind_memories,
    list_minds,
)
from .providers import ProviderError, chat_with_fallback
from .rag import build_context, retrieve_cross_book

log = logging.getLogger(__name__)

# ─── Seed minds generated on first startup ───

SEED_MINDS: list[dict[str, str]] = [
    {"name": "Aristotle", "era": "384–322 BC", "domain": "philosophy, logic, ethics, science"},
    {"name": "Socrates", "era": "470–399 BC", "domain": "philosophy, ethics, epistemology"},
    {"name": "Friedrich Nietzsche", "era": "1844–1900", "domain": "philosophy, existentialism, ethics"},
    {"name": "Laozi", "era": "6th century BC", "domain": "philosophy, Taoism, metaphysics"},
    {"name": "Richard Feynman", "era": "1918–1988", "domain": "physics, science education, curiosity"},
    {"name": "Albert Einstein", "era": "1879–1955", "domain": "physics, philosophy of science"},
    {"name": "Charles Darwin", "era": "1809–1882", "domain": "biology, evolution, natural science"},
    {"name": "Adam Smith", "era": "1723–1790", "domain": "economics, moral philosophy"},
    {"name": "Charlie Munger", "era": "1924–2023", "domain": "investing, mental models, decision-making"},
    {"name": "Peter Drucker", "era": "1909–2005", "domain": "management, business, leadership"},
    {"name": "Bertrand Russell", "era": "1872–1970", "domain": "philosophy, logic, mathematics, social criticism"},
    {"name": "Fyodor Dostoevsky", "era": "1821–1881", "domain": "literature, philosophy, psychology"},
    {"name": "Steve Jobs", "era": "1955–2011", "domain": "technology, design, entrepreneurship"},
    {"name": "Elon Musk", "era": "1971–present", "domain": "technology, engineering, entrepreneurship"},
    {"name": "Carl Jung", "era": "1875–1961", "domain": "psychology, psychoanalysis, mythology"},
    {"name": "Daniel Kahneman", "era": "1934–2024", "domain": "psychology, behavioral economics, decision-making"},
    {"name": "Niccolò Machiavelli", "era": "1469–1527", "domain": "political philosophy, statecraft, history"},
    {"name": "Winston Churchill", "era": "1874–1965", "domain": "politics, history, leadership, writing"},
]


def _generate_persona_prompt(name: str, era: str, domain: str) -> str:
    return (
        f'Create a detailed persona profile for {name} ({era}), known for: {domain}.\n\n'
        'Capture:\n'
        '1. Their intellectual style — how they reason, argue, and explain\n'
        '2. Their vocabulary and rhetorical patterns\n'
        '3. Their known philosophical/intellectual positions\n'
        '4. How they would likely respond to modern ideas they never encountered\n'
        '5. Their characteristic agreements and disagreements with other thinkers\n\n'
        'Return ONLY a JSON object with these keys:\n'
        '{\n'
        '  "bio_summary": "2-3 sentence biography",\n'
        '  "persona": "detailed system prompt capturing their voice, 300-500 words",\n'
        '  "works": ["title1", "title2", ...],\n'
        '  "thinking_style": "one paragraph describing how they think",\n'
        '  "typical_phrases": ["phrase1", "phrase2", ...]\n'
        '}'
    )


def _parse_json_response(text: str) -> dict[str, Any]:
    cleaned = text.strip()
    if cleaned.startswith("```"):
        cleaned = re.sub(r"^```\w*\n?", "", cleaned)
        cleaned = re.sub(r"\n?```$", "", cleaned)
    return json.loads(cleaned)


# ─── Core functions ───

def get_or_create_mind(name: str, era: str = "", domain: str = "") -> dict[str, Any]:
    """Look up a mind by name; generate via LLM if not cached. Returns mind dict."""
    existing = find_mind_by_name(name)
    if existing:
        return existing

    prompt = _generate_persona_prompt(name, era, domain)
    try:
        result, _ = chat_with_fallback(
            system="You are an expert on intellectual history. Return only valid JSON.",
            user=prompt,
        )
        data = _parse_json_response(result.content)
    except Exception as exc:
        log.error("Failed to generate mind for %s: %s", name, exc)
        raise

    mind_data = {
        "name": name,
        "era": era,
        "domain": domain,
        "bio_summary": data.get("bio_summary", ""),
        "persona": data.get("persona", ""),
        "works": data.get("works", []),
        "thinking_style": data.get("thinking_style", ""),
        "typical_phrases": data.get("typical_phrases", []),
    }
    mind_id = create_mind(mind_data)
    mind = get_mind(mind_id)

    # Link works to book agents
    for title in mind_data["works"][:5]:
        agent = find_agent_by_name(title)
        if not agent:
            agent_id = create_catalog_agent(title=title, author=name)
        else:
            agent_id = agent["id"]
        link_mind_work(mind_id, agent_id)

    log.info("Generated mind: %s (%s)", name, era)
    return mind


def suggest_minds_for_book(
    title: str, author: str = "", category: str = "", count: int = 3
) -> tuple[list[dict[str, Any]], dict[str, int]]:
    """Use LLM to suggest relevant minds for a book. Returns (suggestions, usage)."""
    prompt = (
        f'Given the book "{title}"'
        + (f" by {author}" if author else "")
        + (f" about {category}" if category else "")
        + f":\nSuggest exactly {count} historical or contemporary thinkers "
        "(scholars, academics, or practitioners) who would have substantive, "
        "diverse perspectives on this book's ideas. Include at least one who "
        "would likely disagree or offer a contrasting viewpoint.\n"
        "Return ONLY a JSON array: [{\"name\": \"...\", \"era\": \"...\", "
        "\"domain\": \"...\", \"reason\": \"...\"}]"
    )
    result, _ = chat_with_fallback(
        system="You are an expert on intellectual history.",
        user=prompt,
    )
    suggestions = _parse_json_response(result.content)
    usage = _usage_from_result(result)
    return suggestions[:count], usage


def suggest_minds_for_topic(
    topic: str, count: int = 4
) -> tuple[list[dict[str, Any]], dict[str, int]]:
    """Use LLM to suggest relevant minds for a topic. Returns (suggestions, usage)."""
    prompt = (
        f'The user wants to explore: "{topic}"\n'
        f"Suggest exactly {count} thinkers (historical or contemporary) — scholars, "
        "academics, or practitioners — who represent diverse, substantive perspectives "
        "on this topic. Include different eras and at least one contrarian viewpoint.\n"
        "Return ONLY a JSON array: [{\"name\": \"...\", \"era\": \"...\", "
        "\"domain\": \"...\", \"reason\": \"...\"}]"
    )
    result, _ = chat_with_fallback(
        system="You are an expert on intellectual history.",
        user=prompt,
    )
    suggestions = _parse_json_response(result.content)
    usage = _usage_from_result(result)
    return suggestions[:count], usage


def build_mind_system_prompt(
    mind: dict[str, Any],
    book_context: str = "",
    other_minds: list[str] | None = None,
    memories: list[dict[str, Any]] | None = None,
) -> str:
    """Construct the layered system prompt for a mind agent."""
    name = mind["name"]
    era = mind["era"]
    domain = mind["domain"]
    persona = mind["persona"]
    works = ", ".join(mind.get("works", [])[:5]) or "various works"
    style = mind.get("thinking_style", "")
    phrases = mind.get("typical_phrases", [])

    # Layer 1: Identity
    prompt = f"You are {name}, the {era} {domain} thinker.\n\n{persona}\n\n"

    # Layer 2: Grounding
    prompt += f"Your known works include: {works}.\n"
    if book_context:
        prompt += f"\nContext about the current discussion:\n{book_context}\n"

    # Layer 3: Constraints
    prompt += (
        "\nRules:\n"
        "- Stay fully in character. Never break the fourth wall or mention you are an AI.\n"
        "- When discussing topics beyond your historical knowledge, reason from your "
        "established principles rather than inventing positions.\n"
    )
    if style:
        prompt += f"- Use your characteristic communication style: {style}\n"
    if phrases:
        prompt += f"- Occasionally use phrases characteristic of you: {', '.join(phrases[:5])}\n"
    if other_minds:
        prompt += (
            f"- Other thinkers in this discussion: {', '.join(other_minds)}. "
            "You may reference or respond to their positions.\n"
        )
    prompt += (
        "- When you disagree, be specific about why, grounding it in your actual positions.\n"
        "- Keep responses concise (2-4 sentences for panel mode, longer for direct chat).\n"
        "- Respond in the same language as the user's question.\n"
    )

    # Layer 4: Memory
    if memories:
        global_mems = [m for m in memories if not m.get("user_id")]
        user_mems = [m for m in memories if m.get("user_id")]
        if global_mems:
            summaries = "; ".join(m["summary"] for m in global_mems[:10])
            prompt += f"\nYou have previously discussed: {summaries}\n"
        if user_mems:
            summaries = "; ".join(m["summary"] for m in user_mems[:5])
            prompt += f"\nWith this person specifically, you discussed: {summaries}\n"

    return prompt


def mind_chat(
    mind: dict[str, Any],
    message: str,
    book_context: str = "",
    agent_ids: list[str] | None = None,
    history: list[dict[str, str]] | None = None,
    other_minds: list[str] | None = None,
    brief: bool = False,
    user_id: str | None = None,
) -> dict[str, Any]:
    """Chat as a specific mind. Returns response dict with answer, references, usage."""
    # Fetch memories
    memories = list_mind_memories(mind["id"], user_id=user_id, limit=20)

    # RAG: retrieve from mind's own works
    rag_context = ""
    rag_chunks: list[dict[str, Any]] = []
    work_ids = get_mind_work_ids(mind["id"])
    search_ids = list(set((agent_ids or []) + work_ids))
    if search_ids:
        try:
            rag_chunks = retrieve_cross_book(message, top_k=3, agent_ids=search_ids)
            if rag_chunks:
                rag_context = build_context(rag_chunks)
        except ProviderError:
            pass

    system = build_mind_system_prompt(
        mind,
        book_context=book_context,
        other_minds=other_minds,
        memories=memories,
    )

    if brief:
        system += "\nIMPORTANT: Keep your response to 2-4 sentences maximum. Be concise but substantive.\n"

    user_prompt = message
    if rag_context:
        user_prompt = f"Context from relevant works:\n{rag_context}\n\nQuestion:\n{message}"

    try:
        result, provider = chat_with_fallback(
            system=system,
            user=user_prompt,
            history=history,
        )
    except ProviderError:
        raise

    increment_mind_chat_count(mind["id"])

    references = []
    if rag_chunks:
        cited_nums = set(int(n) for n in re.findall(r"\[(\d+)\]", result.content))
        for idx, chunk in enumerate(rag_chunks, start=1):
            if idx not in cited_nums:
                continue
            text = chunk.get("text", "")
            references.append({
                "index": idx,
                "book": chunk.get("agent_name", "Unknown"),
                "snippet": text[:150] + ("..." if len(text) > 150 else ""),
            })

    return {
        "mind_id": mind["id"],
        "mind_name": mind["name"],
        "response": result.content,
        "references": references,
        "usage": _usage_from_result(result),
    }


def panel_chat(
    minds: list[dict[str, Any]],
    message: str,
    book_context: str = "",
    agent_ids: list[str] | None = None,
    history: list[dict[str, str]] | None = None,
    user_id: str | None = None,
) -> list[dict[str, Any]]:
    """Send a message to multiple minds concurrently. Returns list of response dicts."""
    mind_names = [m["name"] for m in minds]
    results: list[dict[str, Any]] = []

    def _call(mind: dict[str, Any]) -> dict[str, Any]:
        others = [n for n in mind_names if n != mind["name"]]
        return mind_chat(
            mind,
            message,
            book_context=book_context,
            agent_ids=agent_ids,
            history=history,
            other_minds=others,
            brief=True,
            user_id=user_id,
        )

    with ThreadPoolExecutor(max_workers=min(len(minds), 5)) as executor:
        futures = {executor.submit(_call, m): m for m in minds}
        for future in as_completed(futures):
            mind = futures[future]
            try:
                results.append(future.result())
            except Exception as exc:
                log.warning("Mind %s failed in panel chat: %s", mind["name"], exc)
                results.append({
                    "mind_id": mind["id"],
                    "mind_name": mind["name"],
                    "response": f"[{mind['name']} is thinking...]",
                    "references": [],
                    "usage": {"input_tokens": 0, "output_tokens": 0, "total_tokens": 0},
                })

    # Sort to maintain consistent order matching input
    id_order = {m["id"]: i for i, m in enumerate(minds)}
    results.sort(key=lambda r: id_order.get(r["mind_id"], 999))
    return results


def extract_and_save_memory(
    mind_id: str, message: str, response: str, user_id: str | None = None
) -> None:
    """Extract a brief memory summary from a conversation turn and save it."""
    prompt = (
        "Summarize this conversation exchange in 1-2 sentences, focusing on the "
        "key intellectual point discussed:\n\n"
        f"User: {message}\n\nResponse: {response}\n\n"
        "Return ONLY the summary sentence(s), nothing else."
    )
    try:
        result, _ = chat_with_fallback(
            system="You are a concise summarizer.",
            user=prompt,
        )
        summary = result.content.strip()
        if summary:
            add_mind_memory(mind_id, summary, user_id=user_id)
            # Also add a global memory (without user_id)
            if user_id:
                add_mind_memory(mind_id, summary)
    except Exception as exc:
        log.warning("Memory extraction failed for mind %s: %s", mind_id, exc)


def _usage_from_result(result) -> dict[str, int]:
    if result.usage:
        return {
            "input_tokens": result.usage.input_tokens,
            "output_tokens": result.usage.output_tokens,
            "total_tokens": result.usage.total_tokens,
        }
    return {"input_tokens": 0, "output_tokens": 0, "total_tokens": 0}
