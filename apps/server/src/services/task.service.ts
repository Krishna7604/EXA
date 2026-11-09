// Scheduled tasks: the owner's CRUD (cron + timezone validated, next run kept current), manual
// runs, and executing a task unattended as its owner in a fresh server-loop chat.

import type { PromptResult } from "@exa/core";
import {
  type api,
  type FinishReason,
  isUuid,
  type ScheduledTask,
  type TaskRun,
} from "@exa/protocol";
import type { z } from "zod";
import { ERROR_CODES } from "../constants/errors.constants.ts";
import { canonicalTimezone, cronProblem, nextCronRun } from "../helpers/cron.helper.ts";
import { HttpError } from "../models/http-error.model.ts";
import type { Principal } from "../models/principal.model.ts";
import type { StoredSession } from "../models/session.model.ts";
import type { OwnedTask, RunOutcome, TaskChanges, TaskTrigger } from "../models/task.model.ts";
import type { TaskRepo } from "../repositories/task.repository.ts";
import type { ServiceDeps } from "./service-deps.ts";
import type { SessionService } from "./session.service.ts";

// ---------- constants ----------
const MAX_TASKS_PER_USER = 100;
/** A run still going after this long is aborted, so a stuck run can't hold a scheduler slot. */
const MAX_RUN_MS = 30 * 60_000;
const DATE_LOCALE = "en-US";
const TITLE_DATE: Intl.DateTimeFormatOptions = { dateStyle: "medium" };
const PROMPT_TIME: Intl.DateTimeFormatOptions = { dateStyle: "full", timeStyle: "short" };
const CRON_HINT =
  'Use five fields (minute hour day-of-month month day-of-week), e.g. "0 8 * * 1-5" for weekdays at 08:00.';
const TIMEZONE_HINT = 'Use an IANA name such as "Europe/Berlin", "Asia/Kolkata" or "UTC".';
const OWNER_GONE =
  "the task's owner is no longer an active member of this organization, so the task was turned off";
const UNATTENDED_NOTE =
  "Nobody is watching this run: you can't ask questions and nobody can approve actions, so " +
  "anything that needs approval will be denied. Finish the job with what you're allowed to " +
  "do. If something needed approval or an answer from the user, say clearly what and why.";
/** Finish reasons that mean the run didn't complete its job. */
const FAILED_FINISHES: Partial<Record<FinishReason, string>> = {
  "tool-calls": "stopped in the middle of its work; open the chat to see how far it got",
  aborted: "stopped before it finished (time limit reached or server shut down)",
  error: "the model call failed",
  "content-filter": "the model provider's content filter stopped the answer",
};

// ---------- types ----------
type CreateTaskInput = z.infer<typeof api.CreateTaskBody>;
type PatchTaskInput = z.infer<typeof api.PatchTaskBody>;

/** What the task service needs beyond the shared deps. */
export interface TaskServiceParts {
  tasks: TaskRepo;
  sessions: SessionService;
}

/** `POST /v1/tasks/:id/run`: the started run and its chat (null if it failed to start). */
export interface ManualRun {
  run: TaskRun;
  sessionId: string | null;
}

/** A run whose chat exists: everything needed to drive it to the end. */
interface LiveRun {
  task: OwnedTask;
  run: TaskRun;
  principal: Principal;
  session: StoredSession;
}

/** A started run: live, or already finished with an error before it got a chat. */
interface StartedRun {
  run: TaskRun;
  live: LiveRun | null;
}

// ---------- task service ----------
export class TaskService {
  private readonly tasks: TaskRepo;
  private readonly sessions: SessionService;

  constructor(
    private readonly deps: ServiceDeps,
    parts: TaskServiceParts,
  ) {
    this.tasks = parts.tasks;
    this.sessions = parts.sessions;
  }

  list(p: Principal): Promise<ScheduledTask[]> {
    return this.tasks.list(p);
  }

  /** One of the principal's own tasks; 404 for anyone else's. */
  async get(p: Principal, id: string): Promise<ScheduledTask> {
    const task = isUuid(id) ? await this.tasks.get(p, id) : null;
    if (!task) throw notFound();
    return task;
  }

  async create(p: Principal, input: CreateTaskInput): Promise<ScheduledTask> {
    if ((await this.tasks.count(p)) >= MAX_TASKS_PER_USER)
      throw new HttpError(
        409,
        `you can have at most ${MAX_TASKS_PER_USER} scheduled tasks`,
        ERROR_CODES.conflict,
      );
    const { timezone, next } = checkedSchedule(input.schedule, input.timezone);
    return this.tasks.create(p, { ...input, timezone, nextRunAt: input.enabled ? next : null });
  }

  /** Recomputes the next run whenever the schedule, timezone or enabled flag is sent. */
  async update(p: Principal, id: string, input: PatchTaskInput): Promise<ScheduledTask> {
    const current = await this.get(p, id);
    const changes: TaskChanges = { ...input };
    if (touchesSchedule(input)) Object.assign(changes, scheduleChanges(current, input));
    const updated = await this.tasks.update(p, current.id, changes);
    if (!updated) throw notFound();
    return updated;
  }

  async delete(p: Principal, id: string): Promise<void> {
    const isDeleted = isUuid(id) && (await this.tasks.delete(p, id));
    if (!isDeleted) throw notFound();
  }

  /** The task's runs, newest first. */
  async runs(p: Principal, id: string, limit: number): Promise<TaskRun[]> {
    const task = await this.get(p, id);
    return this.tasks.runs(p, task.id, limit);
  }

  /** Starts a run now in the background; the run and its chat id are returned right away. */
  async runNow(p: Principal, id: string): Promise<ManualRun> {
    const task = await this.get(p, id);
    const owned: OwnedTask = { ...task, tenantId: p.tenantId, userId: p.userId };
    const { run, live } = await this.start(owned, "manual");
    if (live) void this.complete(live).catch((e) => logRunFailure(task.id, e));
    return { run, sessionId: run.sessionId };
  }

  /** Due tasks, claimed for this node (no other node gets them). */
  claimDue(now: Date, limit: number): Promise<OwnedTask[]> {
    return this.tasks.claimDue(now, limit);
  }

  /** Runs a task unattended as its owner and records the outcome; resolves once it's done. */
  async execute(task: OwnedTask, trigger: TaskTrigger): Promise<TaskRun> {
    const { run, live } = await this.start(task, trigger);
    return live ? this.complete(live) : run;
  }

  /** Records the run, then opens its chat as the owner. Failures finish the run as an error. */
  private async start(task: OwnedTask, trigger: TaskTrigger): Promise<StartedRun> {
    const run = await this.tasks.startRun(task, trigger);
    const principal = await this.ownerPrincipal(task);
    if (!principal) {
      await this.tasks.disable(task);
      return { run: await this.fail(task, run, OWNER_GONE), live: null };
    }
    try {
      const session = await this.sessions.create(principal, sessionInput(task, run));
      const attached = await this.tasks.attachSession(task.tenantId, run, session.id);
      return { run: attached, live: { task, run: attached, principal, session } };
    } catch (e) {
      return { run: await this.fail(task, run, errorMessage(e)), live: null };
    }
  }

  private async complete(live: LiveRun): Promise<TaskRun> {
    const outcome = await this.runToEnd(live);
    return this.tasks.finishRun(live.task.tenantId, live.run, outcome);
  }

  private async runToEnd({ task, run, principal, session }: LiveRun): Promise<RunOutcome> {
    const timer = setTimeout(() => this.deps.runtime.abort(session.id), MAX_RUN_MS);
    try {
      const text = unattendedPrompt(task, new Date(run.time.started));
      return outcomeOf(await this.deps.runtime.run(principal, session, { text }));
    } catch (e) {
      return { status: "error", error: errorMessage(e), cost: 0 };
    } finally {
      clearTimeout(timer);
    }
  }

  private fail(task: OwnedTask, run: TaskRun, error: string): Promise<TaskRun> {
    return this.tasks.finishRun(task.tenantId, run, { status: "error", error, cost: 0 });
  }

  /** The owner as a principal, or null when they're no longer an active member. */
  private async ownerPrincipal(task: OwnedTask): Promise<Principal | null> {
    const membership = await this.deps.identity.membership(task.tenantId, task.userId);
    if (!membership) return null;
    return { tenantId: task.tenantId, userId: task.userId, role: membership.role, kind: "web" };
  }
}

// ---------- helpers ----------
function notFound(): HttpError {
  return new HttpError(404, "task not found", ERROR_CODES.notFound);
}

function invalid(message: string): HttpError {
  return new HttpError(400, message, ERROR_CODES.validation);
}

/** Validates a schedule in a timezone; returns the canonical timezone and the next run. */
function checkedSchedule(schedule: string, timezone: string): { timezone: string; next: Date } {
  const problem = cronProblem(schedule);
  if (problem) throw invalid(`invalid schedule "${schedule}": ${problem}. ${CRON_HINT}`);
  const zone = canonicalTimezone(timezone);
  const next = zone ? nextRunIn(schedule, zone) : null;
  if (!zone || !next) throw invalid(`unknown timezone "${timezone}". ${TIMEZONE_HINT}`);
  return { timezone: zone, next };
}

/** Null when croner can't evaluate the schedule in this zone (one Intl accepts but croner doesn't). */
function nextRunIn(schedule: string, timezone: string): Date | null {
  try {
    return nextCronRun(schedule, timezone, new Date());
  } catch {
    // reported to the user as an unknown timezone by the caller
    return null;
  }
}

function touchesSchedule(input: PatchTaskInput): boolean {
  return (
    input.schedule !== undefined || input.timezone !== undefined || input.enabled !== undefined
  );
}

function scheduleChanges(current: ScheduledTask, input: PatchTaskInput): TaskChanges {
  const schedule = input.schedule ?? current.schedule;
  const enabled = input.enabled ?? current.enabled;
  const { timezone, next } = checkedSchedule(schedule, input.timezone ?? current.timezone);
  return { schedule, timezone, nextRunAt: enabled ? next : null };
}

function sessionInput(task: OwnedTask, run: TaskRun) {
  const date = formatIn(task.timezone, TITLE_DATE, new Date(run.time.started));
  return {
    loopHost: "server" as const,
    storageMode: "server" as const,
    agent: task.agent ?? undefined,
    model: task.model ?? undefined,
    title: `${task.name} · ${date}`,
    taskId: task.id,
  };
}

/** The task prompt, prefixed with when it runs and that nobody is there to answer. */
function unattendedPrompt(task: OwnedTask, at: Date): string {
  const when = formatIn(task.timezone, PROMPT_TIME, at);
  const header = `[Scheduled task "${task.name}", run unattended on ${when} (${task.timezone})]`;
  return `${header}\n${UNATTENDED_NOTE}\n\n${task.prompt}`;
}

function outcomeOf(result: PromptResult): RunOutcome {
  const failure = result.error?.message ?? FAILED_FINISHES[result.finish];
  if (failure) return { status: "error", error: failure, cost: result.cost };
  return { status: "ok", error: null, cost: result.cost };
}

function formatIn(timezone: string, options: Intl.DateTimeFormatOptions, at: Date): string {
  return new Intl.DateTimeFormat(DATE_LOCALE, { ...options, timeZone: timezone }).format(at);
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function logRunFailure(taskId: string, e: unknown): void {
  console.error("[exa-server] task run failed", taskId, e);
}
