// Search-hit snippets that are safe to render as HTML. Postgres marks the hits with private-use
// characters (never real tags), everything is HTML-escaped here, and only then do the markers
// become <b>…</b>, so stored text can never inject markup.

// ---------- constants ----------
/** Start/stop markers handed to ts_headline; stripped from the source text beforehand. */
export const HIT_START = String.fromCharCode(0xe000);
export const HIT_STOP = String.fromCharCode(0xe001);

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};
const HTML_SPECIAL = /[&<>"']/g;
const WHITESPACE_RUN = /\s+/g;

// ---------- snippets ----------
/** A ts_headline result (hits between HIT_START/HIT_STOP) as one line of escaped HTML. */
export function highlightSnippet(marked: string): string {
  const oneLine = marked.replace(WHITESPACE_RUN, " ").trim();
  return escapeHtml(oneLine).replaceAll(HIT_START, "<b>").replaceAll(HIT_STOP, "</b>");
}

export function escapeHtml(text: string): string {
  return text.replace(HTML_SPECIAL, (c) => HTML_ESCAPES[c] ?? c);
}
