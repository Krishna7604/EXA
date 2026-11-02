// apply_patch: multi-file edits in the "*** Begin Patch" envelope format (preferred by
// GPT/Codex-family models). Atomic: every hunk is validated against the current files
// before anything is written.

import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { defineTool, type PermissionAsk, type ToolContext } from "@exa/core";
import { z } from "zod";
import { type FileTimes, fileTimesFor } from "../../helpers/file-times.helper.ts";
import { pathAsks, resolvePath } from "../../helpers/paths.helper.ts";
import { applyChunks } from "./patch-apply.ts";
import { type PatchChunk, type PatchOp, parsePatch } from "./patch-parse.ts";

// ---------- constants ----------
/** Suffix of the temp file each write goes through before the atomic rename. */
const TEMP_SUFFIX = ".exa-tmp";

// ---------- types ----------
/** One pending filesystem change; `content: null` deletes, `from` marks a move source. */
interface PendingWrite {
  abs: string;
  content: string | null;
  from?: string;
}

/** Everything the patch will do, computed in memory before touching the disk. */
interface PatchPlan {
  writes: PendingWrite[];
  summary: string[];
  additions: number;
  deletions: number;
}

// ---------- apply_patch tool ----------
export const applyPatchTool = defineTool({
  name: "apply_patch",
  description:
    "Apply a multi-file patch. Format:\n*** Begin Patch\n*** Add File: path\n+new line\n*** Update File: path\n@@ optional context\n unchanged line\n-removed line\n+added line\n*** Delete File: path\n*** End Patch\n" +
    "Include 3 lines of unchanged context around each change. Read files before patching them. All hunks are checked before anything is written.",
  schema: z.object({ patchText: z.string().min(1).describe("The full patch text") }),
  permissionKey: "edit",
  readonly: false,
  permissions: (input, ctx) => patchAsks(parsePatch(input.patchText), ctx),
  async execute(input, ctx: ToolContext) {
    const ops = parsePatch(input.patchText);
    const fileTimes = fileTimesFor(ctx);
    const plan = await planPatch(ops, ctx, fileTimes);
    await commitWrites(plan.writes, ctx.sessionId, fileTimes);
    return {
      output: `Applied patch:\n${plan.summary.join("\n")}`,
      title: `${ops.length} file(s)`,
      metadata: { additions: plan.additions, deletions: plan.deletions, files: plan.summary },
    };
  },
});

// ---------- helpers ----------
function patchAsks(ops: PatchOp[], ctx: ToolContext): PermissionAsk[] {
  const asks: PermissionAsk[] = [];
  for (const op of ops) {
    const moveTo = op.kind === "update" ? op.moveTo : undefined;
    for (const p of [op.path, moveTo]) {
      if (!p) continue;
      const r = resolvePath(ctx, p);
      asks.push(...pathAsks("edit", r, `${op.kind} ${r.rel}`));
    }
  }
  return asks;
}

/** Phase 1: compute every result in memory so a bad hunk aborts before any write. */
async function planPatch(
  ops: PatchOp[],
  ctx: ToolContext,
  fileTimes: FileTimes | undefined,
): Promise<PatchPlan> {
  const plan: PatchPlan = { writes: [], summary: [], additions: 0, deletions: 0 };
  for (const op of ops) {
    if (op.kind === "add") await planAdd(plan, op, ctx);
    else if (op.kind === "delete") await planDelete(plan, op, ctx, fileTimes);
    else await planUpdate(plan, op, ctx, fileTimes);
  }
  return plan;
}

async function planAdd(
  plan: PatchPlan,
  op: Extract<PatchOp, { kind: "add" }>,
  ctx: ToolContext,
): Promise<void> {
  const r = resolvePath(ctx, op.path);
  const exists = await stat(r.abs).then(
    () => true,
    () => false,
  );
  if (exists) throw new Error(`${r.rel} already exists; use Update File`);
  plan.writes.push({ abs: r.abs, content: op.content });
  plan.additions += op.content.split("\n").length - 1;
  plan.summary.push(`A ${r.rel}`);
}

async function planDelete(
  plan: PatchPlan,
  op: Extract<PatchOp, { kind: "delete" }>,
  ctx: ToolContext,
  fileTimes: FileTimes | undefined,
): Promise<void> {
  const r = resolvePath(ctx, op.path);
  await fileTimes?.assertFresh(ctx.sessionId, r.abs);
  plan.writes.push({ abs: r.abs, content: null });
  plan.summary.push(`D ${r.rel}`);
}

async function planUpdate(
  plan: PatchPlan,
  op: Extract<PatchOp, { kind: "update" }>,
  ctx: ToolContext,
  fileTimes: FileTimes | undefined,
): Promise<void> {
  const r = resolvePath(ctx, op.path);
  await fileTimes?.assertFresh(ctx.sessionId, r.abs);
  const current = await readFile(r.abs, "utf8").catch(() => {
    throw new Error(`${r.rel} not found`);
  });
  const next = applyChunks(current, op.chunks, r.rel);
  for (const c of op.chunks) {
    plan.additions += changedLines(c.new, c);
    plan.deletions += changedLines(c.old, c);
  }
  if (!op.moveTo) {
    plan.writes.push({ abs: r.abs, content: next });
    plan.summary.push(`M ${r.rel}`);
    return;
  }
  const to = resolvePath(ctx, op.moveTo);
  plan.writes.push({ abs: to.abs, content: next, from: r.abs });
  plan.summary.push(`R ${r.rel} → ${to.rel}`);
}

/** Lines of `side` that aren't shared context (approximated by old lines also present in new). */
function changedLines(side: string[], chunk: PatchChunk): number {
  const shared = chunk.old.filter((x) => chunk.new.includes(x)).length;
  return side.length - shared;
}

/** Phase 2: write via temp file + rename, delete, and finish moves. */
async function commitWrites(
  writes: PendingWrite[],
  sessionId: string,
  fileTimes: FileTimes | undefined,
): Promise<void> {
  for (const w of writes) {
    if (w.content === null) {
      await rm(w.abs, { force: true });
      continue;
    }
    await mkdir(dirname(w.abs), { recursive: true });
    const tmp = `${w.abs}${TEMP_SUFFIX}`;
    await writeFile(tmp, w.content, "utf8");
    await rename(tmp, w.abs);
    if (w.from && w.from !== w.abs) await rm(w.from, { force: true });
    const st = await stat(w.abs);
    fileTimes?.recordRead(sessionId, w.abs, st.mtimeMs);
  }
}
