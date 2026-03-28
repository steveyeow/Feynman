# Implementation Log — BiDi Text Rendering (`dir="auto"`)

## Context

Objective: fix mixed RTL/LTR chat rendering (Arabic + English) by applying native HTML5 BiDi direction detection at message-rendering chokepoints.

Branch used: `fix/bidi-text-rendering`

Date: 2026-03-28

## Scope of Change

Only frontend message wrapper attributes were changed in `app/static/app.js`.

No changes were made to:

- markdown parsing logic (`renderMarkdown`)
- backend response generation
- CSS direction rules
- any API contracts

## Targeted Functions and Exact Lines

File: `app/static/app.js`

### 1) `appendMsg(container, role, text, sources, opts)`

- Added `dir="auto"` on outer message wrapper:
  - around line `1304`
  - code: `el.setAttribute('dir', 'auto');`

- Added `dir="auto"` on assistant content wrapper:
  - around line `1313`
  - code: `content.setAttribute('dir', 'auto');`

Reasoning:

- `el` (`.chat-message ...`) is the bubble-level container for both user/assistant messages.
- `content` (`.msg-content`) is where markdown HTML is injected (`innerHTML`), so this is the closest semantic wrapper around mixed-script text blocks.
- Applying both ensures correct base direction in both plain-text and markdown-rendered assistant responses.

### 2) `appendMindMsg(container, mindName, text)`

- Added `dir="auto"` on outer message wrapper:
  - around line `1393`
  - code: `el.setAttribute('dir', 'auto');`

- Added `dir="auto"` on mind markdown content wrapper:
  - around line `1404`
  - code: `content.setAttribute('dir', 'auto');`

Reasoning:

- Mind responses are rendered separately from normal assistant messages.
- Without this, mind messages would continue inheriting default LTR direction even after fixing `appendMsg`.

## Why `dir="auto"` Was Placed Here

These two functions are the final DOM chokepoints for message rendering across:

- global chat
- book chat
- mind chat
- restored chat history/session replay

Placing `dir="auto"` at these wrappers guarantees the browser computes base direction from each message’s first strong directional character at render time, regardless of backend source or history path.

## Edge Cases Considered

- **Mixed Arabic/English with punctuation**: `dir="auto"` improves neutral punctuation placement by setting per-message base direction instead of inheriting global LTR.
- **Markdown output**: assistant/mind markdown is injected via `innerHTML`; setting `dir` on `.msg-content` ensures block-level markdown text gets direction context.
- **User plain text branch**: user messages use `textContent`; setting `dir` on outer wrapper (`el`) still applies.
- **Session restore/history replay**: old messages re-render through the same functions, so fix applies retroactively at display time.

## Potential Side Effects

- Direction is determined by the first strong character in each message. If a message intentionally starts with LTR text and then becomes mostly RTL (or vice versa), rendered base direction may follow that initial token. This is native `dir="auto"` behavior.
- Nested inline elements (links, superscripts for citations) inherit from container direction; this is expected and generally improves BiDi behavior vs. default LTR inheritance.

## Validation Notes

- Verified that only `app/static/app.js` was modified for behavior.
- Confirmed no markdown parser changes were introduced.
- Confirmed branch isolation from `main`.

## Commit Record

Commit made for code change:

- `fix(chat): add native bidi text support via dir=auto`

This log file is committed as a permanent implementation record on the same branch.
