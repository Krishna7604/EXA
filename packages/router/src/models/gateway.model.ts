// Gateway port types: who is calling (Principal), what they may use (ModelPolicy), the
// host-provided ports, and the usage record written per request.

import type { Tokens } from "@exa/protocol";
import type { Credential } from "../providers/provider-catalog.ts";

// ---------- types ----------
export interface Principal {
  tenantId: string;
  userId: string;
  sessionId?: string;
}

export interface ModelPolicy {
  /** Wildcard patterns over slugs ("exa*", "openai/*"). Empty/undefined = everything. */
  allowed?: string[];
  byokEnabled: boolean;
  /** May direct (non-exa) models fall back to the platform pool when no BYOK key exists? */
  poolForDirect: boolean;
}

export interface GatewayPorts {
  /** BYOK lookup: user key first, then tenant key. */
  byok(principal: Principal, provider: string): Promise<Credential | null>;
  policy(principal: Principal): Promise<ModelPolicy>;
  /** Throws ModelError(429) when over quota. */
  checkQuota(principal: Principal): Promise<void>;
  recordUsage(u: UsageRecord): void;
}

export interface UsageRecord {
  tenantId: string;
  userId: string;
  sessionId?: string;
  modelRequested: string;
  modelUsed: string;
  keySource: Credential["source"];
  tokens: Partial<Tokens>;
  costUsd: number;
  latencyMs: number;
  status: "ok" | "error" | "aborted";
  time: number;
}
