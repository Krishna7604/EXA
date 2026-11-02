// HTML → readable plain text for the webfetch tool: drops scripts/styles, keeps headings,
// list items and link targets, decodes entities and collapses whitespace.

// ---------- constants ----------
const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

const INVISIBLE_ELEMENTS = /<(script|style|noscript|svg|head|iframe)[\s\S]*?<\/\1>/gi;
const COMMENTS = /<!--[\s\S]*?-->/g;
const LINE_BREAKS = /<br\s*\/?>/gi;
const BLOCK_ENDS =
  /<\/(p|div|section|article|li|tr|h[1-6]|pre|blockquote|header|footer|ul|ol|table)>/gi;
const HEADING_STARTS = /<h([1-6])[^>]*>/gi;
const LIST_ITEM_STARTS = /<li[^>]*>/gi;
const LINKS = /<a\s[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
const ANY_TAG = /<[^>]+>/g;
const ENTITY = /&(#x?[0-9a-f]+|[a-z]+);/gi;
const HEX_RADIX = 16;
const DECIMAL_RADIX = 10;

// ---------- html to text ----------
export function htmlToText(html: string): string {
  const text = html
    .replace(INVISIBLE_ELEMENTS, "")
    .replace(COMMENTS, "")
    .replace(LINE_BREAKS, "\n")
    .replace(BLOCK_ENDS, "\n")
    .replace(HEADING_STARTS, (_m, n) => `\n${"#".repeat(Number(n))} `)
    .replace(LIST_ITEM_STARTS, "- ")
    .replace(LINKS, (_m, href, t) => `${t} (${href})`)
    .replace(ANY_TAG, "")
    .replace(ENTITY, decodeEntity);
  return collapseWhitespace(text);
}

// ---------- helpers ----------
function decodeEntity(match: string, entity: string): string {
  if (entity[0] !== "#") return ENTITIES[entity.toLowerCase()] ?? match;
  const isHex = entity[1] === "x" || entity[1] === "X";
  const code = isHex
    ? parseInt(entity.slice(2), HEX_RADIX)
    : parseInt(entity.slice(1), DECIMAL_RADIX);
  return Number.isFinite(code) ? String.fromCodePoint(code) : match;
}

function collapseWhitespace(s: string): string {
  return s
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}
