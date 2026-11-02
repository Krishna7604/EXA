// Tier classifier for the `exa` virtual model: cheap and deterministic, so the hot path never
// pays for an extra model call just to decide which tier to use.
import type { ContentBlock, ModelRequest, Tier } from "@exa/protocol";

// ---------- constants ----------
const STRONG_HINTS =
  /\b(architect|architecture|design|redesign|refactor|debug|root cause|race condition|deadlock|security|vulnerab|performance|optimi[sz]e|migrat|plan|why does|explain how|complex|concurren|distributed|algorithm)\b/i;

/** Rough chars-per-token ratio used for size estimates. */
const CHARS_PER_TOKEN = 4;
/** Size charged for blocks without text (images etc.). */
const OPAQUE_BLOCK_CHARS = 4000;
/** Requests bigger than this go to the strong tier regardless of wording. */
const STRONG_MIN_TOKENS = 60_000;
/** Short, tool-less, non-tool-loop prompts under this length go to the fast tier. */
const FAST_MAX_TEXT_CHARS = 400;

// ---------- classifier ----------
/** Cheap, deterministic tier classifier (no extra model call on the hot path). */
export function classify(req: ModelRequest, explicit?: Tier): Tier {
  if (explicit) return explicit;
  if (req.tier) return req.tier;
  const text = lastUserText(req);
  const tokens = approxTokens(req);
  const inToolLoop = req.messages.at(-1)?.content.some((b) => b.type === "tool-result") ?? false;
  if (STRONG_HINTS.test(text) || tokens > STRONG_MIN_TOKENS) return "strong";
  if (!req.tools?.length && text.length < FAST_MAX_TEXT_CHARS && !inToolLoop) return "fast";
  return "balanced";
}

/** Approximate prompt size in tokens (system + every content block). */
export function approxTokens(req: ModelRequest): number {
  let chars = req.system.length;
  for (const m of req.messages) for (const b of m.content) chars += blockChars(b);
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

// ---------- helpers ----------
function blockChars(b: ContentBlock): number {
  switch (b.type) {
    case "text":
      return b.text.length;
    case "tool-result":
      return b.output.length;
    case "tool-call":
      return JSON.stringify(b.input).length;
    default:
      return OPAQUE_BLOCK_CHARS;
  }
}

function lastUserText(req: ModelRequest): string {
  for (let i = req.messages.length - 1; i >= 0; i--) {
    const m = req.messages[i];
    if (m.role !== "user") continue;
    const t = m.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { text: string }).text)
      .join("\n");
    if (t.trim()) return t;
  }
  return "";
}
