from __future__ import annotations

import json
import logging
import re
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Any

import numpy as np

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
    list_minds_missing_embeddings,
    list_minds_with_embeddings,
    update_mind_embedding,
)
from .providers import ProviderError, chat_with_fallback, pick_provider
from .rag import build_context, retrieve_cross_book

log = logging.getLogger(__name__)

_SNIPPET_META_RE = re.compile(
    r"^(?:Title:\s*[^\n]*?\s*)?(?:Description:\s*)?", re.IGNORECASE
)


def _clean_snippet(text: str, max_len: int = 150) -> str:
    cleaned = _SNIPPET_META_RE.sub("", text).strip()
    if not cleaned:
        cleaned = text.strip()
    return cleaned[:max_len] + ("..." if len(cleaned) > max_len else "")


# ─── Mind embedding helpers ───

def _mind_embedding_text(mind_data: dict[str, Any]) -> str:
    """Build a single text block from a mind's profile for embedding."""
    parts = [
        mind_data.get("name", ""),
        mind_data.get("domain", ""),
        mind_data.get("bio_summary", ""),
        mind_data.get("thinking_style", ""),
    ]
    works = mind_data.get("works", [])
    if isinstance(works, list):
        parts.append(", ".join(works[:10]))
    elif isinstance(works, str):
        parts.append(works)
    persona = mind_data.get("persona", "")
    if persona:
        parts.append(persona[:1000])
    return "\n".join(p for p in parts if p)


def embed_mind(mind_id: str, mind_data: dict[str, Any]) -> None:
    """Generate and store an embedding vector for a mind."""
    text = _mind_embedding_text(mind_data)
    if not text.strip():
        return
    try:
        embedder = pick_provider("embed")
        vectors = embedder.embed_texts([text], task_type="RETRIEVAL_DOCUMENT")
        arr = np.array(vectors[0], dtype=np.float32)
        norm = float(np.linalg.norm(arr))
        if norm == 0.0:
            norm = 1.0
        update_mind_embedding(mind_id, arr.tobytes(), arr.shape[0], norm)
    except Exception as exc:
        log.warning("Failed to embed mind %s: %s", mind_id, exc)


def backfill_mind_embeddings(batch_size: int = 10) -> int:
    """Embed minds missing an embedding vector, up to batch_size at a time.

    Returns the number embedded in this batch. Call repeatedly until it returns 0.
    """
    missing = list_minds_missing_embeddings()
    if not missing:
        return 0
    batch = missing[:batch_size]
    count = 0
    for mind in batch:
        try:
            embed_mind(mind["id"], mind)
            count += 1
        except Exception as exc:
            log.warning("Backfill embed failed for %s: %s", mind["name"], exc)
    log.info("Backfilled embeddings for %d/%d minds (%d remaining)", count, len(missing), len(missing) - count)
    return count


def compute_mind_layout() -> list[dict[str, Any]]:
    """Project each mind's embedding to 2D via PCA.

    Returns [{id, rx, ry}] where rx/ry are in [0.05, 0.95] — ready to use
    as fractional canvas coordinates for the graph layout force.
    """
    rows = list_minds_with_embeddings()
    if len(rows) < 2:
        return []

    ids = []
    vecs = []
    for r in rows:
        if not r.get("embedding"):
            continue
        emb = bytes(r["embedding"]) if isinstance(r["embedding"], memoryview) else r["embedding"]
        arr = np.frombuffer(emb, dtype=np.float32, count=r["embedding_dim"])
        norm = r["embedding_norm"] or float(np.linalg.norm(arr)) or 1.0
        vecs.append(arr / norm)
        ids.append(r["id"])

    if len(vecs) < 2:
        return []

    mat = np.stack(vecs)
    centered = mat - mat.mean(axis=0)
    _, _, Vt = np.linalg.svd(centered, full_matrices=False)
    coords = centered @ Vt[:2].T  # shape (n, 2)

    # Normalize each axis to [0.05, 0.95]
    result = []
    for axis in range(2):
        col = coords[:, axis]
        lo, hi = col.min(), col.max()
        if hi > lo:
            coords[:, axis] = 0.08 + 0.84 * (col - lo) / (hi - lo)
        else:
            coords[:, axis] = 0.5

    for i, mind_id in enumerate(ids):
        result.append({
            "id": mind_id,
            "rx": round(float(coords[i, 0]), 4),
            "ry": round(float(coords[i, 1]), 4),
        })
    return result


def compute_mind_similarities() -> list[dict[str, Any]]:
    """Compute pairwise cosine similarities between all minds with embeddings.

    Returns a list of {source, target, strength} dicts sorted by strength descending.
    Only returns pairs with positive similarity.
    """
    rows = list_minds_with_embeddings()
    if len(rows) < 2:
        return []

    ids = []
    names = []
    domains = []
    vecs = []
    for r in rows:
        if not r.get("embedding"):
            continue
        emb = bytes(r["embedding"]) if isinstance(r["embedding"], memoryview) else r["embedding"]
        arr = np.frombuffer(emb, dtype=np.float32, count=r["embedding_dim"])
        norm = r["embedding_norm"] or float(np.linalg.norm(arr)) or 1.0
        vecs.append(arr / norm)
        ids.append(r["id"])
        names.append(r["name"])
        domains.append(r.get("domain", ""))

    if len(vecs) < 2:
        return []

    mat = np.stack(vecs)
    sims = mat @ mat.T

    # For each node keep only its top-K strongest neighbors (regardless of absolute threshold).
    # This bounds total link count to ~n*TOP_K/2 regardless of how close embeddings are,
    # preventing the graph from collapsing when all intellectual personas sit near each
    # other in embedding space.
    TOP_K = 4
    from collections import defaultdict
    top_per_node: dict[int, list[tuple[float, int]]] = defaultdict(list)
    for i in range(len(ids)):
        for j in range(i + 1, len(ids)):
            s = float(sims[i, j])
            if s > 0.45:
                top_per_node[i].append((s, j))
                top_per_node[j].append((s, i))

    seen: set[tuple] = set()
    results = []
    for node_i, neighbors in top_per_node.items():
        neighbors.sort(reverse=True)
        for s, node_j in neighbors[:TOP_K]:
            pair = (min(node_i, node_j), max(node_i, node_j))
            if pair not in seen:
                seen.add(pair)
                results.append({
                    "source": ids[node_i],
                    "target": ids[node_j],
                    "strength": round(s, 4),
                })
    results.sort(key=lambda x: x["strength"], reverse=True)
    return results

# ─── Seed minds generated on first startup ───

SEED_MINDS: list[dict[str, str]] = [
    # ── Ancient & Classical Philosophy ──
    {"name": "Aristotle", "era": "384–322 BC", "domain": "ancient philosophy, logic, ethics, metaphysics, rhetoric"},
    {"name": "Socrates", "era": "470–399 BC", "domain": "ancient philosophy, ethics, epistemology, dialectic"},
    {"name": "Plato", "era": "428–348 BC", "domain": "ancient philosophy, metaphysics, political theory, epistemology"},
    {"name": "Marcus Aurelius", "era": "121–180 AD", "domain": "stoicism, ancient philosophy, ethics, leadership"},
    {"name": "Confucius", "era": "551–479 BC", "domain": "eastern philosophy, ethics, governance, education"},
    {"name": "Laozi", "era": "6th century BC", "domain": "eastern philosophy, Taoism, metaphysics"},
    {"name": "Sun Tzu", "era": "544–496 BC", "domain": "eastern philosophy, military strategy, leadership, game theory"},

    # ── Modern Philosophy ──
    {"name": "Friedrich Nietzsche", "era": "1844–1900", "domain": "modern philosophy, existentialism, ethics, cultural criticism"},
    {"name": "Niccolò Machiavelli", "era": "1469–1527", "domain": "political philosophy, statecraft, power, realism"},
    {"name": "Bertrand Russell", "era": "1872–1970", "domain": "analytic philosophy, logic, mathematics, social criticism"},
    {"name": "Michel Foucault", "era": "1926–1984", "domain": "modern philosophy, power, social theory, knowledge systems"},
    {"name": "Immanuel Kant", "era": "1724–1804", "domain": "modern philosophy, epistemology, ethics, metaphysics"},

    # ── Physics & Mathematics ──
    {"name": "Richard Feynman", "era": "1918–1988", "domain": "physics, quantum mechanics, science education"},
    {"name": "Albert Einstein", "era": "1879–1955", "domain": "physics, relativity, philosophy of science"},
    {"name": "Isaac Newton", "era": "1643–1727", "domain": "physics, mathematics, classical mechanics, optics"},
    {"name": "Nikola Tesla", "era": "1856–1943", "domain": "physics, electrical engineering, invention"},
    {"name": "Stephen Hawking", "era": "1942–2018", "domain": "physics, cosmology, science communication"},
    {"name": "John von Neumann", "era": "1903–1957", "domain": "mathematics, computer science, game theory, quantum mechanics"},

    # ── Biology & Life Sciences ──
    {"name": "Charles Darwin", "era": "1809–1882", "domain": "biology, evolution, natural history"},
    {"name": "E.O. Wilson", "era": "1929–2021", "domain": "biology, sociobiology, ecology, biodiversity"},

    # ── Economics & Investing ──
    {"name": "Adam Smith", "era": "1723–1790", "domain": "economics, free markets, moral philosophy"},
    {"name": "John Maynard Keynes", "era": "1883–1946", "domain": "economics, macroeconomics, fiscal policy"},
    {"name": "Charlie Munger", "era": "1924–2023", "domain": "investing, mental models, multidisciplinary thinking"},
    {"name": "Warren Buffett", "era": "1930–present", "domain": "investing, value investing, business analysis"},
    {"name": "Ray Dalio", "era": "1949–present", "domain": "investing, macroeconomics, principles, systems thinking"},

    # ── Psychology & Cognitive Science ──
    {"name": "Daniel Kahneman", "era": "1934–2024", "domain": "cognitive psychology, behavioral economics, decision-making"},
    {"name": "Carl Jung", "era": "1875–1961", "domain": "depth psychology, psychoanalysis, mythology, archetypes"},
    {"name": "Sigmund Freud", "era": "1856–1939", "domain": "depth psychology, psychoanalysis, unconscious mind"},
    {"name": "Steven Pinker", "era": "1954–present", "domain": "cognitive psychology, linguistics, human nature, rationality"},

    # ── Literature & Arts ──
    {"name": "Fyodor Dostoevsky", "era": "1821–1881", "domain": "literature, existentialism, human nature"},
    {"name": "Leo Tolstoy", "era": "1828–1910", "domain": "literature, moral philosophy, pacifism"},
    {"name": "William Shakespeare", "era": "1564–1616", "domain": "literature, drama, human nature, language"},
    {"name": "Jorge Luis Borges", "era": "1899–1986", "domain": "literature, metaphysics, philosophy of mind"},

    # ── History & Political Leadership ──
    {"name": "Winston Churchill", "era": "1874–1965", "domain": "political leadership, history, wartime strategy, rhetoric"},
    {"name": "Leonardo da Vinci", "era": "1452–1519", "domain": "art, engineering, anatomy, invention, polymathy"},

    # ── Tech & Product ──
    {"name": "Steve Jobs", "era": "1955–2011", "domain": "technology, product design, entrepreneurship, innovation"},
    {"name": "Elon Musk", "era": "1971–present", "domain": "technology, engineering, space, first principles thinking"},
    {"name": "Jensen Huang", "era": "1963–present", "domain": "technology, semiconductors, AI, computing"},
    {"name": "Jeff Bezos", "era": "1964–present", "domain": "technology, business strategy, customer obsession, e-commerce"},

    # ── Startups & Venture Capital ──
    {"name": "Marc Andreessen", "era": "1971–present", "domain": "venture capital, software, startups, techno-optimism"},
    {"name": "Paul Graham", "era": "1964–present", "domain": "startups, programming, essays, venture capital"},
    {"name": "Peter Thiel", "era": "1967–present", "domain": "venture capital, contrarian thinking, startups, monopoly theory"},
    {"name": "Sam Altman", "era": "1985–present", "domain": "AI, startups, technology, venture capital"},

    # ── Business & Management ──
    {"name": "Peter Drucker", "era": "1909–2005", "domain": "management, business strategy, leadership, knowledge work"},

    # ── Interdisciplinary Thinkers ──
    {"name": "Naval Ravikant", "era": "1974–present", "domain": "startups, personal philosophy, wealth, decision-making"},
    {"name": "Nassim Nicholas Taleb", "era": "1960–present", "domain": "risk, probability, antifragility, epistemology"},
    {"name": "Yuval Noah Harari", "era": "1976–present", "domain": "history, futurism, cognitive science, anthropology"},
    {"name": "Jordan Peterson", "era": "1962–present", "domain": "depth psychology, personal development, mythology, cultural criticism"},
    {"name": "Tim Ferriss", "era": "1977–present", "domain": "productivity, self-optimization, entrepreneurship, podcasting"},
    {"name": "James Clear", "era": "1986–present", "domain": "habits, behavioral psychology, productivity, self-improvement"},
    {"name": "Balaji Srinivasan", "era": "1980–present", "domain": "technology, network state, crypto, futurism"},
    {"name": "Tyler Cowen", "era": "1962–present", "domain": "economics, cultural commentary, innovation, blogging"},
]


def _generate_persona_prompt(name: str, era: str, domain: str) -> str:
    is_contemporary = "present" in era.lower() or any(
        int(y) > 1960 for y in re.findall(r'\b(19\d{2}|20\d{2})\b', era)
    ) if era else False
    extra = ""
    if is_contemporary:
        extra = (
            "6. Their public communication style — tweets, blog posts, interviews, talks\n"
            "7. Their contrarian or distinctive takes that set them apart\n"
            "8. Their most famous or viral statements\n\n"
            "For 'works', include books, essays, blog posts, famous talks, or notable interviews.\n\n"
        )
    context = f'{name}'
    if era:
        context += f' ({era})'
    if domain:
        context += f', known for: {domain}'
    era_domain_keys = ''
    if not era or not domain:
        era_domain_keys = (
            '  "era": "birth-death years or century, e.g. 369-286 BC",\n'
            '  "domain": "comma-separated fields of expertise",\n'
        )
    return (
        f'Create a detailed persona profile for {context}.\n\n'
        'Capture:\n'
        '1. Their intellectual style — how they reason, argue, and explain\n'
        '2. Their vocabulary and rhetorical patterns\n'
        '3. Their known philosophical/intellectual positions\n'
        '4. How they would likely respond to modern ideas they never encountered\n'
        '5. Their characteristic agreements and disagreements with other thinkers\n'
        + extra +
        '\nReturn ONLY a JSON object with these keys:\n'
        '{\n'
        + era_domain_keys +
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

def get_or_create_mind(name: str, era: str = "", domain: str = "", link_works: bool = True) -> dict[str, Any]:
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
        "era": era or data.get("era", ""),
        "domain": domain or data.get("domain", ""),
        "bio_summary": data.get("bio_summary", ""),
        "persona": data.get("persona", ""),
        "works": data.get("works", []),
        "thinking_style": data.get("thinking_style", ""),
        "typical_phrases": data.get("typical_phrases", []),
    }
    mind_id = create_mind(mind_data)
    mind = get_mind(mind_id)

    if link_works:
        for title in mind_data["works"][:5]:
            try:
                agent = find_agent_by_name(title)
                if not agent:
                    agent_id = create_catalog_agent(title=title, author=name)
                else:
                    agent_id = agent["id"]
                link_mind_work(mind_id, agent_id)
            except Exception as exc:
                log.warning("Failed to link work '%s' for mind '%s': %s", title, name, exc)

    embed_mind(mind_id, mind_data)
    log.info("Generated mind: %s (%s)", name, era)
    return mind


def _fetch_url_text(url: str, max_chars: int = 12000) -> str:
    """Fetch text content from a URL (Twitter profile, blog, etc.)."""
    import httpx

    headers = {
        "User-Agent": "Mozilla/5.0 (compatible; Feynman/1.0)",
        "Accept": "text/html,application/xhtml+xml,text/plain,*/*",
    }
    with httpx.Client(timeout=30, follow_redirects=True) as client:
        resp = client.get(url, headers=headers)
        resp.raise_for_status()
    text = resp.text
    # Strip HTML tags for a rough text extraction
    import html
    clean = re.sub(r'<script[^>]*>.*?</script>', '', text, flags=re.DOTALL)
    clean = re.sub(r'<style[^>]*>.*?</style>', '', clean, flags=re.DOTALL)
    clean = re.sub(r'<[^>]+>', ' ', clean)
    clean = html.unescape(clean)
    clean = re.sub(r'\s+', ' ', clean).strip()
    return clean[:max_chars]


def create_mind_from_content(
    name: str,
    source_url: str = "",
    content: str = "",
) -> dict[str, Any]:
    """Create a user's own mind agent from a URL or pasted content.

    The LLM analyzes the provided content to extract the person's voice,
    thinking style, domains, and then creates a mind agent.
    """
    existing = find_mind_by_name(name)
    if existing:
        return existing

    source_text = content
    if source_url and not source_text:
        try:
            source_text = _fetch_url_text(source_url)
        except Exception as exc:
            log.warning("Failed to fetch URL %s: %s", source_url, exc)
            source_text = f"(URL provided but could not be fetched: {source_url})"

    source_label = f"URL: {source_url}" if source_url else "user-provided text"
    source_snippet = source_text[:8000] if source_text else "(no content provided)"

    prompt = (
        f"Analyze the following content from {name} ({source_label}) and create a persona profile.\n\n"
        f"--- CONTENT ---\n{source_snippet}\n--- END CONTENT ---\n\n"
        "Based on this content, infer:\n"
        "1. Their intellectual style — how they think, argue, and communicate\n"
        "2. Their key topics and domains of expertise\n"
        "3. Their vocabulary, tone, and rhetorical patterns\n"
        "4. Their distinctive viewpoints or contrarian takes\n"
        "5. Their public communication style\n\n"
        "Return ONLY a JSON object with these keys:\n"
        "{\n"
        '  "bio_summary": "2-3 sentence biography based on the content",\n'
        '  "era": "their approximate active period, e.g. 1985–present",\n'
        '  "domain": "comma-separated list of 3-5 domains they focus on",\n'
        '  "persona": "detailed system prompt capturing their voice, 300-500 words",\n'
        '  "works": ["notable works, articles, posts mentioned or implied"],\n'
        '  "thinking_style": "one paragraph describing how they think",\n'
        '  "typical_phrases": ["characteristic phrases or expressions"]\n'
        "}"
    )

    try:
        result, _ = chat_with_fallback(
            system="You are an expert at analyzing writing to build persona profiles. Return only valid JSON.",
            user=prompt,
        )
        data = _parse_json_response(result.content)
    except Exception as exc:
        log.error("Failed to generate mind from content for %s: %s", name, exc)
        raise

    mind_data = {
        "name": name,
        "era": data.get("era", "present"),
        "domain": data.get("domain", ""),
        "bio_summary": data.get("bio_summary", ""),
        "persona": data.get("persona", ""),
        "works": data.get("works", []),
        "thinking_style": data.get("thinking_style", ""),
        "typical_phrases": data.get("typical_phrases", []),
    }
    mind_id = create_mind(mind_data)
    mind = get_mind(mind_id)

    for title in mind_data["works"][:5]:
        agent = find_agent_by_name(title)
        if not agent:
            agent_id = create_catalog_agent(title=title, author=name)
        else:
            agent_id = agent["id"]
        link_mind_work(mind_id, agent_id)

    embed_mind(mind_id, mind_data)
    log.info("Generated mind from content: %s", name)
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
    user_invited: bool = False,
    user_mentioned: bool = False,
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
    if user_mentioned:
        prompt += (
            "\nIMPORTANT: The user has directly @mentioned you by name in their message. "
            "They are specifically asking YOU to respond. You MUST carefully read the "
            "conversation history and the user's latest question, then directly answer "
            "what they are asking. Do NOT introduce yourself. Do NOT give generic commentary. "
            "Engage with the specific question or topic the user raised, providing your "
            "unique perspective grounded in your expertise and the conversation context.\n"
        )
    elif user_invited:
        prompt += (
            "\nIMPORTANT: The user has specifically invited you to this conversation. "
            "You must carefully read the conversation history and the user's latest question, "
            "then directly respond to what the user is asking. Do NOT introduce yourself or "
            "give a generic opening statement. Focus on providing your unique perspective "
            "on the user's actual question, drawing from the conversation context and your expertise.\n"
        )

    # Layer 4: Memory (privacy-aware)
    if memories:
        global_topics = [m["topic"] for m in memories
                         if not m.get("user_id") and m.get("topic")]
        user_mems = [m for m in memories if m.get("user_id") and m.get("summary")]
        if global_topics:
            topics = "; ".join(dict.fromkeys(global_topics).keys())
            prompt += f"\nTopics you have been asked about broadly: {topics}\n"
        if user_mems:
            summaries = "; ".join(m["summary"] for m in user_mems[:10])
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
    user_invited: bool = False,
    user_mentioned: bool = False,
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
        user_invited=user_invited,
        user_mentioned=user_mentioned,
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
        cited_nums: set[int] = set()
        for group in re.findall(r"\[([\d,\s]+)\]", result.content):
            for num in group.split(","):
                num = num.strip()
                if num.isdigit():
                    cited_nums.add(int(num))
        for idx, chunk in enumerate(rag_chunks, start=1):
            if idx not in cited_nums:
                continue
            text = chunk.get("text", "")
            references.append({
                "index": idx,
                "book": chunk.get("agent_name", "Unknown"),
                "snippet": _clean_snippet(text),
                "full_text": text.strip(),
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
    invited_mind_ids: list[str] | None = None,
    is_mention: bool = False,
) -> list[dict[str, Any]]:
    """Send a message to multiple minds concurrently. Returns list of response dicts."""
    mind_names = [m["name"] for m in minds]
    invited_set = set(invited_mind_ids or [])
    results: list[dict[str, Any]] = []

    def _call(mind: dict[str, Any]) -> dict[str, Any]:
        others = [n for n in mind_names if n != mind["name"]]
        is_invited = mind["id"] in invited_set
        return mind_chat(
            mind,
            message,
            book_context=book_context,
            agent_ids=agent_ids,
            history=history,
            other_minds=others,
            brief=True,
            user_id=user_id,
            user_invited=is_invited,
            user_mentioned=is_mention and is_invited,
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
    """Extract memory from a conversation turn.

    Saves two types:
    - Private memory (with user_id): full conversation summary, only visible to that user.
    - Global topic tag (without user_id): anonymized topic keyword only, safe to share
      across users. Useful for mind's knowledge of popular topics and future user matching.
    """
    prompt = (
        "Analyze this conversation and return a JSON object with two fields:\n"
        "1. \"summary\": 1-2 sentence summary of the intellectual point discussed\n"
        "2. \"topic\": a short topic tag (2-5 words, e.g. \"free will and determinism\")\n\n"
        f"User: {message}\n\nResponse: {response}\n\n"
        "Return ONLY the JSON object, nothing else."
    )
    try:
        result, _ = chat_with_fallback(
            system="You are a concise summarizer. Return only valid JSON.",
            user=prompt,
        )
        text = result.content.strip()
        if text.startswith("```"):
            text = re.sub(r"^```\w*\n?", "", text)
            text = re.sub(r"\n?```$", "", text)
        data = json.loads(text)
        summary = data.get("summary", "").strip()
        topic = data.get("topic", "").strip()

        if summary:
            add_mind_memory(mind_id, summary, topic=topic, user_id=user_id)
        if topic and user_id:
            add_mind_memory(mind_id, topic, topic=topic)
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
