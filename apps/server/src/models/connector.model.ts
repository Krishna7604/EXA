// Connector shapes on the server: a user's remote MCP servers as stored (no secret values),
// what a write carries (headers already sealed), and the connectors one live session uses.
import type { InstructionsPort, ToolSpec } from "@exa/core";
import type { SealedSecret } from "@exa/router";

// ---------- types ----------
export type ConnectorScope = "user" | "tenant";

/** A connector row. Secret header values live sealed in `secrets`; only names are here. */
export interface StoredConnector {
  id: string;
  scope: ConnectorScope;
  /** The owning user (user scope) or the tenant (tenant scope). */
  scopeId: string;
  name: string;
  url: string;
  enabled: boolean;
  headerNames: string[];
  secretId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** A sealed header set: JSON `{ name: value }` encrypted by the KeyVault. */
export type SealedHeaders = Pick<SealedSecret, "ciphertext" | "wrappedDek" | "keyVersion">;

export interface NewConnector {
  scope: ConnectorScope;
  name: string;
  url: string;
  enabled: boolean;
  headerNames: string[];
  sealed: SealedHeaders | null;
}

/** Fields to change; `headers` absent = keep, null = remove all, sealed = replace all. */
export interface ConnectorChanges {
  url?: string;
  enabled?: boolean;
  headers?: { names: string[]; sealed: SealedHeaders | null };
}

/** An enabled connector with its sealed headers, ready to be connected. */
export interface ConnectorWithSecret extends StoredConnector {
  sealed: SealedHeaders | null;
}

/** Result of `POST /v1/connectors/:id/test`. */
export interface ConnectorTestResult {
  ok: boolean;
  tools: Array<{ name: string; description: string }>;
  error?: string;
}

/** The connectors one live session uses. `close` ends every MCP session they opened. */
export interface ConnectedTools {
  tools: ToolSpec[];
  /** MCP servers' own instructions for the system prompt. */
  instructions: InstructionsPort;
  close(): Promise<void>;
}
