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
} from "@/lib/og/cards";
import {
  fetchMind,
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
  const opts = { ...OG_SIZE, fonts, headers: { "Cache-Control": CACHE } };

  try {
    const el = await build(type, id, slug, kind);
    return new ImageResponse(el, opts);
  } catch {
    return new ImageResponse(<FallbackCard />, opts);
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
      const [cover, related] = await Promise.all([
        isAi ? Promise.resolve(null) : bookCoverDataUri(isbnOf(data.meta)),
        getRelatedForBook(id),
      ]);
      return (
        <BookCard
          title={data.title}
          author={data.author}
          description={data.description || data.subtitle}
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

    default:
      return <HomeCard />;
  }
}
