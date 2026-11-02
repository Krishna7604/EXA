// Class-level tests: tool classes + ToolRegistry + HookManager. No network;
// shell test uses only `echo` (safe) plus a blocked-pattern rejection.
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HookManager } from "../../hooks.js";
import { EditTool } from "../edit.js";
import { GlobTool } from "../glob.js";
import { GrepTool } from "../grep.js";
import { ReadTool } from "../read.js";
import { ShellTool } from "../shell.js";
import { ToolRegistry } from "../tool.js";
import { WriteTool } from "../write.js";

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "exa-tool-"));
}

describe("HookManager", () => {
  test("shell defaults to ask-human, destructive patterns are denied", async () => {
    const h = new HookManager();
    expect(await h.onPreToolUse("shell", { cmd: "echo hi" })).toMatchObject({ allow: "ask-human" });
    expect(await h.onPreToolUse("shell", { cmd: "rm -rf /tmp/x" })).toMatchObject({ allow: false });
    expect(await h.onPreToolUse("read", { path: "x" })).toMatchObject({ allow: true });
  });
});

describe("ToolRegistry", () => {
  test("register/get/require/list/run", async () => {
    const reg = new ToolRegistry([new ReadTool()]);
    expect(reg.list().map((t) => t.name)).toEqual(["read"]);
    expect(reg.get("missing")).toBeUndefined();
    expect(() => reg.require("missing")).toThrow("unknown tool");
    const dir = await tempDir();
    try {
      const p = join(dir, "a.txt");
      await writeFile(p, "hello-tools", "utf8");
      expect(await reg.run("read", { path: p })).toBe("hello-tools");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("tool classes", () => {
  test("ReadTool reads, validates args", async () => {
    const dir = await tempDir();
    try {
      const p = join(dir, "r.txt");
      await writeFile(p, "read-me", "utf8");
      const t = new ReadTool();
      expect(t.name).toBe("read");
      expect(t.readonly).toBe(true);
      expect(await t.execute({ path: p })).toBe("read-me");
      await expect(t.execute({ path: "" })).rejects.toThrow("non-empty string");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("WriteTool creates parent dirs, validates content", async () => {
    const dir = await tempDir();
    try {
      const t = new WriteTool();
      expect(t.readonly).toBe(false);
      const p = join(dir, "sub", "w.txt");
      expect(await t.execute({ path: p, content: "abc" })).toContain("wrote");
      await expect(t.execute({ path: p, content: 42 as unknown as string })).rejects.toThrow("must be a string");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("EditTool replaces once, throws when oldString missing", async () => {
    const dir = await tempDir();
    try {
      const p = join(dir, "e.txt");
      await writeFile(p, "foo bar foo", "utf8");
      const t = new EditTool();
      expect(await t.execute({ path: p, oldString: "bar", newString: "BAZ" })).toContain("edited");
      await expect(t.execute({ path: p, oldString: "zzz", newString: "q" })).rejects.toThrow("oldString not found");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("GlobTool validates pattern, returns string list", async () => {
    const t = new GlobTool();
    const out = await t.execute({ pattern: "src/router/*.ts" });
    expect(Array.isArray(out)).toBe(true);
    expect(out.every((f) => typeof f === "string")).toBe(true);
    await expect(t.execute({ pattern: "" })).rejects.toThrow("non-empty string");
  });

  test("GrepTool finds a planted token in an isolated dir", async () => {
    const dir = await tempDir();
    try {
      await writeFile(join(dir, "hit.md"), "line one\nUNIQUE_TOKEN_XYZ_42 here\n", "utf8");
      const t = new GrepTool();
      const hits = await t.execute({ pattern: "UNIQUE_TOKEN_XYZ_42", dir });
      expect(hits.length).toBeGreaterThan(0);
      expect(hits[0]).toContain("UNIQUE_TOKEN_XYZ_42");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("ShellTool runs echo, blocks destructive commands", async () => {
    const t = new ShellTool(new HookManager());
    expect(await t.execute({ cmd: "echo shell-ok" })).toContain("shell-ok");
    await expect(t.execute({ cmd: "rm -rf /tmp/should-not-run" })).rejects.toThrow("blocked");
    await expect(t.execute({ cmd: "" })).rejects.toThrow("non-empty string");
  });
});
