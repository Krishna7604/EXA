// Terminal side of the client's Interaction port: approvals, questions, events and notices.

import type { Interface as RlInterface } from "node:readline/promises";
import type { PermissionReply, PermissionRequest } from "@exa/protocol";
import type { Interaction } from "../models/interaction.model.ts";
import { color } from "../ui/color.ts";
import type { Ui } from "../ui/terminal-ui.ts";

// ---------- types ----------
export interface InteractionOptions {
  ui: Ui;
  rl: RlInterface;
  /** --yes: approve every "ask" prompt without asking. */
  autoYes: boolean;
  /** -p: one-shot run, so there may be no terminal to ask on. */
  isOneShot: boolean;
  /** Logged in to a server, so another attached client can answer approvals. */
  hasServer: boolean;
}

// ---------- interaction ----------
export function makeInteraction(opts: InteractionOptions): Interaction {
  const { ui, rl } = opts;
  return {
    approve: (req, signal) => approve(opts, req, signal),
    ask: (_sid, qs, signal) => ui.question(rl, qs, signal),
    onEvent: (e) => ui.handle(e),
    notice: (m) => ui.line(color.yellow(`  ! ${m}`)),
  };
}

// ---------- helpers ----------
async function approve(
  opts: InteractionOptions,
  req: PermissionRequest,
  signal: AbortSignal,
): Promise<PermissionReply | null> {
  const { ui, rl } = opts;
  if (opts.autoYes) {
    ui.line(color.gray(`  ✓ auto-approved ${req.permission}: ${req.title}`));
    return "once";
  }
  if (!process.stdin.isTTY && opts.isOneShot) return approveWithoutTerminal(opts, req, signal);
  return ui.approval(rl, req, signal);
}

/** No terminal to ask: wait for another attached client (web/phone), or reject in local mode. */
function approveWithoutTerminal(
  opts: InteractionOptions,
  req: PermissionRequest,
  signal: AbortSignal,
): Promise<PermissionReply | null> {
  const { ui } = opts;
  if (opts.hasServer) {
    ui.line(color.yellow(`  ? waiting for approval from another device: ${req.title}`));
    return new Promise((resolve) =>
      signal.addEventListener("abort", () => resolve(null), { once: true }),
    );
  }
  ui.line(
    color.yellow(
      `  ✗ needs approval (${req.permission}: ${req.title}) — rerun interactively or with --yes`,
    ),
  );
  return Promise.resolve("reject");
}
