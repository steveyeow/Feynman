/**
 * @-mention parsing for the composer send path.
 *
 * Faithful port of parseMentions / stripMentions in app.js (~5581-5603). Mind
 * names contain spaces (e.g. "Charlie Munger"), so we match the longest names
 * first to avoid a shorter name swallowing part of a longer one. Matching is
 * case-insensitive, and a mention only counts when the @Name is bounded by
 * whitespace or end-of-string (so "@Aristotle's" doesn't match "Aristotle").
 */

/** Escape a string for safe insertion into a RegExp. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Return the known mind names that appear as `@Name` in `text` (case-insensitive,
 * longest-first). Only names present in `knownMindNames` are returned, and the
 * casing of the returned names is the canonical casing from `knownMindNames`.
 */
export function parseMentions(text: string, knownMindNames: string[]): string[] {
  if (!text) return [];
  const mentioned: string[] = [];
  const sorted = [...knownMindNames].sort((a, b) => b.length - a.length);
  for (const name of sorted) {
    if (!name) continue;
    const pattern = new RegExp("@" + escapeRegExp(name) + "(?=\\s|$)", "gi");
    if (pattern.test(text)) mentioned.push(name);
  }
  return mentioned;
}

/**
 * Strip the `@` from any `@Name` in `text` that matches a known mind name,
 * leaving the bare name (so the model sees "Charlie Munger" rather than the
 * mention token). Longest-first, case-insensitive; trims the result.
 */
export function stripMentions(text: string, knownMindNames: string[]): string {
  if (!text) return text;
  let result = text;
  const sorted = [...knownMindNames].sort((a, b) => b.length - a.length);
  for (const name of sorted) {
    if (!name) continue;
    const pattern = new RegExp("@" + escapeRegExp(name) + "(?=\\s|$)", "gi");
    result = result.replace(pattern, name);
  }
  return result.trim();
}
