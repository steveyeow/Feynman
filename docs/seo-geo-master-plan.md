# SEO/GEO Master Plan — Per-Entity Page Strategy

**Date:** 2026-05-25 (original) · **Last updated:** 2026-05-27
**Status:** Plan locked; **Phases 0–5, 7.1, 7.2, 7.3, 7.4, 8.1 all shipped + GSC verified (sitemap success, 1030 pages discovered)**. See § 1.5 for snapshot.

**Honest assessment**: infrastructure ≈ 90% done, content fill ≈ 10% done. The engine is built; fuel (Type 1 / Type 4 content density) is what's actually still missing. The two biggest levers from here are (a) **mind expansion 50 → 1000** (1-week, ~$25 one-time, unlocks 20K Type-2 pages — Wikipedia structurally can't have these), (b) **Gutenberg backfill of remaining 49 books** (Type 1 long-tail). Both bottlenecked on Gemini quota; user is upgrading to paid tier.
**Goal:** Convert Feynman's 750+ entity pages (books + minds) from indexable-but-unranking shells into the canonical, citable source for "chat with [book]" and "ask [mind] about [topic]" queries — across Google Search **and** LLM-driven discovery (ChatGPT, Perplexity, Claude, Google AI Overviews).

---

## 1. Why This Matters

Feynman's product is "chat with books + minds-join." But the **discovery surface** for that product is the per-entity page. Today:

- Total entity URLs in sitemap: **751**
- Sitemap, robots.txt, llms.txt, OG tags, JSON-LD — all present ✓
- But page content is so thin Google indexes without ranking, and LLMs have nothing to cite

This plan is the content + structure layer that turns the existing infrastructure into actual traffic. The infrastructure work is done; the content engineering is not.

---

## 1.5 Status snapshot — 2026-05-26 EOD

What actually shipped to production since this doc was written (2026-05-25 22:00 → 2026-05-26 22:17):

### ✅ Shipped — covered by original plan

| Phase | Status | Commit | Notes |
|---|---|---|---|
| 0 — Schema correctness | ✅ shipped + follow-up | [e25b3b1](https://github.com/steveyeow/Feynman/commit/e25b3b1) [89410b8](https://github.com/steveyeow/Feynman/commit/89410b8) | First pass at landing; second pass added QAPage required Google fields (text + answerCount) |
| 1 — Book content enrichment | ✅ shipped | [e25b3b1](https://github.com/steveyeow/Feynman/commit/e25b3b1) | 24→800+ word jump achieved |
| 2 — Mind content enrichment | ✅ shipped | [e25b3b1](https://github.com/steveyeow/Feynman/commit/e25b3b1) | 101→500+ words, sameAs populated |
| 3a — Capability landing page | ✅ shipped | [38253b9](https://github.com/steveyeow/Feynman/commit/38253b9) | Referer-based redirect for crawlers vs humans |
| 4 — Compound URL pages | ✅ shipped | [e0fa69a](https://github.com/steveyeow/Feynman/commit/e0fa69a) + [a393244](https://github.com/steveyeow/Feynman/commit/a393244) + [9c0e097](https://github.com/steveyeow/Feynman/commit/9c0e097) | topic hubs + book Q&A + mind-on-topic; /topic/ opened to crawlers; sitemap chunk-threshold quality gate |
| 5 — Related books / internal linking | ✅ shipped | [5741206](https://github.com/steveyeow/Feynman/commit/5741206) + [50d0f7b](https://github.com/steveyeow/Feynman/commit/50d0f7b) | Related Books module + Explore footer on every page |
| 6 — UGC pipeline | 🔒 ready, gated off | [5741206](https://github.com/steveyeow/Feynman/commit/5741206) | All backend + render routes shipped behind `ENABLE_PUBLIC_DISCUSSIONS=false`; activation gated on 10K MAU + AI moderation |
| 7.2 — IndexNow ping | ✅ shipped | [50d0f7b](https://github.com/steveyeow/Feynman/commit/50d0f7b) | Daily Vercel cron at 04:00 UTC pings Bing/Yandex/Naver |
| 7.3 — LLM referrer tracking | ✅ shipped | [50d0f7b](https://github.com/steveyeow/Feynman/commit/50d0f7b) | New `llm_referrals` table + `GET /api/admin/llm-referrals?since_days=7` |
| **8.1 — Live AI Output Indexing (MVP)** | ✅ **shipped** | [3f0bf68](https://github.com/steveyeow/Feynman/commit/3f0bf68) | Routes `/book/{id}/insights` + `/mind/{id}/dialogues` live; PII scrub + user-echo strip + quality gate; Article JSON-LD; 25 unit tests. **Phase 8.2 topic clustering not yet shipped.** |

### ✅ Shipped — not in original plan but part of SEO/GEO arc

| Item | Commit | Why it matters |
|---|---|---|
| Branded landing-page chrome | [5b08c26](https://github.com/steveyeow/Feynman/commit/5b08c26) | logo header / max-width / typography / footer — crawler-fetched landing pages now look like a product, not a JSON dump |
| Book chat CTA route fix | [5a8a3c9](https://github.com/steveyeow/Feynman/commit/5a8a3c9) | `/#/chat/{id}` (SPA session-id) → `/#/read/{id}` (book route) — without this, crawler→landing→CTA hit 404 |
| **Gutenberg as primary content source** | [afb64b2](https://github.com/steveyeow/Feynman/commit/afb64b2) | 920 catalog books had 8 with real text, 912 stubs; Gutenberg gives 70K+ books with full text. Pre-condition for Phase 8 quality and Phase 1 content density on the long tail of catalog books |
| Backfill safety fixes | [f7a13b3](https://github.com/steveyeow/Feynman/commit/f7a13b3) | `probe_pgvector` + `replace_existing` + `delete_chunks_for_agent` — required for re-indexing the 54 catalog stubs through Gutenberg without halfvec gaps or duplicate chunks |
| RAG egress optimization | [b134c2a](https://github.com/steveyeow/Feynman/commit/b134c2a) | pgvector ANN routing — without this, content-enrichment + compound URLs would blow Supabase free-tier egress on every chat |

### ⏳ Remaining queue — explicit triggers and ownership

Each item below has an explicit **trigger** (what unblocks it) and **owner** (who has to act). When you're wondering "why hasn't this shipped," look at trigger.

#### P1 — biggest levers, action queued

| # | Item | Effort | Trigger | Owner | What it unlocks |
|---|---|---|---|---|---|
| 1 | **Mind expansion 50 → 1000** (Wikidata → bio → persona → 20 Type-2 essays each) | 1 week | Gemini paid tier upgrade (in progress) | Claude executes | **20K new Type-2 pages** — the largest single content lever. Content type Wikipedia structurally can't have. Bill: ~$25 one-time. |
| 2 | **Finish Gutenberg backfill** (49 remaining books) | A few days (5 books/batch) | Gemini paid tier upgrade | Claude executes | Type-1 long-tail ~270 /q/ pages with full-text-grounded answers. 2/54 done as of today. |
| 3 | **Phase 8.2 topic clustering** on /insights and /dialogues | 1-2 weeks | Need Type-4 corpus ≥1000 messages first (currently 284) — gated on user activity + mind expansion | Claude executes when data threshold met | 5x URL expansion: /book/{id}/insights/{topic}, /mind/{id}/dialogues/{topic} |

#### P2 — should ship soon

| # | Item | Effort | Trigger | Owner | Notes |
|---|---|---|---|---|---|
| 4 | **Phase 7.4 — JSON-LD CI validator** | ✅ shipped 2026-05-27 | — | — | `.github/workflows/test.yml` + `tests/test_jsonld_regression.py` (10 tests). Catches the QAPage-missing-fields class of regression. |
| 5 | **_learn_agent error→revert fix** | ✅ shipped 2026-05-27 | — | — | Was: failed first chat → status='error' permanent. Now: reverts to 'catalog' + stashes last error in meta. Real prod bug. |
| 6 | **Phase 6.1 — Editorial showcase opt-in** | A few hours | (a) you set `ENABLE_PUBLIC_DISCUSSIONS=true` + `ADMIN_USER_IDS=<your supabase uuid>` in Vercel, (b) you pick 10 chat sessions to feature | User sets env, Claude provides marking script | Surfaces Type-5 content (real user+AI dialogues) without waiting for general UGC infra. The flag does NOT auto-publish — every session stays `private` unless explicitly marked `approved`. |
| 7 | **"Popular Questions" hybrid layer** — render real high-frequency user questions on /book/{id} | 1 day + product decision | Need ≥5 real user questions per book in `session_messages` (currently 3 total contextBooks rows in prod). Auto-populates as Gutenberg backfill drives traffic. | Claude executes once threshold met | Replaces LLM-pretend questions with actual reader queries. Pending product decision: write back to questions table (→ new /q/{slug} URLs) or render separately? |
| 8 | **Phase 7.5 — Weekly GSC query/CTR pull script** | 1 day | GSC has 7+ days of data (it does, as of 2026-05-27) | Claude executes | Auto-report top queries, low-CTR pages needing title/description rewrites. |

#### P3 — deferred, not blocking anything

| # | Item | Effort | Why not now |
|---|---|---|---|
| 9 | **Phase 3 — URL slug migration** (`/book/{uuid}` → `/book/{slug}`) | 2-3 days | Mostly cosmetic + marginal keyword signal. 301 from UUID preserves backlinks. Do after mind expansion + 8.2. |
| 10 | **Phase 8.3 — Synthesis layer** (LLM TL;DR on top of /insights) | 1-2 weeks | Defer until Type-4 corpus is large enough to warrant synthesis (probably weeks 4-6 after mind expansion ships). |
| 11 | **IA PD scan integration** (補 Gutenberg miss 的早期/外文/小众 PD 书) | 3-5 days | Marginal ROI: +30-50 books vs +20K Type-2 from mind expansion. Skip. |
| 12 | **Paid content source integration** (O'Reilly Safari, Scribd API, etc.) | 1-2 weeks + ongoing $/book | The only legal path to ingest modern in-copyright text. Requires per-book licensing fees. Defer until traction justifies it. |

#### Hard blockers (structural, not effort)

- **878 of 932 catalog books are modern in-copyright.** No free legal path exists to ingest their full text (Gutenberg can't serve them; IA's borrowable books are post-Hachette-v-IA legally unusable; HathiTrust requires institutional affiliation). These books stay catalog stubs unless: (a) the user uploads their own copy (already supported), or (b) we add a paid content source (P3 item 12). Sitemap chunk gate (commit 9c0e097) already excludes them from Google's crawl path — no thin-content penalty risk.

- **Type 4 / 5 content can't be bulk-generated.** Both require real user activity to accumulate. Phase 6.1 editorial showcase is the manual workaround for seeding Type 5; Type 4 grows organically with chat volume.

---

## 2. Diagnostic Findings (with measurements)

### Page content density (Googlebot UA)

| Page | Visible Words | Unique Words | Verdict |
|---|---:|---:|---|
| `/book/{id}` (Dale Carnegie) | 24 | 16 | 🔴 Doorway-page territory |
| `/mind/{id}` (Karl Marx) | 101 | 68 | 🟡 Thin |
| `/` (homepage) | 213 | — | 🟡 SPA-typical |
| **Goodreads same book** (benchmark) | **11,070** | **4,181** | 🟢 This is the bar |

**Gap to competition: ~460x on books.**

### Per-issue inventory

**🔴 P0 — Critical (kill or fix)**
1. **Book page renders only 24 words.** Title + author + "Read this book on Feynman" — that's it. No summary, no concepts, no questions, no passages. Will not rank; offers nothing for LLMs to cite.
2. **URLs are bare UUIDs.** `/book/765179ae-...` vs ideal `/book/how-to-win-friends-and-influence-people`. The URL keyword signal is gone.
3. **Book JSON-LD has null fields.** `numberOfPages: null`, `wordCount: null`, `hasPart: null` — schema parsers skip these. We have the data; we're just not threading it through correctly (chapter count exists but isn't being written to `numberOfPages`, and `numberOfPages` is being set to chapter count anyway which is *wrong* — `numberOfPages` is for physical pages, not chapters).

**🟡 P1 — High value, lower effort**
4. **Mind page underrenders existing data.** `persona`, `thinking_style`, `typical_phrases`, related `mind_works` are all in the DB but never rendered. We could double the content thickness with zero new data work.
5. **No `BreadcrumbList` schema** anywhere. Loses sitelinks eligibility.
6. **No `FAQPage` schema** despite `questions` table being populated for every indexed book.
7. **`sameAs` on Person schema is empty.** Even an empty Wikidata/Wikipedia link list is a missed entity-graph signal. For famous minds (Marx, Einstein, Feynman), linking `sameAs` to Wikipedia is high-leverage.

**🟢 P2 — Strategic / multipliers**
8. **No compound-URL pages.** Every Q&A pair, every "[mind] on [topic]" combination is its own potential URL. This is the single biggest scale lever (10-100x URL count from real content, not programmatic spam).
9. **No internal linking graph.** Books don't link to related books; minds don't link to books they wrote/influenced; topics don't link to anything. Internal PageRank flow is wasted.
10. **UGC pipeline absent.** Real user chats are the moat vs Goodreads/Wikipedia — but we have no privacy-respecting publishing path for them.

**🔵 Infrastructure (already good — keep)**
- robots.txt allows GPTBot, ClaudeBot, PerplexityBot, Google-Extended, Applebot-Extended, cohere-ai ✓
- Sitemap is dynamic, cached, includes all ready entities ✓
- llms.txt + llms-full.txt exist ✓
- OG/Twitter Card meta complete ✓
- Canonical URLs set ✓
- `_is_crawler()` detection lets us serve full SSR to bots, redirect to SPA for humans (not cloaking — content is identical) ✓

---

## 3. Strategic Framework

### SEO goal
Become the **canonical destination** for two query classes:
- **Entity-intent:** `"[book title] summary"`, `"[author] [book] key ideas"`, `"chat with [book]"`
- **Person-intent:** `"[famous person] on [topic]"`, `"what would [person] say about [X]"`

### GEO goal (the bigger long-term play)
Become the **most-cited source** when ChatGPT/Perplexity/Claude/AI Overviews answer:
- `"What does [book] say about [X]?"`
- `"How would [person] approach [problem]?"`
- `"What are the key ideas in [book]?"`

GEO citations require: clear Q&A structure, explicit attribution, unique angle (not Wikipedia regurgitation), structured data, fast crawl.

### The unique angle (vs Goodreads/Wikipedia)

Goodreads has reviews. Wikipedia has facts. **Feynman has dialogue** — applied knowledge that doesn't exist anywhere else on the open internet. The next section unpacks exactly what categories of new content we produce.

---

## 3.5. The full content supply taxonomy (the strategic core — do not lose)

This is the actual answer to "what new content does Feynman put on the internet that Wikipedia / Goodreads / SparkNotes / Reddit / Quora cannot." One **foundation** (Type 0) plus five distinct **content** types, each with a defensible structural advantage. Of the five: the first three are shipped or partially shipped. **Types 4 and 5 are not yet shipped and are the next priorities** — Type 4 is P1 because it has no user-privacy complication, Type 5 (UGC) is P2.

**Read this carefully — two different axes.** Type 0 is a *capability* (the interactive product). Types 1–5 are *content* (indexable text). Crawlers and LLMs index text, not interactivity, so Type 0 never appears *inside* a content list — but it is the **root that generates and anchors the rest**, and it is the single most important piece of unique supply. Do not let the SEO-first framing of Types 1–5 obscure that the chattable entity is the core.

### Type 0 — The chattable entity (the foundation; the engine for 1, 2, 4)
- **What it is:** A book you can **chat with** (not just read a static detail page) and a thinker you can **chat with / invite into a conversation** (not just read a static bio). The core interactive product.
- **Where it lives:** The entity hub pages `/book/{id}` and `/mind/{id}` — crawlable static aggregation layer (passages, Q&A, related graph, insights) **+** the chat affordance (the interactive layer). Same URL serves both crawler and human.
- **Why unique:** Goodreads/Amazon book pages are **static** (cover, blurb, ratings, reviews). Wikipedia/SEP thinker pages are **static** (biography, past tense). Nobody lets you *interrogate the book itself* or *hold a live conversation with the thinker*. That capability exists nowhere else.
- **Why it is not "one of the five":** "Chattability" is a capability, not an indexable artifact — a different axis from the content types. Google ranks / LLMs cite the *text*, not "the ability to chat."
- **How it drives SEO/GEO (indirectly but decisively):**
  1. **It generates the unique text.** Type 1 (Q&A) and Type 4 (insights/dialogues) are literally the *indexed exhaust* of chatting with books/minds. No chat engine → no Type 1, no Type 4.
  2. **It makes the hub pages structurally richer** than static incumbents, so `/book/{id}` out-competes the Goodreads page for the same query.
  3. **It is the conversion + engagement layer** — a searcher who lands and chats sends strong dwell/return signals and becomes a user.
- **Implication:** Types 1–5 are the crawlable *surface* that the chattable core (Type 0) produces and is organized by. Maximize SEO/GEO from the core by (a) aggressively surfacing its output (Types 1 & 4), (b) making hubs visibly richer + clearly chattable, (c) treating chat volume as a content-supply lever, not just a growth metric.

### Type 1 — Question + grounded answer from primary text
- **What it is:** A reader's question (e.g., "How does Sapiens describe cooperation?") + an LLM-synthesized answer that cites specific passages from the book's actual chunks.
- **Where it lives:** `/book/{id}/q/{slug}` (~3,750 URLs, one per popular question per book) — **SHIPPED**
- **Why unique:** Wikipedia has "what is Sapiens"; Goodreads has "did people like Sapiens." Neither answers "what does Sapiens say about X." The actual book is paywalled and not indexed. We are the only canonical source for this query class.
- **What LLMs cite us for:** "According to a synthesis of passages from Sapiens on Feynman, …"

### Type 2 — Counterfactual / imagined perspective of a thinker on a topic
- **What it is:** A short essay framed as "How [Karl Marx] would approach [behavioral economics]" — grounded in the mind's persona, thinking style, and characteristic phrases, labelled as imagined.
- **Where it lives:** `/mind/{id}/on/{slug}` (~224 relevance-filtered pairs) — **SHIPPED**
- **Why unique:** Wikipedia has Marx's biography. The internet has his actual writings. Nobody on the open web has "Marx on cryptocurrency / climate change / AI" as a stable, citable URL. LLMs currently fabricate this on demand; we provide a canonical, disclosure-labelled, persona-grounded version.
- **What LLMs cite us for:** "On Feynman, an imagined synthesis of Marx's framework applied to [modern topic] suggests …"

### Type 3 — Entity-relation graph (books ↔ minds ↔ topics)
- **What it is:** Topic hub pages aggregating books and thinkers in a domain, with cross-links flowing in all directions.
- **Where it lives:** `/topic/{slug}` (15 hubs) + cross-links on every entity page — **SHIPPED**
- **Why unique:** Wikipedia's link graph is "related articles," not "related discussions." Goodreads has "similar books," not "thinkers who would discuss this book." Nobody builds the book × mind × topic three-way graph; it is genuinely our data structure.
- **What LLMs cite us for:** "On the topic of [X], Feynman aggregates [N books] and [M thinkers] who address it …"

### Type 4 — **Live AI output extracted from real chat sessions** (NOT YET SHIPPED, P1)
- **What it is:** The AI's responses inside real multi-turn chat sessions, extracted, anonymized (user queries stripped or paraphrased away), aggregated by book + topic or mind + topic, surfaced as standalone pages.
- **Where it would live:**
  - `/book/{id}/insights` — main insights page for a book
  - `/book/{id}/insights/{topic-slug}` — book × topic deep dive (the AI's accumulated commentary on this book regarding this topic, drawn from real chats)
  - `/mind/{id}/dialogues` — main page for a mind agent
  - `/mind/{id}/dialogues/{topic-slug}` — mind × topic accumulated AI-mind contributions
- **Why uniquely valuable (the insight we almost missed):**
  - **Goodreads, Wikipedia, SparkNotes are all DEAD text.** Wikipedia entries describe Marx in past tense. Marx's own works are static. There is nowhere on the internet that has Marx (or any thinker, or any book) producing **live, current, applied** commentary on questions that today's readers actually ask.
  - **Chat-with-book commentary is structurally absent from the open web.** Reviews describe the book; we synthesize from the book in response to specific questions, accumulated across hundreds of real reader sessions. That corpus of applied synthesis has no analog.
  - **Mind-on-topic dialogue is structurally absent.** Everything about a thinker on the open web is biographical, historical, or quotational. Nobody has "Marx on AI labor markets in 2026." We are the only place this content type can exist.
- **Why no user-privacy concern:** We extract only the assistant's outputs. User queries are never published. The AI's responses get a light strip-pass to remove any echo of the user's specific situation ("as you mentioned…", "your question about…"). Optional: paraphrase the original question into a generic form to lead each AI response with context, regenerated as a synthetic prompt.
- **What LLMs cite us for:** "On Feynman, an accumulated synthesis of how the AI agent of Karl Marx responds when asked about contemporary capitalism …"
- **Why this is P1:** Highest unique-content density × zero privacy blockers × leverages data we already collect on every chat (no new infrastructure beyond mining and rendering).

### Type 5 — **Full user-shared dialogues (user + AI, opt-in)** (NOT YET SHIPPED, P2 — was Phase 6 PARKED)
- **What it is:** Complete multi-turn conversations between a real user and a book or a mind, shared publicly with the user's consent.
- **Where it would live:** `/book/{id}/discussions`, `/mind/{id}/discussions` (infrastructure shipped, gated off behind `ENABLE_PUBLIC_DISCUSSIONS=false`).
- **Why unique:** Multi-turn chat-with-book dialogues simply do not exist anywhere on the open web. ChatGPT's Share Chat feature creates isolated dialogues but they aren't aggregated, cross-linked, or attached to entities readers are searching for.
- **Why this is P2 (after Type 4):**
  - Type 4 captures most of the unique-content value (the AI's contributions are the substantive part of any dialogue) without the privacy and incentive complications.
  - Type 5 adds the user's contributions (questions, follow-ups, personal context) on top — high value but high complexity.
  - User-incentive analysis (Phase 6 PARKED notes below) is unresolved but **partly self-solving**: "sharing IS itself an incentive for some users" — Twitter / Substack / blog model, where many users post for self-expression even without a sophisticated reputation mechanism. We don't need a perfect incentive system to start; we need a non-zero one.
- **What LLMs cite us for:** "On Feynman, a public discussion thread about [book] illustrates how readers engage with the material …"

### Why this taxonomy matters

Every *content* page we ship should be classifiable into exactly one of Types 1–5. If a proposed page doesn't fit, ask whether it's actually unique content supply or just rearrangement of existing data. (Type 0 is the capability beneath them, not a page bucket — but every hub page should make it obvious.)

**Type 0 + the five together** are the answer to "why would Google index us, why would ChatGPT cite us, why would users prefer Feynman over Wikipedia/Goodreads for [class of query]." Type 0 (the chattable book/mind) is the differentiated product and the engine; Types 1–5 are the crawlable content it generates (1, 2, 4) and is organized by (3, 5). Each targets a query space the established players structurally cannot serve — and the chattable core is the thing none of them can copy without rebuilding into an interactive product.

**Categorical inversion of the LLM-search era:**
- Pre-LLM internet: Wikipedia dominates because users want canonical summaries.
- LLM-search era: LLMs already produce canonical summaries from training data. What they need is **citable, applied, dialogic content that grounds their answers in primary sources**. Types 1–5 are all built for this need.

This is why we expect our SEO/GEO traffic share to grow over time as LLMs become more dominant in discovery — Wikipedia's relative citation weight goes down as LLMs internalize its content; ours goes up as ours is the content the LLMs need but don't have.

---

## 4. The Complete Fix List (everything to do, in execution order)

### Phase 0: Schema & metadata correctness (1 PR, no design changes) — ✅ SHIPPED
- [x] Fix `numberOfPages` semantics in Book JSON-LD (currently misuses chapter count) — done in [e25b3b1](https://github.com/steveyeow/Feynman/commit/e25b3b1) (omitted entirely; chapter count moved to `hasPart` where it belongs)
- [x] Add `wordCount` from existing `total_words` field — [e25b3b1](https://github.com/steveyeow/Feynman/commit/e25b3b1)
- [x] Add `hasPart` chapter array correctly — [e25b3b1](https://github.com/steveyeow/Feynman/commit/e25b3b1)
- [x] Add `BreadcrumbList` JSON-LD on `/book/{id}` and `/mind/{id}` — [e25b3b1](https://github.com/steveyeow/Feynman/commit/e25b3b1)
- [x] Add `inLanguage`, `datePublished`/`dateModified` where available — [50d0f7b](https://github.com/steveyeow/Feynman/commit/50d0f7b)
- [x] Pre-populate `sameAs` for top ~20 famous minds — [e25b3b1](https://github.com/steveyeow/Feynman/commit/e25b3b1)
- [x] **Follow-up:** QAPage required Google fields (`text` + `answerCount`) — [89410b8](https://github.com/steveyeow/Feynman/commit/89410b8) (caught by Phase 4 audit)

### Phase 1: Book page content enrichment (the 24→800+ word jump) — ✅ SHIPPED ([e25b3b1](https://github.com/steveyeow/Feynman/commit/e25b3b1))
Render these sections in SSR, all from existing DB data:
- [ ] **"About this book"** — subtitle/description from outline (already have)
- [ ] **"Table of Contents"** — already rendered, keep
- [ ] **"Popular Questions Readers Ask"** — render `list_questions(agent_id)` (5 questions per book, all pre-generated, zero cost)
  - Wrap in `FAQPage` JSON-LD schema (huge GEO win)
- [ ] **"Key Concepts"** — pull top 5-8 chunks from RAG using book's own outline keywords as queries; render headline + 1-2 sentence excerpt with attribution to chapter
- [ ] **"Sample Passages"** — render 2-3 representative chunks verbatim with chapter attribution
- [ ] **"Discussed by these Great Minds"** — reverse lookup `mind_works` for `agent_id`, render cross-links to `/mind/{id}` (drives internal PageRank)
- [ ] **"Related Books"** — books sharing topic tags or author, render cross-links

Target: 800-1500 visible words, 5+ internal links, 2 JSON-LD blocks (Book + FAQPage).

### Phase 2: Mind page content enrichment (101→500+ word jump) — ✅ SHIPPED ([e25b3b1](https://github.com/steveyeow/Feynman/commit/e25b3b1))
- [ ] **"Bio"** — already rendered, keep
- [ ] **"Notable Works"** — already rendered. Cross-link items to `/book/{id}` where `mind_works.agent_id` matches.
- [ ] **"How [Mind] Thinks"** — render condensed `thinking_style` (currently unused in SSR)
- [ ] **"Characteristic Phrases"** — render `typical_phrases` JSON list (currently unused) — perfect for GEO quote extraction
- [ ] **"Core Frameworks"** — short bullet extract from `persona` text (use first ~500 chars, format as bullets if structured)
- [ ] **"Books [Mind] Discusses"** — render `mind_works` cross-links to `/book/{id}`
- [ ] **"Related Minds"** — same domain, render cross-links
- [ ] Populate `sameAs` Wikipedia/Wikidata for top minds (manually curated initial set, then automated)

Target: 500-1000 visible words, 5+ internal links.

### Phase 3: URL hardening (slugs + redirects) — ⏳ DEFERRED (P3)
- [ ] Add slug column to `agents` and `minds` tables (or derive on-the-fly, store in `meta`)
- [ ] Slug format: `kebab-case` of name + optional author/disambiguation suffix
- [ ] New canonical URL: `/book/{slug}` and `/mind/{slug}`
- [ ] Keep `/book/{uuid}` and `/mind/{uuid}` routes returning **301 redirect** to slug URL (preserves all backlinks; required for safe migration)
- [ ] Update sitemap to emit slug URLs only
- [ ] Update canonical tags to slug URLs
- [ ] Slug collision handling: append numeric suffix
- [ ] Internal SPA hash routes (`/#/read/{id}`) keep using UUID for stability — only the canonical landing page gets a slug

### Phase 4: Compound URL pages (the biggest scale lever) — ✅ SHIPPED ([e0fa69a](https://github.com/steveyeow/Feynman/commit/e0fa69a) + [a393244](https://github.com/steveyeow/Feynman/commit/a393244) + [9c0e097](https://github.com/steveyeow/Feynman/commit/9c0e097))
Create two new route patterns that capture massive long-tail volume:

**`/book/{slug}/q/{question-slug}`** — one URL per popular question per book
- Source: `questions` table (5 per book × 750 books = 3,750 pages immediately)
- Content: question as `<h1>`, AI-generated answer using book's RAG, 3-5 supporting passages with chapter attribution
- JSON-LD: `QAPage` schema with `acceptedAnswer`
- Cache aggressively (these don't change)
- Sitemap inclusion

**`/mind/{slug}/on/{topic-slug}`** — one URL per (mind, topic) pair
- Source: cross-join top minds × top topics (start with 50 minds × 50 topics = 2,500 pages)
- Content: short essay generated by the mind agent on the topic; cite sources where possible
- JSON-LD: `Article` schema with author = the mind
- Generate lazily on first crawl + cache, OR pre-generate for top combinations

These two patterns scale current 750 URLs → ~10,000+ unique-content URLs without programmatic spam, because each page is grounded in either pre-existing questions or actual mind-agent generation.

### Phase 5: Internal linking graph — ✅ SHIPPED ([5741206](https://github.com/steveyeow/Feynman/commit/5741206) + [50d0f7b](https://github.com/steveyeow/Feynman/commit/50d0f7b) Explore footer)
- [ ] Books ↔ Minds (already designed in Phase 1+2)
- [ ] Books → Related Books (same topic, same author)
- [ ] Minds → Related Minds (same domain, same era)
- [ ] Compound pages → parent entity + sibling compound pages
- [ ] New `/topics/{topic-slug}` hub pages (one per topic in `TOPIC_TAGS`) linking to top books and minds in that topic
- [ ] Footer of every entity page: 3-5 "Explore" links to neighboring entities

### Phase 6: UGC pipeline — **P2, revived 2026-05-26** (was PARKED; revived after Type 4/5 taxonomy work; do AFTER Phase 8)

**TL;DR**: The full backend (DB schema, opt-in/withdraw/moderation APIs, public `/discussions` render routes, DiscussionForumPosting JSON-LD, PII scrubbing) shipped to production behind `ENABLE_PUBLIC_DISCUSSIONS=false`. **Sequencing decision (2026-05-26): do Phase 8 first (Type 4 content — AI-only, no privacy concern), then come back to Phase 6 (Type 5 content — full dialogues with user consent).** Reasoning: most of the unique-content value sits in the AI's responses, which Phase 8 captures without the user-incentive and moderation problems that gate Phase 6. Phase 8 also seeds traffic to entity pages so that, when Phase 6 finally opens user opt-in, there's an audience for the public discussions to be discovered by.

**Two blockers identified at park time still relevant, but reframed for revival:**

#### What's already built and live (gated off)
- DB schema: `chat_sessions` has `public_status`, `public_handle`, `public_title`, `consent_at`, `approved_at`, `approved_by` columns (additive migration, idempotent in both PG and SQLite branches)
- API routes (all 404 when flag off):
  - `POST /api/chat-sessions/{id}/share` — user opt-in
  - `POST /api/chat-sessions/{id}/withdraw` — user withdraw
  - `GET /api/chat-sessions/{id}/public-status` — owner read
  - `POST /api/admin/chat-sessions/{id}/approve` / `/reject` — moderation
  - `GET /api/admin/moderation-queue/count` — dashboard helper
- Public render routes (all 404 when flag off):
  - `GET /book/{id}/discussions`, `GET /mind/{id}/discussions`
- PII scrubbing in `app/core/ugc.py`: emails, phones, URLs, @handles
- SQL-side gate on `public_status = 'approved'` even if upstream cache layer goes stale
- JSON-LD: `DiscussionForumPosting` with anonymized author per comment
- Admin gating via `ADMIN_USER_IDS` env (empty default — combined with feature flag, two locks required before any data flows)
- Tests: 28 unit tests + integration test verifying flag-off 404s everything

#### Blocker 1: manual moderation does not scale

The shipped implementation requires admin approval for every opted-in session. This works for the first 10–50 shares but breaks down quickly. Three realistic alternatives identified:

  A. **AI auto-moderation** (LLM as judge, ~$0.001/session). Score 0–10 on quality, PII, on-topic, civility. Auto-approve high scores; queue ≤ threshold for review. 95% automatic, 5% human attention. Recommended path if UGC ships.
  B. **No prior moderation, easy takedown.** Auto-publish after PII scrub. Self-serve user withdraw + admin emergency takedown + report button. Reddit/Twitter model. Higher legal exposure.
  C. **Editorial-only.** Only the Feynman team can publish curated "best of" conversations. No user opt-in surface at all. Lowest risk, also lowest scale.

#### Blocker 2: user incentive — **revised view (2026-05-26): partly self-solving**

Original park-time view: "without a sophisticated reputation mechanism, expected opt-in rate is <0.1%." Revised view based on Twitter / Substack / blog precedent: **sharing is itself an incentive for a meaningful slice of users** — people share their thinking on the open web every day, often with no recognition mechanism beyond the act of sharing. We don't need a perfect incentive system to start; we need a non-zero one.

Practical incentive design for Phase 6 revival (start with one, add more if traction):

  - **Attribution + link-out (must-have, low cost).** Public conversation shows "by @handle" linking to the user's Twitter/site/profile. Matches Stack Overflow / GitHub motivation. Schema additions already in place (`public_handle` column); needs only a `public_handle_url` column + an anchor in the rendered output.
  - **Sharing as self-expression (free).** Some users will share simply because they want to. Twitter's growth was not driven by a karma mechanism. Substack writers don't get badges. Treating "share" as a free-text action with a one-click button often suffices.
  - **LLM citation counter (deferred, GEO-native).** "Your shared discussions were cited 47 times this month by ChatGPT / Perplexity." Requires LLM referrer tracking infrastructure (Phase 7 monitoring work).
  - **Featured surfaces (deferred).** Top public discussions surface on book/mind hero positions → user gets "front page."
  - **Pro-only feature (consider).** Free users can't opt-in or can't add attribution links → reverse incentive into subscription conversion.

#### Activation criteria — DO NOT flip `ENABLE_PUBLIC_DISCUSSIONS=true` until ALL of these hold

1. **Scale.** Feynman has ≥10K MAU. Below this, supply (sharers) and demand (readers) are both too thin for a UGC flywheel.
2. **Moderation.** Either alternative (A) AI auto-moderation pipeline is implemented, OR alternative (C) editorial-only mode is the chosen path. Manual one-by-one is off the table.
3. **At least one incentive mechanism is live.** Attribution + link-out is the minimum bar (small implementation cost — add `public_handle_url` column, render anchor in `_render_public_post_html`).
4. **SPA opt-in UI exists.** Frontend chat session menu has a "Share publicly" action that calls `POST /api/chat-sessions/{id}/share` with the user's chosen handle. Without this, the backend opt-in route is unreachable from the product.
5. **`ADMIN_USER_IDS` env is populated** with the moderator user IDs (even under editorial-only mode, you need authorized publishers).
6. **Privacy/legal review done.** Public conversation publishing under a user's display name has GDPR/CCPA implications; ToS and Privacy Policy should reflect this explicitly.

#### Recommended phased revisit (when growth threshold hits)

  **Phase 6.1 — Editorial showcase** (week-1 from decision):
  - Set `ADMIN_USER_IDS` with team user IDs only.
  - Set `ENABLE_PUBLIC_DISCUSSIONS=true`.
  - Team manually marks 10 best-of conversations as `approved` via direct DB edit or a quick admin script.
  - `/discussions` pages now have seed content. Observe traffic + user response.

  **Phase 6.2 — User opt-in with AI moderation** (week 4+ if 6.1 shows signal):
  - Build AI moderation pipeline (LLM scorer, score-gated auto-approve).
  - Add `public_handle_url` column for attribution link-out.
  - Ship SPA "Share publicly" button.
  - Open opt-in to all authenticated users.

  **Phase 6.3 — LLM citation counter** (optional, when GEO referrer tracking lands):
  - Wire ChatGPT / Perplexity / AI Overview referrer tags into analytics.
  - Surface "cited N times" on user's shared sessions.
  - This is the GEO-native motivation no incumbent UGC platform offers.

#### If the decision is to abandon UGC entirely

Lowest-friction path:
  - Code stays in tree at zero ongoing cost (feature flag default off, all routes 404).
  - DB schema additions are inert until written to.
  - Delete only if the columns conflict with future migrations.
  - Tests in `tests/test_seo_pages.py::TestPhase6*` keep guarding the scrubbing / handle validation utilities, which have general-purpose value beyond UGC.

### Phase 7: Monitoring & iteration — 🟢 SHIPPED (5 of 6); only 7.5 weekly pull script remaining
- [x] **7.1** Google Search Console property + sitemap submitted — ✅ verified 2026-05-27 (`feynman.wiki` property, sitemap.xml Status=Success, 1030 pages discovered)
- [x] **7.2** Add IndexNow ping on entity create/update for Bing/Yandex — ✅ [50d0f7b](https://github.com/steveyeow/Feynman/commit/50d0f7b) (daily cron at 04:00 UTC, key file at `/{INDEXNOW_KEY}.txt`)
- [x] **7.3** Track LLM referrer traffic separately — ✅ [50d0f7b](https://github.com/steveyeow/Feynman/commit/50d0f7b) (`llm_referrals` table + `GET /api/admin/llm-referrals?since_days=7`)
- [x] **7.4** Add structured-data validator CI check (lint JSON-LD on every PR) — ✅ shipped 2026-05-27 (`.github/workflows/test.yml` + `tests/test_jsonld_regression.py`, 10 required-field assertions covering Book / Person / QAPage / FAQPage / BreadcrumbList / Article)
- [ ] **7.5** Weekly: pull top queries, top pages, impressions vs CTR — depends on 7.1; can ship now (GSC has been collecting data since 2026-05-26)

### Phase 8: **Live AI Output Indexing** — ✅ 8.1 SHIPPED, ⏳ 8.2/8.3 remain (2026-05-26)

**Status update 2026-05-26:**
- **8.1 MVP — ✅ SHIPPED** ([3f0bf68](https://github.com/steveyeow/Feynman/commit/3f0bf68)). New module `app/core/insights.py`; routes `GET /book/{id}/insights` + `GET /mind/{id}/dialogues` live in production; PII scrub + 9 user-context echo regex patterns + publishable quality gate; `ENABLE_AI_INSIGHTS` kill switch (default ON); Article JSON-LD; 25 unit tests added.
- **8.2 Topic clustering — ⏳ NOT YET.** Pages currently render flat lists of sanitized responses; no `/{topic-slug}` deep dives yet. This is the next P1 ship after Phase 8.1 has corpus data to cluster.
- **8.3 Synthesis layer — ⏳ deferred.** Defer until corpus size warrants synthesis (probably weeks 4-6).

This is the implementation of Type 4 from the content supply taxonomy above. Mine the AI's responses out of real chat sessions, anonymize / strip the user side, aggregate by entity + topic, surface as standalone SEO/GEO-friendly pages.

**Why this is P1** (do before Phase 6 UGC):
- Captures most of the structural-content-supply value (the AI's contributions are the substantive part)
- Zero user-privacy blocker (we publish AI output only, never user queries)
- No moderation queue needed (AI output passed our own prompt safety; spot-check rather than per-item gate)
- No user-incentive problem (the content exists whether users opt-in or not)
- Leverages data we already collect on every chat — no new data ingestion infrastructure
- Will populate `/insights` and `/dialogues` URLs with content immediately on launch, instead of waiting for users to opt-in

**Privacy posture (must hold):**
- **Never expose user queries.** Mining pulls only `session_messages` where `role = 'assistant'`. User-role messages stay private.
- **Strip user-context echoes from AI output.** Common patterns to remove or paraphrase: "as you asked", "your question about X", "the situation you described", anything quoting the user. Implementation: regex pass for common patterns + LLM rewrite pass for stubborn echoes.
- **Aggregate-only display.** Never render content traceable to a single chat session. The `/insights/{topic}` page mixes responses from many sessions clustered around the topic; no single user is identifiable.
- **No need for user opt-in.** Because nothing user-generated is being published. (Document this clearly in privacy policy when shipping.)

**Architecture (5 layers):**

1. **Extraction layer** (`app/core/insights.py` — new module)
   - `list_assistant_messages_for_agent(agent_id, since=None, limit=1000)` — pulls `role='assistant'` messages from `session_messages` joined to `chat_sessions WHERE session_type='book' AND mind_id={agent_id}`.
   - `list_assistant_messages_for_mind(mind_id, since=None, limit=1000)` — same for `session_type IN ('chat', 'mind') AND mind_id={mind_id}`.
   - Each row carries: `content`, `created_at`, `session_id` (kept internally for dedup/audit, never rendered).

2. **Sanitization layer**
   - `scrub_user_context_echoes(text)`: regex pass for "as you asked", "your question", "the situation you described", etc. + drop sentences that begin with "You" or contain second-person possessives in the first ~150 chars.
   - Optional pass: LLM rewrite for any output that still contains a user echo after regex. Bounded budget (~$0.0005 per message at Flash rates).
   - Output must read as a standalone commentary, not a reply.

3. **Aggregation layer**
   - **Topic classification**: classify each sanitized response into 0–N of `TOPIC_TAGS` using either embedding-similarity match (cheap, run once at insertion) or LLM-as-classifier (more accurate, batch overnight).
   - **Dedup**: near-duplicate detection via embedding cosine threshold (~0.92). Keep the longest / highest-quality variant of each cluster.
   - **Synthesis (optional, later)**: top-K responses per topic synthesized by LLM into a clean "Overview of AI insights on this book regarding this topic." Initial ship can skip this and just render top-K responses verbatim.
   - **Storage**: new tables `agent_insights` and `mind_insights`, partitioned by topic. Or store in `chat_sessions.meta_json` as derived data — pragmatic choice TBD.

4. **Render layer (new SSR routes)**
   - `GET /book/{id}/insights` — main insights page. Lists topics covered with counts; cross-links to each topic deep-dive.
   - `GET /book/{id}/insights/{topic-slug}` — top 5–10 AI commentaries on this book regarding this topic. Each rendered as a blockquote-style card with a short timestamp ("Synthesized from N reader sessions, updated YYYY-MM").
   - `GET /mind/{id}/dialogues` — main page for a mind agent's accumulated contributions.
   - `GET /mind/{id}/dialogues/{topic-slug}` — the mind agent's perspective on a topic, drawn from real chat dialogues.
   - All gated by `ENABLE_AI_INSIGHTS=true` (default true once stable) for easy kill-switch parity with Phase 4 / Phase 6 patterns.

5. **Schema + sitemap + llms.txt updates (the SEO/GEO surface)**
   - **JSON-LD**: `Article` schema per page. `author` = the agent / mind (with `disclosure` note: "Synthesized from AI agent responses across reader sessions"). `publisher` = Feynman. `dateModified` = latest contributing message timestamp.
   - **Sitemap**: include all `/insights` and `/insights/{topic-slug}` URLs, similar to how we batch `questions_by_agent` today. Estimated URL growth: ~750 books × (1 + ~5 topics each) = ~4,500 new URLs from books; ~50 minds × (1 + ~3 topics each) = ~200 new URLs from minds. **Total sitemap goes from 3,935 to ~8,500+ URLs** (further 2x growth).
   - **llms.txt** (MUST UPDATE): add a new bullet under "What Feynman Does" explicitly mentioning the live AI insights pages. Example wording: "**Live AI Insights**: each book and great mind has accumulated AI commentary pages at `/book/{id}/insights/{topic}` and `/mind/{id}/dialogues/{topic}` — synthesized from real reader sessions, updated continuously, available for citation."
   - **llms-full.txt** (also update): describe the architecture and the privacy guarantee (AI output only, no user queries).

**Implementation phases:**

  **Phase 8.1 — MVP, no aggregation** (week 1–2):
  - Extraction + sanitization layers
  - Render route shows N most-recent sanitized AI responses for an entity (no topic clustering yet)
  - Test PII guarantee end-to-end with real production chat logs
  - Ship behind feature flag; spot-check a sample of rendered pages manually

  **Phase 8.2 — Topic clustering** (week 3–4):
  - Add classification (LLM or embedding)
  - Per-topic deep-dive pages live
  - Sitemap + llms.txt updated
  - Quality bar: each `/insights/{topic}` page must have ≥3 distinct AI responses to be rendered (else 404 to avoid thin content)

  **Phase 8.3 — Synthesis layer** (later, when corpus is large):
  - LLM-synthesized "overview" paragraph per topic on top of the raw responses
  - Updated infrequently (weekly cron)
  - Sits above the raw response list as a TL;DR

**Open design decisions for Phase 8 (resolve before kickoff):**
- Sanitization aggressiveness vs naturalness tradeoff. Too aggressive → reads sterile and loses what makes the content unique. Too soft → leaks user context. Recommend: start aggressive, dial back based on rendered quality review.
- Storage shape: derived-data table vs `meta_json` blob. Probably new tables since we'll query by topic.
- When to re-extract: on every new chat? Nightly batch? Trade-off freshness vs cost.
- Whether to expose AI responses verbatim or always paraphrase: verbatim is more powerful for citation; paraphrase is safer for privacy. Recommend: verbatim with the sanitization pass, audit weekly.

**Dependencies + sequencing:**
- Depends on: existing `session_messages` table (in place), an LLM provider (in place), embeddings if doing similarity dedup (in place).
- Blocks: nothing — this can ship in parallel with anything else.
- Should ship before: Phase 6 (UGC) revival — Phase 8 establishes the `/insights` and `/dialogues` URL precedent before `/discussions` lands, so the IA is clean.

---

## 5. Sequencing & ROI

| Phase | Status | Effort | Time-to-impact | SEO impact | GEO impact | Priority |
|---|---|---|---|---|---|---|
| 0 — Schema correctness | ✅ shipped (+QAPage follow-up) | XS | done | M | L | — |
| 1 — Book content enrichment | ✅ shipped | M | done | **XL** | **XL** | — |
| 2 — Mind content enrichment | ✅ shipped | S | done | L | L | — |
| 3a — Capability landing | ✅ shipped | S | done | M | M | — |
| 4 — Compound URL pages | ✅ shipped | L | done | **XL** | **XL** | — |
| 5 — Related books / topic linkback | ✅ shipped | S | done | M | S | — |
| **8.1 — Live AI Output Indexing MVP (Type 4)** | ✅ **shipped 2026-05-26** | M | done | **XL** | **XL** | — |
| 7.2 — IndexNow ping | ✅ shipped | XS | done | M | — | — |
| 7.3 — LLM referrer tracking | ✅ shipped | XS | done | — | M | — |
| **Gutenberg backfill (54 books)** | 🟡 **in progress** | S | 1-3 days | **XL** | **XL** | **P1** |
| **8.2 — Topic clustering** (/insights/{topic}, /dialogues/{topic}) | ⏳ **next** | M | 1-2 weeks | **XL** | **XL** | **P1** |
| 7.1 — Google Search Console + weekly query pull | ⏳ not started | S | 1 day setup + ongoing | L | — | P2 |
| 7.4 — Structured-data CI validator | ⏳ not started | S | 1 day | M | — | P2 |
| 8.3 — Synthesis layer on top of /insights | ⏳ deferred | M | 2-4 weeks | M | **XL** | P2 (await corpus) |
| 6 — UGC pipeline (Type 5) | 🔒 ready, gated off | XL | gated on 10K MAU | M | **XL** | P2-conditional |
| 3 — URL slugs | ⏳ deferred | M | 4-8 weeks | **L** | M | P3 |

**Updated execution order rationale (2026-05-26 EOD revision):**

The original "Phase 8 is next P1" rationale held — and Phase 8.1 MVP shipped same-day. The **next P1** is now the Gutenberg backfill of catalog stubs + Phase 8.2 topic clustering, in that order:

- **P1a: Gutenberg backfill.** Until this lands, the long tail of /q/ and /insights pages on classic books still says "no passages contain the information" because the chunks table only has metadata stubs for ~900 catalog books. Phase 1/4/8 content density depends on this. Auto-scheduled to resume 2026-05-27 07:30 +08:00.
- **P1b: Phase 8.2 topic clustering.** Phase 8.1 ships the page shells but they render flat lists. Per-topic deep dives are the 5x URL-count expansion Phase 8 was sized around (~4,500 new sitemap URLs). Quality bar: ≥3 distinct AI responses per topic to render (avoids thin-content penalties).
- **P2: Phase 7.1 (GSC) + 7.4 (CI validator).** Both are operational/quality-control plumbing rather than content production; they catch regressions on what we've already shipped. GSC setup is a 1-day op task; CI validator is a 1-day code task.
- **P2-conditional: Phase 6 revival.** Activation gated on the 10K MAU + AI moderation criteria from § 4. Phase 6.1 editorial showcase is the cheap unlock (set env, mark 10 best conversations approved).
- **P3: Phase 3 (URL slugs).** Still deferred. Not blocking anything; would be a 2-3 day migration if ever prioritized.

---

## 6. Risks & Tradeoffs

**Risk: AI-generated content quality flags**
- Google penalizes auto-generated content that lacks human value. Mitigation: ground every generated section in actual book chunks or mind persona — not generic LLM output. Each section must have a `cite_source` that traces to a real chunk/persona/work.

**Risk: Crawl budget on compound pages**
- Adding ~10,000 URLs from Phase 4 could overwhelm crawl budget for a young site. Mitigation: only include in sitemap after first 30 days; control with `<priority>` in sitemap; add IndexNow.

**Risk: Slug migration breaks existing backlinks**
- Mitigation: 301 redirects from UUID → slug, never remove old route.

**Risk: Cloaking accusation**
- Current `_is_crawler` design serves identical content to bots and humans (humans just see it briefly before SPA loads). This is acceptable but watch for any divergence in future changes. Document explicitly: SSR content == SPA initial content.

**Risk: GEO content cannibalization**
- If LLMs cite our pages but users get answers without clicking through, traffic suffers. Counter-strategy: pages must offer something the citation doesn't — interactive chat, related minds, deeper passages.

---

## 7. Definition of Done (per phase)

**Phase 0 done when:** A random book/mind page passes `https://search.google.com/test/rich-results` for both Book/Person and BreadcrumbList schemas without warnings.

**Phase 1 done when:** Sampled `/book/{id}` (Googlebot UA) renders ≥800 visible words; renders FAQPage JSON-LD; renders ≥3 internal links to `/mind/{id}`.

**Phase 2 done when:** Sampled `/mind/{id}` renders ≥500 visible words; renders ≥3 internal links to `/book/{id}`; `sameAs` populated for top 20 minds.

**Phase 3 done when:** All sitemap URLs use slugs; all UUID URLs 301 to slug; canonical updated; no 404s introduced.

**Phase 4 done when:** Sitemap includes compound URLs; ≥5 compound URLs indexed in GSC; first cited-by-LLM occurrence logged.

---

## 8. What we are NOT doing (explicit non-goals)

- **No programmatic spam pages.** Every page must be grounded in real data (questions table, RAG chunks, mind persona). No "top 10 books like X" filler.
- **No keyword stuffing.** Content must read naturally; we're optimizing for LLM citation, not 2015 SEO tricks.
- **No reciprocal-link schemes or paid link building.** Earn links via genuine cross-citations and content quality.
- **No public UGC without user consent.** Phase 6 is gated on a product-level opt-in flow.

---

## Appendix A: Data sources mapped to features

| Section | Data source | Function |
|---|---|---|
| Book summary | `agents.meta`, `ai_books.outline.subtitle` | Already loaded |
| TOC | `ai_books.outline.chapters` | Already rendered |
| Popular Questions | `questions` table | `list_questions(agent_id)` |
| Key Concepts | `chunks` + RAG | `retrieve(agent_id, key_query)` |
| Sample passages | `chunks` | `get_chunks_text_only(agent_id)` |
| Minds discussing book | `mind_works` reverse | new: `list_minds_for_agent(agent_id)` |
| Related books | `agents.meta.topics` | new: `list_books_by_topics(topics, exclude)` |
| Mind persona excerpt | `minds.persona` | Already loaded, unused |
| Mind thinking style | `minds.thinking_style` | Already loaded, unused |
| Mind phrases | `minds.typical_phrases` | Already loaded, unused |
| Books mind discusses | `mind_works` | new: `list_works_for_mind(mind_id)` |
| Compound Q&A answer | RAG + LLM | `retrieve()` + chat provider |
| Mind-on-topic essay | mind agent | persona + LLM with topic prompt |

## Appendix B: Files this plan will touch (initial estimate)

- `app/main.py` — `book_page`, `mind_page` handlers, new compound routes
- `app/core/db.py` — new helper queries (`list_minds_for_agent`, `list_works_for_mind`, `list_books_by_topics`)
- `app/core/seo.py` *(new)* — slug generation, schema builders, content composition helpers
- `app/core/db.py` schema migration — `slug` column on `agents` and `minds`
- `tests/test_seo_pages.py` *(new)* — SSR content density assertions, JSON-LD validation
- `docs/seo-geo-master-plan.md` — this file

---

## 9. Post-cutover content-density + indexing pass (2026-06-01)

Context: after this plan shipped, the frontend was cut over to a Next.js app (`web/`) that renders all HTML and calls the Python app as a JSON API. The cutover **regressed several shipped SEO features** because the Next SSR calls the API server-side with no user cookie, so auth-gated endpoints 401 and pages silently degraded to empty. GSC (2026-06-01) showed **207 indexed / 1,184 not-indexed**, dominated by **"Discovered – currently not indexed" = 1,160** — a crawl-budget problem on a ~2-week-old domain (the §6 risk made real), not an index-rejection problem (of pages actually crawled, 91% indexed).

### 9.1 Index-blocking bugs fixed (the regressions)

| Bug | Effect | Fix |
|---|---|---|
| `/api/agents/{id}/questions` auth-gated (`PRIVATE_GET_SUFFIXES`) | all 225 `/q/` pages 404; hubs lost Popular-Questions + FAQ + internal links | un-gate it (`app/pro/auth.py`) — it's public SEO content |
| SSR sample passages fetched gated `/read` | book hubs rendered passage-less (a 4,250-word book showed 92 words) | use public `/api/public/book/{id}/read` (`web/lib/seo-book.ts`) |
| JS `morphologicalStem` diverged from Python (`economics`→`economic` vs `econom`) | `/mind/{id}/on/economics` etc. 404'd; mind↔topic internal links dropped | faithful port of the Python stemmer (`web/lib/seo-mind.ts`); removed the redundant relevance double-gate in the `/on/` route |

### 9.2 Content-density work (Bucket A/B/C)

**A — internal links + citability (zero LLM):** mind hub now links to its own `/on/{topic}` essays; topic hub cross-links each mind's `/on/` essay (Type-3→Type-2); removed the templated-deflection `FAQPage` schema (every answer was "Open Feynman to chat…" — non-citable); exposed a bounded `persona_excerpt` on `/api/minds/{id}` so the "Core approach" section is no longer empty.

**B — generated density (lazy-gen + cache, mirrors the `/qa` and `/on/` pattern):** new `app/core/overview.py` + `GET /api/agents/{id}/overview` (unique "About this book" overview + Key Concepts — RAG-grounded for real books, general-knowledge mode for catalog stubs with an anti-fabrication guard) and `GET /api/topics/{slug}/overview` (15 topic intros). The generator checks `meta.overview`/`meta.key_concepts` first, so a future batch can pre-store and remove per-render LLM latency. **Decision: catalog stubs are thickened via the overview rather than gated out of the sitemap** — each hub is substantive on first crawl (SSR awaits the overview), so no pages were removed from discovery.

**C — auto-fill scaffold (fills with growth, no later code change):** Type-4 `/insights` and `/dialogues` render-when-present + empty-state otherwise + sitemap-gate at ≥3; added `dateModified` to the dialogues Article schema so fresh dialogue triggers re-crawl. "Recent themes" (mind hub) and book×mind activity badges already auto-fill. The loop: content crosses threshold → enters sitemap + bumps `dateModified` → Google re-crawls → page upgrades in place.

### 9.3 Deferred (with reasons)
- **Real reader-question aggregation** (replace LLM-pretend questions with real high-frequency ones) — needs chat volume + the open write-back product decision (item 7 of §1.5).
- **Mind × modern-topic essays** ("Marx on AI labor") — part of the mind-expansion lever (§1.5 P1); the current `/on/` is the 15 canonical TOPIC_TAGS.
- **Type-5 discussions** — `ENABLE_PUBLIC_DISCUSSIONS=false`, gated on 10K MAU.

### 9.4 Files touched
`app/pro/auth.py`, `app/main.py` (overview + topic-overview endpoints, `persona_excerpt`), `app/core/overview.py` *(new)*; `web/lib/seo-book.ts`, `web/lib/seo-mind.ts`, `web/app/book/[id]/page.tsx`, `web/app/mind/[id]/page.tsx`, `web/app/mind/[id]/on/[slug]/page.tsx`, `web/app/mind/[id]/dialogues/page.tsx`, `web/app/topic/[slug]/page.tsx`, `web/styles/liquid.css`. Verify post-deploy by re-fetching `/q/` and `/on/` (404→200) and a book hub (overview + Key Concepts present).

---

**Owner:** Steve
**Plan version:** 1.2 (2026-05-27 — GSC verified, Phase 7.4 shipped (CI + JSON-LD regression suite), _learn_agent error revert shipped, queue restructured with explicit triggers/owners, structural blockers (878 modern in-copyright books) flagged honestly. Mind expansion identified as the highest-ROI lever pending Gemini quota upgrade.)
