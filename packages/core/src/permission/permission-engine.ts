// Permission engine. Same code runs in the client loop and on the server so identical
// inputs give identical decisions.
//
// Resolution: rules are concatenated in precedence order
//   builtin < tenant < project < user < agent < session
// and the LAST matching rule wins (write the catch-all first, specifics after).
// Locked rules (tenant policy) are then evaluated on their own; if one matches, it wins
// regardless of anything below it. Mode `bypass` turns a final `ask` into `allow`, never a `deny`.
//
// Built-in rule sets live in permission-rules.ts, the per-session gate in permission-gate.ts.

import type { PermissionAction, PermissionMode, PermissionRule } from "@exa/protocol";
import { wildcardMatch } from "./wildcard.ts";

// ---------- constants ----------
const SEVERITY: Record<PermissionAction, number> = { allow: 0, ask: 1, deny: 2 };
const ANY = "*";

// ---------- types ----------
export interface Decision {
  action: PermissionAction;
  rule?: PermissionRule;
}

// ---------- permission engine ----------
export function strictest(a: PermissionAction, b: PermissionAction): PermissionAction {
  return SEVERITY[a] >= SEVERITY[b] ? a : b;
}

export class PermissionEngine {
  private readonly unlocked: PermissionRule[];
  private readonly locked: PermissionRule[];

  constructor(
    rules: PermissionRule[],
    readonly mode: PermissionMode = "default",
  ) {
    this.unlocked = rules.filter((r) => !r.locked);
    this.locked = rules.filter((r) => r.locked);
  }

  get rules(): PermissionRule[] {
    return [...this.unlocked, ...this.locked];
  }

  /** Engine with extra rules appended (higher precedence). */
  extend(rules: PermissionRule[], mode: PermissionMode = this.mode): PermissionEngine {
    return new PermissionEngine([...this.unlocked, ...this.locked, ...rules], mode);
  }

  /**
   * Decide one resource. `aliases` are alternative spellings of the same resource (e.g. a
   * root-relative path next to the absolute one) — a rule matching any of them applies.
   */
  evaluate(permission: string, resource: string, aliases: string[] = []): Decision {
    const values = [resource, ...aliases];
    const unlockedRule = lastMatch(this.unlocked, permission, values);
    const lockedRule = lastMatch(this.locked, permission, values);
    const rule = lockedRule ?? unlockedRule;
    const decision: Decision = rule ? { action: rule.action, rule } : { action: "ask" };
    if (this.mode === "bypass" && decision.action === "ask" && !decision.rule?.locked) {
      return { action: "allow", rule: decision.rule };
    }
    return decision;
  }

  /** True when every rule for `permission` denies `*` — the tool is hidden from the model. */
  isFullyDenied(permission: string): boolean {
    const d = this.evaluate(permission, ANY);
    if (d.action !== "deny" || d.rule?.pattern !== ANY) return false;
    // a later, more specific allow/ask would re-enable some resources
    const all = [...this.unlocked, ...this.locked];
    const idx = all.indexOf(d.rule);
    return !all
      .slice(idx + 1)
      .some((r) => (r.permission === permission || r.permission === ANY) && r.action !== "deny");
  }
}

// ---------- errors ----------
export class PermissionDeniedError extends Error {
  constructor(
    readonly permission: string,
    readonly pattern: string,
    readonly rule?: PermissionRule,
  ) {
    const ruleLabel = rule ? ` (rule ${rule.scope}:${rule.permission}=${rule.pattern})` : "";
    super(
      `Permission denied: ${permission} "${pattern}"${ruleLabel}. Do not retry this; choose a different approach or ask the user.`,
    );
    this.name = "PermissionDeniedError";
  }
}

export class PermissionRejectedError extends Error {
  constructor(readonly permission: string) {
    super(
      `The user rejected permission for ${permission}. Stop and wait for the user's direction.`,
    );
    this.name = "PermissionRejectedError";
  }
}

// ---------- helpers ----------
/** The last rule (highest precedence) matching `permission` and any of `values`. */
function lastMatch(
  rules: PermissionRule[],
  permission: string,
  values: string[],
): PermissionRule | undefined {
  for (let i = rules.length - 1; i >= 0; i--) {
    if (ruleMatches(rules[i], permission, values)) return rules[i];
  }
  return undefined;
}

function ruleMatches(rule: PermissionRule, permission: string, values: string[]): boolean {
  if (rule.permission !== ANY && rule.permission !== permission) return false;
  return values.some((v) => wildcardMatch(rule.pattern, v));
}
