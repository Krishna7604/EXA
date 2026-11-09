// Scheduled-task entities on the server: a task together with the user it runs as, the values
// a create or patch writes, and the outcome a finished run records.
import type { ScheduledTask, TaskRun, TaskRunStatus } from "@exa/protocol";

// ---------- types ----------
/** Whose task it is: every user-facing query is scoped to one tenant and one user. */
export interface TaskOwner {
  tenantId: string;
  userId: string;
}

/** A task as the scheduler handles it: with the tenant and user it runs as. */
export type OwnedTask = ScheduledTask & TaskOwner;

export type TaskTrigger = TaskRun["trigger"];

/** Columns a create writes (a patch writes any subset of them). */
export interface TaskValues {
  name: string;
  prompt: string;
  schedule: string;
  timezone: string;
  model: string | null;
  agent: string | null;
  enabled: boolean;
  /** Null while disabled. */
  nextRunAt: Date | null;
}

export type TaskChanges = Partial<TaskValues>;

/** How a run ended, as recorded on `task_runs` and the task's `last_status`. */
export interface RunOutcome {
  status: Exclude<TaskRunStatus, "running">;
  error: string | null;
  cost: number;
}
