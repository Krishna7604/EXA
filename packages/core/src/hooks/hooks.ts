// Plugin hooks (OpenCode-style): throw to block, mutate `output` to rewrite.
// Hooks are scoped to a session's loop — they never touch the user's own shells.

import type { ToolResult } from "../models/tool.model.ts";

// ---------- constants ----------
const REDACTED = "[REDACTED]";
/** Provider keys, tokens and private keys that must never reach the model or the logs. */
const SECRET_PATTERNS: RegExp[] = [
  /\bsk-(?:ant-|proj-|or-v1-)?[A-Za-z0-9_-]{20,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bghp_[A-Za-z0-9]{36}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{40,}\b/g,
  /\bxox[abpr]-[A-Za-z0-9-]{10,}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\bgsk_[A-Za-z0-9]{40,}\b/g,
  /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g,
];

// ---------- types ----------
export interface Hooks {
  "tool.execute.before"?: (
    input: { tool: string; sessionId: string; callId: string; agent: string },
    output: { args: any },
  ) => void | Promise<void>;
  "tool.execute.after"?: (
    input: { tool: string; sessionId: string; callId: string; agent: string; args: unknown },
    output: { result: ToolResult; error?: string },
  ) => void | Promise<void>;
  "chat.system"?: (
    input: { sessionId: string; agent: string },
    output: { system: string[] },
  ) => void | Promise<void>;
  "chat.message"?: (input: { sessionId: string }, output: { text: string }) => void | Promise<void>;
  "session.compacting"?: (
    input: { sessionId: string },
    output: { context: string[]; prompt?: string },
  ) => void | Promise<void>;
}

export type HookName = keyof Hooks;

// ---------- hook runner ----------
export class HookRunner {
  constructor(private readonly hooks: Hooks[] = []) {}

  add(h: Hooks): void {
    this.hooks.push(h);
  }

  async run<K extends HookName>(
    name: K,
    input: Parameters<NonNullable<Hooks[K]>>[0],
    output: Parameters<NonNullable<Hooks[K]>>[1],
  ): Promise<void> {
    for (const h of this.hooks) {
      const fn = h[name] as ((i: unknown, o: unknown) => void | Promise<void>) | undefined;
      if (fn) await fn(input, output);
    }
  }
}

// ---------- secret scrubbing ----------
export function scrubSecrets(text: string): string {
  let out = text;
  for (const re of SECRET_PATTERNS) out = out.replace(re, REDACTED);
  return out;
}

/** Built-in safety hook: scrub secrets that look like provider keys out of tool output. */
export const secretScrubHook: Hooks = {
  "tool.execute.after": (_i, o) => {
    o.result.output = scrubSecrets(o.result.output);
  },
};
