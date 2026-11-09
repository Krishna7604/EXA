// Scheduled tasks and their runs. User-facing reads and writes are tenant-scoped (RLS) and
// always filtered by user; `claimDue` runs as the owner role across all tenants so any server
// node can pick up due work without two nodes ever claiming the same task.
import { newId, type ScheduledTask, type TaskRun, type TaskRunStatus } from "@exa/protocol";
import { type Db, type Orm, scheduledTasks, taskRuns } from "@exa/store";
import { and, asc, count, desc, eq, getTableColumns, lte, sql } from "drizzle-orm";
import { nextCronRun } from "../helpers/cron.helper.ts";
import type {
  OwnedTask,
  RunOutcome,
  TaskChanges,
  TaskOwner,
  TaskTrigger,
  TaskValues,
} from "../models/task.model.ts";

// ---------- constants ----------
const RUNNING: TaskRunStatus = "running";

// ---------- types ----------
type TaskRow = typeof scheduledTasks.$inferSelect;
type RunRow = typeof taskRuns.$inferSelect;

// ---------- task repo ----------
export class TaskRepo {
  constructor(private readonly db: Db) {}

  // ---- the owner's tasks ----
  async list(owner: TaskOwner): Promise<ScheduledTask[]> {
    const rows = await this.db.withTenant(owner.tenantId, (q) =>
      q.orm
        .select()
        .from(scheduledTasks)
        .where(eq(scheduledTasks.userId, owner.userId))
        .orderBy(desc(scheduledTasks.createdAt)),
    );
    return rows.map(taskFromRow);
  }

  async get(owner: TaskOwner, id: string): Promise<ScheduledTask | null> {
    const [row] = await this.db.withTenant(owner.tenantId, (q) =>
      q.orm.select().from(scheduledTasks).where(ownTask(owner, id)),
    );
    return row ? taskFromRow(row) : null;
  }

  async count(owner: TaskOwner): Promise<number> {
    const [row] = await this.db.withTenant(owner.tenantId, (q) =>
      q.orm
        .select({ n: count() })
        .from(scheduledTasks)
        .where(eq(scheduledTasks.userId, owner.userId)),
    );
    return Number(row?.n ?? 0);
  }

  async create(owner: TaskOwner, values: TaskValues): Promise<ScheduledTask> {
    const { tenantId, userId } = owner;
    const [row] = await this.db.withTenant(tenantId, (q) =>
      q.orm
        .insert(scheduledTasks)
        .values({ id: newId(), tenantId, userId, ...values })
        .returning(),
    );
    return taskFromRow(row);
  }

  async update(owner: TaskOwner, id: string, changes: TaskChanges): Promise<ScheduledTask | null> {
    const [row] = await this.db.withTenant(owner.tenantId, (q) =>
      q.orm
        .update(scheduledTasks)
        .set({ ...changes, updatedAt: new Date() })
        .where(ownTask(owner, id))
        .returning(),
    );
    return row ? taskFromRow(row) : null;
  }

  /** Deletes the task; its runs go with it (FK cascade), its sessions stay. */
  async delete(owner: TaskOwner, id: string): Promise<boolean> {
    const rows = await this.db.withTenant(owner.tenantId, (q) =>
      q.orm.delete(scheduledTasks).where(ownTask(owner, id)).returning({ id: scheduledTasks.id }),
    );
    return rows.length > 0;
  }

  /** Turns a task off: it has no next run until its owner enables it again. */
  async disable(task: OwnedTask): Promise<void> {
    await this.db.withTenant(task.tenantId, (q) =>
      q.orm
        .update(scheduledTasks)
        .set({ enabled: false, nextRunAt: null, updatedAt: new Date() })
        .where(ownTask(task, task.id)),
    );
  }

  // ---- runs ----
  /** Records a run as started and marks its task as running. */
  async startRun(task: OwnedTask, trigger: TaskTrigger): Promise<TaskRun> {
    const startedAt = new Date();
    const [row] = await this.db.withTenant(task.tenantId, async (q) => {
      await q.orm
        .update(scheduledTasks)
        .set({ lastStatus: RUNNING, lastRunAt: startedAt })
        .where(ownTask(task, task.id));
      return q.orm
        .insert(taskRuns)
        .values({
          id: newId(),
          tenantId: task.tenantId,
          taskId: task.id,
          trigger,
          status: RUNNING,
          startedAt,
        })
        .returning();
    });
    return runFromRow(row);
  }

  /** Points a run, and its task's latest-session link, at the session the run happens in. */
  async attachSession(tenantId: string, run: TaskRun, sessionId: string): Promise<TaskRun> {
    const [row] = await this.db.withTenant(tenantId, async (q) => {
      await q.orm
        .update(scheduledTasks)
        .set({ lastSessionId: sessionId })
        .where(eq(scheduledTasks.id, run.taskId));
      return q.orm.update(taskRuns).set({ sessionId }).where(eq(taskRuns.id, run.id)).returning();
    });
    return runFromRow(row);
  }

  /** Records how a run ended, on the run and as its task's last status. */
  async finishRun(tenantId: string, run: TaskRun, outcome: RunOutcome): Promise<TaskRun> {
    const [row] = await this.db.withTenant(tenantId, async (q) => {
      await q.orm
        .update(scheduledTasks)
        .set({ lastStatus: outcome.status })
        .where(eq(scheduledTasks.id, run.taskId));
      return q.orm
        .update(taskRuns)
        .set({
          status: outcome.status,
          error: outcome.error,
          costUsd: outcome.cost,
          finishedAt: new Date(),
        })
        .where(eq(taskRuns.id, run.id))
        .returning();
    });
    return runFromRow(row);
  }

  /** The owner's runs of one task, newest first (none when the task isn't theirs). */
  async runs(owner: TaskOwner, taskId: string, limit: number): Promise<TaskRun[]> {
    const rows = await this.db.withTenant(owner.tenantId, (q) =>
      q.orm
        .select(getTableColumns(taskRuns))
        .from(taskRuns)
        .innerJoin(scheduledTasks, eq(scheduledTasks.id, taskRuns.taskId))
        .where(and(eq(taskRuns.taskId, taskId), eq(scheduledTasks.userId, owner.userId)))
        .orderBy(desc(taskRuns.startedAt), desc(taskRuns.id))
        .limit(limit),
    );
    return rows.map(runFromRow);
  }

  // ---- scheduler ----
  /**
   * Claims up to `limit` due tasks across all tenants. In one transaction the rows are locked
   * (SKIP LOCKED: rows another node holds are passed over) and moved to their next occurrence
   * after `now`, so once it commits no other claimer sees them due. Occurrences missed while
   * no node was running collapse into this one run.
   */
  async claimDue(now: Date, limit: number): Promise<OwnedTask[]> {
    return this.db.tx(async (q) => {
      const due = await q.orm
        .select()
        .from(scheduledTasks)
        // bare `enabled` (not `enabled = $1`) so the partial index on next_run_at applies
        .where(and(sql`${scheduledTasks.enabled}`, lte(scheduledTasks.nextRunAt, now)))
        .orderBy(asc(scheduledTasks.nextRunAt))
        .limit(limit)
        .for("update", { skipLocked: true });
      const claimed: OwnedTask[] = [];
      for (const row of due) claimed.push(await claimRow(q.orm, row, now));
      return claimed;
    });
  }
}

// ---------- helpers ----------
function ownTask(owner: TaskOwner, id: string) {
  return and(eq(scheduledTasks.id, id), eq(scheduledTasks.userId, owner.userId));
}

async function claimRow(orm: Orm, row: TaskRow, now: Date): Promise<OwnedTask> {
  const claim = { nextRunAt: followingRun(row, now), lastRunAt: now, lastStatus: RUNNING };
  await orm.update(scheduledTasks).set(claim).where(eq(scheduledTasks.id, row.id));
  const claimed = { ...row, ...claim };
  return { ...taskFromRow(claimed), tenantId: row.tenantId, userId: row.userId };
}

/** The first occurrence after `now`; null (no further runs) if the stored schedule won't parse. */
function followingRun(row: TaskRow, now: Date): Date | null {
  try {
    return nextCronRun(row.schedule, row.timezone, now);
  } catch {
    // Validated on every write, so this only happens if the runtime's timezone data changed.
    // The task stays visible with no next run until its owner fixes the schedule.
    return null;
  }
}

function taskFromRow(r: TaskRow): ScheduledTask {
  return {
    id: r.id,
    name: r.name,
    prompt: r.prompt,
    schedule: r.schedule,
    timezone: r.timezone,
    model: r.model,
    agent: r.agent,
    enabled: r.enabled,
    nextRunAt: timeOrNull(r.nextRunAt),
    lastRunAt: timeOrNull(r.lastRunAt),
    lastStatus: r.lastStatus as TaskRunStatus | null,
    lastSessionId: r.lastSessionId,
    time: { created: r.createdAt.getTime(), updated: r.updatedAt.getTime() },
  };
}

function runFromRow(r: RunRow): TaskRun {
  return {
    id: r.id,
    taskId: r.taskId,
    sessionId: r.sessionId,
    trigger: r.trigger as TaskTrigger,
    status: r.status as TaskRunStatus,
    error: r.error,
    cost: Number(r.costUsd),
    time: { started: r.startedAt.getTime(), finished: timeOrNull(r.finishedAt) },
  };
}

function timeOrNull(d: Date | null): number | null {
  return d ? d.getTime() : null;
}
