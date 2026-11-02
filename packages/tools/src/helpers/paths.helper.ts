// Path confinement. Every path tool resolves through here: symlinks are resolved so a link
// inside the workspace can't smuggle access outside it; anything outside the root needs the
// `external_directory` permission in addition to the tool's own permission.

import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import type { PermissionAsk, ToolContext } from "@exa/core";

// ---------- constants ----------
/** Upper bound on how many missing path segments we walk up before giving up. */
const MAX_MISSING_SEGMENTS = 256;

/** Workspace root → its real (symlink-free) path. */
const rootCache = new Map<string, string>();

// ---------- types ----------
export interface ResolvedPath {
  abs: string;
  rel: string;
  inside: boolean;
  root: string;
}

// ---------- path resolution ----------
export function resolvePath(ctx: Pick<ToolContext, "root" | "cwd">, p: string): ResolvedPath {
  const input = expandHome(p.trim());
  const abs = realpathLoose(normalize(isAbsolute(input) ? input : join(ctx.cwd, input)));
  const root = realRoot(ctx.root);
  const inside = isInsideRoot(abs, root);
  const rel = inside ? relative(root, abs) || "." : abs;
  return { abs, rel, inside, root };
}

/** Permission asks for touching `p` with `permission` (read/edit/list/...). */
export function pathAsks(
  permission: string,
  resolved: ResolvedPath,
  title?: string,
): PermissionAsk[] {
  const asks: PermissionAsk[] = [];
  if (!resolved.inside) asks.push(externalDirectoryAsk(resolved.abs));
  const alwaysDir = resolved.inside ? resolved.root : dirname(resolved.abs);
  asks.push({
    permission,
    patterns: [resolved.abs],
    aliases: [[resolved.rel]],
    always: [`${alwaysDir}/*`],
    title: title ?? `${permission} ${resolved.rel}`,
  });
  return asks;
}

// ---------- helpers ----------
function expandHome(input: string): string {
  if (input === "~" || input.startsWith("~/")) return homedir() + input.slice(1);
  return input;
}

function isInsideRoot(abs: string, root: string): boolean {
  const rootPrefix = root.endsWith(sep) ? root : root + sep;
  return abs === root || abs.startsWith(rootPrefix);
}

function externalDirectoryAsk(abs: string): PermissionAsk {
  return {
    permission: "external_directory",
    patterns: [abs],
    always: [`${dirname(abs)}/*`],
    title: `Access outside the workspace: ${abs}`,
  };
}

/** realpath that tolerates missing files: resolve the deepest existing ancestor, re-append the rest. */
function realpathLoose(p: string): string {
  let cur = p;
  const tail: string[] = [];
  for (let i = 0; i < MAX_MISSING_SEGMENTS; i++) {
    try {
      const real = realpathSync(cur);
      return tail.length ? join(real, ...tail.reverse()) : real;
    } catch {
      const parent = dirname(cur);
      if (parent === cur) return p;
      tail.push(cur.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)));
      cur = parent;
    }
  }
  return p;
}

function realRoot(root: string): string {
  let real = rootCache.get(root);
  if (!real) {
    real = realpathLoose(resolve(root));
    rootCache.set(root, real);
  }
  return real;
}
