# Task 2 — Content Expansion Runbook (Hobby-budget-safe)

**Goal:** grow the unique, citable corpus (the master plan's "fuel") — Gutenberg
backfill of stub books, minds 50 → 1000 (→ ~20K Type-2 pages), Type-4 clustering
— **without exceeding the Vercel Hobby caps** (4h Active-CPU/month + the Gemini
quota).

## The one principle that makes this possible

**Decouple corpus size from Vercel CPU.** All heavy work — book indexing
(parse/chunk), persona generation, essay/overview/Q&A generation, embeddings —
runs **off-Vercel** as throttled batch scripts (your machine or CI), writing
results to the DB. The live Vercel functions then only **serve pre-stored
content** (cheap DB reads + edge-cached sitemap/OG). Add 20K pages and Vercel
Active-CPU stays flat; the only thing that scales is your **Gemini quota**, which
you throttle with `--limit` / `--sleep`.

| Work | Where it runs | Cost it spends |
|---|---|---|
| `scripts/*` batches (expand_minds, backfill_overviews, reindex_via_gutenberg, backfill_questions) | **off-Vercel** (your machine/CI) | Gemini quota + your CPU — **never** Vercel CPU |
| Serving `/book`, `/mind`, `/topic`, `/q`, `/on`, sitemap, OG | Vercel `feynman-pro` | cheap reads (pre-stored) + edge cache |
| Crons (`discover` etc.) | Vercel `feynman-pro` | **bounded** (see guards) |

## Set the Hobby guards first (Vercel → feynman-pro → Env)

- `DISCOVER_CRON_MAX_INDEX=5` (default) — caps on-Vercel indexing per cron run.
  On a tight month set `ENABLE_DISCOVER_CRON=false` and do all indexing via the
  Gutenberg script instead.
- OG rendering is already `lru_cache`d + cheap (PR #39). Overviews are pre-stored
  by `backfill_overviews` so `/overview` serves with zero generation.

## Execution waves (run each off-Vercel; `--dry-run` first; watch the meters between)

**Wave 0 — flatten the existing hot path (do now).**
```bash
python -m scripts.backfill_overviews --limit 50 --sleep 1   # repeat until drained
```
Pre-stores overviews → `/overview` stops generating per crawl. Idempotent.

**Wave 1 — Gutenberg backfill (thin stubs → real text).**
```bash
python -m scripts.reindex_via_gutenberg   # see its --help for batch flags
```
Turns stub books into substantive, chattable, Q&A-able pages. Heaviest CPU —
runs off-Vercel, so it doesn't touch the cap. Then fill questions:
```bash
python -m scripts.backfill_questions --limit 50
```

**Wave 2 — mind expansion (the 20K-page lever), in throttled chunks.**
```bash
python -m scripts.expand_minds --dry-run                       # eyeball candidates
python -m scripts.expand_minds --per-domain 20 --limit 50 --sleep 1.5
# repeat; idempotent. Each new mind × its relevant topics = new Type-2 /on/ pages.
```
⚠️ Each `/mind/{id}/on/{topic}` essay is currently **lazy-generated on first
crawl** (cached after). Small batches (≤50 minds ≈ ≤750 essays) are quota-safe.
**Before going full 1000**, build the essay pre-store (next section) so 20K
essays don't each hit Gemini on crawl.

**Wave 3 — essay + Q&A pre-store (CODE TODO, gating prerequisite for full scale).**
Mirror the overview pre-store: store each `/on/` essay and `/q/` answer in the DB
(a `mind_essays` / `agent_qa` table, or mind/agent `meta`), add a pre-store
short-circuit to `api_mind_on_topic` / `api_agent_qa`, and a
`scripts/backfill_essays.py` / `backfill_qa.py`. Then the 20K essays serve from
the DB — zero per-crawl Gemini. **This is the remaining engineering piece before
mass mind-expansion is quota-safe.**

**Wave 4 — Type-4 clustering.** Gated on chat volume (≥1000 publishable assistant
messages; ~284 today). Fills automatically as traffic from Waves 1–2 drives chat.

## Budget math / decision point

- **Vercel CPU:** with the guards above, Active-CPU stays roughly flat regardless
  of corpus size — the heavy work is off-Vercel. The one thing to watch is the
  bounded discover cron; keep `DISCOVER_CRON_MAX_INDEX` small on Hobby.
- **Gemini quota** is the real throttle on *how fast* you fill content. Run waves
  in `--limit`/`--sleep` chunks across the quota window.
- **Hobby vs Pro:** you can *fill* the corpus on Hobby (off-Vercel batches). You'd
  upgrade to **Pro** only if (a) serving traffic grows enough to push Active-CPU
  past 4h on reads alone, or (b) you want the discover/index cron to run at scale
  on Vercel instead of via scripts. Until then, **stay on Hobby + run the batches.**

## Sequencing back-pressure (don't skip)

Expansion only pays off if pages get **indexed**. Don't front-load 20K URLs while
the existing ~350 are still being (re)crawled — finish Task-1's GSC validation
first, expand in waves, and watch the indexed-count climb before adding the next
wave. Scale follows indexation, not the other way around.
