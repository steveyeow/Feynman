"use client";

/**
 * In-chat composer (the one under the transcript). Reuses the same shape as the
 * home composer: auto-growing textarea, books + minds popovers, send button.
 * Ported from the chat-input-area in index.html + handleChatSend in app.js.
 *
 * Selection state (books/minds) is owned by ChatView and passed down, so chips
 * stay in sync with what gets sent.
 */

import { useRef, useState } from "react";
import {
  SelectedChips,
  BookPopover,
  MindsPopover,
  PopoverAnchor,
  BooksIcon,
  MindsIcon,
  SendIcon,
  type SelectedBook,
  type SelectedMind,
} from "./ComposerPickers";
import { useMentionAutocomplete, type MentionMind } from "./useMentionAutocomplete";

export default function Composer({
  books,
  minds,
  mentionable = [],
  disabled,
  onSend,
  onToggleBook,
  onToggleMind,
  onRemoveBook,
  onRemoveMind,
}: {
  books: Map<string, SelectedBook>;
  minds: Map<string, SelectedMind>;
  /** Minds @-mentionable here: active (auto-joined) ∪ chip-selected. */
  mentionable?: MentionMind[];
  disabled?: boolean;
  onSend: (message: string) => void;
  onToggleBook: (book: SelectedBook) => void;
  onToggleMind: (mind: SelectedMind) => void;
  onRemoveBook: (id: string) => void;
  onRemoveMind: (id: string) => void;
}) {
  const [value, setValue] = useState("");
  const [booksOpen, setBooksOpen] = useState(false);
  const [mindsOpen, setMindsOpen] = useState(false);
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const mention = useMentionAutocomplete({ taRef, setValue, minds: mentionable });

  const grow = () => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, 200) + "px";
  };

  const submit = () => {
    const msg = value.trim();
    if (!msg || disabled) return;
    setValue("");
    if (taRef.current) taRef.current.style.height = "auto";
    onSend(msg);
  };

  // The @-hint shows when minds are mentionable — chip-selected OR auto-joined
  // (port of _updateComposerMentionHint: activeMinds ∪ selectedMinds).
  const hasMinds = minds.size > 0 || mentionable.length > 0;
  const placeholder = hasMinds
    ? "Ask a follow-up question... Type @ to mention a mind"
    : "Ask a follow-up question...";

  return (
    <div className="chat-composer chat-composer-inline">
      {mention.dropdown}
      <SelectedChips
        books={books}
        minds={minds}
        onRemoveBook={onRemoveBook}
        onRemoveMind={onRemoveMind}
      />
      <textarea
        ref={taRef}
        className="composer-input"
        rows={1}
        placeholder={placeholder}
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          grow();
          mention.refresh();
        }}
        onBlur={mention.onBlur}
        onKeyDown={(e) => {
          // The mention dropdown intercepts Arrow/Enter/Tab/Escape first so a
          // completion doesn't also submit the message.
          if (mention.onKeyDown(e)) return;
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            submit();
          }
        }}
      />
      <div className="composer-toolbar">
        <div className="composer-left">
          <PopoverAnchor>
            <button
              type="button"
              className="composer-icon-btn"
              title="Books"
              aria-label="Books"
              // stop the document mousedown (used for outside-click close) so
              // toggling the button doesn't close-then-reopen.
              onMouseDown={(e) => e.stopPropagation()}
              onClick={() => {
                setBooksOpen((o) => !o);
                setMindsOpen(false);
              }}
            >
              <BooksIcon />
            </button>
            <BookPopover
              open={booksOpen}
              direction="up"
              selected={books}
              onToggle={onToggleBook}
              onClose={() => setBooksOpen(false)}
            />
          </PopoverAnchor>
          <PopoverAnchor>
            <button
              type="button"
              className="composer-icon-btn composer-minds-btn"
              title="Invite great minds"
              aria-label="Invite great minds"
              onMouseDown={(e) => e.stopPropagation()}
              onClick={() => {
                setMindsOpen((o) => !o);
                setBooksOpen(false);
              }}
            >
              <MindsIcon />
            </button>
            <MindsPopover
              open={mindsOpen}
              direction="up"
              selected={minds}
              onToggle={onToggleMind}
              onClose={() => setMindsOpen(false)}
            />
          </PopoverAnchor>
        </div>
        <button
          type="button"
          className="composer-send-btn"
          title="Send"
          aria-label="Send"
          disabled={disabled || !value.trim()}
          onClick={submit}
        >
          <SendIcon />
        </button>
      </div>
    </div>
  );
}
