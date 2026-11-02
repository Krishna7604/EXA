import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { builtinRules, PermissionEngine, type ToolContext } from "@exa/core";
import {
  bashAsks,
  bashTool,
  editTool,
  FileTimes,
  GitSnapshots,
  globTool,
  grepTool,
  htmlToText,
  LocalInstructions,
  LocalSkills,
  listTool,
  locate,
  readTool,
  resolvePath,
  scrubbedEnv,
  writeTool,
} from "../index.ts";

let root: string;
let outside: string;
const ctx = (extra: Partial<ToolContext> = {}): ToolContext => ({
  sessionId: "s1",
  messageId: "m1",
  callId: `c${Math.random()}`,
  agent: "build",
  root,
  cwd: root,
  signal: new AbortController().signal,
  outputDir: join(root, ".out"),
  depth: 0,
  services: { fileTimes: new FileTimes() },
  ...extra,
});

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "exa-tools-"));
  outside = await mkdtemp(join(tmpdir(), "exa-outside-"));
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(
    join(root, "src", "a.ts"),
    "export const a = 1;\nexport function f() {\n  return a;\n}\n",
  );
  await writeFile(join(root, ".env"), "SECRET=1\n");
  await writeFile(join(outside, "secret.txt"), "nope\n");
  await symlink(outside, join(root, "link"));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

describe("path confinement", () => {
  test("relative, ../ escape and symlink escape", () => {
    expect(resolvePath(ctx(), "src/a.ts").inside).toBe(true);
    expect(resolvePath(ctx(), "../../etc/passwd").inside).toBe(false);
    const viaLink = resolvePath(ctx(), "link/secret.txt");
    expect(viaLink.inside).toBe(false);
    expect(viaLink.abs.endsWith("secret.txt")).toBe(true);
  });
  test("read outside root requires external_directory; .env is denied", async () => {
    const engine = new PermissionEngine(builtinRules());
    const asks = await readTool.permissions({ filePath: "link/secret.txt" }, ctx());
    expect(asks.map((a) => a.permission)).toEqual(["external_directory", "read"]);
    expect(engine.evaluate("external_directory", asks[0].patterns[0]).action).toBe("ask");
    const envAsk = (await readTool.permissions({ filePath: ".env" }, ctx()))[0];
    expect(engine.evaluate("read", envAsk.patterns[0]).action).toBe("deny");
  });
});

describe("file tools", () => {
  test("read numbers lines and records read time; edit requires prior read", async () => {
    const c = ctx();
    await expect(
      editTool.execute({ filePath: "src/a.ts", oldString: "a = 1", newString: "a = 2" }, c),
    ).rejects.toThrow("must read");
    const r = await readTool.execute({ filePath: "src/a.ts" }, c);
    expect(r.output.split("\n")[0]).toBe("1\texport const a = 1;");
    const e = await editTool.execute(
      { filePath: "src/a.ts", oldString: "a = 1", newString: "a = 2" },
      c,
    );
    expect(e.output).toContain("1 replacement");
    expect(await readFile(join(root, "src/a.ts"), "utf8")).toContain("a = 2");
  });
  test("edit: ambiguous match fails, replaceAll works, whitespace-tolerant fallback", async () => {
    const c = ctx();
    await writeFile(join(root, "dup.txt"), "x\nx\n  indented line\n");
    await readTool.execute({ filePath: "dup.txt" }, c);
    await expect(
      editTool.execute({ filePath: "dup.txt", oldString: "x", newString: "y" }, c),
    ).rejects.toThrow("matches 2");
    await editTool.execute(
      { filePath: "dup.txt", oldString: "x", newString: "y", replaceAll: true },
      c,
    );
    await editTool.execute(
      { filePath: "dup.txt", oldString: "indented line", newString: "  changed" },
      c,
    );
    expect(await readFile(join(root, "dup.txt"), "utf8")).toBe("y\ny\n    changed\n");
    expect(locate("a\n    b  \nc", "b\nc").length).toBe(1);
  });
  test("edit detects external modification since read", async () => {
    const c = ctx();
    await writeFile(join(root, "m.txt"), "one\n");
    await readTool.execute({ filePath: "m.txt" }, c);
    await Bun.sleep(5);
    await writeFile(join(root, "m.txt"), "two\n");
    await expect(
      editTool.execute({ filePath: "m.txt", oldString: "two", newString: "three" }, c),
    ).rejects.toThrow("modified since");
  });
  test("write creates new files and dirs", async () => {
    const r = await writeTool.execute({ filePath: "new/dir/f.txt", content: "hi\n" }, ctx());
    expect(r.output).toContain("Created");
  });
  test("list/glob/grep", async () => {
    const l = await listTool.execute({}, ctx());
    expect(l.output).toContain("src/");
    const g = await globTool.execute({ pattern: "**/*.ts" }, ctx());
    expect(g.output).toContain("src/a.ts");
    const gr = await grepTool.execute({ pattern: "function f" }, ctx());
    expect(gr.output).toContain("a.ts");
    expect(gr.output).toContain("2: export function f()");
  });
});

describe("bash", () => {
  test("asks per parsed subcommand with prefix-based always patterns", () => {
    const asks = bashAsks("git status && rm -rf build > log.txt", ctx());
    const bash = asks.find((a) => a.permission === "bash")!;
    expect(bash.patterns).toEqual(["git status", "rm -rf build"]);
    expect(bash.always).toContain("git status *");
    expect(asks.some((a) => a.permission === "edit" && a.patterns[0].endsWith("log.txt"))).toBe(
      true,
    );
  });
  test("paths outside root in rm/cp need external_directory", () => {
    const asks = bashAsks("rm -rf /etc/hosts", ctx());
    expect(asks.some((a) => a.permission === "external_directory")).toBe(true);
  });
  test("unparseable command asks with the raw string", () => {
    const asks = bashAsks(`echo "unterminated`, ctx());
    expect(asks[0].patterns[0]).toBe(`echo "unterminated`);
  });
  test("runs, reports exit code, scrubs secrets from env", async () => {
    process.env.OPENAI_API_KEY = "sk-test-should-not-leak";
    const r = await bashTool.execute({ command: "echo $OPENAI_API_KEY; exit 3" }, ctx());
    expect(r.output).not.toContain("sk-test");
    expect(r.metadata?.exit).toBe(3);
    expect(scrubbedEnv({ OPENAI_API_KEY: "x", PATH: "/bin", EXA_TOKEN: "t" })).toEqual({
      PATH: "/bin",
    });
    delete process.env.OPENAI_API_KEY;
  });
  test("timeout kills the process group", async () => {
    const started = Date.now();
    const r = await bashTool.execute(
      { command: "sleep 5 & sleep 5; echo never", timeout: 1000 },
      ctx(),
    );
    expect(Date.now() - started).toBeLessThan(4000);
    expect(r.output).toContain("timed out");
  });
});

describe("workspace services", () => {
  test("instructions: AGENTS.md preferred over CLAUDE.md, walking up from cwd", async () => {
    await writeFile(join(root, "CLAUDE.md"), "root claude");
    await writeFile(join(root, "src", "AGENTS.md"), "src agents");
    const ins = await new LocalInstructions(
      root,
      join(root, "src"),
      [],
      join(root, "nohome"),
    ).load();
    expect(ins.map((i) => i.content)).toEqual(["root claude", "src agents"]);
  });
  test("skills: name must match directory, frontmatter required", async () => {
    await mkdir(join(root, ".agents/skills/good-skill"), { recursive: true });
    await writeFile(
      join(root, ".agents/skills/good-skill/SKILL.md"),
      "---\nname: good-skill\ndescription: Does good things\n---\nBody here",
    );
    await mkdir(join(root, ".agents/skills/bad"), { recursive: true });
    await writeFile(
      join(root, ".agents/skills/bad/SKILL.md"),
      "---\nname: other\ndescription: x\n---\n",
    );
    const s = new LocalSkills(root, join(root, "nohome"));
    expect((await s.list()).map((x) => x.name)).toEqual(["good-skill"]);
    expect((await s.load("good-skill"))!.body).toBe("Body here");
  });
  test("snapshots: track, detect changes, restore", async () => {
    const dir = await mkdtemp(join(tmpdir(), "exa-snap-"));
    await writeFile(join(dir, "f.txt"), "v1\n");
    const snapData = await mkdtemp(join(tmpdir(), "exa-snapdata-"));
    const snaps = new GitSnapshots(dir, snapData);
    const s1 = await snaps.track();
    expect(s1).toBeTruthy();
    await writeFile(join(dir, "f.txt"), "v2\n");
    await writeFile(join(dir, "new.txt"), "n\n");
    const changed = await snaps.changed(s1!);
    expect(changed.map((f) => f.split("/").pop()).sort()).toEqual(["f.txt", "new.txt"]);
    await snaps.restore(s1!, changed);
    expect(await readFile(join(dir, "f.txt"), "utf8")).toBe("v1\n");
    expect(await Bun.file(join(dir, "new.txt")).exists()).toBe(false);
    await rm(dir, { recursive: true, force: true });
    await rm(snapData, { recursive: true, force: true });
  });
  test("htmlToText", () => {
    expect(
      htmlToText(
        "<html><head><title>x</title></head><body><h1>Hi</h1><p>a &amp; b</p><script>evil()</script></body></html>",
      ),
    ).toBe("# Hi\na & b");
  });
});

describe("apply_patch", () => {
  test("add/update/move/delete atomically; a bad hunk changes nothing", async () => {
    const { applyPatchTool } = await import("../tools/patch/apply-patch.tool.ts");
    const c = ctx();
    await writeFile(join(root, "p1.txt"), "a\nb\nc\nd\n");
    await writeFile(join(root, "p2.txt"), "keep\n");
    await readTool.execute({ filePath: "p1.txt" }, c);
    await readTool.execute({ filePath: "p2.txt" }, c);
    const bad =
      "*** Begin Patch\n*** Add File: new1.txt\n+x\n*** Update File: p1.txt\n@@\n-zzz\n+yyy\n*** End Patch";
    await expect(applyPatchTool.execute({ patchText: bad }, c)).rejects.toThrow("did not match");
    expect(await Bun.file(join(root, "new1.txt")).exists()).toBe(false);
    const good = [
      "*** Begin Patch",
      "*** Add File: sub/new.txt",
      "+hello",
      "*** Update File: p1.txt",
      "*** Move to: p1-renamed.txt",
      "@@",
      " b",
      "-c",
      "+C",
      " d",
      "*** Delete File: p2.txt",
      "*** End Patch",
    ].join("\n");
    const asks = await applyPatchTool.permissions({ patchText: good }, c);
    expect(asks.every((a) => a.permission === "edit")).toBe(true);
    const r = await applyPatchTool.execute({ patchText: good }, c);
    expect(r.output).toContain("R p1.txt → p1-renamed.txt");
    expect(await readFile(join(root, "p1-renamed.txt"), "utf8")).toBe("a\nb\nC\nd\n");
    expect(await readFile(join(root, "sub/new.txt"), "utf8")).toBe("hello\n");
    expect(await Bun.file(join(root, "p2.txt")).exists()).toBe(false);
    expect(await Bun.file(join(root, "p1.txt")).exists()).toBe(false);
  });
});

describe("custom agents + commands", () => {
  test("agents and commands load from .exa/.opencode/.claude and expand", async () => {
    const { loadLocalAgents, loadLocalCommands, expandCommand } = await import("../index.ts");
    await mkdir(join(root, ".opencode/agents"), { recursive: true });
    await writeFile(
      join(root, ".opencode/agents/reviewer.md"),
      "---\ndescription: Reviews code. Read-only.\nmode: subagent\npermission:\n  edit: deny\n  bash: deny\n---\nYou review code.",
    );
    await writeFile(
      join(root, ".opencode/agents/broken.md"),
      "---\nmode: subagent\n---\nno description",
    );
    await mkdir(join(root, ".exa/commands"), { recursive: true });
    await writeFile(
      join(root, ".exa/commands/fix.md"),
      "---\ndescription: Fix an issue\nagent: build\n---\nFix $1 in @src/a.ts. Status: !`echo clean`. All: $ARGUMENTS",
    );
    const agents = await loadLocalAgents(root, join(root, "nohome"));
    expect(agents.map((a) => a.name)).toEqual(["reviewer"]);
    expect(agents[0].rules.map((r) => `${r.permission}=${r.action}`)).toEqual([
      "edit=deny",
      "bash=deny",
    ]);
    const cmds = await loadLocalCommands(root, join(root, "nohome"));
    expect(cmds[0]).toMatchObject({ name: "fix", description: "Fix an issue", agent: "build" });
    const noShell = await expandCommand(cmds[0], "bug-42 now", { root, allowShell: false });
    expect(noShell).toContain("Fix bug-42 in");
    expect(noShell).toContain('<file path="src/a.ts">');
    expect(noShell).toContain("[shell substitution skipped: echo clean]");
    const withShell = await expandCommand(cmds[0], "x", {
      root,
      allowShell: true,
      runShell: async (c) => (c === "echo clean" ? "clean\n" : ""),
    });
    expect(withShell).toContain("Status: clean.");
  });
});

describe("webfetch SSRF guard", () => {
  test("blocks private literals, internal DNS names and CGNAT; allows public names", async () => {
    const { assertPublicHost } = await import("../index.ts");
    for (const h of [
      "127.0.0.1",
      "10.1.2.3",
      "169.254.169.254",
      "192.168.0.1",
      "172.20.0.1",
      "[::1]",
      "::ffff:10.0.0.1",
      "100.64.1.1",
      "localhost",
      "metadata.google.internal",
    ]) {
      await expect(assertPublicHost(h)).rejects.toThrow();
    }
    await expect(assertPublicHost("localhost.localdomain.invalid")).rejects.toThrow();
    await expect(assertPublicHost("8.8.8.8")).resolves.toBeUndefined();
  });
});
