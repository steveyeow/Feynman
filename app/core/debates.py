"""Multi-mind debates — the Type-4 generation engine.

2-4 great minds argue ONE question in a written symposium; each speaker (after
the first) sees the prior remarks and engages them by name, so the transcript
has the cross-reference *emergence* a single /q answer never has. That emergent,
multi-perspective text is the unique indexable artifact (Type 4): it doesn't
exist on Wikipedia (dead biography), Goodreads (reviews), or Wikiquote (isolated
quotes), and — unlike /q/on programmatic pages — it's far less templated, so it
reads as genuine applied dialogue rather than fill-in-the-blank.

Why generated, not mined from real chats: the per-mind dialogues page mines real
sessions, but chat volume is ~0, so that surface is empty. Debates are the
chat-volume-independent way to seed Type 4 (the philosophie.ai insight). Quality
comes from a CURATED seed list (contrasting thinkers per question), not blind
auto-selection.

Provider: bulk_chat → DeepSeek fallback (NOT geoblocked), so this runs locally.
"""
from __future__ import annotations

import json
import logging
import re
from typing import Any

from .db import (
    add_debate_turn,
    create_debate,
    debate_question_exists,
    get_mind_by_name,
)
from .providers import bulk_chat

log = logging.getLogger(__name__)

_DEBATE_SYSTEM = (
    "You are simulating one of history's great thinkers speaking in their own "
    "first-person voice in a written symposium with other great minds. Stay true "
    "to the thinker's documented ideas and characteristic way of reasoning — no "
    "invented quotes, dates, or biography. When prior remarks are provided, ENGAGE "
    "them: name a previous speaker and sharpen, extend, or rebut them, then advance "
    "your own distinct position. This is a debate of ideas, never a personal attack. "
    "Write tight, substantive prose — no greetings, no sign-offs, no stage directions."
)


def _voice_bits(m: dict[str, Any]) -> tuple[str, str]:
    try:
        phrases = "; ".join(json.loads(m.get("typical_phrases") or "[]")[:6])
    except Exception:
        phrases = ""
    try:
        works = ", ".join(json.loads(m.get("works") or "[]")[:3])
    except Exception:
        works = ""
    return phrases, works


def _debate_prompt(question: str, m: dict[str, Any], transcript: str, is_first: bool) -> str:
    phrases, works = _voice_bits(m)
    head = (
        f"You are {m['name']} ({m.get('era') or ''}; {m.get('domain') or ''}).\n"
        f"Persona: {(m.get('persona') or '')[:600]}\n"
        f"Thinking style: {(m.get('thinking_style') or '')[:240]}\n"
        f"Characteristic phrases (for voice, do not quote verbatim): {phrases}\n"
        f"Your works: {works}\n\n"
        f'The symposium question: "{question}"\n\n'
    )
    if is_first:
        body = (
            f"You open the symposium. State your position as {m['name']} — the core "
            "claim and the reasoning that makes it unmistakably yours."
        )
    else:
        body = (
            f"Remarks already made:\n{transcript}\n\n"
            f"Now respond as {m['name']}. Reference at least one prior speaker by name "
            "where you agree or disagree, then advance your own position."
        )
    return head + body + "\n\nFirst person, 110-170 words, concrete and specific. No greetings or sign-offs."


def _clean(text: str) -> str:
    t = (text or "").strip()
    t = re.sub(r"^```.*?\n|\n```$", "", t, flags=re.S).strip()
    # strip a leading "Name:" the model sometimes prepends
    t = re.sub(r"^[A-Z][A-Za-z .'-]{2,40}:\s*", "", t)
    return t.strip()


def generate_debate(question: str, minds: list[dict[str, Any]], rounds: int = 1) -> list[dict[str, Any]]:
    """Round-robin generation. Each speaker sees the running transcript. Returns
    a list of {mind, turn_index, content}. A failed/short turn is skipped."""
    turns: list[dict[str, Any]] = []
    transcript = ""
    idx = 0
    for _r in range(rounds):
        for m in minds:
            try:
                res, _ = bulk_chat(system=_DEBATE_SYSTEM, user=_debate_prompt(question, m, transcript, idx == 0))
            except Exception as exc:
                log.warning("debate turn failed for %s: %s", m.get("name"), exc)
                continue
            content = _clean(res.content or "")
            if len(content.split()) < 40:
                continue
            turns.append({"mind": m, "turn_index": idx, "content": content})
            transcript += f"\n\n— {m['name']}:\n{content}"
            idx += 1
    return turns


# Curated seeds: contrasting thinkers per question. Names must match minds.name
# (case-insensitive); a missing/persona-less thinker is dropped, and a debate
# needs >= 2 survivors. Topics align with TOPIC_TAGS where possible.
SEED_DEBATES: list[dict[str, Any]] = [
    {"q": "Should we fear death?", "topic": "Personal Meaning",
     "minds": ["Socrates", "Marcus Aurelius", "Epicurus", "Zhuangzi"]},
    {"q": "Does free will exist, or is it a useful illusion?", "topic": "Personal Meaning",
     "minds": ["Friedrich Nietzsche", "Baruch Spinoza", "Jean-Paul Sartre", "David Hume"]},
    {"q": "What does a just society owe its weakest members?", "topic": "Politics & Governance",
     "minds": ["Plato", "John Rawls", "Karl Marx", "Adam Smith"]},
    {"q": "Is morality objective, or invented by humans?", "topic": "Ethics & Morality",
     "minds": ["Immanuel Kant", "Friedrich Nietzsche", "David Hume", "Confucius"]},
    {"q": "Can a machine truly think?", "topic": "Technology & AI",
     "minds": ["Alan Turing", "René Descartes", "John Searle", "Daniel Dennett"]},
    {"q": "What makes a life meaningful?", "topic": "Personal Meaning",
     "minds": ["Aristotle", "Albert Camus", "Confucius", "Friedrich Nietzsche"]},
    {"q": "Should the state direct the economy, or stay out of it?", "topic": "Economics & Inequality",
     "minds": ["Karl Marx", "Adam Smith", "John Maynard Keynes", "Friedrich Hayek"]},
    {"q": "Is human nature fundamentally good or self-interested?", "topic": "Ethics & Morality",
     "minds": ["Mencius", "Thomas Hobbes", "Jean-Jacques Rousseau", "Xunzi"]},
    {"q": "Does technology liberate us or enslave us?", "topic": "Technology & AI",
     "minds": ["Karl Marx", "Martin Heidegger", "Marshall McLuhan", "Hannah Arendt"]},
    {"q": "What is the right relationship between the individual and the state?", "topic": "Politics & Governance",
     "minds": ["John Stuart Mill", "Confucius", "Niccolò Machiavelli", "Hannah Arendt"]},
    {"q": "Can we know anything for certain?", "topic": "Education",
     "minds": ["René Descartes", "David Hume", "Immanuel Kant", "Socrates"]},
    {"q": "Is inequality a natural and acceptable feature of society?", "topic": "Economics & Inequality",
     "minds": ["Jean-Jacques Rousseau", "Adam Smith", "Karl Marx", "Aristotle"]},
    {"q": "Should we always tell the truth?", "topic": "Ethics & Morality",
     "minds": ["Immanuel Kant", "Confucius", "Friedrich Nietzsche", "John Stuart Mill"]},
    {"q": "What is the purpose of education?", "topic": "Education",
     "minds": ["Confucius", "John Dewey", "Plato", "Jean-Jacques Rousseau"]},
    {"q": "Is the pursuit of happiness the right aim of life?", "topic": "Personal Meaning",
     "minds": ["Aristotle", "Epicurus", "Arthur Schopenhauer", "John Stuart Mill"]},
]


def run_debate_batch(limit: int | None = None, rounds: int = 1) -> tuple[int, int]:
    """Generate + store debates from the seed list. Idempotent (skips questions
    already debated). Returns (created, remaining). Drives a local script."""
    created = 0
    remaining = 0
    for seed in SEED_DEBATES:
        if debate_question_exists(seed["q"]):
            continue
        remaining += 1
        if limit is not None and created >= limit:
            continue
        minds = []
        seen = set()
        for nm in seed["minds"]:
            m = get_mind_by_name(nm)
            if m and m.get("persona") and m["id"] not in seen:
                minds.append(m)
                seen.add(m["id"])
        if len(minds) < 2:
            log.warning("debate %r: only %d debaters found, skipping", seed["q"], len(minds))
            continue
        turns = generate_debate(seed["q"], minds, rounds=rounds)
        if len(turns) < 2:
            log.warning("debate %r: only %d turns generated, skipping", seed["q"], len(turns))
            continue
        d = create_debate(seed["q"], seed["topic"], [t["mind"]["id"] for t in turns])
        for t in turns:
            add_debate_turn(d["id"], t["mind"]["id"], t["mind"]["name"], t["turn_index"], t["content"])
        created += 1
        log.info("debate created: %r (%d turns) → /debate/%s", seed["q"], len(turns), d["slug"])
    return created, max(0, remaining - created)
