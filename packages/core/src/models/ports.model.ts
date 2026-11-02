// Everything the loop needs from the outside world. The same loop is hosted by the heavy
// client (local executor, gateway over HTTP) and by the server (sandbox executor, in-process
// gateway) — only these implementations differ.

import type {
  ExaEvent,
  MessageInfo,
  MessageWithParts,
  ModelChunk,
  ModelRequest,
  Part,
  SessionInfo,
} from "@exa/protocol";

export interface ModelPort {
  stream(req: ModelRequest, signal: AbortSignal): AsyncIterable<ModelChunk>;
}

export interface SessionStore {
  createSession(info: SessionInfo): Promise<void>;
  getSession(id: string): Promise<SessionInfo | null>;
  updateSession(id: string, patch: Partial<SessionInfo>): Promise<void>;
  messages(sessionId: string): Promise<MessageWithParts[]>;
  putMessage(info: MessageInfo): Promise<void>;
  /** Final-state parts only (batched per step). */
  putParts(parts: Part[]): Promise<void>;
  deleteMessages(sessionId: string, messageIds: string[]): Promise<void>;
  deleteSession(sessionId: string): Promise<void>;
}

export interface EventSink {
  publish(e: ExaEvent): void;
}

export interface SnapshotPort {
  /** Record the current workspace state; returns a ref (git tree hash). */
  track(): Promise<string | undefined>;
  /** Files changed since `from`, plus the ref they were diffed against. */
  changed(from: string): Promise<string[]>;
  /** Restore given files (or everything) to the state at `ref`. */
  restore(ref: string, files?: string[]): Promise<void>;
  diff(from: string, to?: string): Promise<string>;
}

export interface InstructionsPort {
  /** AGENTS.md / CLAUDE.md / project instructions, already read. */
  load(): Promise<Array<{ source: string; content: string }>>;
}

export interface SkillInfo {
  name: string;
  description: string;
  location: string;
}

export interface SkillsPort {
  list(): Promise<SkillInfo[]>;
  load(name: string): Promise<{ info: SkillInfo; body: string } | null>;
}

export interface EnvInfo {
  root: string;
  cwd: string;
  platform: string;
  date: string;
  isGitRepo: boolean;
  gitBranch?: string;
  host: "client" | "server";
}
