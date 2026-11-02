// Adapter tests: our classes exposed as LangChain StructuredTools.
// Behavior must match the classes (validation, hooks, truncation).
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HookManager } from "../../hooks.js";
import { langchainTools, toStructuredTool, TOOL_SCHEMAS } from "../langchain.js";
import { ReadTool } from "../read.js";
import { ShellTool } from "../shell.js";

describe("langchain adapter", () => {
  test("exposes all six tools with names + descriptions", () => {
    const tools = langchainTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["edit", "glob", "grep", "read", "shell", "write"]);
    expect(tools.every((t) => typeof t.description === "string" && t.description.length > 0)).toBe(true);
  });

  test("read/write roundtrip through invoke", async () => {
    const dir = await mkdtemp(join(tmpdir(), "exa-lc-"));
    try {
      const tools = langchainTools();
      const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
      const p = join(dir, "lc.txt");
      expect(await byName.write.invoke({ path: p, content: "lc-hello" })).toContain("wrote");
      expect(await byName.read.invoke({ path: p })).toBe("lc-hello");
      // schema rejects empty path before our class even runs
      await expect(byName.read.invoke({ path: "" })).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("non-string results come back JSON-encoded", async () => {
    const tools = langchainTools();
    const glob = tools.find((t) => t.name === "glob");
    if (!glob) throw new Error("glob tool missing");
    const out = await glob.invoke({ pattern: "src/tools/tool.ts" });
    expect(JSON.parse(out)).toContain("src/tools/tool.ts");
  });

  test("shell keeps hook approvals (echo ok, rm -rf denied)", async () => {
    const shell = toStructuredTool(new ShellTool(new HookManager()), TOOL_SCHEMAS.shell);
    expect(await shell.invoke({ cmd: "echo lc-shell-ok" })).toContain("lc-shell-ok");
    await expect(shell.invoke({ cmd: "rm -rf /tmp/lc-nope" })).rejects.toThrow("blocked");
  });

  test("toStructuredTool delegates to the wrapped instance", async () => {
    const dir = await mkdtemp(join(tmpdir(), "exa-lc-"));
    try {
      const p = join(dir, "d.txt");
      await writeFile(p, "delegated", "utf8");
      const tool = toStructuredTool(new ReadTool(), TOOL_SCHEMAS.read);
      expect(tool.name).toBe("read");
      expect(await tool.invoke({ path: p })).toBe("delegated");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
