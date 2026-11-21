"""Database row-activity diagnostics; these counters do not measure egress bytes."""

from __future__ import annotations

from html import escape
from typing import Any


def collect_snapshot() -> dict[str, Any]:
    from .db import get_conn, _fetchone, _fetchall

    with get_conn() as conn:
        meta = _fetchone(conn, "SELECT current_database() AS database, "
                         "now() AS sampled_at, pg_database_size(current_database()) AS db_bytes")
        reset = _fetchone(conn, "SELECT stats_reset FROM pg_stat_statements_info")
        rows = _fetchall(conn,
            "SELECT userid, queryid::text AS queryid, calls, rows, "
            "left(regexp_replace(query, '\\s+', ' ', 'g'), 600) AS query "
            "FROM pg_stat_statements WHERE dbid = "
            "(SELECT oid FROM pg_database WHERE datname = current_database()) "
            "AND toplevel AND queryid IS NOT NULL")
        # A reset during collection makes this sample unsuitable for comparison.
        reset_after = _fetchone(conn, "SELECT stats_reset FROM pg_stat_statements_info")
    return {
        "schema_version": 2,
        "database": meta["database"],
        "sampled_at": str(meta["sampled_at"]),
        "stats_reset": str(reset_after["stats_reset"]),
        "collection_reset": reset != reset_after,
        "db_bytes": int(meta["db_bytes"]),
        "total_rows": sum(int(row["rows"]) for row in rows),
        "total_calls": sum(int(row["calls"]) for row in rows),
        "statements": {
            f"{row['userid']}:{row['queryid']}": {
                "rows": int(row["rows"]), "calls": int(row["calls"]),
                "query": row["query"],
            } for row in rows
        },
    }


def stored_snapshot(snapshot: dict[str, Any]) -> dict[str, Any]:
    """Persist counters only; SQL text is unnecessary baseline payload."""
    return {**snapshot, "statements": {
        key: {"rows": row["rows"], "calls": row["calls"]}
        for key, row in snapshot["statements"].items()
    }}


def compare_snapshots(current: dict[str, Any], previous: dict[str, Any]) -> dict[str, Any]:
    result: dict[str, Any] = {
        "rows_delta": None, "calls_delta": None, "top_queries": [],
        "interval_start": previous.get("sampled_at"),
        "interval_end": current["sampled_at"], "partial": False,
        "baseline_reason": None,
    }
    if previous.get("schema_version") != 2 or previous.get("database") != current["database"]:
        result["baseline_reason"] = "New database-scoped statement baseline"
        return result
    if (current["collection_reset"] or previous.get("collection_reset")
            or previous.get("stats_reset") != current["stats_reset"]):
        result["baseline_reason"] = "PostgreSQL statement statistics were reset"
        return result
    old = previous["statements"]
    changes = []
    result["partial"] = bool(old.keys() - current["statements"].keys())
    for key, row in current["statements"].items():
        prior = old.get(key, {"rows": 0, "calls": 0})
        rows_delta = row["rows"] - prior["rows"]
        calls_delta = row["calls"] - prior["calls"]
        if rows_delta < 0 or calls_delta < 0:
            result["partial"] = True
            continue
        changes.append({"rows_delta": rows_delta, "calls_delta": calls_delta,
                        "query": row["query"]})
    result["rows_delta"] = sum(row["rows_delta"] for row in changes)
    result["calls_delta"] = sum(row["calls_delta"] for row in changes)
    result["top_queries"] = sorted(
        (row for row in changes if row["rows_delta"]),
        key=lambda row: row["rows_delta"], reverse=True,
    )[:6]
    return result


def render_alert(snapshot: dict[str, Any], interval: dict[str, Any],
                 alerts: list[str], db_limit: int, db_label: str) -> str:
    pct = round(100 * snapshot["db_bytes"] / db_limit, 1)
    queries = "".join(
        f"<li><code>calls_delta={row['calls_delta']:,} "
        f"rows_delta={row['rows_delta']:,}</code> — {escape(row['query'])}</li>"
        for row in interval["top_queries"]
    )
    note = ""
    if interval["baseline_reason"]:
        note = f"<p>{escape(interval['baseline_reason'])}; no interval row alert on this run.</p>"
    elif interval["partial"]:
        note = ("<p>Some statements were evicted or their counters restarted; "
                "interval totals may undercount activity.</p>")
    return (
        "<h3>Feynman database activity watch</h3><ul>"
        + "".join(f"<li>{escape(alert)}</li>" for alert in alerts) + "</ul>"
        f"<p>DB size: {snapshot['db_bytes'] / 1024**2:,.1f} MiB / "
        f"{db_limit / 1024**2:,.1f} MiB ({escape(db_label)}; {pct}%).</p>"
        f"<p>Interval (UTC): {escape(interval['interval_start'] or 'baseline unavailable')} "
        f"to {escape(interval['interval_end'])}.</p>"
        + note
        + f"<p>Top queries by rows returned or affected in this interval:</p><ul>{queries}</ul>"
        f"<p>Cumulative counters for this database only: {snapshot['total_rows']:,} rows "
        f"over {snapshot['total_calls']:,} calls. These are not interval totals.</p>"
        "<p>Row counts are an activity proxy, not transferred bytes or proof of an egress "
        "overage. Check Supabase Usage, including Shared Pooler Egress, for actual GB. "
        "Inspect the interval queries for unnecessary rows and wide columns.</p>"
    )
