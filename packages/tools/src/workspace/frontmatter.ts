// Minimal YAML-ish frontmatter parser for SKILL.md, agent and command files: flat
// `key: value` pairs, with indented continuation lines folded into the previous value.

// ---------- constants ----------
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;
const KEY_VALUE = /^([\w-]+):\s*(.*)$/;
const INDENTED_TEXT = /^\s+\S/;
const LOOKS_LIKE_KEY = /^[\w-]+:/;
const SURROUNDING_QUOTES = /^["']|["']$/g;

// ---------- parse ----------
export function parseFrontmatter(text: string): { data: Record<string, string>; body: string } {
  const m = text.match(FRONTMATTER);
  if (!m) return { data: {}, body: text };
  return { data: parseFields(m[1]), body: m[2] };
}

// ---------- helpers ----------
function parseFields(block: string): Record<string, string> {
  const data: Record<string, string> = {};
  let key: string | null = null;
  for (const line of block.split(/\r?\n/)) {
    const kv = line.match(KEY_VALUE);
    if (kv) {
      key = kv[1];
      data[key] = kv[2].trim().replace(SURROUNDING_QUOTES, "");
      continue;
    }
    if (!key || !INDENTED_TEXT.test(line)) continue;
    const text = line.trim();
    if (!data[key]) data[key] = text;
    else if (!LOOKS_LIKE_KEY.test(text)) data[key] += ` ${text}`;
  }
  return data;
}
