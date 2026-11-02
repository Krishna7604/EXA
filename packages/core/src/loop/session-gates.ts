// One PermissionGate per (session, agent), kept across prompts so "always" answers stick while
// the rules and mode are rebuilt fresh on every prompt.

import type { SessionInfo } from "@exa/protocol";
import type { AgentDef } from "../models/agent.model.ts";
import type { LoopDeps } from "../models/loop.model.ts";
import { PermissionEngine } from "../permission/permission-engine.ts";
import { PermissionGate } from "../permission/permission-gate.ts";
import { modeRules } from "../permission/permission-rules.ts";

// ---------- session gates ----------
export class SessionGates {
  private readonly gates = new Map<string, PermissionGate>();

  constructor(private readonly deps: Pick<LoopDeps, "permissions">) {}

  gateFor(session: SessionInfo, agent: AgentDef): PermissionGate {
    const key = gateKey(session.id, agent.name);
    const engine = this.buildEngine(session, agent);
    const existing = this.gates.get(key);
    if (existing) {
      existing.setEngine(engine); // rules/mode may have changed; keep "always" answers
      return existing;
    }
    const { approvals, authorizer, serverChecked } = this.deps.permissions;
    const gate = new PermissionGate(engine, approvals, {
      sessionId: session.id,
      authorizer,
      serverChecked,
    });
    this.gates.set(key, gate);
    return gate;
  }

  forget(sessionId: string): void {
    const prefix = gateKey(sessionId, "");
    for (const key of this.gates.keys()) if (key.startsWith(prefix)) this.gates.delete(key);
  }

  private buildEngine(session: SessionInfo, agent: AgentDef): PermissionEngine {
    const { permissions } = this.deps;
    const mode = permissions.mode(session);
    return new PermissionEngine([...permissions.rules(), ...agent.rules, ...modeRules(mode)], mode);
  }
}

// ---------- helpers ----------
function gateKey(sessionId: string, agentName: string): string {
  return `${sessionId}:${agentName}`;
}
