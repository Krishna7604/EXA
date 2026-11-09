// Markdown → HTML for agent replies. Safe by construction: every piece of source text is
// HTML-escaped before any markup is added, and only http(s) links are produced. Supports
// headings, lists, quotes, tables, rules, fenced code (with a copy button) and inline code,
// bold, italic and links. Unclosed fences (mid-stream) render as code.

// ---------- constants ----------
const HTML_ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const FENCE = /^\s*```/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/;
const QUOTE = /^\s*>\s?/;
const BULLET = /^\s*[-*+]\s+/;
const ORDERED = /^\s*\d+[.)]\s+/;
const TABLE_DIVIDER = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
/** Markers for stashed inline HTML; private-use characters never appear in normal text. */
const STASH_OPEN = "";
const STASH_CLOSE = "";

// ---------- markdown ----------
export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);

export function md(src) {
  const lines = String(src ?? "")
    .replace(/\r\n?/g, "\n")
    .split("\n");
  const out = [];
  let i = 0;
  while (i < lines.length) i = renderBlock(lines, i, out);
  return out.join("");
}

// ---------- blocks ----------
/** Render the block starting at line `i`; returns the index of the next unread line. */
function renderBlock(lines, i, out) {
  const line = lines[i];
  if (!line.trim()) return i + 1;
  if (FENCE.test(line)) return codeBlock(lines, i, out);
  const heading = line.match(HEADING);
  if (heading) {
    const level = Math.min(heading[1].length + 2, 4);
    out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
    return i + 1;
  }
  if (RULE.test(line)) {
    out.push("<hr>");
    return i + 1;
  }
  if (QUOTE.test(line)) return quoteBlock(lines, i, out);
  if (BULLET.test(line) || ORDERED.test(line)) return listBlock(lines, i, out);
  if (isTableStart(lines, i)) return tableBlock(lines, i, out);
  return paragraph(lines, i, out);
}

function codeBlock(lines, i, out) {
  const lang = lines[i].replace(FENCE, "").trim().split(/\s+/)[0] ?? "";
  const body = [];
  let j = i + 1;
  while (j < lines.length && !FENCE.test(lines[j])) body.push(lines[j++]);
  const head = `<div class="code-head"><span>${esc(lang || "code")}</span><button class="btn quiet sm copy-btn" type="button">Copy</button></div>`;
  out.push(`<div class="codeblock">${head}<pre><code>${esc(body.join("\n"))}</code></pre></div>`);
  return j + 1;
}

function quoteBlock(lines, i, out) {
  const body = [];
  let j = i;
  while (j < lines.length && QUOTE.test(lines[j])) body.push(lines[j++].replace(QUOTE, ""));
  out.push(`<blockquote>${md(body.join("\n"))}</blockquote>`);
  return j;
}

function listBlock(lines, i, out) {
  const isOrdered = ORDERED.test(lines[i]);
  const marker = isOrdered ? ORDERED : BULLET;
  const items = [];
  let j = i;
  while (j < lines.length) {
    const line = lines[j];
    if (marker.test(line)) items.push(line.replace(marker, ""));
    else if (line.trim() && /^\s{2,}/.test(line) && items.length)
      items[items.length - 1] += `\n${line.trim()}`;
    else break;
    j++;
  }
  const tag = isOrdered ? "ol" : "ul";
  const start = isOrdered ? Number.parseInt(lines[i], 10) : 1;
  const startAttr = isOrdered && start > 1 ? ` start="${start}"` : "";
  out.push(
    `<${tag}${startAttr}>${items.map((t) => `<li>${inlineLines(t)}</li>`).join("")}</${tag}>`,
  );
  return j;
}

function isTableStart(lines, i) {
  return lines[i].includes("|") && i + 1 < lines.length && TABLE_DIVIDER.test(lines[i + 1]);
}

function tableBlock(lines, i, out) {
  const header = tableCells(lines[i]);
  const rows = [];
  let j = i + 2;
  while (j < lines.length && lines[j].includes("|") && lines[j].trim())
    rows.push(tableCells(lines[j++]));
  const th = header.map((c) => `<th>${inline(c)}</th>`).join("");
  const body = rows
    .map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`)
    .join("");
  out.push(`<table><thead><tr>${th}</tr></thead><tbody>${body}</tbody></table>`);
  return j;
}

function tableCells(line) {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());
}

function paragraph(lines, i, out) {
  const body = [];
  let j = i;
  while (j < lines.length && lines[j].trim() && !startsBlock(lines, j)) body.push(lines[j++]);
  if (!body.length) body.push(lines[j++]);
  out.push(`<p>${inlineLines(body.join("\n"))}</p>`);
  return j;
}

function startsBlock(lines, j) {
  const line = lines[j];
  return (
    FENCE.test(line) ||
    HEADING.test(line) ||
    QUOTE.test(line) ||
    BULLET.test(line) ||
    ORDERED.test(line) ||
    isTableStart(lines, j)
  );
}

// ---------- inline ----------
function inlineLines(text) {
  return text.split("\n").map(inline).join("<br>");
}

/** Escape, then add code spans, links, bold and italic. Code and links are stashed first. */
function inline(text) {
  const stash = [];
  const keep = (html) => `${STASH_OPEN}${stash.push(html) - 1}${STASH_CLOSE}`;
  let t = esc(text);
  t = t.replace(/`([^`]+)`/g, (_m, code) => keep(`<code>${code}</code>`));
  t = t.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (_m, label, url) =>
    keep(link(url, label)),
  );
  t = t.replace(/\bhttps?:\/\/[^\s<]+[^\s<.,;:!?)\]'"]/g, (url) => keep(link(url, url)));
  t = t.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  t = t.replace(/(^|[^*\w])\*([^*\s][^*]*)\*(?!\w)/g, "$1<em>$2</em>");
  const restore = new RegExp(`${STASH_OPEN}(\\d+)${STASH_CLOSE}`, "g");
  return t.replace(restore, (_m, n) => stash[Number(n)]);
}

/** `url` and `label` are already escaped. */
function link(url, label) {
  return `<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`;
}
