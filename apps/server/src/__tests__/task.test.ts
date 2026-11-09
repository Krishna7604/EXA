import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KeyVault } from "@exa/router";
import { createApp } from "../app.ts";
import { loadConfig } from "../config/env.config.ts";
import { createServices, type Services } from "../container.ts";
import { nextCronRun } from "../helpers/cron.helper.ts";
import { runDueTasks } from "../jobs/scheduler.job.ts";

let s: Services;
let app: ReturnType<typeof createApp>;
let dataDir: string;

// Fake OpenAI-compatible provider: calls `write` when asked to, otherwise answers in text.
const fakeFetch = (async (_url: any, init?: RequestInit) => {
  const body = JSON.parse(String(init?.body ?? "{}"));
  const msgs = body.messages as any[];
  const last = msgs[msgs.length - 1];
  const lastUser = [...msgs].reverse().find((m) => m.role === "user");
  const wantsWrite = String(lastUser?.content).includes("write hello.txt");
  const events: unknown[] = [];
  if (body.tools && last.role === "user" && wantsWrite) {
    const args = JSON.stringify({ filePath: "hello.txt", content: "hi\n" });
    events.push({
      choices: [
        {
          delta: {
            tool_calls: [{ index: 0, id: "call_w", function: { name: "write", arguments: args } }],
          },
          finish_reason: "tool_calls",
        },
      ],
    });
  } else {
    const content = last.role === "tool" ? "file written" : "here is your summary";
    events.push({ choices: [{ delta: { content }, finish_reason: "stop" }] });
  }
  events.push({ choices: [], usage: { prompt_tokens: 50, completion_tokens: 5 } });
  const text = `${events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("")}data: [DONE]\n\n`;
  return new Response(text, { headers: { "content-type": "text/event-stream" } });
}) as unknown as typeof fetch;

const j = async (method: string, path: string, token?: string, body?: unknown) => {
  const res = await app.fetch(
    new Request(`http://exa.test${path}`, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }),
  );
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};

async function login(email: string, tenant: string) {
  const r = await j("POST", "/v1/auth/dev-login", undefined, { email, tenant });
  expect(r.status).toBe(200);
  return r.body as { token: string; tenant: { id: string }; user: { id: string }; role: string };
}

async function createTask(token: string, overrides: Record<string, unknown> = {}) {
  const r = await j("POST", "/v1/tasks", token, {
    name: "Morning brief",
    prompt: "Summarise the news",
    schedule: "0 8 * * 1-5",
    timezone: "Europe/Berlin",
    ...overrides,
  });
  expect(r.status).toBe(201);
  return r.body;
}

/** Makes a task due right now (as if its time had come while nobody looked). */
async function makeDue(taskId: string, ago = "1 minute") {
  await s.db.query(`update scheduled_tasks set next_run_at = now() - $2::interval where id = $1`, [
    taskId,
    ago,
  ]);
}

/** Local wall-clock "HH:MM" of a timestamp in a timezone. */
function clockIn(timeZone: string, ms: number): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(ms));
}

async function waitFor<T>(fn: () => Promise<T | null | undefined>, ms = 5000): Promise<T> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await Bun.sleep(25);
  }
  throw new Error("timed out waiting");
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`hung > ${ms}ms`)), ms)),
  ]);
}

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "exa-task-"));
  const pgUrl = process.env.EXA_TEST_DATABASE_URL;
  if (pgUrl) {
    const { PostgresDb } = await import("@exa/store");
    const reset = await PostgresDb.open(pgUrl);
    await reset.exec(
      "drop schema public cascade; create schema public; grant usage on schema public to public;",
    );
    await reset.close();
  }
  const cfg = loadConfig({
    ...(pgUrl ? { DATABASE_URL: pgUrl } : {}),
    EXA_DATA_DIR: dataDir,
    EXA_DB_DIR: "memory",
    EXA_DEV_AUTH: "1",
    EXA_JWT_SECRET: "test-secret-test-secret-test-secret-123",
    OPENAI_API_KEY: "pool-openai-key",
    EXA_BACKENDS: JSON.stringify(
      ["fast", "balanced", "strong"].map((tier) => ({
        id: `fake-${tier}`,
        provider: "openai",
        model: `fake-${tier}`,
        tier,
        supportsTools: true,
        contextWindow: 100000,
        priority: 1,
      })),
    ),
  });
  s = await createServices(cfg, {
    fetch: fakeFetch,
    vault: new KeyVault({ 1: crypto.getRandomValues(new Uint8Array(32)) }),
  });
  app = createApp(s);
});

afterAll(async () => {
  await s.close();
  await rm(dataDir, { recursive: true, force: true });
});

describe("task validation", () => {
  test("bad cron expressions and timezones are 400s with a readable message", async () => {
    const a = await login("alice@acme.dev", "acme");
    const base = { name: "t", prompt: "p", timezone: "UTC" };
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ ...base, schedule: "61 8 * * *" }, /invalid schedule.*minute.*five fields/i],
      [{ ...base, schedule: "0 0 8 * * 1-5" }, /invalid schedule.*5 parts/i],
      [{ ...base, schedule: "every morning" }, /invalid schedule/i],
      [{ ...base, schedule: "0 0 30 2 *" }, /never fires/i],
      [{ ...base, schedule: "0 8 * * *", timezone: "Mars/Olympus" }, /unknown timezone.*IANA/i],
    ];
    for (const [body, message] of cases) {
      const r = await j("POST", "/v1/tasks", a.token, body);
      expect(r.status).toBe(400);
      expect(r.body.error.code).toBe("validation");
      expect(r.body.error.message).toMatch(message);
    }
    expect((await j("POST", "/v1/tasks", a.token, { name: "t" })).status).toBe(400);
    expect((await j("GET", "/v1/tasks")).status).toBe(401);
  });

  test("create returns the task with its next run; patch validates and leaves it unchanged", async () => {
    const a = await login("alice@acme.dev", "acme");
    const task = await createTask(a.token, { timezone: "asia/kolkata" });
    expect(task.timezone).toBe("Asia/Kolkata");
    expect(task).toMatchObject({ enabled: true, model: null, agent: null, lastStatus: null });
    expect(task.nextRunAt).toBeGreaterThan(Date.now());
    const bad = await j("PATCH", `/v1/tasks/${task.id}`, a.token, { schedule: "* * * * * * *" });
    expect(bad.status).toBe(400);
    const badZone = await j("PATCH", `/v1/tasks/${task.id}`, a.token, { timezone: "Nope/Nope" });
    expect(badZone.status).toBe(400);
    const got = await j("GET", `/v1/tasks/${task.id}`, a.token);
    expect(got.body.schedule).toBe("0 8 * * 1-5");
    expect(got.body.timezone).toBe("Asia/Kolkata");
  });
});

describe("next run", () => {
  test("is computed in the task's timezone", async () => {
    const a = await login("alice@acme.dev", "acme");
    const kolkata = await createTask(a.token, { schedule: "0 8 * * *", timezone: "Asia/Kolkata" });
    expect(clockIn("Asia/Kolkata", kolkata.nextRunAt)).toBe("08:00");
    expect(clockIn("UTC", kolkata.nextRunAt)).toBe("02:30");
    const ny = await createTask(a.token, { schedule: "0 8 * * *", timezone: "America/New_York" });
    expect(clockIn("America/New_York", ny.nextRunAt)).toBe("08:00");
    // Friday 2026-11-06 12:00 UTC is 07:00 in New York (EST): today's 08:00, then Monday's
    const friday = new Date("2026-11-06T12:00:00Z");
    expect(nextCronRun("0 8 * * 1-5", "America/New_York", friday)?.toISOString()).toBe(
      "2026-11-06T13:00:00.000Z",
    );
    const afterRun = new Date("2026-11-06T13:00:00Z");
    expect(nextCronRun("0 8 * * 1-5", "America/New_York", afterRun)?.toISOString()).toBe(
      "2026-11-09T13:00:00.000Z",
    );
  });

  test("disabling clears it; enabling or changing the schedule recomputes it", async () => {
    const a = await login("alice@acme.dev", "acme");
    const task = await createTask(a.token);
    const off = await j("PATCH", `/v1/tasks/${task.id}`, a.token, { enabled: false });
    expect(off.body).toMatchObject({ enabled: false, nextRunAt: null });
    const renamed = await j("PATCH", `/v1/tasks/${task.id}`, a.token, { name: "Evening brief" });
    expect(renamed.body).toMatchObject({ name: "Evening brief", nextRunAt: null });
    const on = await j("PATCH", `/v1/tasks/${task.id}`, a.token, {
      enabled: true,
      schedule: "30 18 * * *",
      timezone: "Asia/Tokyo",
    });
    expect(on.body.enabled).toBe(true);
    expect(clockIn("Asia/Tokyo", on.body.nextRunAt)).toBe("18:30");
    const created = await j("POST", "/v1/tasks", a.token, {
      name: "off",
      prompt: "p",
      schedule: "0 8 * * *",
      enabled: false,
    });
    expect(created.body.nextRunAt).toBeNull();
  });
});

describe("claiming due tasks", () => {
  test("two concurrent claims never take the same task", async () => {
    const a = await login("alice@acme.dev", "acme");
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) ids.push((await createTask(a.token, { name: `claim ${i}` })).id);
    for (const id of ids) await makeDue(id);
    const now = new Date();
    const [first, second] = await Promise.all([
      s.taskService.claimDue(now, 4),
      s.taskService.claimDue(now, 4),
    ]);
    const mine = (list: { id: string }[]) => list.map((t) => t.id).filter((id) => ids.includes(id));
    const [x, y] = [mine(first), mine(second)];
    expect(x.filter((id) => y.includes(id))).toEqual([]);
    expect(new Set([...x, ...y]).size).toBe(6);
    expect(mine(await s.taskService.claimDue(new Date(), 50))).toEqual([]);
    for (const t of first) {
      expect(t.tenantId).toBe(a.tenant.id);
      expect(t.userId).toBe(a.user.id);
      expect(t.lastStatus).toBe("running");
      expect(t.nextRunAt).toBeGreaterThan(now.getTime());
    }
  });

  test("occurrences missed while the server was down collapse into one run", async () => {
    const a = await login("alice@acme.dev", "acme");
    const hourly = await createTask(a.token, { name: "hourly", schedule: "0 * * * *" });
    await makeDue(hourly.id, "3 days");
    const now = new Date();
    const claimed = await s.taskService.claimDue(now, 50);
    expect(claimed.filter((t) => t.id === hourly.id).length).toBe(1);
    const got = await j("GET", `/v1/tasks/${hourly.id}`, a.token);
    expect(got.body.nextRunAt).toBeGreaterThan(now.getTime());
    expect(got.body.nextRunAt).toBeLessThanOrEqual(now.getTime() + 3_600_000);
    expect(got.body.lastRunAt).toBe(now.getTime());
  });
});

describe("scheduled runs", () => {
  test("a due task runs as its owner in a stored chat linked to the task", async () => {
    const a = await login("alice@acme.dev", "acme");
    const task = await createTask(a.token, { name: "News digest" });
    await makeDue(task.id);
    const runs = await runDueTasks(s, { limit: 50 });
    const run = runs.find((r) => r.taskId === task.id)!;
    expect(run).toMatchObject({ trigger: "schedule", status: "ok", error: null });
    expect(run.sessionId).toBeString();
    expect(run.time.finished).toBeNumber();

    const after = await j("GET", `/v1/tasks/${task.id}`, a.token);
    expect(after.body).toMatchObject({ lastStatus: "ok", lastSessionId: run.sessionId });
    expect(after.body.nextRunAt).toBeGreaterThan(Date.now());
    const history = await j("GET", `/v1/tasks/${task.id}/runs`, a.token);
    expect(history.body.map((r: any) => r.id)).toEqual([run.id]);

    const chat = await j("GET", `/v1/sessions/${run.sessionId}`, a.token);
    expect(chat.body.info).toMatchObject({ taskId: task.id, storageMode: "server" });
    expect(chat.body.info.title).toStartWith("News digest · ");
    expect(chat.body.messages.length).toBe(2);
    const prompt = chat.body.messages[0].parts.find((p: any) => p.type === "text").text;
    expect(prompt).toContain("unattended");
    expect(prompt).toContain("Summarise the news");
    const stored = await s.db.query<{ n: number }>(
      "select count(*)::int as n from messages where session_id = $1",
      [run.sessionId],
    );
    expect(stored[0].n).toBe(2);
    const list = await j("GET", "/v1/sessions", a.token);
    expect(list.body.find((x: any) => x.id === run.sessionId).taskId).toBe(task.id);
  });

  test("an action that needs approval is denied, and the run carries on", async () => {
    const c = await login("carol@approvals.dev", "approvals");
    const setting = { scope: "tenant", key: "web.tools", value: "agent" };
    expect((await j("PUT", "/v1/settings", c.token, setting)).status).toBe(200);
    const task = await createTask(c.token, { prompt: "please write hello.txt" });
    await makeDue(task.id);
    const runs = await withTimeout(runDueTasks(s, { limit: 50 }), 10_000);
    const run = runs.find((r) => r.taskId === task.id)!;
    expect(run.status).toBe("ok");
    const chat = await j("GET", `/v1/sessions/${run.sessionId}`, c.token);
    const parts = chat.body.messages.slice(1).flatMap((m: any) => m.parts);
    const tool = parts.find((p: any) => p.type === "tool");
    expect(tool).toMatchObject({ tool: "write", state: { status: "error" } });
    expect(tool.state.error).toMatch(/scheduled run.*approval/);
    expect(parts.some((p: any) => p.type === "text")).toBe(true);
    expect(chat.body.pendingApprovals).toEqual([]);
  });

  test("a task whose owner left is turned off instead of run", async () => {
    const a = await login("alice@acme.dev", "acme");
    const d = await login("dave@acme.dev", "acme");
    const task = await createTask(d.token);
    await s.db.query(
      "update memberships set status = 'removed' where tenant_id = $1 and user_id = $2",
      [a.tenant.id, d.user.id],
    );
    await makeDue(task.id);
    const run = (await runDueTasks(s, { limit: 50 })).find((r) => r.taskId === task.id)!;
    expect(run).toMatchObject({ status: "error", sessionId: null });
    expect(run.error).toMatch(/no longer an active member/);
    const [row] = await s.db.query<{ enabled: boolean; next_run_at: unknown }>(
      "select enabled, next_run_at from scheduled_tasks where id = $1",
      [task.id],
    );
    expect(row).toEqual({ enabled: false, next_run_at: null });
  });
});

describe("manual runs", () => {
  test("POST /run starts a run in the background and returns it with its chat", async () => {
    const a = await login("alice@acme.dev", "acme");
    const task = await createTask(a.token, { enabled: false });
    const started = await j("POST", `/v1/tasks/${task.id}/run`, a.token);
    expect(started.status).toBe(202);
    expect(started.body.run).toMatchObject({ taskId: task.id, trigger: "manual" });
    expect(started.body.sessionId).toBe(started.body.run.sessionId);
    const done = await waitFor(async () => {
      const r = await j("GET", `/v1/tasks/${task.id}/runs`, a.token);
      return r.body[0]?.status === "running" ? null : r.body[0];
    });
    expect(done).toMatchObject({ id: started.body.run.id, status: "ok" });
    const chat = await j("GET", `/v1/sessions/${started.body.sessionId}`, a.token);
    expect(chat.body.info.taskId).toBe(task.id);
    const after = await j("GET", `/v1/tasks/${task.id}`, a.token);
    expect(after.body).toMatchObject({ lastStatus: "ok", enabled: false, nextRunAt: null });
  });
});

describe("user scoping", () => {
  test("other users can't see, change, run or delete your task", async () => {
    const a = await login("alice@acme.dev", "acme");
    const b = await login("bob@acme.dev", "acme");
    const e = await login("eve@evil.dev", "evil");
    const task = await createTask(a.token);
    for (const other of [b, e]) {
      const ids = (await j("GET", "/v1/tasks", other.token)).body.map((t: any) => t.id);
      expect(ids).not.toContain(task.id);
      expect((await j("GET", `/v1/tasks/${task.id}`, other.token)).status).toBe(404);
      expect((await j("PATCH", `/v1/tasks/${task.id}`, other.token, { name: "x" })).status).toBe(
        404,
      );
      expect((await j("POST", `/v1/tasks/${task.id}/run`, other.token)).status).toBe(404);
      expect((await j("GET", `/v1/tasks/${task.id}/runs`, other.token)).status).toBe(404);
      expect((await j("DELETE", `/v1/tasks/${task.id}`, other.token)).status).toBe(404);
    }
    expect((await j("GET", "/v1/tasks/not-a-uuid", a.token)).status).toBe(404);
    expect((await j("GET", "/v1/tasks", a.token)).body.map((t: any) => t.id)).toContain(task.id);
    expect((await j("DELETE", `/v1/tasks/${task.id}`, a.token)).status).toBe(204);
    expect((await j("GET", `/v1/tasks/${task.id}`, a.token)).status).toBe(404);
  });
});
