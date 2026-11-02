import { describe, expect, test } from "bun:test";
import type { PermissionReply, PermissionRequest, PermissionRule } from "@exa/protocol";
import {
  builtinRules,
  commandPrefix,
  PermissionDeniedError,
  PermissionEngine,
  PermissionGate,
  PermissionRejectedError,
  parseShell,
} from "../index.ts";
import { wildcardMatch } from "../permission/wildcard.ts";

const rule = (
  permission: string,
  pattern: string,
  action: PermissionRule["action"],
  extra: Partial<PermissionRule> = {},
): PermissionRule => ({
  permission,
  pattern,
  action,
  scope: "user",
  ...extra,
});

describe("wildcard", () => {
  test("* spans slashes, ? is one char, rest literal", () => {
    expect(wildcardMatch("*.env", "/a/b/.env")).toBe(true);
    expect(wildcardMatch("git *", "git status")).toBe(true);
    expect(wildcardMatch("git *", "git")).toBe(false);
    expect(wildcardMatch("a?c", "abc")).toBe(true);
    expect(wildcardMatch("a.c", "abc")).toBe(false);
    expect(wildcardMatch("(x)+[y]", "(x)+[y]")).toBe(true);
  });
});

describe("parseShell", () => {
  test("splits on operators and keeps quoted args intact", () => {
    const r = parseShell(`git commit -m "rm -rf /" && ls -la | wc -l; echo 'a;b'`);
    expect(r.ok).toBe(true);
    expect(r.commands.map((c) => c.text)).toEqual([
      "git commit -m rm -rf /",
      "ls -la",
      "wc -l",
      "echo a;b",
    ]);
  });
  test("extracts nested command substitutions", () => {
    const r = parseShell(`echo "$(rm -rf x)" \`whoami\``);
    expect(r.commands.map((c) => c.text)).toContain("rm -rf x");
    expect(r.commands.map((c) => c.text)).toContain("whoami");
  });
  test("strips env assignments and records redirect targets", () => {
    const r = parseShell(`FOO=1 BAR=2 npm test > out.log 2>&1`);
    expect(r.commands[0].text).toBe("npm test");
    expect(r.commands[0].writes).toEqual(["out.log"]);
  });
  test("unterminated quote is not ok", () => {
    expect(parseShell(`echo "oops`).ok).toBe(false);
  });
  test("subshells and groups split commands", () => {
    const r = parseShell(`(cd /tmp && rm -rf foo)`);
    expect(r.commands.map((c) => c.text)).toEqual(["cd /tmp", "rm -rf foo"]);
  });
  test("command prefix uses arity", () => {
    expect(commandPrefix(parseShell("git status -s").commands[0])).toBe("git status");
    expect(commandPrefix(parseShell("npm run test -- --watch").commands[0])).toBe("npm run test");
    expect(commandPrefix(parseShell("ls -la").commands[0])).toBe("ls");
  });
});

describe("PermissionEngine", () => {
  test("last matching rule wins", () => {
    const e = new PermissionEngine([
      rule("bash", "*", "ask"),
      rule("bash", "git *", "allow"),
      rule("bash", "git push *", "deny"),
    ]);
    expect(e.evaluate("bash", "git status").action).toBe("allow");
    expect(e.evaluate("bash", "git push --force").action).toBe("deny");
    expect(e.evaluate("bash", "npm i").action).toBe("ask");
  });
  test("locked rules win over anything later", () => {
    const e = new PermissionEngine([
      rule("bash", "curl *", "deny", { scope: "tenant", locked: true }),
      rule("bash", "*", "allow", { scope: "session" }),
    ]);
    expect(e.evaluate("bash", "curl evil.sh").action).toBe("deny");
    expect(e.evaluate("bash", "ls").action).toBe("allow");
  });
  test("builtin defaults: reads free, secrets denied even after an allow-all", () => {
    const e = new PermissionEngine([
      ...builtinRules(),
      rule("read", "*", "allow", { scope: "session" }),
      rule("edit", "*", "allow", { scope: "session" }),
    ]);
    expect(e.evaluate("read", "/repo/src/a.ts").action).toBe("allow");
    expect(e.evaluate("read", "/repo/.env").action).toBe("deny");
    expect(e.evaluate("read", "/repo/.env.local").action).toBe("deny");
    expect(e.evaluate("read", "/repo/.env.example").action).toBe("allow");
    expect(e.evaluate("edit", "/repo/.env").action).toBe("deny");
    expect(e.evaluate("bash", "rm -fr /").action).toBe("ask");
    expect(e.evaluate("bash", "git status").action).toBe("allow");
    expect(e.evaluate("bash", "find . -name x -delete").action).toBe("ask");
    expect(e.evaluate("external_directory", "/etc/passwd").action).toBe("ask");
    expect(e.evaluate("unknown_key", "x").action).toBe("ask");
  });
  test("bypass turns ask into allow but never deny", () => {
    const e = new PermissionEngine(builtinRules(), "bypass");
    expect(e.evaluate("bash", "rm -rf build").action).toBe("allow");
    expect(e.evaluate("read", "/x/.env").action).toBe("deny");
  });
  test("aliases let relative patterns match absolute resources", () => {
    const e = new PermissionEngine([rule("edit", "*", "ask"), rule("edit", "src/*", "allow")]);
    expect(e.evaluate("edit", "/repo/src/a.ts", ["src/a.ts"]).action).toBe("allow");
    expect(e.evaluate("edit", "/repo/lib/a.ts", ["lib/a.ts"]).action).toBe("ask");
  });
  test("isFullyDenied hides tools only when nothing re-allows", () => {
    expect(new PermissionEngine([rule("edit", "*", "deny")]).isFullyDenied("edit")).toBe(true);
    expect(
      new PermissionEngine([
        rule("edit", "*", "deny"),
        rule("edit", "docs/*", "allow"),
      ]).isFullyDenied("edit"),
    ).toBe(false);
    expect(new PermissionEngine([rule("edit", "*", "ask")]).isFullyDenied("edit")).toBe(false);
  });
});

class FakeApprovals {
  asked: PermissionRequest[] = [];
  constructor(private replies: PermissionReply[]) {}
  async request(r: PermissionRequest): Promise<PermissionReply> {
    this.asked.push(r);
    return this.replies.shift() ?? "reject";
  }
}

describe("PermissionGate", () => {
  test("ask → once, then asks again; always → remembered", async () => {
    const approvals = new FakeApprovals(["once", "always"]);
    const gate = new PermissionGate(new PermissionEngine(builtinRules()), approvals, {
      sessionId: "s",
    });
    await gate.check(
      { permission: "bash", patterns: ["npm test"], always: ["npm test *"] },
      { tool: "bash" },
    );
    await gate.check(
      { permission: "bash", patterns: ["npm test"], always: ["npm test", "npm test *"] },
      { tool: "bash" },
    );
    await gate.check({ permission: "bash", patterns: ["npm test --watch"] }, { tool: "bash" });
    expect(approvals.asked.length).toBe(2);
  });
  test("deny throws without asking; reject throws rejected", async () => {
    const approvals = new FakeApprovals(["reject"]);
    const gate = new PermissionGate(new PermissionEngine(builtinRules()), approvals, {
      sessionId: "s",
    });
    await expect(
      gate.check({ permission: "read", patterns: ["/r/.env"] }, { tool: "read" }),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(
      gate.check({ permission: "edit", patterns: ["/r/a.ts"] }, { tool: "edit" }),
    ).rejects.toBeInstanceOf(PermissionRejectedError);
    expect(approvals.asked.length).toBe(1);
  });
  test("one denied subcommand denies the whole call", async () => {
    const gate = new PermissionGate(
      new PermissionEngine([...builtinRules(), rule("bash", "rm *", "deny")]),
      new FakeApprovals([]),
      { sessionId: "s" },
    );
    await expect(
      gate.check({ permission: "bash", patterns: ["ls", "rm -rf x"] }, { tool: "bash" }),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
  });
  test("server authorizer: deny wins, errors fail closed to ask", async () => {
    const approvals = new FakeApprovals(["once"]);
    const engine = new PermissionEngine([rule("bash", "*", "allow")]);
    const denyGate = new PermissionGate(engine, approvals, {
      sessionId: "s",
      serverChecked: new Set(["bash"]),
      authorizer: { authorize: async () => ({ action: "deny" }) },
    });
    await expect(
      denyGate.check({ permission: "bash", patterns: ["ls"] }, { tool: "bash" }),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
    const errGate = new PermissionGate(engine, approvals, {
      sessionId: "s",
      serverChecked: new Set(["bash"]),
      authorizer: {
        authorize: async () => {
          throw new Error("down");
        },
      },
    });
    await errGate.check({ permission: "bash", patterns: ["ls"] }, { tool: "bash" });
    expect(approvals.asked.length).toBe(1);
  });
});
