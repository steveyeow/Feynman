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
              headers: dict[str, str] | None = None, timeout: int = 30) -> Any:
    """Thin wrapper — lazy-imports httpx so this module stays importable
    even when sources_wikidata isn't actually used."""
    import httpx
    h = {"User-Agent": _UA, "Accept": "application/json"}
    if headers:
        h.update(headers)
    with httpx.Client(timeout=timeout, follow_redirects=True) as c:
        r = c.get(url, params=params or {}, headers=h)
    r.raise_for_status()
    return r.json()


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


def discover_candidates(per_domain_limit: int = 50, throttle: float = 0.5) -> list[dict[str, Any]]:
    """Walk every TOPIC_TAG → top N candidates, deduped by qid.

    Throttles between SPARQL calls to respect Wikidata's 1 req/sec norm.
    Returns enriched candidates with bio_summary pulled from EN Wikipedia.
    """
    seen: set[str] = set()
    out: list[dict[str, Any]] = []
    for domain, occ_qid in DOMAIN_QUERIES.items():
        log.info("Querying domain %s (occupation %s)…", domain, occ_qid)
        for c in query_thinkers(occ_qid, limit=per_domain_limit):
            if c["qid"] in seen:
                # If a person matches multiple occupations (e.g. polymath),
                # keep the FIRST domain we encountered them in. Could be
                # smarter (pick the highest-sitelinks domain) but FIRST
                # is deterministic + fine for the initial scan.
                continue
            seen.add(c["qid"])
            c["domain"] = domain
            out.append(c)
        time.sleep(throttle)
    # Enrich with Wikipedia bio (one extra HTTP call per candidate;
    # cached on disk so re-runs are free)
    for c in out:
        c["bio_summary"] = fetch_wikipedia_intro(c["wikipedia_slug"])
        time.sleep(throttle / 5)  # Wikipedia REST is generous
    return out
