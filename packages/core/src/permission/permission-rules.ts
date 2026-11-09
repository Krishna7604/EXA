// Built-in permission rule sets: the defaults every session starts from, the locked secret
// floor, and the rules each permission mode contributes.

import type { PermissionAction, PermissionMode, PermissionRule } from "@exa/protocol";

// ---------- constants ----------
/** Read-only shell commands allowed without asking (with or without arguments). */
const SAFE_BASH = [
  "ls",
  "pwd",
  "echo",
  "cat",
  "head",
  "tail",
  "wc",
  "file",
  "stat",
  "which",
  "type",
  "whoami",
  "date",
  "uname",
  "tree",
  "du",
  "df",
  "env",
  "printenv",
  "basename",
  "dirname",
  "realpath",
  "sort",
  "uniq",
  "cut",
  "diff",
  "cmp",
  "rg",
  "grep",
  "egrep",
  "fgrep",
  "find",
  "fd",
  "jq",
  "git status",
  "git diff",
  "git log",
  "git show",
  "git branch",
  "git blame",
  "git rev-parse",
  "git remote",
  "git ls-files",
  "git describe",
  "git tag",
];

/** Mutating forms of otherwise safe commands: these stay behind approval. */
const MUTATING_BASH = [
  // find variants that mutate or exec
  "find * -delete*",
  "find * -exec*",
  "find * -execdir*",
  "find * -ok*",
  "git branch -D*",
  "git branch -d*",
  "git branch -m*",
  "git tag -d*",
  "git remote add*",
  "git remote remove*",
  "git remote set-url*",
];

/** Paths whose content the agent may never read or write. */
const SECRET_PATHS = [
  "*.env",
  "*.env.*",
  "*/.ssh/*",
  "*.pem",
  "*.key",
  "*/.aws/credentials",
  "*/.exa/credentials.json",
  "*/.netrc",
];

/** Secret-looking templates that are safe to read. */
const SECRET_TEMPLATES = ["*.env.example", "*.env.sample", "*.env.template"];

// ---------- rule sets ----------
/** Defaults modeled on OpenCode: reads free (except secrets), edits/shell ask, unknown keys ask. */
export function builtinRules(): PermissionRule[] {
  const r = builtinRule;
  return [
    r("*", "*", "ask"),
    r("read", "*", "allow"),
    r("glob", "*", "allow"),
    r("grep", "*", "allow"),
    r("list", "*", "allow"),
    r("skill", "*", "allow"),
    r("todowrite", "*", "allow"),
    r("question", "*", "allow"),
    r("task", "*", "allow"),
    r("websearch", "*", "allow"),
    r("memory", "*", "allow"),
    r("recall", "*", "allow"),
    r("webfetch", "*", "ask"),
    r("edit", "*", "ask"),
    r("bash", "*", "ask"),
    ...SAFE_BASH.flatMap((c) => [r("bash", c, "allow"), r("bash", `${c} *`, "allow")]),
    ...MUTATING_BASH.map((c) => r("bash", c, "ask")),
    r("external_directory", "*", "ask"),
    r("doom_loop", "*", "ask"),
    ...secretFloor(),
  ];
}

/**
 * Locked safety floor: secrets are never read or written by the agent, whatever a later
 * "always" answer or user rule says. Tenants can add their own locked rules after these.
 */
export function secretFloor(): PermissionRule[] {
  const out: PermissionRule[] = [];
  for (const permission of ["read", "edit"]) {
    for (const pattern of SECRET_PATHS) out.push(lockedRule(permission, pattern, "deny"));
  }
  // re-allow the safe templates (last locked match wins)
  for (const pattern of SECRET_TEMPLATES) out.push(lockedRule("read", pattern, "allow"));
  return out;
}

/** Rules a permission mode contributes (agent layer). */
export function modeRules(mode: PermissionMode): PermissionRule[] {
  switch (mode) {
    case "accept-edits":
      return [{ permission: "edit", pattern: "*", action: "allow", scope: "session" }];
    case "plan":
      return [
        { permission: "edit", pattern: "*", action: "deny", scope: "session" },
        { permission: "todowrite", pattern: "*", action: "allow", scope: "session" },
      ];
    default:
      return [];
  }
}

// ---------- helpers ----------
function builtinRule(
  permission: string,
  pattern: string,
  action: PermissionAction,
): PermissionRule {
  return { permission, pattern, action, scope: "builtin" };
}

function lockedRule(permission: string, pattern: string, action: PermissionAction): PermissionRule {
  return { permission, pattern, action, scope: "builtin", locked: true };
}
