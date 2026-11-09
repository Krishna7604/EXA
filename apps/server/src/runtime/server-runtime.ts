// Server-hosted agent loops for light clients (web, phone) and scheduled tasks: one live
// AgentLoop per active session, each with its own workspace, optional Docker sandbox, the org's
// policy, and the user's memory, web search and connectors when the server provides them.

import { join } from "node:path";
import {
  AgentLoop,
  AgentRegistry,
  type ApprovalPort,
  agentFromSpec,
  type EventBus,
  HookRunner,
  type MemoryPort,
  PermissionDeniedError,
  type PromptResult,
  type SearchPort,
  type SkillsPort,
  secretScrubHook,
  ToolRegistry,
} from "@exa/core";
import {
  makeEvent,
  type PermissionMode,
  type PermissionRule,
  type SessionInfo,
} from "@exa/protocol";
import type { Gateway } from "@exa/router";
import { builtinTools, FileTimes, GitSnapshots, TodoStore } from "@exa/tools";
import type { ServerConfig } from "../config/env.config.ts";
import type { ConnectedTools } from "../models/connector.model.ts";
import type { Principal } from "../models/principal.model.ts";
import type { ResolvedSettings } from "../models/settings.model.ts";
import type { Subject } from "../models/subject.model.ts";
import type { ExtensionsRepo } from "../repositories/extensions.repository.ts";
import { ServerSessionStore } from "../repositories/server-session.store.ts";
import type { SessionRepo } from "../repositories/session.repository.ts";
import type { TelemetryWriter } from "../repositories/telemetry.repository.ts";
import type { PolicyService } from "../services/policy.service.ts";
import type { ApprovalBroker } from "./approval-broker.ts";
import { orgSkills } from "./org-skills.ts";
import { DockerSandbox, Workspaces } from "./sandbox.ts";

// ---------- constants ----------
const SESSION_BUSY_STATUS = 409;
const DEFAULT_MAX_STEPS = 50;
const DEFAULT_MAX_COST_USD = 0;
const DEFAULT_MAX_SUBAGENT_DEPTH = 1;
const SANDBOX_NAME_ID_CHARS = 18;
/** Tools the server re-checks against locked org rules and the risk classifier. */
const SERVER_CHECKED_TOOLS = ["bash"];

// ---------- types ----------
export interface ServerRuntimeDeps {
  cfg: ServerConfig;
  gateway: Gateway;
  sessions: SessionRepo;
  extensions: ExtensionsRepo;
  policy: PolicyService;
  bus: EventBus;
  approvals: ApprovalBroker;
  telemetry: TelemetryWriter;
  /** The user's long-term memory; absent → no memory tools and no memory in the prompt. */
  memoryFor?: (tenantId: string, userId: string) => MemoryPort;
  /** Web search from the server config; absent → no websearch tool. */
  search?: SearchPort | null;
  /** The user's enabled remote MCP connectors, connected for one live session. */
  connectorsFor?: (subject: Subject) => Promise<ConnectedTools>;
}

/** What to run: the user's text plus optional per-turn agent/model overrides. */
interface PromptRequest {
  text: string;
  agent?: string;
  model?: string;
}

type RuntimeSession = SessionInfo & { permissionMode?: string };

/** Rules + mode are re-read every turn, so the loop reads them through this mutable holder. */
interface PermissionState {
  rules: PermissionRule[];
  mode: PermissionMode;
}

interface LiveSession {
  loop: AgentLoop;
  tenantId: string;
  userId: string;
  lastActive: number;
  permissions: PermissionState;
  sandbox?: DockerSandbox;
  agents: AgentRegistry;
  connectors?: ConnectedTools;
}

interface LoopParts {
  tenantId: string;
  session: RuntimeSession;
  subject: Subject;
  settings: ResolvedSettings;
  permissions: PermissionState;
  dir: string;
  hasFiles: boolean;
  sandbox?: DockerSandbox;
  agents: AgentRegistry;
  skills: SkillsPort;
  connectors?: ConnectedTools;
}

// ---------- errors ----------
/**
 * A scheduled run reached an action that needs approval. Nobody is there to give it, so the
 * call is denied — the agent sees the reason and carries on, instead of the run ending.
 */
class UnattendedDenial extends PermissionDeniedError {
  constructor(permission: string, pattern: string) {
    super(permission, pattern);
    this.message = `Not allowed in a scheduled run: ${permission} "${pattern}" needs the user's approval and nobody is there to give it. Don't retry it; finish what you can without it and say in your result what needed approval.`;
  }
}

/** A prompt arrived while the session's loop is still running a turn (surfaces as HTTP 409). */
class SessionBusyError extends Error {
  readonly status = SESSION_BUSY_STATUS;

  constructor() {
    super("session is busy — wait for the current turn or abort it");
  }
}

// ---------- server runtime ----------
export class ServerRuntime {
  private readonly live = new Map<string, LiveSession>();
  private readonly stores = new Map<string, ServerSessionStore>();
  private readonly workspaces: Workspaces;
  private readonly fileTimes = new FileTimes();
  private readonly todos = new TodoStore();

  constructor(private readonly deps: ServerRuntimeDeps) {
    this.workspaces = new Workspaces(deps.cfg.sandboxRoot);
  }

  storeFor(tenantId: string): ServerSessionStore {
    let store = this.stores.get(tenantId);
    if (!store) {
      store = new ServerSessionStore(this.deps.sessions, tenantId);
      this.stores.set(tenantId, store);
    }
    return store;
  }

  isBusy(sessionId: string): boolean {
    return this.live.get(sessionId)?.loop.isBusy(sessionId) ?? false;
  }

  /** Starts a run in the background; progress is on the event stream. */
  async prompt(p: Principal, session: RuntimeSession, input: PromptRequest): Promise<void> {
    const live = await this.liveFor(p, session);
    if (live.loop.isBusy(session.id)) throw new SessionBusyError();
    void live.loop
      .prompt({ sessionId: session.id, text: input.text, agent: input.agent, model: input.model })
      .catch((err) => {
        const message = String(err?.message ?? err);
        this.deps.bus.publish(
          makeEvent("session.error", session.id, { error: { name: "RuntimeError", message } }),
        );
      });
  }

  /** Runs a prompt to completion (scheduled tasks). Progress is still published as events. */
  async run(p: Principal, session: RuntimeSession, input: PromptRequest): Promise<PromptResult> {
    const live = await this.liveFor(p, session);
    if (live.loop.isBusy(session.id)) throw new SessionBusyError();
    return live.loop.prompt({
      sessionId: session.id,
      text: input.text,
      agent: input.agent,
      model: input.model,
    });
  }

  abort(sessionId: string): boolean {
    return this.live.get(sessionId)?.loop.abort(sessionId) ?? false;
  }

  async revert(
    p: Principal,
    session: SessionInfo,
    messageId: string,
    partId?: string,
  ): Promise<void> {
    const live = await this.liveFor(p, session);
    await live.loop.revert(session.id, messageId, partId);
  }

  async unrevert(p: Principal, session: SessionInfo): Promise<void> {
    const live = await this.liveFor(p, session);
    await live.loop.unrevert(session.id);
  }

  async compact(p: Principal, session: SessionInfo): Promise<boolean> {
    const live = await this.liveFor(p, session);
    return live.loop.compactSession(session.id);
  }

  async forget(tenantId: string, sessionId: string): Promise<void> {
    const live = this.live.get(sessionId);
    live?.loop.abort(sessionId);
    if (live) await stopLive(live);
    this.live.delete(sessionId);
    this.deps.bus.drop(sessionId);
    // The workspace may never have been created (chat-only sessions); nothing to clean up then.
    await this.workspaces.remove(tenantId, sessionId).catch(() => {});
  }

  /** Evict idle runtimes (frees memory + stops sandboxes). Content for storage=none is lost by design. */
  async sweep(): Promise<number> {
    const cutoff = Date.now() - this.deps.cfg.idleRuntimeMs;
    let evicted = 0;
    for (const [id, live] of this.live) {
      if (live.lastActive >= cutoff || live.loop.isBusy(id)) continue;
      await stopLive(live);
      this.live.delete(id);
      evicted++;
    }
    this.deps.bus.sweep(this.deps.cfg.idleRuntimeMs);
    return evicted;
  }

  async shutdown(): Promise<void> {
    for (const [id, live] of this.live) {
      live.loop.abort(id);
      await stopLive(live);
    }
    this.live.clear();
  }

  private async liveFor(p: Principal, session: RuntimeSession): Promise<LiveSession> {
    const subject = { tenantId: p.tenantId, userId: session.userId, projectId: session.projectId };
    const [rules, settings] = await Promise.all([
      this.deps.policy.rulesFor(subject),
      this.deps.policy.settingsFor(subject),
    ]);
    const mode = this.deps.policy.effectiveMode(settings, session.permissionMode);
    const existing = this.live.get(session.id);
    if (existing) return this.refreshLive(existing, subject, { rules, mode });
    const created = await this.createLive(p.tenantId, session, subject, settings, { rules, mode });
    this.live.set(session.id, created);
    return created;
  }

  private async refreshLive(
    live: LiveSession,
    subject: Subject,
    permissions: PermissionState,
  ): Promise<LiveSession> {
    live.permissions.rules = permissions.rules;
    live.permissions.mode = permissions.mode;
    for (const spec of await this.deps.extensions.agents(subject))
      live.agents.register(agentFromSpec(spec));
    live.lastActive = Date.now();
    return live;
  }

  private async createLive(
    tenantId: string,
    session: RuntimeSession,
    subject: Subject,
    settings: ResolvedSettings,
    permissions: PermissionState,
  ): Promise<LiveSession> {
    // `web.tools` = "chat" (default): an agent that reasons, calls the web, keeps todos and can
    // delegate to subagents, but has no filesystem at all. No workspace directory is created on
    // the VM and no file tool is registered. "agent" restores the full coding-agent toolset
    // inside a per-chat sandbox workspace.
    const hasFiles = settings.values["web.tools"] === "agent";
    const dir = hasFiles
      ? await this.workspaces.ensure(tenantId, session.id)
      : this.workspaces.dir(tenantId, session.id);
    const sandbox = hasFiles ? this.sandboxFor(dir, session.id, settings) : undefined;
    const agents = new AgentRegistry();
    for (const spec of await this.deps.extensions.agents(subject))
      agents.register(agentFromSpec(spec));
    const skills = orgSkills(this.deps.extensions, subject);
    const connectors = await this.connectorsFor(subject);
    const loop = this.buildLoop({
      tenantId,
      session,
      subject,
      settings,
      permissions,
      dir,
      hasFiles,
      sandbox,
      agents,
      skills,
      connectors,
    });
    return {
      loop,
      tenantId,
      userId: session.userId,
      lastActive: Date.now(),
      permissions,
      sandbox,
      agents,
      connectors,
    };
  }

  /** Connector failures never block a chat: it just runs without them. */
  private async connectorsFor(subject: Subject): Promise<ConnectedTools | undefined> {
    if (!this.deps.connectorsFor) return undefined;
    try {
      return await this.deps.connectorsFor(subject);
    } catch (err) {
      console.error("[exa-server] connectors unavailable", err);
      return undefined;
    }
  }

  private sandboxFor(
    dir: string,
    sessionId: string,
    settings: ResolvedSettings,
  ): DockerSandbox | undefined {
    if (this.deps.cfg.sandboxShell !== "docker") return undefined;
    if (settings.values["sandbox.shell"] === false) return undefined;
    const name = `exa-${sessionId.slice(0, SANDBOX_NAME_ID_CHARS)}`;
    return new DockerSandbox(dir, this.deps.cfg.sandboxImage, name);
  }

  private buildLoop(parts: LoopParts): AgentLoop {
    const { tenantId, session, subject, permissions, dir, sandbox, skills, connectors } = parts;
    const principal = { tenantId, userId: session.userId, sessionId: session.id };
    const memory = this.deps.memoryFor?.(tenantId, session.userId);
    const search = this.deps.search ?? undefined;
    const tools = builtinTools({
      files: parts.hasFiles,
      shell: !!sandbox,
      web: true,
      memory: !!memory,
      search: !!search,
    });
    return new AgentLoop({
      model: { stream: (req, signal) => this.deps.gateway.stream(principal, req, signal) },
      store: this.storeFor(tenantId),
      events: this.deps.bus,
      tools: new ToolRegistry([...tools, ...(connectors?.tools ?? [])]),
      agents: parts.agents,
      skills,
      memory,
      search,
      instructions: connectors?.instructions,
      permissions: {
        rules: () => permissions.rules,
        mode: () => permissions.mode,
        approvals: this.approvalsFor(tenantId, session),
        authorizer: {
          authorize: (req) => this.deps.policy.authorize(subject, req, permissions.mode),
        },
        serverChecked: new Set(SERVER_CHECKED_TOOLS),
      },
      env: () => sandboxEnv(dir),
      hooks: this.buildHooks(tenantId, session),
      snapshots: parts.hasFiles
        ? new GitSnapshots(dir, join(this.deps.cfg.dataDir, "snapshots"))
        : undefined,
      outputDir: join(this.deps.cfg.dataDir, "tool-output", tenantId, session.id),
      services: {
        fileTimes: this.fileTimes,
        todos: this.todos,
        shell: sandbox ?? false,
        blockPrivateNetwork: true,
        skills,
      },
      config: loopLimits(parts.settings),
    });
  }

  /** Chats ask the user (any attached client answers); scheduled runs refuse instead. */
  private approvalsFor(tenantId: string, session: RuntimeSession): ApprovalPort {
    if (session.taskId)
      return {
        request: async (req) => {
          throw new UnattendedDenial(req.permission, req.patterns.join(", "));
        },
      };
    return { request: (req, signal) => this.deps.approvals.ask(tenantId, req, signal) };
  }

  private buildHooks(tenantId: string, session: RuntimeSession): HookRunner {
    return new HookRunner([
      secretScrubHook,
      {
        "tool.execute.after": (input, output) => {
          this.deps.telemetry.recordAudit({
            tenantId,
            actorUserId: session.userId,
            sessionId: session.id,
            action: "tool.run",
            target: input.tool,
            decision: output.error ? "error" : "ok",
          });
        },
      },
    ]);
  }
}

// ---------- helpers ----------
/** Frees what a live session holds outside the process: its sandbox and connector sessions. */
async function stopLive(live: LiveSession): Promise<void> {
  await live.sandbox?.stop();
  await live.connectors?.close().catch((err) => {
    console.error("[exa-server] closing connectors failed", err);
  });
}

function sandboxEnv(dir: string) {
  return {
    root: dir,
    cwd: dir,
    platform: "linux-sandbox",
    date: new Date().toISOString().slice(0, 10),
    isGitRepo: false,
    host: "server" as const,
  };
}

function loopLimits(settings: ResolvedSettings) {
  return {
    maxSteps: Number(settings.values["loop.maxSteps"] ?? DEFAULT_MAX_STEPS),
    maxCostUsd: Number(settings.values["loop.maxCostUsd"] ?? DEFAULT_MAX_COST_USD),
    maxDepth: Number(settings.values["subagent.maxDepth"] ?? DEFAULT_MAX_SUBAGENT_DEPTH),
  };
}
