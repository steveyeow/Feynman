/**
 * Unified social-share card renderer.
 *
 * One Satori endpoint for every share node — `?type=` selects the card,
 * `id`/`slug`/`kind` carry the entity. Each branch fetches the node's data
 * (ISR-cached fetchers, so a crawl wave doesn't re-hit the backend), hydrates
 * the real hero asset (Wikimedia portrait / Open Library cover) when available,
 * and renders the matching card from lib/og/cards. Replaces the split Pillow
 * (book/mind) + per-route Satori (answer) setup with one design system.
 *
 * The page metadata for each node points its og:image + twitter:image here; the
 * share preview modal previews this same URL — so what gets posted is exactly
 * what the author sees.
 */
import { ImageResponse } from "next/og";

import { loadOgFonts } from "@/lib/og/fonts";
import { bookCoverDataUri, mindPortraitDataUri } from "@/lib/og/assets";
import {
  OG_SIZE,
  BRAND,
  bookAccent,
  bookInitials,
  mindAccent,
  mindInitials,
  clip,
} from "@/lib/og/theme";
import {
  MindCard,
  BookCard,
  AnswerCard,
  QaCard,
  EssayCard,
  TopicCard,
  DiscussionCard,
  AggCard,
  HomeCard,
  FallbackCard,
  OgAvatar,
  OgMiniCover,
  SymposiumCard,
  SymposiumTurnCard,
  SymposiumsIndexCard,
} from "@/lib/og/cards";
import {
  fetchMind,
  fetchDebate,
  fetchDebatesList,
  fetchPublicAnswer,
  fetchPublicDiscussion,
  fetchMindOnTopic,
  resolveTopicSlug,
  fetchAgents,
  fetchMinds,
  filterBooksByTopic,
  filterMindsByTopic,
} from "@/lib/seo-mind";
import {
  getBookData,
  getBookReadMeta,
  getQuestions,
  findQuestionBySlug,
  getBookQa,
  getRelatedForBook,
} from "@/lib/seo-book";

export const runtime = "nodejs";

const CACHE = "public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800";

function isbnOf(meta: Record<string, unknown>): string {
  return typeof meta.isbn === "string" ? meta.isbn : "";
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const type = searchParams.get("type") || "home";
  const id = searchParams.get("id") || "";
  const slug = searchParams.get("slug") || "";
  const kind = searchParams.get("kind") || "";

  const fonts = await loadOgFonts();
  const opts = { ...OG_SIZE, fonts };

  // @vercel/og's ImageResponse injects its own "immutable, max-age=31536000"
  // Cache-Control and the `headers` option doesn't reliably override it — the
  // result drops our s-maxage. WITHOUT s-maxage the Vercel CDN won't cache the
  // image (x-vercel-cache: MISS), so every social scrape cold-renders it (Satori
  // + remote portrait fetch ≈ 2s) and slow scrapers (X/Twitter) time out to a
  // BLANK card. Set it explicitly on the response so the CDN caches it and
  // re-scrapes are instant. Applies to every card type (book/mind/symposium/…).
  try {
    const el = await build(type, id, slug, kind);
    const img = new ImageResponse(el, opts);
    img.headers.set("Cache-Control", CACHE);
    return img;
  } catch {
    const img = new ImageResponse(<FallbackCard />, opts);
    img.headers.set("Cache-Control", CACHE);
    return img;
  }
}

async function build(type: string, id: string, slug: string, kind: string) {
  switch (type) {
    case "mind": {
      const mind = await fetchMind(id);
      if (!mind) return <HomeCard />;
      const portrait = await mindPortraitDataUri({
        name: mind.name,
        wikidata_url: mind.wikidata_url,
      });
      return (
        <MindCard
          data={{ name: mind.name, era: mind.era, domain: mind.domain, voice: mind.voice, bio: mind.bio_summary }}
          portrait={portrait}
          accent={mindAccent(mind.name)}
          initials={mindInitials(mind.name)}
        />
      );
    }

    case "book": {
      const data = await getBookData(id);
      if (!data) return <HomeCard />;
      const isAi = (data.agent.type || "").toLowerCase() === "ai_book";
      const [cover, related, readMeta] = await Promise.all([
        isAi ? Promise.resolve(null) : bookCoverDataUri(isbnOf(data.meta)),
        getRelatedForBook(id),
        getBookReadMeta(id),
      ]);
      return (
        <BookCard
          title={data.title}
          author={readMeta.author || data.author}
          subtitle={readMeta.subtitle || data.subtitle}
          cover={cover}
          bg={bookAccent(data.title, isAi)}
          minds={[
            ...related.minds.slice(0, 3).map((m) => mindAccent(m.name)),
            "#5e4285", "#855e42", "#428585",
          ].slice(0, 3)}
        />
      );
    }

    case "answer": {
      const ans = await fetchPublicAnswer(id);
      if (!ans) return <HomeCard />;
      const isMind = ans.answer_role === "mind" && !!ans.mind;
      let portrait: string | null = null;
      let accent = BRAND;
      let initials = "F";
      let name = "Feynman";
      let kind: "mind" | "feynman" = "feynman";
      if (isMind && ans.mind) {
        const full = ans.mind.id ? await fetchMind(ans.mind.id) : null;
        portrait = await mindPortraitDataUri({ name: ans.mind.name, wikidata_url: full?.wikidata_url });
        accent = mindAccent(ans.mind.name);
        initials = mindInitials(ans.mind.name);
        name = ans.mind.name;
        kind = "mind";
      }
      const book = ans.book
        ? { title: ans.book.name, bg: bookAccent(ans.book.name), initials: bookInitials(ans.book.name) }
        : null;
      return (
        <AnswerCard
          reply={ans.answer}
          speakerName={name}
          speakerPortrait={portrait}
          speakerAccent={accent}
          speakerInitials={initials}
          speakerKind={kind}
          book={book}
        />
      );
    }

    case "demo": {
      // Design-preview only — the flagship "a great mind joined a book chat"
      // card with live mind data (portrait + name), so the design is reviewable
      // before any real shared answer exists. Not referenced by page metadata.
      const m =
        (await fetchMind("zhuangzi")) ||
        (await fetchMind("laozi")) ||
        (await fetchMind("confucius"));
      const name = m?.name || "Zhuangzi";
      const portrait = m ? await mindPortraitDataUri({ name: m.name, wikidata_url: m.wikidata_url }) : null;
      return (
        <AnswerCard
          reply="Sun Tzu teaches you to win the battle — but the truly skilled never step onto the field of contention at all. Water defeats the hardest stone not by force but by yielding; master the war you never have to fight."
          speakerName={name}
          speakerPortrait={portrait}
          speakerAccent={mindAccent(name)}
          speakerInitials={mindInitials(name)}
          speakerKind="mind"
          book={{ title: "The Art of War", bg: bookAccent("The Art of War"), initials: bookInitials("The Art of War") }}
        />
      );
    }

    case "qa": {
      const data = await getBookData(id);
      if (!data) return <HomeCard />;
      const questions = await getQuestions(id);
      const question = findQuestionBySlug(questions, slug);
      const isAi = (data.agent.type || "").toLowerCase() === "ai_book";
      const cover = isAi ? null : await bookCoverDataUri(isbnOf(data.meta));
      const bg = bookAccent(data.title, isAi);
      if (!question) {
        return (
          <BookCard title={data.title} author={data.author} description={data.description || data.subtitle} cover={cover} bg={bg} />
        );
      }
      const qa = await getBookQa(id, question);
      const snippet = (qa?.answer || qa?.passages?.[0]?.text || data.description || "").trim();
      return (
        <QaCard
          question={question}
          snippet={snippet}
          bookTitle={data.title}
          author={data.author}
          cover={cover}
          bg={bg}
          initials={bookInitials(data.title)}
        />
      );
    }

    case "essay": {
      const [mind, topic] = await Promise.all([fetchMind(id), resolveTopicSlug(slug)]);
      if (!mind || !topic) return <HomeCard />;
      const [onTopic, portrait] = await Promise.all([
        fetchMindOnTopic(id, slug),
        mindPortraitDataUri({ name: mind.name, wikidata_url: mind.wikidata_url }),
      ]);
      const snippet = (onTopic?.essay || "").replace(/\s+/g, " ").trim();
      return (
        <EssayCard
          mindName={mind.name}
          topic={topic}
          snippet={snippet}
          portrait={portrait}
          accent={mindAccent(mind.name)}
          initials={mindInitials(mind.name)}
        />
      );
    }

    case "topic": {
      const topic = await resolveTopicSlug(slug);
      if (!topic) return <HomeCard />;
      const [agents, minds] = await Promise.all([fetchAgents(), fetchMinds()]);
      const books = filterBooksByTopic(agents, topic, 30);
      const topicMinds = filterMindsByTopic(minds, topic, 12);
      return (
        <TopicCard
          topic={topic}
          bookCount={books.length}
          mindCount={topicMinds.length}
          books={books.map((b) => ({ bg: bookAccent(b.name, b.type === "ai_book"), initials: bookInitials(b.name) }))}
          minds={topicMinds.map((m) => ({ accent: mindAccent(m.name), initials: mindInitials(m.name) }))}
        />
      );
    }

    case "discussion": {
      const disc = await fetchPublicDiscussion(id);
      if (!disc) return <HomeCard />;
      const firstUser = disc.messages.find((m) => m.role === "user");
      const firstAns = disc.messages.find((m) => m.role !== "user");
      const withWho = (firstAns?.speaker || "Feynman").trim() || "Feynman";
      const isMind = !!firstAns?.speaker && firstAns.speaker !== "Feynman";
      const portrait = isMind ? await mindPortraitDataUri({ name: withWho }) : null;
      return (
        <DiscussionCard
          withWho={withWho}
          userMsg={firstUser?.content || disc.title || ""}
          answerMsg={firstAns?.content || ""}
          turns={disc.messages.length}
          accent={isMind ? mindAccent(withWho) : BRAND}
          initials={isMind ? mindInitials(withWho) : "F"}
          portrait={portrait}
        />
      );
    }

    case "mind-agg": {
      const mind = await fetchMind(id);
      if (!mind) return <HomeCard />;
      const isDialogues = kind === "dialogues";
      return (
        <AggCard
          title={isDialogues ? `AI dialogues with ${clip(mind.name, 40)}` : `Discussions with ${clip(mind.name, 40)}`}
          sub={isDialogues
            ? "AI responses from real conversations, in this mind's voice — refreshed as readers chat."
            : "Public conversations readers have shared with this great mind."}
          glyph={<OgAvatar src={null} initials={mindInitials(mind.name)} accent={mindAccent(mind.name)} size={56} />}
          name={mind.name}
          label={isDialogues ? "Great Minds · dialogues" : "Great Minds · discussions"}
        />
      );
    }

    case "book-agg": {
      const data = await getBookData(id);
      if (!data) return <HomeCard />;
      const isInsights = kind === "insights";
      const isAi = (data.agent.type || "").toLowerCase() === "ai_book";
      return (
        <AggCard
          title={isInsights ? `Insights from ${clip(data.title, 44)}` : `Discussions about ${clip(data.title, 42)}`}
          sub={isInsights
            ? "Key takeaways distilled from real reader conversations with this book."
            : "Public conversations readers have shared about this book."}
          glyph={<OgMiniCover bg={bookAccent(data.title, isAi)} initials={bookInitials(data.title)} />}
          name={data.title}
          label={data.author ? clip(data.author, 44) : isInsights ? "Reader insights" : "Reader discussions"}
        />
      );
    }

    case "symposiums": {
      const list = await fetchDebatesList();
      return <SymposiumsIndexCard questions={list.map((d) => d.question)} />;
    }

    case "symposium": {
      const d = await fetchDebate(slug);
      if (!d) return <HomeCard />;
      const seen = new Set<string>();
      const uniq: { id: string; name: string }[] = [];
      for (const t of d.turns) {
        if (seen.has(t.mind_id)) continue;
        seen.add(t.mind_id);
        uniq.push({ id: t.mind_id, name: t.mind_name });
      }
      const top = uniq.slice(0, 5); // = the avatars the card shows
      // Real Wikimedia portraits for the roster (a grid of faces is far more
      // share-worthy than initial circles). Portrait resolution needs the mind's
      // wikidata QID — name-only only works for the curated FAMOUS_MIND table —
      // so resolve each mind for its wikidata_url first. All in parallel; initials
      // fallback per-mind on any miss (never throws).
      const portraits = await Promise.all(
        top.map(async (u) => {
          try {
            const m = await fetchMind(u.id);
            return await mindPortraitDataUri({ name: u.name, wikidata_url: m?.wikidata_url, width: 128, timeoutMs: 6000 });
          } catch {
            return null;
          }
        }),
      );
      const parts = top.map((u, i) => ({
        accent: mindAccent(u.name),
        initials: mindInitials(u.name),
        portrait: portraits[i] || null,
      }));
      const names = uniq.map((u) => u.name);
      const rosterLabel =
        names.length <= 1
          ? names[0] || ""
          : names.slice(0, -1).join(", ") + " and " + names[names.length - 1];
      return (
        <SymposiumCard
          question={d.question}
          topic={d.topic}
          participants={parts}
          rosterLabel={rosterLabel}
        />
      );
    }

    case "symposium-turn": {
      const d = await fetchDebate(slug);
      if (!d) return <HomeCard />;
      const i = Math.max(0, parseInt(kind || "0", 10) || 0);
      const turn = d.turns[i] || d.turns[0];
      if (!turn) return <HomeCard />;
      const portrait = await mindPortraitDataUri({ name: turn.mind_name });
      return (
        <SymposiumTurnCard
          question={d.question}
          speakerName={turn.mind_name}
          snippet={(turn.content || "").replace(/\s+/g, " ").trim()}
          portrait={portrait}
          accent={mindAccent(turn.mind_name)}
          initials={mindInitials(turn.mind_name)}
        />
      );
    }

    default:
      return <HomeCard />;
  }
}
