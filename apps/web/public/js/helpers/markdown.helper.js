// Minimal markdown → HTML: everything is escaped first, then a small safe subset is applied
// (code blocks, inline code, bold, http(s) links, headings, bullets, paragraphs).

// ---------- constants ----------
const HTML_ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

// ---------- markdown ----------
export const esc = (s) => s.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);

export function md(src) {
  // odd chunks are inside ``` fences
  return src
    .split(/```/)
    .map((chunk, i) => (i % 2 === 1 ? codeBlock(chunk) : inlineMarkdown(chunk)))
    .join("");
}

// ---------- helpers ----------
/** Fenced block; the first line (language tag) is dropped. */
function codeBlock(chunk) {
  const nl = chunk.indexOf("\n");
  const body = nl === -1 ? chunk : chunk.slice(nl + 1);
  return `<pre><code>${esc(body.replace(/\n$/, ""))}</code></pre>`;
}

function inlineMarkdown(chunk) {
  let t = esc(chunk);
  t = t.replace(/`([^`\n]+)`/g, "<code>$1</code>");
  t = t.replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>");
  t = t.replace(
    /\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>',
  );
  t = t.replace(/^#{1,6} (.+)$/gm, "<b>$1</b>");
  t = t.replace(/^[-*] (.+)$/gm, "• $1");
  return t
    .split(/\n{2,}/)
    .map((p) => (p.trim() ? `<p>${p.replace(/\n/g, "<br>")}</p>` : ""))
    .join("");
}
