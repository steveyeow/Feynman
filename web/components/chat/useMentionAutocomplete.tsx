"use client";

/**
 * @-mention autocomplete for the composers. Faithful port of
 * bindMentionAutocomplete (app.js 5407-5546): detect a trailing `@token` at the
 * caret (only when preceded by whitespace/start, no newline in the token),
 * filter the mentionable minds by name (case-insensitive, capped at 6), and
 * render a dropdown with arrow-key nav, Enter/Tab insert, Escape close, and
 * blur-to-dismiss. Reuses the ported `.mention-dropdown` / `.mention-item`
 * styles in web/styles/app.css.
 *
 * The mentionable set is active minds ∪ chip-selected minds (NOT the full
 * catalog) so it stays consistent with the parseMentions known-names used on
 * send (ChatView handleSend).
 */

import { useCallback, useMemo, useRef, useState } from "react";
import { esc, mindColor, mindInitials } from "./markdown";

export interface MentionMind {
  name: string;
  era?: string;
  domain?: string;
}

interface QueryInfo {
  query: string;
  atIdx: number;
}

/** Detect the trailing `@token` query at the textarea caret (port of getQuery). */
function getQueryFrom(ta: HTMLTextAreaElement): QueryInfo | null {
  const val = ta.value;
  const cur = ta.selectionStart ?? val.length;
  const before = val.slice(0, cur);
  const atIdx = before.lastIndexOf("@");
  if (atIdx < 0) return null;
  // The char before @ must be whitespace or start-of-string.
  if (atIdx > 0 && /\S/.test(before[atIdx - 1])) return null;
  const query = before.slice(atIdx + 1);
  if (/\n/.test(query)) return null;
  return { query, atIdx };
}

/** Bold the matched substring of the name (port of highlightMatch). */
function highlightMatch(name: string, query: string): string {
  if (!query) return esc(name);
  const i = name.toLowerCase().indexOf(query.toLowerCase());
  if (i < 0) return esc(name);
  return (
    esc(name.slice(0, i)) +
    "<strong>" +
    esc(name.slice(i, i + query.length)) +
    "</strong>" +
    esc(name.slice(i + query.length))
  );
}

export function useMentionAutocomplete(opts: {
  taRef: React.RefObject<HTMLTextAreaElement | null>;
  setValue: (v: string) => void;
  minds: MentionMind[];
}) {
  const { taRef, setValue, minds } = opts;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const atIdxRef = useRef(-1);
  const blurTimer = useRef<number | null>(null);

  const matches = useMemo(() => {
    if (!open) return [] as MentionMind[];
    const q = query.toLowerCase();
    // Dedupe by name (active ∪ chips can overlap).
    const seen = new Set<string>();
    const out: MentionMind[] = [];
    for (const m of minds) {
      if (!m.name || seen.has(m.name.toLowerCase())) continue;
      if (!m.name.toLowerCase().includes(q)) continue;
      seen.add(m.name.toLowerCase());
      out.push(m);
      if (out.length >= 6) break;
    }
    return out;
  }, [open, query, minds]);

  /** Recompute the @-query from the live textarea (call on input). */
  const refresh = useCallback(() => {
    const ta = taRef.current;
    if (!ta) {
      setOpen(false);
      return;
    }
    const info = getQueryFrom(ta);
    if (!info) {
      setOpen(false);
      atIdxRef.current = -1;
      return;
    }
    atIdxRef.current = info.atIdx;
    setQuery(info.query);
    setActive(0);
    setOpen(true);
  }, [taRef]);

  const close = useCallback(() => {
    setOpen(false);
    atIdxRef.current = -1;
  }, []);

  /** Splice "@Name " into the controlled value at the @ index (port of selectItem). */
  const insert = useCallback(
    (name: string) => {
      const ta = taRef.current;
      if (!ta) return;
      const val = ta.value;
      const cur = ta.selectionStart ?? val.length;
      const atIdx =
        atIdxRef.current >= 0 ? atIdxRef.current : val.slice(0, cur).lastIndexOf("@");
      if (atIdx < 0) return;
      const newVal = val.slice(0, atIdx) + "@" + name + " " + val.slice(cur);
      const newCur = atIdx + name.length + 2;
      setValue(newVal);
      close();
      // The textarea is React-controlled — restore focus + caret next frame.
      requestAnimationFrame(() => {
        const t = taRef.current;
        if (!t) return;
        t.focus();
        try {
          t.setSelectionRange(newCur, newCur);
        } catch {
          /* ignore */
        }
      });
    },
    [taRef, setValue, close],
  );

  /**
   * Key handler that MUST run before the composer's Enter-to-send. Returns true
   * when it consumed the key (so the caller skips send) — mirrors production's
   * textarea._mentionDropdownOpen guard in bindEnterSend.
   */
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>): boolean => {
      if (!open || matches.length === 0) return false;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActive((a) => (a + 1) % matches.length);
        return true;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setActive((a) => (a - 1 + matches.length) % matches.length);
        return true;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        insert((matches[active] || matches[0]).name);
        return true;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        close();
        return true;
      }
      return false;
    },
    [open, matches, active, insert, close],
  );

  const onBlur = useCallback(() => {
    if (blurTimer.current) window.clearTimeout(blurTimer.current);
    blurTimer.current = window.setTimeout(() => close(), 150);
  }, [close]);

  const dropdown =
    open && matches.length ? (
      <div className="mention-dropdown" onMouseDown={(e) => e.preventDefault()}>
        {matches.map((m, i) => {
          const sub = [m.era, m.domain].filter(Boolean).join(" · ");
          return (
            <div
              key={m.name}
              className={`mention-item${i === active ? " active" : ""}`}
              onMouseEnter={() => setActive(i)}
              onMouseDown={(e) => {
                e.preventDefault();
                insert(m.name);
              }}
            >
              <div
                className="mention-item-avatar"
                style={{ background: mindColor(m.name) }}
              >
                {mindInitials(m.name)}
              </div>
              <div className="mention-item-info">
                <span
                  className="mention-item-name"
                  dangerouslySetInnerHTML={{ __html: highlightMatch(m.name, query) }}
                />
                {sub && <span className="mention-item-domain">{sub}</span>}
              </div>
            </div>
          );
        })}
      </div>
    ) : null;

  return { dropdown, onKeyDown, refresh, onBlur, open };
}
