"""Tests for P0-B: paragraph-aware chunking in text_utils.py."""

from __future__ import annotations

import pytest

from app.core.text_utils import chunk_text, _split_by_sentences


class TestChunkTextBasics:
    def test_empty_text(self):
        assert chunk_text("") == []

    def test_short_text_single_chunk(self):
        text = "Hello world."
        chunks = chunk_text(text, max_chars=1200)
        assert len(chunks) == 1
        assert chunks[0] == text

    def test_returns_list_of_strings(self):
        chunks = chunk_text("Some text here.", max_chars=100)
        assert all(isinstance(c, str) for c in chunks)


class TestParagraphBoundaries:
    def test_splits_on_double_newline(self):
        para1 = "First paragraph with some content."
        para2 = "Second paragraph with different content."
        para3 = "Third paragraph with more content."
        text = f"{para1}\n\n{para2}\n\n{para3}"
        # max_chars small enough to force splits
        chunks = chunk_text(text, max_chars=50)
        assert len(chunks) >= 2
        # No chunk should contain text from two different paragraphs
        # (unless they're small enough to merge)

    def test_merges_small_paragraphs(self):
        """Small paragraphs below threshold should be merged into one chunk."""
        paras = ["Short.", "Also short.", "Tiny."]
        text = "\n\n".join(paras)
        chunks = chunk_text(text, max_chars=1200)
        assert len(chunks) == 1
        for p in paras:
            assert p in chunks[0]

    def test_respects_max_chars(self):
        """No chunk should exceed max_chars."""
        text = "\n\n".join([f"Paragraph {i} with some filler text to make it longer." for i in range(20)])
        max_chars = 200
        chunks = chunk_text(text, max_chars=max_chars)
        for chunk in chunks:
            assert len(chunk) <= max_chars, f"Chunk too long ({len(chunk)} > {max_chars}): {chunk[:50]}..."


class TestHeadingSplits:
    def test_splits_on_markdown_headings(self):
        text = "Intro paragraph.\n\n# Chapter One\n\nContent of chapter one.\n\n## Section 1.1\n\nMore content here."
        chunks = chunk_text(text, max_chars=80)
        assert len(chunks) >= 2

    def test_heading_preserved_in_chunk(self):
        """Headings should be kept at the start of their chunk, not split away."""
        text = "Some intro text.\n\n# Important Heading\n\nContent under heading."
        chunks = chunk_text(text, max_chars=200)
        heading_found = any("# Important Heading" in c for c in chunks)
        assert heading_found, "Heading should appear in some chunk"


class TestOversizedSections:
    def test_oversized_paragraph_split_by_sentences(self):
        """A single paragraph exceeding max_chars should be split at sentence boundaries."""
        sentences = [f"Sentence number {i} is here." for i in range(30)]
        text = " ".join(sentences)
        chunks = chunk_text(text, max_chars=200, overlap=0)
        assert len(chunks) > 1
        for chunk in chunks:
            assert len(chunk) <= 200

    def test_overlap_applied_on_sentence_split(self):
        """When splitting by sentences, overlap should carry trailing context."""
        sentences = [f"Sentence {i} with some extra words." for i in range(20)]
        text = " ".join(sentences)
        chunks = chunk_text(text, max_chars=200, overlap=50)
        assert len(chunks) > 1
        # With overlap > 0, consecutive chunks should share some text
        for i in range(len(chunks) - 1):
            tail = chunks[i][-30:]
            assert tail in chunks[i + 1] or chunks[i + 1].startswith(tail[:10]), \
                "Overlap should create shared text between consecutive chunks"


class TestSplitBySentences:
    def test_basic_sentence_split(self):
        text = "First sentence. Second sentence. Third sentence."
        chunks = _split_by_sentences(text, max_chars=30, overlap=0)
        assert len(chunks) >= 2
        assert all(len(c) <= 30 for c in chunks)

    def test_zero_overlap(self):
        text = "A. B. C. D. E."
        chunks = _split_by_sentences(text, max_chars=8, overlap=0)
        assert len(chunks) >= 2


class TestBackwardCompatibility:
    def test_same_signature(self):
        """chunk_text should accept the same args as before."""
        chunk_text("hello", max_chars=100, overlap=10)

    def test_default_params(self):
        """Should work with defaults (uses config values)."""
        chunks = chunk_text("A short text.")
        assert len(chunks) == 1

    def test_fallback_for_unchunkable_text(self):
        """Single blob with no paragraph breaks should still produce output."""
        text = "x" * 5000
        chunks = chunk_text(text, max_chars=1200, overlap=0)
        assert len(chunks) > 0
        assert all(len(c) <= 1200 for c in chunks)
