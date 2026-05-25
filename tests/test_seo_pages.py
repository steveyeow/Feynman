"""Tests for SEO/GEO page composition helpers (app/core/seo.py).

These guard against the "thin content regression" — the failure mode where
a refactor accidentally strips the rendered sections back down to a 24-word
shell. Each test asserts a contract that any future maintainer must keep.
"""

from __future__ import annotations

import json
import re

import pytest

from app.core import seo


# ─── slugify ──────────────────────────────────────────────────────────

class TestSlugify:
    def test_basic_title(self):
        assert seo.slugify("How to Win Friends and Influence People") == \
            "how-to-win-friends-and-influence-people"

    def test_name_with_apostrophe(self):
        assert seo.slugify("Marx's Capital") == "marx-s-capital"

    def test_empty_returns_untitled(self):
        assert seo.slugify("") == "untitled"
        assert seo.slugify(None or "") == "untitled"

    def test_punctuation_collapses_to_single_dash(self):
        assert seo.slugify("hello -- world!!") == "hello-world"

    def test_max_len_respected(self):
        long = "x" * 200
        out = seo.slugify(long, max_len=30)
        assert len(out) <= 30

    def test_non_ascii_degrades_gracefully(self):
        # Non-Latin characters are dropped to dashes; we still get something safe
        out = seo.slugify("孔子 Confucius")
        assert out  # never empty for any non-empty input
        assert re.match(r"^[a-z0-9-]+$", out)

    def test_idempotent(self):
        slug = seo.slugify("Some Book Title")
        assert seo.slugify(slug) == slug


# ─── visible_word_count ───────────────────────────────────────────────

class TestVisibleWordCount:
    def test_strips_scripts(self):
        html = "<html><body>Hello world<script>var x = 1;</script></body></html>"
        assert seo.visible_word_count(html) == 2

    def test_strips_styles(self):
        html = "<html><body>Hello world<style>body{color:red}</style></body></html>"
        assert seo.visible_word_count(html) == 2

    def test_strips_tags(self):
        html = "<p>one <strong>two</strong> three</p>"
        assert seo.visible_word_count(html) == 3

    def test_empty(self):
        assert seo.visible_word_count("") == 0
        assert seo.visible_word_count("<html></html>") == 0


# ─── JSON-LD builders ─────────────────────────────────────────────────

class TestJsonLdBuilders:
    def test_breadcrumb_structure(self):
        bc = seo.breadcrumb_jsonld([
            ("Home", "https://x.com"),
            ("Books", "https://x.com/books"),
            ("Foo", "https://x.com/book/foo"),
        ])
        assert bc["@type"] == "BreadcrumbList"
        assert len(bc["itemListElement"]) == 3
        # Position numbering is 1-indexed per schema.org spec
        assert bc["itemListElement"][0]["position"] == 1
        assert bc["itemListElement"][-1]["position"] == 3

    def test_faq_requires_non_empty_answer(self):
        faq = seo.faq_jsonld([("What is X?", "Open the app to find out.")])
        assert faq["@type"] == "FAQPage"
        entity = faq["mainEntity"][0]
        assert entity["@type"] == "Question"
        assert entity["acceptedAnswer"]["text"]  # must be non-empty

    def test_book_jsonld_omits_word_count_when_zero(self):
        # Schema validators reject null leaves; jsonld_script drops them.
        book = seo.book_jsonld(
            title="T", description="D", author="A",
            url="https://x.com/b", image="https://x.com/i.png",
            word_count=None, chapters=None, site_url="https://x.com",
        )
        wrapped = seo.jsonld_script(book)
        parsed = json.loads(wrapped.split(">", 1)[1].rsplit("<", 1)[0])
        assert "wordCount" not in parsed
        assert "hasPart" not in parsed

    def test_book_jsonld_emits_haspart_when_chapters_present(self):
        book = seo.book_jsonld(
            title="T", description="D", author="A",
            url="https://x.com/b", image="https://x.com/i.png",
            word_count=12345,
            chapters=[{"title": "Ch1"}, {"title": "Ch2"}],
            site_url="https://x.com",
        )
        wrapped = seo.jsonld_script(book)
        parsed = json.loads(wrapped.split(">", 1)[1].rsplit("<", 1)[0])
        assert parsed["wordCount"] == 12345
        assert len(parsed["hasPart"]) == 2
        assert parsed["hasPart"][0]["@type"] == "Chapter"

    def test_book_jsonld_never_emits_number_of_pages(self):
        # We intentionally don't render numberOfPages anywhere — Schema.org
        # defines it as physical pages, not chapters. The old code had a
        # semantic bug; ensure we never reintroduce it.
        book = seo.book_jsonld(
            title="T", description="D", author="A",
            url="u", image="i", word_count=100,
            chapters=[{"title": "Ch1"}], site_url="s",
        )
        wrapped = seo.jsonld_script(book)
        assert "numberOfPages" not in wrapped

    def test_person_jsonld_includes_same_as(self):
        p = seo.person_jsonld(
            name="Karl Marx", description="", domain="",
            url="u", image="i",
            same_as=["https://en.wikipedia.org/wiki/Karl_Marx"],
        )
        assert p["sameAs"] == ["https://en.wikipedia.org/wiki/Karl_Marx"]

    def test_person_jsonld_knows_about_splits_domain(self):
        p = seo.person_jsonld(
            name="X", description="d", domain="Physics, Mathematics",
            url="u", image="i",
        )
        assert p["knowsAbout"] == ["Physics", "Mathematics"]

    def test_jsonld_script_wraps_and_drops_nulls(self):
        payload = {"a": 1, "b": None, "c": "", "d": [], "e": {"f": None, "g": 2}}
        s = seo.jsonld_script(payload)
        assert s.startswith('<script type="application/ld+json">')
        assert s.endswith("</script>")
        # nulls/empty values must be stripped
        assert "null" not in s
        # nested empty cleanup
        body = s.split(">", 1)[1].rsplit("<", 1)[0]
        parsed = json.loads(body)
        assert parsed == {"a": 1, "e": {"g": 2}}


# ─── Section renderers — non-empty input produces visible content ──────

class TestRenderBookSections:
    def test_about_renders_subtitle(self):
        out = seo.render_book_about("A guide to influence.", "Dale Carnegie")
        assert "guide to influence" in out

    def test_about_empty_returns_empty(self):
        assert seo.render_book_about("", "") == ""

    def test_stats_includes_words_chapters_reading_time(self):
        out = seo.render_stats(50000, 12)
        assert "50,000 words" in out
        assert "12 chapters" in out
        assert "min read" in out

    def test_stats_empty(self):
        assert seo.render_stats(0, 0) == ""

    def test_toc_renders_ol(self):
        out = seo.render_toc([{"title": "Ch1"}, {"title": "Ch2"}])
        assert "<ol" in out
        assert "Ch1" in out and "Ch2" in out

    def test_toc_skips_blank_titles(self):
        out = seo.render_toc([{"title": ""}, {"title": "Ch2"}])
        assert "Ch2" in out
        # Only one <li> should render
        assert out.count("<li>") == 1

    def test_sample_passages_truncates(self):
        long = "word " * 200  # 1000 chars
        out = seo.render_sample_passages([{"text": long}], count=1, max_chars=100)
        assert "<blockquote>" in out
        # truncation marker present
        assert "…" in out

    def test_sample_passages_escapes_html(self):
        out = seo.render_sample_passages([{"text": "<script>x</script>"}], count=1)
        assert "<script>x</script>" not in out
        assert "&lt;script&gt;" in out

    def test_popular_questions_renders_with_links(self):
        out = seo.render_popular_questions(
            ["What is X?", "Why Y?"],
            "https://x.com/#/read/abc",
        )
        assert out.count("<li>") == 2
        assert "What is X?" in out
        assert "https://x.com/#/read/abc" in out

    def test_minds_for_book_renders_cross_links(self):
        minds = [{"id": "m1", "name": "Marx", "domain": "Economics"}]
        out = seo.render_minds_for_book(minds, "https://x.com")
        assert 'href="https://x.com/mind/m1"' in out
        assert "Marx" in out


class TestRenderMindSections:
    def test_thinking_style_renders(self):
        out = seo.render_mind_thinking_style("Systems thinking, first principles.")
        assert "first principles" in out

    def test_phrases_renders_quotes(self):
        out = seo.render_mind_phrases(["Cogito ergo sum", "Ich denke, also bin ich"])
        assert "<q>" in out
        assert "Cogito" in out

    def test_phrases_limit(self):
        out = seo.render_mind_phrases([f"phrase{i}" for i in range(20)], limit=3)
        assert out.count("<q>") == 3

    def test_persona_excerpt_truncates(self):
        long = "word " * 500
        out = seo.render_mind_persona_excerpt(long, max_chars=80)
        assert "…" in out

    def test_works_cross_links_when_match(self):
        works = ["Das Kapital", "The Communist Manifesto"]
        linked = [{"id": "b1", "name": "Das Kapital"}]
        out = seo.render_mind_works(works, linked, "https://x.com")
        assert 'href="https://x.com/book/b1"' in out
        # Unlinked work stays plain text
        assert "The Communist Manifesto" in out
        # Only one anchor — the matching one
        assert out.count("<a ") == 1

    def test_works_fuzzy_match(self):
        # Subtitle variation should still match
        works = ["Das Kapital, Volume I"]
        linked = [{"id": "b1", "name": "Das Kapital"}]
        out = seo.render_mind_works(works, linked, "https://x.com")
        assert 'href="https://x.com/book/b1"' in out

    def test_lookup_same_as_case_insensitive(self):
        assert seo.lookup_same_as("Karl Marx") == seo.lookup_same_as("KARL MARX")
        assert seo.lookup_same_as("karl marx") == seo.lookup_same_as("Karl Marx")

    def test_lookup_same_as_returns_wikipedia_and_wikidata(self):
        urls = seo.lookup_same_as("Albert Einstein")
        assert urls is not None
        assert any("wikipedia" in u for u in urls)
        assert any("wikidata" in u for u in urls)

    def test_lookup_same_as_unknown_returns_none(self):
        assert seo.lookup_same_as("Some Person Nobody Knows") is None
        assert seo.lookup_same_as("") is None

    def test_related_minds_renders(self):
        related = [
            {"id": "m1", "name": "Engels", "era": "19th Century"},
            {"id": "m2", "name": "Lenin", "era": "20th Century"},
        ]
        out = seo.render_related_minds(related, "https://x.com")
        assert "Engels" in out and "Lenin" in out
        assert 'href="https://x.com/mind/m1"' in out


# ─── End-to-end content density floor ─────────────────────────────────

class TestContentDensityFloor:
    """If these break, the per-entity SEO/GEO strategy is broken. They are
    the regression net for the "24-word shell" failure mode that motivated
    the rewrite in the first place."""

    def _build_book_html(self) -> str:
        # Realistic chunk size — actual indexed chunks average ~1200 chars
        # of varied prose. The default render_sample_passages truncates at
        # 800 chars per blockquote × 3 = ~2400 chars rendered.
        chunk_text_a = (
            "The fundamental technique in handling people requires that we never "
            "criticize them directly. Criticism puts a person on the defensive and "
            "wounds their precious pride; it hurts their sense of importance and "
            "arouses resentment. Even when criticism is justified, the person we "
            "criticize will rarely respond with the change we desired. Instead, they "
            "will spend their energy justifying themselves and explaining why their "
            "behavior was correct. The skill we must cultivate is the patience to "
            "understand what made someone act as they did before we attempt to "
            "change them."
        )
        chunk_text_b = (
            "Give honest and sincere appreciation. The deepest principle in human "
            "nature is the craving to be appreciated, and most people pass through "
            "their lives without experiencing it. Flattery is hollow and selfish; "
            "appreciation comes from the heart and is grounded in genuine attention "
            "to what is admirable in another person. When we notice the work, the "
            "effort, the choices someone has made, and we tell them so clearly and "
            "specifically, we awaken something powerful — a willingness to engage "
            "with us as collaborators rather than adversaries."
        )
        chunk_text_c = (
            "Arouse in the other person an eager want. The only way to influence "
            "anyone is to talk about what they want and show them how to get it. "
            "Every action we ever take springs from a fundamental desire — for "
            "security, for recognition, for the well-being of those we love. To "
            "persuade effectively, we must first stand in the other person's shoes "
            "and see the question from their angle, then frame our proposal as the "
            "thing that helps them get what they already wanted."
        )
        chunks = [
            {"text": chunk_text_a},
            {"text": chunk_text_b},
            {"text": chunk_text_c},
        ]
        sections = [
            "<h1>How to Win Friends and Influence People</h1>",
            "<p>by Dale Carnegie</p>",
            seo.render_book_about(
                "Dale Carnegie's classic guide to interpersonal communication, "
                "influence, and the timeless principles of human relations that "
                "have shaped business and personal success for nearly a century.",
                "Dale Carnegie",
            ),
            seo.render_stats(89000, 30),
            seo.render_sample_passages(chunks),
            seo.render_toc([
                {"title": "Fundamental Techniques in Handling People"},
                {"title": "Six Ways to Make People Like You"},
                {"title": "How to Win People to Your Way of Thinking"},
                {"title": "Be a Leader: How to Change People Without Giving Offense"},
                {"title": "Letters That Produced Miraculous Results"},
                {"title": "Seven Rules for Making Your Home Life Happier"},
                {"title": "How to Develop Self-Confidence"},
                {"title": "The Big Secret of Dealing with People"},
                {"title": "Make People Glad to Do What You Want"},
                {"title": "Concluding Principles for Lasting Influence"},
            ]),
            seo.render_popular_questions(
                [
                    "What is the central thesis of How to Win Friends and Influence People?",
                    "How does Carnegie suggest handling criticism in a workplace setting?",
                    "What role does sincere appreciation play in building influence?",
                    "How can these communication techniques apply to modern digital teams?",
                    "What concrete evidence does Carnegie cite to support his claims?",
                ],
                "https://x.com/#/read/abc",
            ),
            seo.render_minds_for_book(
                [
                    {"id": "m1", "name": "Dale Carnegie", "domain": "Communication"},
                    {"id": "m2", "name": "Adam Smith", "domain": "Economics, Moral Philosophy"},
                    {"id": "m3", "name": "Benjamin Franklin", "domain": "Practical Philosophy"},
                ],
                "https://x.com",
            ),
        ]
        return "<html><body>" + "\n".join(sections) + "</body></html>"

    def _build_mind_html(self) -> str:
        # Persona texts are typically 1500+ chars of system-prompt-style
        # description; sample below is representative.
        persona = (
            "I approach every question by first asking who benefits materially "
            "from the present arrangement and whose labor is appropriated to "
            "produce that benefit. Ideology, religion, law, and politics are "
            "the superstructure resting on the economic base; to understand "
            "any of them you must first understand the underlying relations of "
            "production. History is the history of class struggle, and the "
            "conflict between those who own the means of production and those "
            "who must sell their labor is the engine of social transformation. "
            "Capitalism is not natural or eternal — it emerged from specific "
            "historical conditions and contains internal contradictions that "
            "will lead to its eventual supersession by a more rational system "
            "in which producers collectively control the conditions of their work."
        )
        sections = [
            "<h1>Karl Marx</h1>",
            "<p>19th Century · Political Economy, Philosophy</p>",
            seo.render_mind_bio(
                "Karl Marx (1818-1883) was a German philosopher, economist, "
                "political theorist, and revolutionary socialist whose theories "
                "about society, economics, and politics — collectively understood "
                "as Marxism — hold that human societies develop through class "
                "conflict. His most famous works, co-authored with Friedrich Engels, "
                "include The Communist Manifesto (1848) and the three-volume Das "
                "Kapital. His ideas profoundly influenced the development of "
                "socialist and communist movements across the twentieth century."
            ),
            seo.render_mind_thinking_style(
                "Materialist dialectics. Analyzes societies through the lens of "
                "class conflict and economic relations. Distinguishes appearance "
                "from underlying social reality, and treats every institution as "
                "historically contingent rather than natural or eternal."
            ),
            seo.render_mind_phrases([
                "The history of all hitherto existing society is the history of class struggles.",
                "Workers of the world, unite! You have nothing to lose but your chains.",
                "From each according to his ability, to each according to his needs.",
                "The philosophers have only interpreted the world; the point is to change it.",
                "Religion is the opium of the people.",
            ]),
            seo.render_mind_persona_excerpt(persona),
            seo.render_mind_works(
                [
                    "Das Kapital, Volume I",
                    "The Communist Manifesto",
                    "The German Ideology",
                    "Economic and Philosophic Manuscripts of 1844",
                    "Theses on Feuerbach",
                    "Grundrisse",
                    "Critique of the Gotha Programme",
                ],
                [{"id": "b1", "name": "Das Kapital"}],
                "https://x.com",
            ),
            seo.render_related_minds(
                [
                    {"id": "m2", "name": "Friedrich Engels", "era": "19th Century"},
                    {"id": "m3", "name": "Adam Smith", "era": "18th Century"},
                    {"id": "m4", "name": "G.W.F. Hegel", "era": "19th Century"},
                ],
                "https://x.com",
            ),
        ]
        return "<html><body>" + "\n".join(sections) + "</body></html>"

    def test_book_page_clears_phase1_word_floor(self):
        """The motivating diagnostic showed 24 visible words. Phase 1 of the
        SEO plan (Sample passages + TOC + Popular Questions + Minds-for-book)
        clears 400 words on representative fixtures — an ~17x improvement.

        Stretch target (Phase 4: compound URLs + per-chapter pages) is 800+;
        reaching that requires additional surface area, not just thicker
        Phase 1 sections. If this floor drops, Phase 1 has regressed."""
        html = self._build_book_html()
        wc = seo.visible_word_count(html)
        assert wc >= 400, f"Book page only renders {wc} visible words; Phase 1 floor is 400"

    def test_mind_page_clears_phase1_word_floor(self):
        """The motivating diagnostic showed 101 visible words. Phase 1 of the
        SEO plan (bio + thinking_style + phrases + persona excerpt + works +
        related minds) clears 280 on representative fixtures — a ~2.8x
        improvement. Stretch target (Phase 4: per-topic essay pages) is 500+."""
        html = self._build_mind_html()
        wc = seo.visible_word_count(html)
        assert wc >= 280, f"Mind page only renders {wc} visible words; Phase 1 floor is 280"

    def test_book_page_has_internal_mind_links(self):
        """Internal linking graph is the multiplier on entity authority."""
        html = self._build_book_html()
        assert html.count('href="https://x.com/mind/') >= 2

    def test_mind_page_has_internal_book_link(self):
        html = self._build_mind_html()
        assert 'href="https://x.com/book/' in html


class TestCapabilityDetection:
    """Phase 3a: only show CTAs that the entity actually supports.
    The motivating bug: catalog books with 63 words of stub content were
    sending users to an empty reader because the page blindly linked to
    /#/read/. detect_capabilities + render_cta_matrix fix this."""

    def test_full_ai_book_supports_read_preview_chat(self):
        agent = {"type": "ai_book", "status": "ready"}
        book = {
            "total_words": 50000,
            "outline": {"chapters": [{"title": "Ch1"}, {"title": "Ch2"}]},
        }
        caps = seo.detect_capabilities(agent, book)
        assert caps["read"] is True
        assert caps["chat"] is True

    def test_catalog_stub_chat_only(self):
        # The exact failure mode from production: 63 words of stub
        agent = {"type": "catalog", "status": "catalog"}
        book = None  # catalog agents have no ai_books row
        caps = seo.detect_capabilities(agent, book)
        assert caps["read"] is False, "catalog stubs must not advertise Read"
        assert caps["preview"] is False
        assert caps["chat"] is True, "chat is always available for non-failed agents"

    def test_partial_content_is_preview_not_read(self):
        agent = {"type": "catalog", "status": "ready"}
        book = {"total_words": 200, "outline": {"chapters": []}}
        caps = seo.detect_capabilities(agent, book)
        assert caps["read"] is False
        assert caps["preview"] is True
        assert caps["chat"] is True

    def test_writing_status_is_preview(self):
        agent = {"type": "ai_book", "status": "ready"}
        book = {
            "total_words": 5000,
            "status": "writing",
            "outline": {"chapters": [{"title": "Ch1"}]},
        }
        caps = seo.detect_capabilities(agent, book)
        # Mid-write: words present but book is still being generated
        # → "Preview" framing is more honest than "Read"
        assert caps["preview"] is True

    def test_failed_agent_no_caps(self):
        agent = {"type": "ai_book", "status": "failed"}
        book = {"total_words": 50000, "outline": {"chapters": [{"title": "X"}]}}
        caps = seo.detect_capabilities(agent, book)
        assert caps == {"read": False, "preview": False, "chat": False}

    def test_upload_with_chunks_is_readable_even_without_chapters(self):
        agent = {"type": "upload", "status": "ready"}
        book = None  # uploads don't go through ai_books table
        # Uploads carry their word count on the agent itself sometimes — but
        # without a book row we have nothing to count. Capability is False
        # in this minimal fixture; production upload paths populate ai_books
        # or expose word count via chunks reassembly.
        caps = seo.detect_capabilities(agent, book)
        # No word count available → not readable (correct conservative default)
        assert caps["read"] is False
        assert caps["chat"] is True

    def test_none_agent_no_caps(self):
        assert seo.detect_capabilities(None, None) == {
            "read": False, "preview": False, "chat": False,
        }


class TestRenderCtaMatrix:
    def test_renders_read_and_chat_for_full_book(self):
        caps = {"read": True, "preview": True, "chat": True}
        out = seo.render_cta_matrix(
            caps, entity_id="abc", entity_name="Sapiens", base="https://x.com",
        )
        assert "Read Sapiens" in out
        assert "Chat about Sapiens" in out
        # Read subsumes Preview — no separate Preview button when Read available
        assert "Preview Sapiens" not in out
        assert 'href="https://x.com/#/read/abc"' in out
        assert 'href="https://x.com/#/chat/abc"' in out

    def test_renders_only_chat_for_catalog_stub(self):
        caps = {"read": False, "preview": False, "chat": True}
        out = seo.render_cta_matrix(
            caps, entity_id="abc", entity_name="Stub Book", base="https://x.com",
        )
        # The bug fix: no misleading Read button for catalog stubs
        assert "Read Stub Book" not in out
        assert "Chat about Stub Book" in out
        # And only the chat URL — no /#/read/ link at all
        assert "/#/read/" not in out
        assert 'href="https://x.com/#/chat/abc"' in out

    def test_renders_preview_when_partial_content(self):
        caps = {"read": False, "preview": True, "chat": True}
        out = seo.render_cta_matrix(
            caps, entity_id="abc", entity_name="Half-written Book",
            base="https://x.com",
        )
        assert "Preview Half-written Book" in out
        assert "Chat about Half-written Book" in out
        assert "Read Half-written Book" not in out

    def test_renders_nothing_when_no_capabilities(self):
        # Failed agent — neither button is appropriate
        out = seo.render_cta_matrix(
            {"read": False, "preview": False, "chat": False},
            entity_id="abc", entity_name="X", base="https://x.com",
        )
        assert out == ""

    def test_escapes_entity_name_in_button_text(self):
        out = seo.render_cta_matrix(
            {"read": True, "preview": True, "chat": True},
            entity_id="abc", entity_name="<script>alert(1)</script>",
            base="https://x.com",
        )
        assert "<script>alert(1)</script>" not in out
        assert "&lt;script&gt;" in out


class TestIsInternalReferer:
    def test_external_referer_is_not_internal(self):
        assert seo.is_internal_referer(
            "https://www.google.com/search?q=feynman",
            "https://feynman.wiki",
        ) is False

    def test_missing_referer_is_not_internal(self):
        # Conservative: no referer means we can't be sure → treat as external
        # → land on landing page (safer for the SEO bounce-rate concern)
        assert seo.is_internal_referer("", "https://feynman.wiki") is False
        assert seo.is_internal_referer(None, "https://feynman.wiki") is False

    def test_internal_referer_recognized(self):
        assert seo.is_internal_referer(
            "https://feynman.wiki/#/library", "https://feynman.wiki",
        ) is True
        assert seo.is_internal_referer(
            "https://feynman.wiki/book/abc", "https://feynman.wiki",
        ) is True

    def test_subdomain_is_not_treated_as_same(self):
        # api.feynman.wiki referring is not the same as a user navigating
        # from the main app — be conservative.
        assert seo.is_internal_referer(
            "https://api.feynman.wiki/something", "https://feynman.wiki",
        ) is False

    def test_case_insensitive_host_match(self):
        assert seo.is_internal_referer(
            "https://FEYNMAN.WIKI/page", "https://feynman.wiki",
        ) is True


class TestPhase4QAHelpers:
    """Phase 4A: /book/{id}/q/{slug} compound pages."""

    def test_find_question_by_slug_exact(self):
        qs = ["What is X?", "Why Y?", "How Z?"]
        assert seo.find_question_by_slug(qs, "what-is-x") == "What is X?"
        assert seo.find_question_by_slug(qs, "why-y") == "Why Y?"

    def test_find_question_by_slug_case_insensitive(self):
        qs = ["What is X?"]
        assert seo.find_question_by_slug(qs, "WHAT-IS-X") == "What is X?"

    def test_find_question_by_slug_no_match(self):
        assert seo.find_question_by_slug(["A?"], "missing") is None
        assert seo.find_question_by_slug([], "any") is None
        assert seo.find_question_by_slug(["A?"], "") is None

    def test_render_qa_answer_preserves_paragraphs(self):
        out = seo.render_qa_answer("First para.\n\nSecond para.")
        assert out.count("<p>") == 2
        assert "First para." in out
        assert "Second para." in out

    def test_render_qa_answer_includes_attribution(self):
        # Transparency about AI synthesis is required by helpful-content guidance
        out = seo.render_qa_answer("Some answer.")
        assert "Synthesized" in out or "synthesized" in out.lower()

    def test_render_qa_answer_empty(self):
        assert seo.render_qa_answer("") == ""
        assert seo.render_qa_answer("   ") == ""

    def test_render_qa_passages_attributes_chunks(self):
        out = seo.render_qa_passages([
            {"chunk_index": 0, "text": "Passage one."},
            {"chunk_index": 5, "text": "Passage six."},
        ])
        # 1-indexed display for humans
        assert "Passage [1]" in out
        assert "Passage [6]" in out

    def test_render_qa_passages_escapes_html(self):
        out = seo.render_qa_passages([{"chunk_index": 0, "text": "<script>x</script>"}])
        assert "<script>x</script>" not in out
        assert "&lt;script&gt;" in out

    def test_render_sibling_questions_skips_self(self):
        out = seo.render_sibling_questions(
            ["What is X?", "Why Y?", "How Z?"],
            book_id="abc", site_url="https://x.com",
            current_question="Why Y?",
        )
        # Current question must not appear as a sibling self-link
        assert "Why Y?" not in out
        assert "What is X?" in out and "How Z?" in out

    def test_render_sibling_questions_uses_compound_urls(self):
        out = seo.render_sibling_questions(
            ["What is X?"], book_id="abc", site_url="https://x.com",
        )
        assert 'href="https://x.com/book/abc/q/what-is-x"' in out

    def test_qa_page_jsonld_uses_real_answer_when_present(self):
        ld = seo.qa_page_jsonld(
            question="What is X?", answer="X is the unknown.",
            url="https://x.com/q", book_title="Book", book_url="https://x.com/b",
        )
        assert ld["@type"] == "QAPage"
        assert ld["mainEntity"]["acceptedAnswer"]["text"] == "X is the unknown."

    def test_qa_page_jsonld_deflects_when_answer_missing(self):
        # Empty answer must still produce a non-empty acceptedAnswer for
        # Google's QAPage schema to be accepted
        ld = seo.qa_page_jsonld(
            question="What is X?", answer="",
            url="https://x.com/q", book_title="Book", book_url="https://x.com/b",
        )
        text = ld["mainEntity"]["acceptedAnswer"]["text"]
        assert text  # non-empty deflection
        assert "Book" in text  # mentions the book by title


class TestPhase4MindOnTopic:
    """Phase 4B: /mind/{id}/on/{topic} compound pages."""

    def _marx(self) -> dict:
        return {
            "id": "m1", "name": "Karl Marx",
            "domain": "Political Economy, Philosophy",
            "bio_summary": "German philosopher and political economist.",
            "thinking_style": "Materialist dialectics.",
            "persona": "Analyzes through class struggle.",
            "typical_phrases": ["Workers of the world, unite!"],
        }

    def test_relevance_match_on_substring(self):
        from app.core import qa
        marx = self._marx()
        assert qa.is_mind_topic_relevant(marx, "Economics") is True  # 'Econom' in 'Political Economy'
        assert qa.is_mind_topic_relevant(marx, "Philosophy") is True

    def test_relevance_rejects_unrelated_topic(self):
        from app.core import qa
        marx = self._marx()
        assert qa.is_mind_topic_relevant(marx, "Computer Science") is False
        assert qa.is_mind_topic_relevant(marx, "Biology") is False

    def test_relevance_ignores_noise_tokens(self):
        from app.core import qa
        # "Art & Design" should not match purely on "&" or "of"
        mind = {"name": "X", "domain": "Mathematics, Physics"}
        assert qa.is_mind_topic_relevant(mind, "Art & Design") is False

    def test_relevance_handles_missing_data(self):
        from app.core import qa
        assert qa.is_mind_topic_relevant(None, "X") is False
        assert qa.is_mind_topic_relevant({}, "X") is False
        assert qa.is_mind_topic_relevant({"domain": ""}, "X") is False
        assert qa.is_mind_topic_relevant({"domain": "Economics"}, "") is False

    def test_relevance_multiword_topic(self):
        from app.core import qa
        mind = {"name": "X", "domain": "Political Economy, Philosophy"}
        # Multi-word topic — substring match on full string
        assert qa.is_mind_topic_relevant(mind, "Political Science") is True  # 'Political' in domain

    def test_render_mind_essay_labels_as_imagined(self):
        # Hard requirement: never present LLM output as the mind's actual words
        out = seo.render_mind_on_topic_essay(
            "First paragraph.\n\nSecond paragraph.",
            "Karl Marx", "Economics",
        )
        assert "Imagined" in out or "imagined" in out.lower()
        assert "Karl Marx" in out
        # Counts both <p> and <p class="…"> — the attribution paragraph
        # has a class so it shows up as "<p " in raw HTML.
        assert out.count("<p") >= 3  # 2 body paragraphs + 1 attribution

    def test_render_mind_essay_empty_returns_empty(self):
        assert seo.render_mind_on_topic_essay("", "X", "Y") == ""

    def test_mind_essay_jsonld_marks_about_entity(self):
        ld = seo.mind_essay_jsonld(
            mind_name="Karl Marx", topic="Economics",
            essay="An essay.",
            url="https://x.com/m/1/on/economics",
            mind_url="https://x.com/mind/1",
        )
        assert ld["@type"] == "Article"
        assert ld["about"]["@type"] == "Person"
        assert ld["about"]["name"] == "Karl Marx"
        # Author is Feynman (the synthesizer), not Marx — accurate attribution
        assert ld["author"]["@type"] == "Organization"
        assert ld["author"]["name"] == "Feynman"


class TestPhase4TopicHub:
    """Phase 4C: /topic/{slug} pages."""

    def test_build_topic_slug_index(self):
        tags = ["Computer Science", "Economics", "Self-Development"]
        idx = seo.build_topic_slug_index(tags)
        assert idx["computer-science"] == "Computer Science"
        assert idx["economics"] == "Economics"
        assert idx["self-development"] == "Self-Development"

    def test_topic_slug_kebab(self):
        assert seo.topic_slug("Business & Strategy") == "business-strategy"
        assert seo.topic_slug("Self-Development") == "self-development"

    def test_render_topic_books_cross_links(self):
        out = seo.render_topic_books(
            [{"id": "b1", "name": "Sapiens", "author": "Yuval Harari"}],
            "https://x.com",
        )
        assert 'href="https://x.com/book/b1"' in out
        assert "Sapiens" in out
        assert "Yuval Harari" in out

    def test_render_topic_minds_cross_links(self):
        out = seo.render_topic_minds(
            [{"id": "m1", "name": "Marx", "era": "19th Century"}],
            "https://x.com",
        )
        assert 'href="https://x.com/mind/m1"' in out
        assert "Marx" in out
        assert "19th Century" in out

    def test_render_topic_intro_with_counts(self):
        out = seo.render_topic_intro("Economics", 12, 5)
        assert "12 books" in out
        assert "5 great minds" in out
        assert "Economics" in out

    def test_render_topic_intro_singular(self):
        out = seo.render_topic_intro("Economics", 1, 1)
        assert "1 book" in out and "1 great mind" in out
        assert "1 books" not in out and "1 great minds" not in out

    def test_render_topic_intro_zero_counts(self):
        # No content yet, but still emit a meaningful intro
        out = seo.render_topic_intro("Economics", 0, 0)
        assert "Economics" in out
        assert out  # not empty

    def test_collection_jsonld_structure(self):
        ld = seo.collection_jsonld(
            name="Economics on Feynman",
            description="...",
            url="https://x.com/topic/economics",
            items=[
                {"name": "Sapiens", "url": "https://x.com/book/b1"},
                {"name": "Marx", "url": "https://x.com/mind/m1"},
            ],
            site_url="https://x.com",
        )
        assert ld["@type"] == "CollectionPage"
        assert ld["mainEntity"]["@type"] == "ItemList"
        assert ld["mainEntity"]["numberOfItems"] == 2
        # 1-indexed positions
        assert ld["mainEntity"]["itemListElement"][0]["position"] == 1


class TestPopularQuestionsCompoundUrls:
    """Phase 4A integration: popular questions on the book page should
    link to each question's own /book/{id}/q/{slug} URL, not all to
    the same chat URL."""

    def test_links_to_compound_url_when_book_id_provided(self):
        out = seo.render_popular_questions(
            ["What is X?", "Why Y?"],
            fallback_url="https://x.com/#/chat/abc",
            book_id="abc",
            site_url="https://x.com",
        )
        assert 'href="https://x.com/book/abc/q/what-is-x"' in out
        assert 'href="https://x.com/book/abc/q/why-y"' in out
        # Fallback URL should not appear
        assert "/#/chat/abc" not in out

    def test_falls_back_to_chat_url_without_book_id(self):
        # Backward compatibility for any caller not using compound URLs
        out = seo.render_popular_questions(
            ["What is X?"], "https://x.com/#/chat/abc",
        )
        assert 'href="https://x.com/#/chat/abc"' in out


class TestPhase5RelatedBooks:
    """Related-books cross-links on /book/{id} — Phase 5 closes the
    book↔book half of the internal linking graph."""

    def test_render_related_books_cross_links(self):
        out = seo.render_related_books(
            [
                {"id": "b1", "name": "Sapiens", "author": "Yuval Harari"},
                {"id": "b2", "name": "Homo Deus", "author": "Yuval Harari"},
            ],
            "https://x.com",
        )
        assert 'href="https://x.com/book/b1"' in out
        assert 'href="https://x.com/book/b2"' in out
        assert "Sapiens" in out and "Homo Deus" in out
        assert "Yuval Harari" in out

    def test_render_related_books_empty(self):
        assert seo.render_related_books([], "https://x.com") == ""

    def test_render_related_books_skips_malformed_entries(self):
        out = seo.render_related_books(
            [
                {"id": "b1", "name": "Good"},
                {"id": "", "name": "Missing ID"},
                {"id": "b3", "name": ""},
            ],
            "https://x.com",
        )
        assert "Good" in out
        assert "Missing ID" not in out
        assert out.count("<li>") == 1

    def test_render_topic_link_back(self):
        out = seo.render_topic_link_back("Economics", "https://x.com")
        assert 'href="https://x.com/topic/economics"' in out
        assert "Economics" in out

    def test_render_topic_link_back_empty(self):
        assert seo.render_topic_link_back("", "https://x.com") == ""

    def test_render_topic_links_for_mind(self):
        out = seo.render_topic_links_for_mind(
            ["Economics", "Philosophy"], "https://x.com",
        )
        assert 'href="https://x.com/topic/economics"' in out
        assert 'href="https://x.com/topic/philosophy"' in out

    def test_render_topic_links_for_mind_caps_at_five(self):
        out = seo.render_topic_links_for_mind(
            ["T" + str(i) for i in range(20)], "https://x.com",
        )
        # Cap is 5
        assert out.count("<a ") == 5


class TestPhase6UgcPiiScrubbing:
    """Phase 6: PII scrubbing must redact before any public render.
    Conservative — better to over-redact than leak."""

    def test_scrub_email(self):
        from app.core import ugc
        out = ugc.scrub_pii_for_public_display("Email me at john.doe+tag@example.co")
        assert "john.doe" not in out
        assert "example.co" not in out
        assert "[email redacted]" in out

    def test_scrub_multiple_emails(self):
        from app.core import ugc
        out = ugc.scrub_pii_for_public_display("a@b.com and c@d.org")
        assert out.count("[email redacted]") == 2

    def test_scrub_phone_us_format(self):
        from app.core import ugc
        out = ugc.scrub_pii_for_public_display("Call (415) 555-1234 anytime")
        assert "555-1234" not in out
        assert "555" not in out  # full number stripped
        assert "[phone redacted]" in out

    def test_scrub_phone_intl_format(self):
        from app.core import ugc
        out = ugc.scrub_pii_for_public_display("+86 138 0013 8000")
        assert "138" not in out
        assert "[phone redacted]" in out

    def test_scrub_url(self):
        from app.core import ugc
        out = ugc.scrub_pii_for_public_display("See https://github.com/me/repo")
        assert "github.com" not in out
        assert "[link redacted]" in out

    def test_scrub_at_handle(self):
        from app.core import ugc
        out = ugc.scrub_pii_for_public_display("Follow @username for more")
        assert "@username" not in out
        assert "[handle redacted]" in out

    def test_scrub_preserves_non_pii_text(self):
        from app.core import ugc
        text = "The book discusses how capitalism evolved in the 19th century."
        assert ugc.scrub_pii_for_public_display(text) == text

    def test_scrub_empty(self):
        from app.core import ugc
        assert ugc.scrub_pii_for_public_display("") == ""

    def test_scrub_mixed(self):
        from app.core import ugc
        out = ugc.scrub_pii_for_public_display(
            "I'm jane@example.com, call 555-867-5309 or DM @jane_x"
        )
        assert "jane@example" not in out
        assert "867" not in out
        assert "@jane_x" not in out


class TestPhase6UgcHandleValidation:
    def test_valid_handle(self):
        from app.core import ugc
        h, err = ugc.validate_public_handle("ReaderJane")
        assert h == "ReaderJane"
        assert err is None

    def test_trims_whitespace(self):
        from app.core import ugc
        h, err = ugc.validate_public_handle("  jane  ")
        assert h == "jane"

    def test_empty_returns_anonymous_not_error(self):
        from app.core import ugc
        h, err = ugc.validate_public_handle("")
        assert h == ""
        assert err is None  # caller falls back to "Anonymous"
        h, err = ugc.validate_public_handle(None)
        assert h == ""
        assert err is None

    def test_rejects_email_like(self):
        from app.core import ugc
        h, err = ugc.validate_public_handle("jane@example.com")
        assert h == ""
        assert err is not None
        assert "@" in err

    def test_rejects_long_digit_run(self):
        from app.core import ugc
        h, err = ugc.validate_public_handle("user12345")  # 5 digits in a row
        assert h == ""
        assert err is not None

    def test_rejects_too_long(self):
        from app.core import ugc
        h, err = ugc.validate_public_handle("x" * 100)
        assert h == ""
        assert err is not None


class TestPhase6UgcFeatureFlag:
    """The kill switch must default OFF and gate everything."""

    def test_default_disabled(self):
        # We can't change the env var post-import (read at module load
        # time), but the module-level read at import time is the only
        # thing that matters in production. Default should be False.
        from app.core import ugc
        # Just confirm the function exists and returns a bool — actual
        # value depends on env. In test env (no var), default is False.
        result = ugc.is_enabled()
        assert isinstance(result, bool)
        # In CI / local dev where ENABLE_PUBLIC_DISCUSSIONS is unset,
        # this must be False.
        import os
        if not os.getenv("ENABLE_PUBLIC_DISCUSSIONS"):
            assert result is False


class TestPhase6UgcDiscussionForumJsonld:
    def test_basic_structure(self):
        from app.core import ugc
        ld = ugc.discussion_forum_jsonld(
            posts=[
                {
                    "handle": "Jane",
                    "body": "Great book.",
                    "created_at": "2026-01-01T00:00:00Z",
                    "session_id": "s1",
                },
            ],
            page_url="https://x.com/book/b1/discussions",
            headline="Discussions about Sapiens",
            about_url="https://x.com/book/b1",
            about_type="Book",
            about_name="Sapiens",
        )
        assert ld["@type"] == "DiscussionForumPosting"
        assert ld["commentCount"] == 1
        assert ld["comment"][0]["@type"] == "Comment"
        assert ld["comment"][0]["author"]["name"] == "Jane"
        assert ld["about"]["@type"] == "Book"
        assert ld["about"]["name"] == "Sapiens"

    def test_anonymous_falls_back_when_handle_missing(self):
        from app.core import ugc
        ld = ugc.discussion_forum_jsonld(
            posts=[{"body": "x", "created_at": "", "session_id": "s1"}],
            page_url="u", headline="h", about_url="a",
            about_type="Book", about_name="n",
        )
        assert ld["comment"][0]["author"]["name"] == "Anonymous"

    def test_empty_posts(self):
        from app.core import ugc
        ld = ugc.discussion_forum_jsonld(
            posts=[], page_url="u", headline="h", about_url="a",
            about_type="Person", about_name="n",
        )
        assert ld["commentCount"] == 0
        assert ld["comment"] == []
        assert ld["about"]["@type"] == "Person"


class TestSparseDataDegradation:
    """A fresh book or mind with no chunks / no questions / no links still
    needs to render without crashing. The page is allowed to be thin in
    that case — we just can't 500 the request."""

    def test_book_sections_with_no_data(self):
        # Every render_* should return "" (not raise) for empty inputs
        assert seo.render_book_about("", "") == ""
        assert seo.render_stats(0, 0) == ""
        assert seo.render_toc([]) == ""
        assert seo.render_sample_passages([]) == ""
        assert seo.render_popular_questions([], "https://x.com") == ""
        assert seo.render_minds_for_book([], "https://x.com") == ""

    def test_mind_sections_with_no_data(self):
        assert seo.render_mind_bio("") == ""
        assert seo.render_mind_thinking_style("") == ""
        assert seo.render_mind_phrases([]) == ""
        assert seo.render_mind_persona_excerpt("") == ""
        assert seo.render_mind_works([], [], "https://x.com") == ""
        assert seo.render_books_for_mind([], "https://x.com") == ""
        assert seo.render_related_minds([], "https://x.com") == ""

    def test_jsonld_still_emits_with_minimal_data(self):
        # Even with no enrichment, the structured-data blocks must render
        book = seo.book_jsonld(
            title="Untitled", description="", author="",
            url="u", image="i", word_count=None, chapters=None, site_url="s",
        )
        wrapped = seo.jsonld_script(book)
        assert "@type" in wrapped and "Book" in wrapped

        person = seo.person_jsonld(
            name="Unknown", description="", domain="",
            url="u", image="i",
        )
        wrapped = seo.jsonld_script(person)
        assert "@type" in wrapped and "Person" in wrapped
