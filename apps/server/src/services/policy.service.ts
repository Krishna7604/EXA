// Policy authority: the signed policy bundle for client loops, the effective permission mode,
// and the server-side authorize check (locked org rules + the command risk classifier) that
// clients can't skip. Signing itself lives in policy-signer.service.ts.
import { builtinRules, strictest, wildcardMatch } from "@exa/core";
import type {
  AuthorizeRequest,
  AuthorizeResponse,
  PermissionMode,
  PermissionRule,
  SignedPolicyBundle,
} from "@exa/protocol";
import type { ResolvedSettings } from "../models/settings.model.ts";
import type { Subject } from "../models/subject.model.ts";
import type { ConfigRepo } from "../repositories/config.repository.ts";
import type { IdentityRepo } from "../repositories/identity.repository.ts";
import { classifyCommand } from "./command-risk.service.ts";
import type { PolicySigner } from "./policy-signer.service.ts";

// ---------- constants ----------
const DEFAULT_BUNDLE_TTL_MS = 15 * 60_000;
const DEFAULT_SERVER_CHECKED = ["bash", "external_directory"];
const PERMISSION_MODES: PermissionMode[] = ["default", "accept-edits", "plan", "bypass"];
const SEVERITY = { allow: 0, ask: 1, deny: 2 } as const;

// ---------- policy service ----------
export class PolicyService {
  constructor(
    private readonly config: ConfigRepo,
    private readonly identity: IdentityRepo,
    private readonly signer: PolicySigner,
  ) {}

  async rulesFor(s: Subject): Promise<PermissionRule[]> {
    return [...builtinRules(), ...(await this.config.rules(s))];
  }

  async settingsFor(s: Subject): Promise<ResolvedSettings> {
    return this.config.resolveSettings(s);
  }

  /** Effective mode: requested mode unless policy forbids it (bypass needs explicit allowance). */
  effectiveMode(settings: ResolvedSettings, requested?: string): PermissionMode {
    const orgMode = settings.values["permission.mode"];
    const mode = (requested ?? orgMode ?? "default") as PermissionMode;
    if (mode === "bypass" && settings.values["permission.bypassAllowed"] !== true) return "default";
    return PERMISSION_MODES.includes(mode) ? mode : "default";
  }

  async bundle(s: Subject, ttlMs = DEFAULT_BUNDLE_TTL_MS): Promise<SignedPolicyBundle> {
    const [rules, settings, tenant] = await Promise.all([
      this.rulesFor(s),
      this.settingsFor(s),
      this.identity.tenant(s.tenantId),
    ]);
    const configured = settings.values["policy.serverChecked"];
    const serverChecked = Array.isArray(configured)
      ? (configured as string[])
      : DEFAULT_SERVER_CHECKED;
    const now = Date.now();
    return this.signer.sign({
      tenantId: s.tenantId,
      version: tenant?.policyVersion ?? 1,
      issuedAt: now,
      expiresAt: now + ttlMs,
      rules,
      settings: { ...settings.values, __locked: [...settings.locked] },
      serverChecked,
    });
  }

  /**
   * Server-side decision for a client-loop tool call. The client already evaluated the full
   * (signed) rule set and the user's session approvals locally, so the server adds only what a
   * client can't be trusted with: locked tenant rules and the risk classifier. Allow otherwise.
   */
  async authorize(
    s: Subject,
    req: AuthorizeRequest,
    mode: PermissionMode,
  ): Promise<AuthorizeResponse> {
    const locked = (await this.rulesFor(s)).filter((r) => r.locked);
    const decision = lockedRuleDecision(locked, req);
    if (req.permission !== "bash") return decision;
    return applyCommandRisk(decision, bashCommand(req), mode);
  }
}

// ---------- helpers ----------
/** Strictest locked rule over all patterns; per pattern the last matching rule applies. */
function lockedRuleDecision(locked: PermissionRule[], req: AuthorizeRequest): AuthorizeResponse {
  let action: AuthorizeResponse["action"] = "allow";
  let reason: string | undefined;
  let ruleId: string | undefined;
  for (const pattern of req.patterns) {
    const rule = lastMatchingRule(locked, req.permission, pattern);
    if (!rule || SEVERITY[rule.action] <= SEVERITY[action]) continue;
    action = rule.action;
    ruleId = rule.id;
    reason = `organization policy: ${rule.permission}=${rule.pattern}`;
  }
  return { action, reason, ruleId };
}

function lastMatchingRule(
  rules: PermissionRule[],
  permission: string,
  pattern: string,
): PermissionRule | undefined {
  for (let i = rules.length - 1; i >= 0; i--) {
    const rule = rules[i];
    const permissionMatches = rule.permission === "*" || rule.permission === permission;
    if (permissionMatches && wildcardMatch(rule.pattern, pattern)) return rule;
  }
  return undefined;
}

function bashCommand(req: AuthorizeRequest): string {
  const command = (req.input as { command?: unknown })?.command;
  return typeof command === "string" ? command : req.patterns.join(" && ");
}

/** Escalates the decision when the classifier flags the command ("ask" is waived in bypass). */
function applyCommandRisk(
  decision: AuthorizeResponse,
  command: string,
  mode: PermissionMode,
): AuthorizeResponse {
  const risk = classifyCommand(command);
  if (!risk) return decision;
  if (mode === "bypass" && risk.action === "ask") return decision;
  const next = strictest(decision.action, risk.action);
  if (next === decision.action) return decision;
  return { action: next, reason: risk.reason, ruleId: decision.ruleId };
}
