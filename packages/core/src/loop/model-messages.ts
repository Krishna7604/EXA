// Final touches on the message list sent to the model: guarantee it is non-empty and that
// roles alternate (providers reject two consecutive same-role messages).

import type { ModelMessage } from "@exa/protocol";

// ---------- constants ----------
const EMPTY_HISTORY_TEXT = "(empty)";

// ---------- model messages ----------
export function userText(text: string): ModelMessage {
  return { role: "user", content: [{ type: "text", text }] };
}

export function ensureNotEmpty(messages: ModelMessage[]): void {
  if (!messages.length) messages.push(userText(EMPTY_HISTORY_TEXT));
}

/** Merge consecutive same-role messages in place, e.g. an appended prompt after tool results. */
export function mergeSameRole(messages: ModelMessage[]): void {
  for (let i = messages.length - 1; i > 0; i--) {
    if (messages[i].role === messages[i - 1].role) {
      messages[i - 1].content.push(...messages[i].content);
      messages.splice(i, 1);
    }
  }
}
