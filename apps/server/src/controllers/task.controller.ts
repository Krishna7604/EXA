// Scheduled-task endpoints: the caller's tasks (CRUD), a manual run and the run history.
import { api } from "@exa/protocol";
import { body, json, noContent, queryInt } from "../helpers/http.helper.ts";
import type { Ctx } from "../models/http-context.model.ts";
import type { TaskService } from "../services/task.service.ts";

// ---------- constants ----------
const DEFAULT_RUNS_LIMIT = 20;
const MAX_RUNS_LIMIT = 100;

// ---------- task controller ----------
export class TaskController {
  constructor(private readonly tasks: TaskService) {}

  list = async (ctx: Ctx): Promise<Response> => json(await this.tasks.list(ctx.principal!));

  create = async (ctx: Ctx): Promise<Response> => {
    const b = await body(ctx, api.CreateTaskBody);
    return json(await this.tasks.create(ctx.principal!, b), 201);
  };

  get = async (ctx: Ctx): Promise<Response> =>
    json(await this.tasks.get(ctx.principal!, ctx.params.id));

  update = async (ctx: Ctx): Promise<Response> => {
    const b = await body(ctx, api.PatchTaskBody);
    return json(await this.tasks.update(ctx.principal!, ctx.params.id, b));
  };

  remove = async (ctx: Ctx): Promise<Response> => {
    await this.tasks.delete(ctx.principal!, ctx.params.id);
    return noContent();
  };

  /** 202: the run continues in the background; follow it on its chat's event stream. */
  run = async (ctx: Ctx): Promise<Response> =>
    json(await this.tasks.runNow(ctx.principal!, ctx.params.id), 202);

  runs = async (ctx: Ctx): Promise<Response> => {
    const limit = queryInt(ctx, "limit", DEFAULT_RUNS_LIMIT, MAX_RUNS_LIMIT);
    return json(await this.tasks.runs(ctx.principal!, ctx.params.id, limit));
  };
}
