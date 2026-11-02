// Skills and agents published to the org (admins) or by a user, shared with every client.

import type { api } from "@exa/protocol";
import type { z } from "zod";
import { ERROR_CODES } from "../constants/errors.constants.ts";
import { isAdmin } from "../helpers/role.helper.ts";
import type { ExtensionScope } from "../models/extension.model.ts";
import { HttpError } from "../models/http-error.model.ts";
import type { Principal } from "../models/principal.model.ts";
import type { ServiceDeps } from "./service-deps.ts";

// ---------- constants ----------
const BUILTIN_AGENT_NAMES = ["build", "plan", "explore", "general", "compaction", "title"];

// ---------- types ----------
type PutSkillInput = z.infer<typeof api.PutSkillBody>;
type PutAgentInput = z.infer<typeof api.PutAgentBody>;

// ---------- extension service ----------
export class ExtensionService {
  constructor(private readonly deps: ServiceDeps) {}

  listSkills(p: Principal) {
    return this.deps.extensions.skills(p);
  }

  async putSkill(p: Principal, input: PutSkillInput): Promise<string> {
    if (input.scope === "tenant" && !isAdmin(p))
      throw new HttpError(403, "only admins can publish org skills", ERROR_CODES.forbidden);
    const id = await this.deps.extensions.putSkill(p, input.scope, input);
    this.auditSaved(p, "skill.saved", `${input.scope}:${input.name}`);
    return id;
  }

  async deleteSkill(p: Principal, name: string, scope: ExtensionScope): Promise<void> {
    assertCanManage(p, scope);
    if (!(await this.deps.extensions.deleteSkill(p, name, scope)))
      throw new HttpError(404, "skill not found", ERROR_CODES.notFound);
  }

  listAgents(p: Principal) {
    return this.deps.extensions.agents(p);
  }

  async putAgent(p: Principal, input: PutAgentInput): Promise<string> {
    if (input.scope === "tenant" && !isAdmin(p))
      throw new HttpError(403, "only admins can publish org agents", ERROR_CODES.forbidden);
    if (BUILTIN_AGENT_NAMES.includes(input.name))
      throw new HttpError(
        400,
        "that name is reserved for a built-in agent",
        ERROR_CODES.validation,
      );
    const id = await this.deps.extensions.putAgent(p, input.scope, input);
    this.auditSaved(p, "agent.saved", `${input.scope}:${input.name}`);
    return id;
  }

  async deleteAgent(p: Principal, name: string, scope: ExtensionScope): Promise<void> {
    assertCanManage(p, scope);
    if (!(await this.deps.extensions.deleteAgent(p, name, scope)))
      throw new HttpError(404, "agent not found", ERROR_CODES.notFound);
  }

  private auditSaved(p: Principal, action: string, target: string): void {
    this.deps.telemetry.recordAudit({
      tenantId: p.tenantId,
      actorUserId: p.userId,
      action,
      target,
    });
  }
}

// ---------- helpers ----------
function assertCanManage(p: Principal, scope: ExtensionScope): void {
  if (scope === "tenant" && !isAdmin(p))
    throw new HttpError(403, "admins only", ERROR_CODES.forbidden);
}
