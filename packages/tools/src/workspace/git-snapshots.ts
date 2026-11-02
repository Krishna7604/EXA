// Shadow-git snapshots for undo/redo: a separate git dir per workspace under
// ~/.exa/snapshots, pointed at the workspace as its work tree. Never touches the user's .git.

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { SnapshotPort } from "@exa/core";
import { runGit } from "./git-run.ts";

// ---------- constants ----------
/** Hex chars of the workspace-path hash used as the snapshot repo's directory name. */
const REPO_HASH_LENGTH = 16;
/** Heavy/generated dirs never belong in undo snapshots, even in non-git projects. */
const SNAPSHOT_EXCLUDES = [
  "node_modules/",
  ".git/",
  "dist/",
  "build/",
  ".next/",
  ".turbo/",
  ".cache/",
  "__pycache__/",
  ".venv/",
  "venv/",
  "target/",
  "coverage/",
  ".DS_Store",
];

// ---------- git snapshots ----------
/**
 * Shadow-git snapshots: `git --git-dir=~/.exa/snapshots/<hash> --work-tree=<root>`.
 * track() = add -A + write-tree (honours the project's .gitignore). Never touches the user's repo.
 */
export class GitSnapshots implements SnapshotPort {
  private readonly gitDir: string;
  private ready: Promise<boolean> | null = null;

  constructor(
    private readonly root: string,
    dataDir: string = join(homedir(), ".exa", "snapshots"),
  ) {
    const hash = createHash("sha256").update(resolve(root)).digest("hex");
    this.gitDir = join(dataDir, hash.slice(0, REPO_HASH_LENGTH));
  }

  async track(): Promise<string | undefined> {
    if (!(await this.init())) return undefined;
    const add = await this.git(["add", "--all", "--", "."]);
    if (add.code !== 0) return undefined;
    const r = await this.git(["write-tree"]);
    return r.code === 0 ? r.out.trim() : undefined;
  }

  async changed(from: string): Promise<string[]> {
    const to = await this.track();
    if (!to || to === from) return [];
    const r = await this.git(["diff", "--name-only", "--no-renames", from, to]);
    if (r.code !== 0) return [];
    return r.out
      .split("\n")
      .filter(Boolean)
      .map((f) => join(this.root, f));
  }

  async diff(from: string, to?: string): Promise<string> {
    const target = to ?? (await this.track());
    if (!target) return "";
    const r = await this.git(["diff", "--no-color", "--no-ext-diff", from, target]);
    return r.code === 0 ? r.out : "";
  }

  async restore(ref: string, files?: string[]): Promise<void> {
    if (!(await this.init())) return;
    if (!files?.length) {
      await this.git(["read-tree", ref]);
      await this.git(["checkout-index", "-a", "-f"]);
      return;
    }
    for (const abs of files) await this.restoreFile(ref, abs);
  }

  /** Lazily create the shadow repo once; resolves false when git is unavailable. */
  private init(): Promise<boolean> {
    if (!this.ready) this.ready = this.createRepo();
    return this.ready;
  }

  private async createRepo(): Promise<boolean> {
    if (!Bun.which("git")) return false;
    if (existsSync(join(this.gitDir, "HEAD"))) return true;
    await mkdir(this.gitDir, { recursive: true });
    const r = await runGit(["init", "--quiet"], {
      cwd: this.root,
      gitDir: this.gitDir,
      workTree: this.root,
    });
    if (r.code !== 0) return false;
    await runGit(["config", "core.fsmonitor", "false"], { cwd: this.root, gitDir: this.gitDir });
    await mkdir(join(this.gitDir, "info"), { recursive: true });
    await Bun.write(join(this.gitDir, "info", "exclude"), `${SNAPSHOT_EXCLUDES.join("\n")}\n`);
    return true;
  }

  /** Restore one file to its state at `ref`; delete it if it didn't exist then. */
  private async restoreFile(ref: string, abs: string): Promise<void> {
    const rel = abs.startsWith(this.root) ? abs.slice(this.root.length + 1) : abs;
    const exists = await this.git(["ls-tree", ref, "--", rel]);
    if (exists.code === 0 && exists.out.trim()) {
      await this.git(["checkout", ref, "--", rel]);
    } else {
      await rm(join(this.root, rel), { force: true });
    }
  }

  private git(args: string[]) {
    return runGit(args, { cwd: this.root, gitDir: this.gitDir, workTree: this.root });
  }
}
