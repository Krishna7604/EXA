// Message-part helpers shared by the loop modules: create a part owned by a message, mark a
// tool call failed, and read what earlier parts recorded (patched files, text).

import {
  type MessageInfo,
  type MessageWithParts,
  newId,
  type Part,
  type TextPart,
  type ToolPart,
} from "@exa/protocol";

// ---------- constants ----------
export const ABORTED_MESSAGE = "Aborted by the user.";

// ---------- types ----------
export type PartOf<T extends Part["type"]> = Extract<Part, { type: T }>;
type PartFields<T extends Part["type"]> = Omit<
  PartOf<T>,
  "id" | "messageId" | "sessionId" | "type"
>;
type PartOwner = Pick<MessageInfo, "id" | "sessionId">;

// ---------- parts ----------
/** A new part with a fresh id, attached to `owner`. */
export function newPart<T extends Part["type"]>(
  owner: PartOwner,
  type: T,
  fields: PartFields<T>,
): PartOf<T> {
  return {
    type,
    id: newId(),
    messageId: owner.id,
    sessionId: owner.sessionId,
    ...fields,
  } as unknown as PartOf<T>;
}

/** Put a tool call in its final error state. `start` defaults to now (never ran). */
export function failToolPart(part: ToolPart, error: string, start?: number): void {
  const end = Date.now();
  part.state = {
    status: "error",
    input: part.state.input,
    error,
    time: { start: start ?? end, end },
  };
}

/** Every file recorded by patch parts in `messages`, in first-seen order. */
export function collectPatchedFiles(messages: MessageWithParts[]): string[] {
  const files = new Set<string>();
  for (const m of messages) {
    for (const p of m.parts) {
      if (p.type === "patch") for (const f of p.files) files.add(f);
    }
  }
  return [...files];
}

export function textsOf(parts: Part[]): string[] {
  return parts.filter((p): p is TextPart => p.type === "text").map((p) => p.text);
}
