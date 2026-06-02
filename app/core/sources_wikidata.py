"""Wikidata SPARQL client — discover famous-thinker candidates for the
mind agent expansion.

Why this exists
---------------
We have 50 mind agents in production. Wikipedia has ~10K notable
thinkers / scientists / philosophers / writers with full English bios.
The expansion goal is: pick the ~1000 most notable across our 15
TOPIC_TAGS domains, generate persona + Type-2 essays per mind, surface
on /mind/{id} and /mind/{id}/on/{topic}.

Wikidata is the structured-data layer for Wikipedia. SPARQL endpoint
is at https://query.wikidata.org/sparql — public, no auth, generous
rate limits (1 req/sec sustained, brief bursts higher).

What this returns
-----------------
For a given occupation/domain category, a list of:
    {
      "qid":          "Q9061"               # wikidata id
      "name":         "Karl Marx"           # English label
      "description":  "German philosopher…" # short blurb
      "bio_summary":  "<first paragraph of EN Wikipedia article>"
      "domain":       "Philosophy"          # mapped to our TOPIC_TAG
      "wikipedia_url":"https://en.wikipedia.org/wiki/Karl_Marx"
      "wikidata_url": "https://www.wikidata.org/wiki/Q9061"
      "image":        "https://commons.wikimedia.org/.../Marx.jpg"
      "birth_year":   1818
      "death_year":   1883
    }

The Wikipedia first-paragraph fetch is a separate REST API call (the
SPARQL response itself doesn't carry article body). We cache locally
via _wikipedia_intro to keep mass-fetching cheap.

Mapping Wikidata occupation QIDs to our 15 TOPIC_TAGS lives in
``DOMAIN_QUERIES`` below — each entry is a (TOPIC_TAG, SPARQL-fragment)
pair scoring famous occupants of that field. Tweak the filters there
to broaden / narrow the candidate pool per domain.
"""
from __future__ import annotations

import json
import logging
import os
import time
from typing import Any

log = logging.getLogger(__name__)

_WD_SPARQL = "https://query.wikidata.org/sparql"
# The MediaWiki action API (CirrusSearch + wbgetentities) — a SEPARATE service
# from the SPARQL query service (WDQS), so it stays up during WDQS outages. Used
# as the discovery fallback so mind expansion isn't blocked by WDQS rate limits.
_WD_ACTION = "https://www.wikidata.org/w/api.php"
# "auto" (default): try SPARQL, fall back to the action API on failure. "action":
# skip SPARQL entirely (use when WDQS is known-down). "sparql": SPARQL only.
_DISCOVERY_MODE = os.getenv("WIKIDATA_DISCOVERY", "auto").strip().lower()
_WP_REST = "https://en.wikipedia.org/api/rest_v1/page/summary"
_UA = "Feynman/1.0 (https://feynman.wiki; sequoiayao@gmail.com)"
_CACHE_DIR = "/tmp/feynman_wikidata_cache"

# Wikidata occupation QIDs mapped to our TOPIC_TAGS. Each query fetches
# people of that occupation, ranked by Wikipedia article quality
# (sitelinks count is a rough fame proxy — articles people across many
# languages bother to translate are notable by definition).
#
# Filter conditions held in common:
#   - has English Wikipedia article (we need EN bio)
#   - died before 2010 OR is widely cited as a "historical figure"
#     (helps avoid living celebrities + ambiguous early-career people)
DOMAIN_QUERIES: dict[str, str] = {
    # Psychology — occupation = psychologist (Q212238)
    "Psychology": "Q212238",
    # Philosophy — occupation = philosopher (Q4964182)
    "Philosophy": "Q4964182",
    # Economics — occupation = economist (Q188094)
    "Economics": "Q188094",
    # Physics — occupation = physicist (Q169470)
    "Physics": "Q169470",
    # Computer Science — occupation = computer scientist (Q82594)
    "Computer Science": "Q82594",
    # Biology — occupation = biologist (Q864503)
    "Biology": "Q864503",
    # History — occupation = historian (Q201788)
    "History": "Q201788",
    # Mathematics — occupation = mathematician (Q170790)
    "Mathematics": "Q170790",
    # Business & Strategy — occupation = entrepreneur (Q131524)
    "Business & Strategy": "Q131524",
    # Neuroscience — occupation = neuroscientist (Q15976092)
    "Neuroscience": "Q15976092",
    # Literature — occupation = writer (Q36180)
    "Literature": "Q36180",
    # Political Science — occupation = political scientist (Q121594)
    "Political Science": "Q121594",
    # Sociology — occupation = sociologist (Q2306091)
    "Sociology": "Q2306091",
    # Art & Design — occupation = artist (Q483501)
    "Art & Design": "Q483501",
    # Self-Development — overlaps Business & Strategy. Skip dedicated
    # query to avoid double-counting the same Jim-Collins-class figures.
}


def _http_get(url: str, params: dict[str, str] | None = None,
              headers: dict[str, str] | None = None, timeout: int = 60,
              retries: int = 2) -> Any:
    """Thin wrapper — lazy-imports httpx so this module stays importable
    even when sources_wikidata isn't actually used. The Wikidata Query
    Service is slow + flaky under load, so we use a generous timeout and
    retry transient failures with backoff."""
    import httpx
    h = {"User-Agent": _UA, "Accept": "application/json"}
    if headers:
        h.update(headers)
    last_exc: Exception | None = None
    for attempt in range(retries + 1):
        try:
            with httpx.Client(timeout=timeout, follow_redirects=True) as c:
                r = c.get(url, params=params or {}, headers=h)
            r.raise_for_status()
            return r.json()
        except Exception as exc:  # timeout, 5xx, connection reset…
            last_exc = exc
            if attempt < retries:
                time.sleep(2 * (attempt + 1))
    raise last_exc  # type: ignore[misc]


def _cache_path(key: str) -> str:
    os.makedirs(_CACHE_DIR, exist_ok=True)
    safe = "".join(ch if ch.isalnum() or ch in ".-_" else "_" for ch in key)
    return os.path.join(_CACHE_DIR, f"{safe}.json")


def _cached_or_fetch(key: str, fetcher) -> Any:
    """Persistent-disk cache for Wikidata/Wikipedia responses. Mass-
    expansion is cheap on disk but expensive on Wikidata's API. One
    fetch per (key) for the lifetime of /tmp."""
    p = _cache_path(key)
    if os.path.exists(p):
        try:
            with open(p) as f:
                return json.load(f)
        except Exception:
            pass
    out = fetcher()
    try:
        with open(p, "w") as f:
            json.dump(out, f)
    except Exception:
        pass
    return out


def query_thinkers(occupation_qid: str, limit: int = 50) -> list[dict[str, Any]]:
    """SPARQL: top-N most notable people with this occupation.

    Notable = highest count of Wikipedia language-sitelinks (a robust
    fame proxy that doesn't depend on subjective metrics).
    """
    sparql = f"""
    SELECT ?p ?pLabel ?pDescription ?birth ?death ?image ?article ?sitelinks
    WHERE {{
      ?p wdt:P106 wd:{occupation_qid} .
      ?article schema:about ?p ;
               schema:isPartOf <https://en.wikipedia.org/> .
      ?p wikibase:sitelinks ?sitelinks .
      OPTIONAL {{ ?p wdt:P569 ?birth . }}
      OPTIONAL {{ ?p wdt:P570 ?death . }}
      OPTIONAL {{ ?p wdt:P18 ?image . }}
      SERVICE wikibase:label {{ bd:serviceParam wikibase:language "en". }}
    }}
    ORDER BY DESC(?sitelinks)
    LIMIT {limit}
    """
    data = _cached_or_fetch(
        f"sparql_{occupation_qid}_{limit}",
        lambda: _http_get(_WD_SPARQL, params={"query": sparql, "format": "json"}),
    )
    out = []
    for binding in data.get("results", {}).get("bindings", []):
        qid_url = binding.get("p", {}).get("value", "")
        qid = qid_url.rsplit("/", 1)[-1] if qid_url else ""
        if not qid:
            continue
        article = binding.get("article", {}).get("value", "")
        # Slug from article URL: /wiki/Karl_Marx → Karl_Marx
        slug = article.rsplit("/", 1)[-1] if article else ""
        out.append({
            "qid": qid,
            "name": binding.get("pLabel", {}).get("value", ""),
            "description": binding.get("pDescription", {}).get("value", ""),
            "birth": binding.get("birth", {}).get("value", "")[:10],
            "death": binding.get("death", {}).get("value", "")[:10],
            "image": binding.get("image", {}).get("value", ""),
            "wikipedia_url": article,
            "wikidata_url": f"https://www.wikidata.org/wiki/{qid}",
            "wikipedia_slug": slug,
            "sitelinks": int(binding.get("sitelinks", {}).get("value", 0)),
        })
    return out


def _claim_year(claims: dict[str, Any], prop: str) -> str:
    """Best-effort 'YYYY-MM-DD' from a Wikidata time claim (P569 birth / P570
    death), or '' if absent/unparseable."""
    try:
        t = claims[prop][0]["mainsnak"]["datavalue"]["value"]["time"]  # "+1856-05-06T00:00:00Z"
        return t[1:11]
    except Exception:
        return ""


def query_thinkers_via_action(occupation_qid: str, limit: int = 50) -> list[dict[str, Any]]:
    """WDQS-FREE discovery: find people with this occupation via the Wikidata
    CirrusSearch action API (`haswbstatement:P106={qid}`) — a DIFFERENT service
    from the SPARQL endpoint, so it works during WDQS outages. A drop-in fallback
    with the same candidate shape as query_thinkers().

    Quality: CirrusSearch can't sort by sitelinks, so we pull a BROADER pool
    (incoming-links order), then RE-RANK by sitelink count (SPARQL's notability
    metric) and gate to humans (P31=Q5, kills test entities like 'Wikidata
    Sandbox') with an English Wikipedia article. NOTE: Wikidata's own P106 data
    is noisy (e.g. botanists tagged 'political scientist'), so action-mode
    candidates are noisier than SPARQL's — always review an expand_minds
    --dry-run before --apply."""
    pool = min(max(limit * 4, 50), 200)
    search = _cached_or_fetch(
        f"wdsearch_{occupation_qid}_{pool}",
        lambda: _http_get(_WD_ACTION, params={
            "action": "query", "list": "search",
            "srsearch": f"haswbstatement:P106={occupation_qid}",
            "srsort": "incoming_links_desc", "srlimit": str(pool),
            "format": "json",
        }),
    )
    qids = [h.get("title") for h in (search.get("query", {}).get("search") or [])
            if (h.get("title") or "").startswith("Q")]
    if not qids:
        return []
    # Hydrate in batches of 50 (wbgetentities cap). props=sitelinks (no /urls →
    # smaller) gives every language sitelink, so len() is the notability count.
    entities: dict[str, Any] = {}
    for i in range(0, len(qids), 50):
        batch = qids[i:i + 50]
        data = _cached_or_fetch(
            f"wdent_{occupation_qid}_{i}_{len(batch)}",
            lambda b=batch: _http_get(_WD_ACTION, params={
                "action": "wbgetentities", "ids": "|".join(b),
                "props": "labels|descriptions|sitelinks|claims",
                "languages": "en", "format": "json",
            }),
        )
        entities.update(data.get("entities", {}) or {})

    out: list[dict[str, Any]] = []
    for qid in qids:
        ent = entities.get(qid) or {}
        claims = ent.get("claims") or {}
        p31 = [((c.get("mainsnak") or {}).get("datavalue") or {}).get("value", {}).get("id")
               for c in (claims.get("P31") or [])]
        if "Q5" not in p31:
            continue  # humans only — drops test entities / non-people
        name = ((ent.get("labels") or {}).get("en") or {}).get("value", "")
        sitelinks = ent.get("sitelinks") or {}
        enwiki = sitelinks.get("enwiki") or {}
        title = enwiki.get("title", "")
        if not name or not title:
            continue  # require an English Wikipedia article (SPARQL parity)
        slug = title.replace(" ", "_")
        out.append({
            "qid": qid,
            "name": name,
            "description": ((ent.get("descriptions") or {}).get("en") or {}).get("value", ""),
            "birth": _claim_year(claims, "P569"),
            "death": _claim_year(claims, "P570"),
            "image": "",
            "wikipedia_url": f"https://en.wikipedia.org/wiki/{slug}",
            "wikidata_url": f"https://www.wikidata.org/wiki/{qid}",
            "wikipedia_slug": slug,
            "sitelinks": len(sitelinks),
        })
    # Re-rank by sitelink count (≈ SPARQL's ORDER BY DESC(sitelinks)), top N.
    out.sort(key=lambda c: c["sitelinks"], reverse=True)
    return out[:limit]


def fetch_wikipedia_intro(slug: str) -> str:
    """Fetch the short summary (first paragraph + key facts) for a
    Wikipedia article via the REST summary API. Returns plain text."""
    if not slug:
        return ""
    def _do():
        try:
            return _http_get(f"{_WP_REST}/{slug}", timeout=20)
        except Exception as exc:
            log.warning("Wikipedia summary fetch failed for %r: %s", slug, exc)
            return {}
    data = _cached_or_fetch(f"wp_intro_{slug}", _do)
    if isinstance(data, dict):
        return (data.get("extract") or "").strip()
    return ""


def _format_era(birth: str, death: str) -> str:
    """A compact 'YYYY–YYYY' (or 'b. YYYY') era from birth/death dates, for the
    mind's `era` field. Previously unset by discovery — minds got a blank era."""
    by, dy = (birth or "")[:4], (death or "")[:4]
    if by and dy:
        return f"{by}–{dy}"
    if by:
        return f"b. {by}"
    return ""


def discover_candidates(per_domain_limit: int = 50, throttle: float = 0.5) -> list[dict[str, Any]]:
    """Walk every TOPIC_TAG → top N candidates, deduped by qid.

    Throttles between SPARQL calls to respect Wikidata's 1 req/sec norm.
    Returns enriched candidates with bio_summary pulled from EN Wikipedia.
    """
    seen: set[str] = set()
    out: list[dict[str, Any]] = []
    # "action" forces the WDQS-free path; otherwise try SPARQL first and, in
    # "auto", switch to the action API for the rest the moment SPARQL fails (so
    # one WDQS outage doesn't waste 15 slow retries).
    use_sparql = _DISCOVERY_MODE != "action"
    for domain, occ_qid in DOMAIN_QUERIES.items():
        log.info("Querying domain %s (occupation %s)…", domain, occ_qid)
        thinkers: list[dict[str, Any]] | None = None
        if use_sparql:
            try:
                thinkers = query_thinkers(occ_qid, limit=per_domain_limit)
            except Exception as exc:
                if _DISCOVERY_MODE == "sparql":
                    log.warning("domain %s SPARQL failed (%s) — skipping", domain, exc)
                    continue
                log.warning("SPARQL failed (%s) — switching to action API for remaining domains", exc)
                use_sparql = False
        if thinkers is None:
            try:
                thinkers = query_thinkers_via_action(occ_qid, limit=per_domain_limit)
            except Exception as exc:
                # One failing domain must not abort the whole expansion.
                log.warning("domain %s action API failed (%s) — skipping", domain, exc)
                continue
        for c in thinkers:
            if c["qid"] in seen:
                # A polymath in multiple occupations → keep the FIRST domain seen
                # (deterministic + fine for the initial scan).
                continue
            seen.add(c["qid"])
            c["domain"] = domain
            out.append(c)
        time.sleep(throttle)
    # Enrich with Wikipedia bio + a human-readable era. Best-effort + disk-cached.
    for c in out:
        try:
            c["bio_summary"] = fetch_wikipedia_intro(c["wikipedia_slug"])
        except Exception:
            c["bio_summary"] = ""
        c["era"] = _format_era(c.get("birth", ""), c.get("death", ""))
        time.sleep(throttle / 5)  # Wikipedia REST is generous
    return out
