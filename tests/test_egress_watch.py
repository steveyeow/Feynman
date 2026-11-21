"""Regression coverage for interval attribution and alert measurement labels."""

from copy import deepcopy
from unittest.mock import Mock

import pytest

from app.core.egress_watch import compare_snapshots, render_alert, stored_snapshot


def snapshot(statements, **overrides):
    return {
        "schema_version": 2, "database": "postgres", "sampled_at": "2026-11-21 08:00:00+00:00",
        "stats_reset": "2026-06-10", "collection_reset": False,
        "db_bytes": 2693 * 1024**2, "total_rows": 300_000_000, "total_calls": 1_000_000,
        "statements": {key: {"rows": rows, "calls": calls, "query": query}
                       for key, rows, calls, query in statements}, **overrides,
    }


def test_rank_by_interval_growth_instead_of_historical_size():
    previous = snapshot([("old", 250_000_000, 1000, "SELECT old"),
                         ("spike", 20, 1, "SELECT spike")])
    current = snapshot([("old", 250_000_010, 1001, "SELECT old"),
                        ("spike", 10_704_839, 4, "SELECT spike")])
    report = compare_snapshots(current, stored_snapshot(previous))
    assert report["rows_delta"] == 10_704_829
    assert report["calls_delta"] == 4
    assert report["top_queries"][0]["query"] == "SELECT spike"


@pytest.mark.parametrize("previous", [{}, {"total_rows": 277_774_366},
                                      snapshot([], database="other")])
def test_first_run_and_old_schema_rebaseline_without_false_spike(previous):
    current = snapshot([("huge", 250_000_000, 1000, "SELECT huge")])
    report = compare_snapshots(current, previous)
    assert report["rows_delta"] is None
    assert report["baseline_reason"]


def test_statistics_reset_is_not_a_new_traffic_spike():
    previous = snapshot([("a", 100, 1, "SELECT a")])
    current = snapshot([("a", 10_000_000, 100, "SELECT a")], stats_reset="new")
    assert compare_snapshots(current, previous)["rows_delta"] is None
    current["stats_reset"] = previous["stats_reset"]
    current["collection_reset"] = True
    assert compare_snapshots(current, previous)["rows_delta"] is None


def test_eviction_does_not_cancel_growth_in_other_statements():
    previous = snapshot([("evicted", 10_000_000, 100, "SELECT old"),
                         ("restarted", 1000, 100, "SELECT reset"),
                         ("growing", 10, 1, "SELECT growing")])
    current = snapshot([("restarted", 1, 1, "SELECT reset"),
                        ("growing", 60, 2, "SELECT growing"),
                        ("new", 500, 1, "SELECT new")])
    report = compare_snapshots(current, previous)
    assert report["rows_delta"] == 550
    assert report["partial"]


def test_email_uses_configured_capacity_and_interval_and_escapes_sql():
    current = snapshot([("a", 200, 2, "SELECT '<script>'")])
    report = compare_snapshots(current, snapshot([("a", 100, 1, "SELECT a")]))
    html = render_alert(current, report, ["alert <check>"], 8 * 1024**3, "8 GiB Pro")
    assert "8,192.0 MiB" in html
    assert "32.9%" in html
    assert "500 MB" not in html
    assert "rows_delta=100" in html
    assert "not transferred bytes" in html
    assert "<script>" not in html
    assert "&lt;script&gt;" in html


def test_cron_dry_run_does_not_advance_baseline_or_send_email(monkeypatch):
    import json
    from starlette.requests import Request
    from app import main
    from app.core import db, egress_watch, notify

    old = snapshot([("a", 0, 0, "SELECT a")])
    current = snapshot([("a", 20_000_000, 100, "SELECT a")])
    monkeypatch.setattr(db, "_USE_PG", True)
    monkeypatch.setattr(egress_watch, "collect_snapshot", lambda: deepcopy(current))
    monkeypatch.setattr(db, "ops_state_get", lambda key: json.dumps(stored_snapshot(old)))
    write = Mock()
    send = Mock()
    monkeypatch.setattr(db, "ops_state_set", write)
    monkeypatch.setattr(notify, "send_alert_email", send)
    monkeypatch.setattr(main, "_CRON_SECRET", "secret")
    request = Request({"type": "http", "query_string": b"dry_run=1&test=1",
                       "headers": [(b"authorization", b"Bearer secret")]})
    report = main.api_cron_egress_watch(request)
    assert report["status"] == "dry_run"
    assert report["would_alert"]
    assert report["top_queries"][0]["rows_delta"] == 20_000_000
    write.assert_not_called()
    send.assert_not_called()


def test_cron_still_checks_capacity_during_baseline_migration(monkeypatch):
    from starlette.requests import Request
    from app import main
    from app.core import db, egress_watch, notify

    current = snapshot([], db_bytes=8 * 1024**3)
    monkeypatch.setattr(db, "_USE_PG", True)
    monkeypatch.setattr(egress_watch, "collect_snapshot", lambda: current)
    monkeypatch.setattr(db, "ops_state_get", lambda key: '{"total_rows": 277774366}')
    write = Mock()
    send = Mock(return_value=False)
    monkeypatch.setattr(db, "ops_state_set", write)
    monkeypatch.setattr(notify, "send_alert_email", send)
    monkeypatch.setattr(main, "_CRON_SECRET", "")
    report = main.api_cron_egress_watch(Request({"type": "http", "query_string": b"", "headers": []}))
    assert report["status"] == "alert_failed"
    assert report["rows_delta"] is None
    assert len(report["alerts"]) == 1
    write.assert_called_once()
    send.assert_called_once()
