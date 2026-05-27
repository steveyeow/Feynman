"""JSON-LD required-field regression suite (Phase 7.4).

Guards against the failure mode where a refactor silently drops a Google-
required field from a JSON-LD block. Symptom in production: rich results
stop appearing for that page type because validators reject the schema —
but the page still renders fine to humans, so the bug is invisible in
manual QA. Commit 89410b8 fixed exactly this for QAPage (missing ``text``
and ``answerCount``); without a regression suite the same gap can re-emerge
on any builder.

These tests assert ONLY the **Google-required** subset — not every schema.org
optional field. The required subset comes from
https://developers.google.com/search/docs/appearance/structured-data and is
the bar for rich-result eligibility.

Builders are tested in isolation (no DB, no FastAPI) — they're pure
functions over dicts, fast, deterministic, no fixtures needed.
"""

from __future__ import annotations

import json

from app.core import seo


def _unwrap_script(html: str) -> dict:
    """Strip the <script type='application/ld+json'>…</script> wrapper
    and parse the JSON. Mirrors what a crawler does to extract JSON-LD."""
    inner = html.split(">", 1)[1].rsplit("<", 1)[0]
    return json.loads(inner)


# ─── Book ─────────────────────────────────────────────────────────────────
# Required by Google: @type, name, author. URL+image strongly recommended.

class TestBookJsonLD:
    def test_required_fields_present(self):
        wrapped = seo.jsonld_script(seo.book_jsonld(
            title="Sapiens",
            description="A brief history of humankind",
            author="Yuval Noah Harari",
            url="https://feynman.wiki/book/abc",
            image="https://feynman.wiki/book/abc/og.png",
            word_count=None,
            chapters=None,
            site_url="https://feynman.wiki",
        ))
        d = _unwrap_script(wrapped)
        assert d["@context"] == "https://schema.org"
        assert d["@type"] == "Book"
        assert d["name"] == "Sapiens"
        assert d["author"]["@type"] == "Person"
        assert d["author"]["name"] == "Yuval Noah Harari"
        assert d["url"].startswith("https://")

    def test_never_emits_numberofpages_null(self):
        # Schema validators reject null leaves outright. The builder must
        # OMIT this field entirely when we don't have it, never null it.
        wrapped = seo.jsonld_script(seo.book_jsonld(
            title="X", description="", author="",
            url="https://x.com/b", image=None,
            word_count=None, chapters=None,
            site_url="https://x.com",
        ))
        d = _unwrap_script(wrapped)
        assert "numberOfPages" not in d, \
            "numberOfPages must never appear (it's for physical pages; " \
            "we use hasPart for chapters instead)"


# ─── Person ───────────────────────────────────────────────────────────────
# Required by Google: @type, name. sameAs strongly recommended for entity
# graph reconciliation.

class TestPersonJsonLD:
    def test_required_fields_present(self):
        d = seo.person_jsonld(
            name="Karl Marx",
            description="19th-century political economist…",
            domain="Political Economy, Philosophy",
            url="https://feynman.wiki/mind/marx",
            image="https://feynman.wiki/mind/marx/og.png",
        )
        assert d["@type"] == "Person"
        assert d["name"] == "Karl Marx"
        assert d["url"].startswith("https://")

    def test_sameas_when_available(self):
        # sameAs is what tells Google's Knowledge Graph "this is THE Karl Marx".
        # Builder must accept and emit it.
        d = seo.person_jsonld(
            name="Karl Marx", description="", domain="", url="https://x.com/m",
            image=None, same_as=["https://en.wikipedia.org/wiki/Karl_Marx"],
        )
        assert "sameAs" in d
        assert d["sameAs"] == ["https://en.wikipedia.org/wiki/Karl_Marx"]


# ─── QAPage ───────────────────────────────────────────────────────────────
# This is the one that bit us in 89410b8. Google requires:
#   - mainEntity.@type = "Question"
#   - mainEntity.name (the question text)
#   - mainEntity.acceptedAnswer.@type = "Answer"
#   - mainEntity.acceptedAnswer.text (the answer body)
#   - answerCount is implicitly required for rich-result eligibility

class TestQAPageJsonLD:
    def test_required_fields_present(self):
        d = seo.qa_page_jsonld(
            question="How does Sapiens explain cooperation?",
            answer="The book argues that shared fictions enable…",
            url="https://feynman.wiki/book/abc/q/cooperation",
            book_title="Sapiens",
            book_url="https://feynman.wiki/book/abc",
            site_url="https://feynman.wiki",
        )
        assert d["@type"] == "QAPage"
        me = d["mainEntity"]
        assert me["@type"] == "Question"
        assert me["name"]
        # The exact bug from 89410b8 — these two must be present:
        assert "text" in me, "QAPage Question must have 'text' (Google required)"
        assert "answerCount" in me, \
            "QAPage Question must have 'answerCount' (Google required)"
        acc = me["acceptedAnswer"]
        assert acc["@type"] == "Answer"
        assert acc["text"]


# ─── FAQPage ──────────────────────────────────────────────────────────────
# Required: mainEntity[] with each entry having @type=Question, name,
# acceptedAnswer.text. Non-empty answers required (deflection answer is
# acceptable, blank string is not).

class TestFAQPageJsonLD:
    def test_required_fields_present(self):
        d = seo.faq_jsonld([
            ("What is X?", "Open Feynman to learn more."),
            ("How does Y work?", "Open Feynman to learn more."),
        ])
        assert d["@type"] == "FAQPage"
        assert isinstance(d["mainEntity"], list)
        assert len(d["mainEntity"]) == 2
        for entry in d["mainEntity"]:
            assert entry["@type"] == "Question"
            assert entry["name"]
            assert entry["acceptedAnswer"]["@type"] == "Answer"
            assert entry["acceptedAnswer"]["text"], \
                "FAQ answer text must be non-empty (Google rejects empty)"


# ─── BreadcrumbList ───────────────────────────────────────────────────────
# Required: itemListElement[] with each entry having @type=ListItem,
# position, name, item (URL).

class TestBreadcrumbListJsonLD:
    def test_required_fields_present(self):
        d = seo.breadcrumb_jsonld([
            ("Feynman", "https://feynman.wiki"),
            ("Books", "https://feynman.wiki/#/library"),
            ("Sapiens", "https://feynman.wiki/book/abc"),
        ])
        assert d["@type"] == "BreadcrumbList"
        items = d["itemListElement"]
        assert len(items) == 3
        for i, item in enumerate(items, 1):
            assert item["@type"] == "ListItem"
            assert item["position"] == i
            assert item["name"]
            assert item["item"].startswith("https://")


# ─── Article (used by /insights and /dialogues) ───────────────────────────
# Required: @type, headline, datePublished or dateModified, author.

class TestArticleJsonLD:
    def test_insights_article_required_fields(self):
        d = seo.insights_article_jsonld(
            headline="AI insights about Sapiens",
            description="Aggregated AI commentary…",
            url="https://feynman.wiki/book/abc/insights",
            about_url="https://feynman.wiki/book/abc",
            about_type="Book",
            about_name="Sapiens",
            site_url="https://feynman.wiki",
            date_modified="2026-05-27T12:00:00Z",
            insight_count=10,
        )
        assert d["@type"] == "Article"
        assert d["headline"]
        # Google requires dateModified or datePublished. Insights pages
        # use dateModified because the content accumulates over time.
        assert "dateModified" in d or "datePublished" in d
        assert d["author"], "Article must declare an author (Google required)"


# ─── jsonld_script wrapper ────────────────────────────────────────────────
# The wrapper has its own contract: must produce a valid <script> tag,
# must drop None-valued top-level keys (validators reject null leaves),
# must HTML-safe-escape its content.

class TestJsonldScriptWrapper:
    def test_wraps_in_script_tag(self):
        out = seo.jsonld_script({"@type": "Thing", "name": "X"})
        assert out.startswith('<script type="application/ld+json">')
        assert out.endswith("</script>")

    def test_drops_none_top_level_keys(self):
        # Bug class: a builder returns {key: None} expecting wrapper to
        # drop it. Validators choke on null leaves. Wrapper must strip.
        out = seo.jsonld_script({
            "@type": "Book", "name": "X", "wordCount": None, "image": None,
        })
        d = _unwrap_script(out)
        assert "wordCount" not in d
        assert "image" not in d
        assert d["name"] == "X"
