"""Catalog recommendation results and limits must hold at the SQL boundary."""

import json
import sqlite3
from contextlib import contextmanager

import pytest

from app.core import db


@pytest.fixture
def catalog(monkeypatch):
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    conn.execute("CREATE TABLE agents (id TEXT, name TEXT, slug TEXT, type TEXT, "
                 "status TEXT, is_deleted INTEGER, created_at TEXT, meta_json TEXT)")

    @contextmanager
    def get_conn():
        yield conn

    monkeypatch.setattr(db, "_USE_PG", False)
    monkeypatch.setattr(db, "get_conn", get_conn)
    # Calling the old full-list path would defeat the egress bound.
    monkeypatch.setattr(db, "list_agents", lambda **kwargs: pytest.fail("Full catalog read"))

    def add(id, category="Economics", author="Author", status="ready", deleted=0, created="2026-01-01"):
        conn.execute("INSERT INTO agents VALUES (?, ?, ?, 'book', ?, ?, ?, ?)",
                     (id, id, id, status, deleted, created,
                      json.dumps({"category": category, "author": author, "overview": "x" * 5000})))
    yield add
    conn.close()


def test_topic_filters_deleted_status_case_and_enforces_limit(catalog):
    catalog("valid", category=" Economics ")
    catalog("newest", created="2026-02-01", status="catalog")
    catalog("deleted", deleted=1)
    catalog("indexing", status="indexing")
    catalog("other", category="Physics")
    rows = db.list_books_by_topic(" ECONOMICS ", limit=1)
    assert rows == [{"id": "newest", "name": "newest", "type": "book", "author": "Author"}]
    assert len(db.list_books_by_topic("economics", limit=30)) == 2


def test_related_topic_priority_author_fallback_and_no_duplicates(catalog):
    catalog("source")
    catalog("both", created="2026-03-01")
    catalog("topic", author="Other")
    catalog("author", category="Physics", created="2026-04-01")
    catalog("unrelated", category="Physics", author="Other")
    rows = db.list_related_books("source", "ECONOMICS", "author", limit=3)
    assert [row["id"] for row in rows] == ["both", "topic", "author"]
    assert set(rows[0]) == {"id", "name", "slug", "type", "author"}
    assert len(db.list_related_books("source", "Economics", "Author", limit=2)) == 2


def test_author_only_and_empty_inputs(catalog):
    catalog("match")
    assert db.list_related_books("source", author=" AUTHOR ")[0]["id"] == "match"
    assert db.list_related_books("source") == []
    assert db.list_related_books("") == []
    assert db.list_books_by_topic(" ") == []
    assert db.list_books_by_topic("Economics", limit=0) == []


def test_matches_beyond_former_2000_row_catalog_cap(catalog):
    catalog("older-match", category="Rare", created="2025-01-01")
    for i in range(2001):
        catalog(f"unrelated-{i}")
    assert db.list_books_by_topic("Rare")[0]["id"] == "older-match"
