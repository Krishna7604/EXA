// Scheduled-task runner. Every tick this node claims the tasks whose time has come (each due
// task is claimed by exactly one node, see TaskRepo.claimDue) and runs them as their owners,
// never more than `cfg.scheduler.concurrency` at a time on this node.

import type { TaskRun } from "@exa/protocol";
import type { Services } from "../container.ts";
import type { OwnedTask } from "../models/task.model.ts";

// ---------- types ----------
export interface DueRunOptions {
  /** Defaults to the current time. */
  now?: Date;
  /** Most tasks to claim; defaults to the node's scheduler concurrency. */
  limit?: number;
}

/** Per-node scheduler state: runs in flight and whether a claim is in progress. */
interface SchedulerState {
  inFlight: number;
  isClaiming: boolean;
}

// ---------- scheduler ----------
/** Ticks every `cfg.scheduler.tickMs`, logging (never throwing) failures; returns a stop fn. */
export function scheduleTasks(s: Services): () => void {
  const state: SchedulerState = { inFlight: 0, isClaiming: false };
  const timer = setInterval(() => void tick(s, state), s.cfg.scheduler.tickMs);
  // catch up on anything that fell due while no node was running, without waiting a full tick
  void tick(s, state);
  return () => clearInterval(timer);
}

/** Claims the due tasks and runs them, resolving with the finished runs (tests, one-off use). */
export async function runDueTasks(s: Services, opts: DueRunOptions = {}): Promise<TaskRun[]> {
  const now = opts.now ?? new Date();
  const limit = opts.limit ?? s.cfg.scheduler.concurrency;
  const claimed = await s.taskService.claimDue(now, limit);
  return Promise.all(claimed.map((task) => s.taskService.execute(task, "schedule")));
}

// ---------- helpers ----------
/** Claims only as many tasks as there are free slots; a slow claim never overlaps the next. */
async function tick(s: Services, state: SchedulerState): Promise<void> {
  const freeSlots = s.cfg.scheduler.concurrency - state.inFlight;
  if (state.isClaiming || freeSlots <= 0) return;
  state.isClaiming = true;
  try {
    const claimed = await s.taskService.claimDue(new Date(), freeSlots);
    for (const task of claimed) startRun(s, state, task);
  } catch (e) {
    console.error("[exa-server] scheduler tick failed", e);
  } finally {
    state.isClaiming = false;
  }
}

function startRun(s: Services, state: SchedulerState, task: OwnedTask): void {
  state.inFlight++;
  void s.taskService
    .execute(task, "schedule")
    .catch((e) => console.error("[exa-server] scheduled task failed", task.id, e))
    .finally(() => {
      state.inFlight--;
    });
}
