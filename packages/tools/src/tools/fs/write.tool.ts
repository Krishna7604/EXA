// write: create a file or overwrite one the agent has already read.

import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { defineTool } from "@exa/core";
import { z } from "zod";
import { fileTimesFor } from "../../helpers/file-times.helper.ts";
import { pathAsks, resolvePath } from "../../helpers/paths.helper.ts";
import { countLines } from "./file-content.ts";

// ---------- write tool ----------
export const writeTool = defineTool({
  name: "write",
  description:
    "Create a new file or overwrite an existing one with the given content. Creates parent directories. " +
    "For existing files you must read them first; prefer edit for changes to existing files.",
  schema: z.object({
    filePath: z.string().min(1).describe("Absolute path, or relative to the working directory"),
    content: z.string().describe("Full file content"),
  }),
  permissionKey: "edit",
  readonly: false,
  permissions: (input, ctx) => {
    const r = resolvePath(ctx, input.filePath);
    return pathAsks("edit", r, `write ${r.rel}`);
  },
  async execute(input, ctx) {
    const { abs, rel } = resolvePath(ctx, input.filePath);
    await fileTimesFor(ctx)?.assertFresh(ctx.sessionId, abs);
    const before = await readExisting(abs);
    const existed = before !== null;
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, input.content, "utf8");
    const st = await stat(abs);
    fileTimesFor(ctx)?.recordRead(ctx.sessionId, abs, st.mtimeMs);
    return {
      output: `${existed ? "Overwrote" : "Created"} ${abs} (${countLines(input.content)} lines).`,
      title: rel,
      metadata: {
        existed,
        additions: countLines(input.content),
        deletions: countLines(before ?? ""),
        file: abs,
      },
    };
  },
});

// ---------- helpers ----------
/** Current content, or null when the file doesn't exist (or can't be read). */
async function readExisting(abs: string): Promise<string | null> {
  try {
    return await readFile(abs, "utf8");
  } catch {
    return null;
  }
}
