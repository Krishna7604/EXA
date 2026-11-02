// Permission rule model shared by server, client loop and policy bundles.

// ---------- types ----------
export type PermissionAction = "allow" | "ask" | "deny";

export type RuleScope = "builtin" | "tenant" | "project" | "user" | "agent" | "session";

export interface PermissionRule {
  /** Permission key, e.g. "bash", "edit", "read", or "*" for every key. */
  permission: string;
  /** Glob over the resource (`*` any run of chars, `?` one char). "*" matches everything. */
  pattern: string;
  action: PermissionAction;
  scope: RuleScope;
  /** Locked rules (tenant policy) are evaluated last and cannot be overridden below. */
  locked?: boolean;
  id?: string;
}

export type PermissionMode = "default" | "accept-edits" | "plan" | "bypass";

export interface PolicyBundle {
  tenantId: string;
  version: number;
  issuedAt: number;
  expiresAt: number;
  rules: PermissionRule[];
  settings: Record<string, unknown>;
  /** Permission keys the client must confirm with POST /v1/authorize before running. */
  serverChecked: string[];
}

export interface SignedPolicyBundle {
  bundle: PolicyBundle;
  /** base64 Ed25519 signature over the canonical JSON of `bundle`. */
  signature: string;
  keyId: string;
}

export interface AuthorizeRequest {
  sessionId: string;
  tool: string;
  permission: string;
  patterns: string[];
  input?: unknown;
}

export interface AuthorizeResponse {
  action: PermissionAction;
  reason?: string;
  ruleId?: string;
}
