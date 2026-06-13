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
    delete_debate_by_question,
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


def _debate_prompt(question: str, m: dict[str, Any], transcript: str, is_first: bool, is_later_round: bool = False) -> str:
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
    elif is_later_round:
        # Second pass: the discussion exists, so push it forward instead of
        # restating an opening — this is what turns 3-4 isolated takes into an
        # actual symposium with depth.
        body = (
            f"The symposium so far:\n{transcript}\n\n"
            f"As {m['name']}, the discussion has developed — now go deeper. Pick the "
            "single strongest challenge another speaker has raised to your view and "
            "meet it head-on, OR pinpoint exactly where you and another speaker "
            "fundamentally diverge and why it matters. Name them. Do NOT restate your "
            "opening — advance it with a concrete distinction, example, or consequence."
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


def generate_debate(question: str, minds: list[dict[str, Any]], rounds: int = 2) -> list[dict[str, Any]]:
    """Round-robin generation. Each speaker sees the running transcript. Returns
    a list of {mind, turn_index, content}. A failed/short turn is skipped.

    rounds=2 (default) gives a real symposium, not 3-4 isolated takes: round 1 =
    opening positions that reference each other; round 2 = each speaker goes
    deeper, meeting the strongest challenge or sharpening a true disagreement."""
    turns: list[dict[str, Any]] = []
    transcript = ""
    idx = 0
    for r in range(rounds):
        for m in minds:
            try:
                res, _ = bulk_chat(
                    system=_DEBATE_SYSTEM,
                    user=_debate_prompt(question, m, transcript, idx == 0, is_later_round=(r >= 1)),
                )
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
    {"q": "What does a just society owe its weakest members?", "topic": "Political Science",
     "minds": ["Plato", "John Rawls", "Karl Marx", "Adam Smith"]},
    {"q": "Is morality objective, or invented by humans?", "topic": "Ethics",
     "minds": ["Immanuel Kant", "Friedrich Nietzsche", "David Hume", "Confucius"]},
    {"q": "Can a machine truly think?", "topic": "Artificial Intelligence",
     "minds": ["Alan Turing", "René Descartes", "John Searle", "Daniel Dennett"]},
    {"q": "What makes a life meaningful?", "topic": "Personal Meaning",
     "minds": ["Aristotle", "Albert Camus", "Confucius", "Friedrich Nietzsche"]},
    {"q": "Should the state direct the economy, or stay out of it?", "topic": "Economics",
     "minds": ["Karl Marx", "Adam Smith", "John Maynard Keynes", "Friedrich Hayek"]},
    {"q": "Is human nature fundamentally good or self-interested?", "topic": "Ethics",
     "minds": ["Mencius", "Thomas Hobbes", "Jean-Jacques Rousseau", "Xunzi"]},
    {"q": "Does technology liberate us or enslave us?", "topic": "Artificial Intelligence",
     "minds": ["Karl Marx", "Martin Heidegger", "Marshall McLuhan", "Hannah Arendt"]},
    {"q": "What is the right relationship between the individual and the state?", "topic": "Political Science",
     "minds": ["John Stuart Mill", "Confucius", "Niccolò Machiavelli", "Hannah Arendt"]},
    {"q": "Can we know anything for certain?", "topic": "Education",
     "minds": ["René Descartes", "David Hume", "Immanuel Kant", "Socrates"]},
    {"q": "Is inequality a natural and acceptable feature of society?", "topic": "Economics",
     "minds": ["Jean-Jacques Rousseau", "Adam Smith", "Karl Marx", "Aristotle"]},
    {"q": "Should we always tell the truth?", "topic": "Ethics",
     "minds": ["Immanuel Kant", "Confucius", "Friedrich Nietzsche", "John Stuart Mill"]},
    {"q": "What is the purpose of education?", "topic": "Education",
     "minds": ["Confucius", "John Dewey", "Plato", "Jean-Jacques Rousseau"]},
    {"q": "Is the pursuit of happiness the right aim of life?", "topic": "Personal Meaning",
     "minds": ["Aristotle", "Epicurus", "Arthur Schopenhauer", "John Stuart Mill"]},
]


def run_debate_batch(limit: int | None = None, rounds: int = 2, force: bool = False) -> tuple[int, int]:
    """Generate + store debates from the seed list. Idempotent: skips questions
    already debated UNLESS force=True, which regenerates them (delete old turns
    first) — used to re-run the seeds at a deeper round count. Returns
    (created, remaining). Drives a local script."""
    created = 0
    remaining = 0
    for seed in SEED_DEBATES:
        exists = debate_question_exists(seed["q"])
        if exists and not force:
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
        # Only delete the old version AFTER a successful regeneration, so a
        # mid-run failure never leaves a question with no symposium at all.
        if exists and force:
            delete_debate_by_question(seed["q"])
        d = create_debate(seed["q"], seed["topic"], [t["mind"]["id"] for t in turns])
        for t in turns:
            add_debate_turn(d["id"], t["mind"]["id"], t["mind"]["name"], t["turn_index"], t["content"])
        created += 1
        log.info("debate created: %r (%d turns) → /debate/%s", seed["q"], len(turns), d["slug"])
    return created, max(0, remaining - created)


# ─── Semi-automatic expansion (scale beyond the curated seeds) ───
# The quality of a symposium lives in (a) a question great thinkers genuinely
# disagree on and (b) a cast that actually CLASHES. So we don't pick blindly:
# an LLM proposes the questions per topic, and an LLM casts the debaters from the
# topic's relevant minds. Human-in-the-loop is the batch size — generate a wave,
# review, widen — never a blind thousand.

_QGEN_SYSTEM = (
    "You design questions for a symposium of history's greatest thinkers. The best "
    "questions are timeless tensions that real thinkers across traditions genuinely "
    "and deeply disagree on — not yes/no trivia, not settled facts."
)


def _qgen_prompt(topic: str, n: int) -> str:
    return (
        f"Topic: {topic}.\n"
        f"Give exactly {n} questions in this domain that great thinkers across history "
        "would genuinely, deeply disagree on — the kind a thoughtful person would "
        "actually search. Each phrased as a searcher types it, 40-90 chars, no "
        "numbering.\n"
        'Return STRICT JSON only: ["question", ...]'
    )


# Never cast as a debater — figures known mainly for political power or for
# atrocities make "what would X argue" read as apologia, not philosophy (cf. the
# mind /q guard). Matched case-insensitively as a substring of the name.
_SENSITIVE_DEBATERS = {
    "mao zedong", "adolf hitler", "joseph stalin", "vladimir lenin",
    "benito mussolini", "pol pot", "kim il-sung", "kim jong", "saddam hussein",
    "muammar gaddafi", "ruhollah khomeini", "yasser arafat", "francisco franco",
    "augusto pinochet", "idi amin", "hirohito", "hideki tojo", "che guevara",
    "fidel castro", "slobodan milosevic",
}


def _is_sensitive(name: str) -> bool:
    low = (name or "").lower()
    return any(s in low for s in _SENSITIVE_DEBATERS)


_CAST_SYSTEM = (
    "You cast participants for a symposium. You pick the thinkers who will produce a "
    "genuine intellectual CLASH — opposing schools or positions, each with a real "
    "stake — never four who'd just nod along. Two hard rules: (1) every pick's OWN "
    "field must genuinely cover the question — exclude anyone whose tie is tangential "
    "(e.g. a scientist on an art question, a politician on a metaphysics question); "
    "(2) never pick a figure known mainly for wielding political power or for "
    "historical atrocities."
)


def _cast_prompt(question: str, roster: str, n: int) -> str:
    return (
        f'Question: "{question}"\n\n'
        f"Candidate thinkers (name — domain):\n{roster}\n\n"
        f"Pick the {n} whose OWN expertise genuinely covers this question and who "
        "would produce the deepest, most genuine disagreement — opposing positions, "
        "not allies. Drop anyone whose connection is tangential. Use names EXACTLY as "
        "listed.\n"
        'Return STRICT JSON only: ["Name", ...]'
    )


def _json_list(raw: str) -> list[str]:
    raw = re.sub(r"^```(?:json)?\s*|\s*```$", "", (raw or "").strip(), flags=re.M).strip()
    try:
        out = json.loads(raw)
        return [str(x).strip() for x in out if str(x).strip()] if isinstance(out, list) else []
    except Exception:
        return []


def _topic_questions(topic: str, n: int) -> list[str]:
    res, _ = bulk_chat(system=_QGEN_SYSTEM, user=_qgen_prompt(topic, n))
    return _json_list(res.content or "")[:n]


def _topic_match_strict(domain: str, topic: str) -> bool:
    """WHOLE-WORD topic↔domain match (vs is_mind_topic_relevant's substring,
    which lets 'Art' match 'Artificial Intelligence' → AI folks polluting the Art
    casting pool). Casting wants precision over recall, so: a topic word (≥4
    chars) must appear as a whole word (or simple plural) in the domain."""
    domain = (domain or "").lower()
    if not domain:
        return False
    dwords = set(re.split(r"[,\s&/;()]+", domain))
    for tw in re.split(r"[,\s&]+", topic.lower()):
        if len(tw) < 4 or tw == "design":
            continue
        if tw in dwords or (tw + "s") in dwords or tw.rstrip("s") in dwords:
            return True
    return False


def _candidates_for_topic(topic: str, limit: int = 24) -> list[dict[str, Any]]:
    """Famous, topic-relevant minds as the casting pool (name + domain suffice;
    persona is fetched per-pick later). Whole-word match + sensitive filter."""
    from .db import list_minds
    minds = list_minds(limit=5000, lite=True)
    rel = [
        m for m in minds
        if _topic_match_strict(m.get("domain", ""), topic) and not _is_sensitive(m.get("name", ""))
    ]
    rel.sort(key=lambda m: -(m.get("chat_count") or 0))
    return rel[:limit]


def _pick_debaters(question: str, candidates: list[dict[str, Any]], n: int = 4) -> list[str]:
    roster = "\n".join(f"- {m['name']} — {(m.get('domain') or '')[:48]}" for m in candidates)
    res, _ = bulk_chat(system=_CAST_SYSTEM, user=_cast_prompt(question, roster, n))
    # Belt-and-suspenders: drop any sensitive figure the model still returned.
    return [p for p in _json_list(res.content or "") if not _is_sensitive(p)][:n]


def regenerate_debate(slug: str, rounds: int = 2) -> str | None:
    """Re-cast + re-generate one existing symposium in place (same question +
    topic + slug), e.g. to replace a tangential or sensitive debater. Deletes the
    old turns only after the new ones generate. Returns the slug or None."""
    from .db import get_debate_by_slug
    d = get_debate_by_slug(slug)
    if not d:
        return None
    q, topic = d["question"], d.get("topic") or ""
    cands = _candidates_for_topic(topic)
    minds, seen = [], set()
    for nm in _pick_debaters(q, cands, 4):
        m = get_mind_by_name(nm)
        if m and m.get("persona") and m["id"] not in seen:
            minds.append(m)
            seen.add(m["id"])
    if len(minds) < 2:
        return None
    turns = generate_debate(q, minds, rounds=rounds)
    if len(turns) < 2:
        return None
    delete_debate_by_question(q)
    nd = create_debate(q, topic, [t["mind"]["id"] for t in turns])
    for t in turns:
        add_debate_turn(nd["id"], t["mind"]["id"], t["mind"]["name"], t["turn_index"], t["content"])
    log.info("regenerated symposium %r → %s (%d turns)", q, nd["slug"], len(turns))
    return nd["slug"]


def expand_symposiums(
    per_topic: int = 5, topics: list[str] | None = None, limit: int | None = None,
) -> tuple[int, int]:
    """LLM-proposed questions × LLM-cast debaters per topic. Idempotent (skips
    existing questions). Returns (created, attempted). Drives a local script."""
    from .catalog import TOPIC_TAGS
    created = attempted = 0
    for topic in (topics or TOPIC_TAGS):
        try:
            questions = _topic_questions(topic, per_topic)
        except Exception as exc:
            log.warning("qgen failed for %s: %s", topic, exc)
            continue
        cands = _candidates_for_topic(topic)
        if len(cands) < 3:
            log.warning("topic %s: only %d candidate minds, skipping", topic, len(cands))
            continue
        for q in questions:
            q = q.strip()
            if not q or debate_question_exists(q):
                continue
            if limit is not None and created >= limit:
                return created, attempted
            attempted += 1
            try:
                names = _pick_debaters(q, cands, 4)
            except Exception as exc:
                log.warning("cast failed for %r: %s", q, exc)
                continue
            minds, seen = [], set()
            for nm in names:
                m = get_mind_by_name(nm)
                if m and m.get("persona") and m["id"] not in seen:
                    minds.append(m)
                    seen.add(m["id"])
            if len(minds) < 2:
                log.warning("symposium %r: only %d cast minds resolved, skipping", q, len(minds))
                continue
            turns = generate_debate(q, minds, rounds=2)
            if len(turns) < 2:
                continue
            d = create_debate(q, topic, [t["mind"]["id"] for t in turns])
            for t in turns:
                add_debate_turn(d["id"], t["mind"]["id"], t["mind"]["name"], t["turn_index"], t["content"])
            created += 1
            log.info("symposium: %r [%s] (%d turns) → /symposium/%s", q, topic, len(turns), d["slug"])
    return created, attempted
