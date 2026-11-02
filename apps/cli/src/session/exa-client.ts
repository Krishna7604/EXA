// Heavy client session host: builds the SAME AgentLoop the server uses, with local tools and
// either the exa server (gateway, policy, approvals, audit, storage) or nothing (--local).

import { homedir } from "node:os";
import { join } from "node:path";
import type { ToolSpec } from "@exa/core";
import {
  AgentLoop,
  AgentRegistry,
  type ApprovalPort,
  agentFromSpec,
  builtinRules,
  EventBus,
  HookRunner,
  MemoryStore,
  type ModelPort,
  type PromptResult,
  type SessionStore,
  secretScrubHook,
  TeeSink,
  ToolRegistry,
} from "@exa/core";
import {
  type ExaEvent,
  type MessageWithParts,
  makeEvent,
  newId,
  type PermissionMode,
  type PermissionReply,
  type PermissionRequest,
  type PermissionRule,
  type SessionInfo,
  type StorageMode,
  zeroTokens,
} from "@exa/protocol";
import { Gateway, localPorts } from "@exa/router";
import { JsonlStore } from "@exa/store";
import {
  builtinTools,
  type CommandDef,
  detectEnv,
  expandCommand,
  FileTimes,
  GitSnapshots,
  LocalInstructions,
  LocalSkills,
  loadLocalAgents,
  loadLocalCommands,
  localShell,
  McpManager,
  type QuestionPort,
  TodoStore,
} from "@exa/tools";
import { EXA_HOME } from "../config/exa-home.config.ts";
import { loadMcpServers } from "../config/mcp.config.ts";
import { combineInstructions, mergeSkills, type OrgSkill } from "../helpers/loop-ports.helper.ts";
import type { Credentials } from "../models/config.model.ts";
import type { Interaction } from "../models/interaction.model.ts";
import { ExaApi } from "../services/api.service.ts";
import { EventForwarder } from "../sync/event-forwarder.ts";
import { LeaseKeeper } from "../sync/lease-keeper.ts";
import { MirrorStore } from "../sync/mirror-store.ts";
import { remoteAuthorizer } from "../sync/remote-authorizer.ts";
import { verifyPolicy } from "../sync/verify-policy.ts";

// ---------- constants ----------
const DEFAULT_AGENT = "build";
const DEFAULT_MODEL = "exa";
const LEASE_TTL_MS = 60_000;
/** Warn once, after this many consecutive sync failures. */
const SYNC_FAILURE_NOTICE_AT = 3;
const SESSION_LIST_LIMIT = 20;
const COMMAND_SHELL_TIMEOUT_MS = 30_000;
const MCP_ERROR_PREVIEW_CHARS = 160;
const DEFAULT_MAX_STEPS = 50;
/** 0 = no cost cap. */
const DEFAULT_MAX_COST_USD = 0;
const DEFAULT_MAX_SUBAGENT_DEPTH = 1;

// ---------- types ----------
export interface ClientOptions {
  cwd: string;
  model?: string;
  agent?: string;
  mode?: PermissionMode;
  storage?: StorageMode;
  resume?: string;
  /** Local mode: env for provider keys. */
  env?: Record<string, string | undefined>;
  localRules?: PermissionRule[];
  instructions?: string[];
}

type WorkspaceEnv = Awaited<ReturnType<typeof detectEnv>>;

interface OpenedSession {
  info: SessionInfo & { permissionMode?: string };
  history: MessageWithParts[] | null;
}

// ---------- client ----------
export class ExaClient {
  readonly agents = new AgentRegistry();
  readonly api: ExaApi | null;
  readonly local: boolean;
  session!: SessionInfo;
  mode: PermissionMode = "default";
  agent = DEFAULT_AGENT;
  loop!: AgentLoop;
  commands: CommandDef[] = [];
  root = "";
  private readonly bus = new EventBus();
  private store!: SessionStore;
  private lease: LeaseKeeper | null = null;
  private forwarder: EventForwarder | null = null;
  private subAbort = new AbortController();
  private pendingRemote = new Map<string, (r: PermissionReply) => void>();
  private rules: PermissionRule[] = builtinRules();
  private serverChecked = new Set<string>();
  private settings: Record<string, unknown> = {};
  private current: AbortController | null = null;
  private mcp: McpManager | null = null;
  private mcpTools: ToolSpec[] = [];
  private orgSkills: OrgSkill[] = [];

  constructor(
    private readonly opts: ClientOptions,
    private readonly io: Interaction,
    readonly creds: Credentials | null,
  ) {
    this.local = !creds;
    this.api = creds ? new ExaApi(creds.server, creds.token) : null;
    this.bus.subscribeAll((e) => io.onEvent(e));
  }

  /** Connect (server mode: verify policy, create/resume session, take the lease). */
  async start(): Promise<void> {
    const env = await detectEnv(this.opts.cwd, "client");
    this.agent = this.opts.agent ?? DEFAULT_AGENT;
    if (this.api && this.creds) await this.startServerSession(this.api, this.creds, env);
    else await this.startLocalSession(env);
    await this.startMcp(env.root);
    this.root = env.root;
    await this.loadDefinitions(env.root);
    this.loop = this.buildLoop(env, this.makeModel());
  }

  get mcpSummary(): string {
    return this.mcp ? this.mcp.clients.map((c) => `${c.name}(${c.tools.length})`).join(" ") : "";
  }

  get busy(): boolean {
    return !!this.current;
  }

  async prompt(text: string): Promise<PromptResult> {
    if (this.lease?.lost) throw new Error("this client no longer holds the session lease");
    this.current = new AbortController();
    try {
      return await this.loop.prompt({
        sessionId: this.session.id,
        text,
        agent: this.agent,
        signal: this.current.signal,
      });
    } finally {
      this.current = null;
      this.session = (await this.store.getSession(this.session.id)) ?? this.session;
      await this.forwarder?.flush();
    }
  }

  /** Expand a custom slash command; `confirmShell` decides whether !`cmd` substitutions may run. */
  async expandCommand(
    cmd: CommandDef,
    args: string,
    confirmShell: (c: string) => Promise<boolean>,
  ): Promise<string> {
    return expandCommand(cmd, args, {
      root: this.root,
      allowShell: true,
      runShell: async (c) => {
        if (!(await confirmShell(c))) return `[skipped: ${c}]`;
        const r = await localShell.run(c, {
          cwd: this.root,
          timeoutMs: COMMAND_SHELL_TIMEOUT_MS,
          signal: new AbortController().signal,
        });
        return r.output;
      },
    });
  }

  abort(): boolean {
    if (!this.current) return false;
    this.current.abort();
    return true;
  }

  /** Revert the last user turn; returns its text, or null when there is nothing to undo. */
  async undo(): Promise<string | null> {
    const visible = await this.visibleMessages();
    const lastUser = [...visible].reverse().find((m) => m.info.role === "user" && !m.info.summary);
    if (!lastUser) return null;
    await this.loop.revert(this.session.id, lastUser.info.id);
    this.session = (await this.store.getSession(this.session.id))!;
    const t = lastUser.parts.find((p) => p.type === "text");
    return t && t.type === "text" ? t.text : "";
  }

  async redo(): Promise<void> {
    await this.loop.unrevert(this.session.id);
    this.session = (await this.store.getSession(this.session.id))!;
  }

  async compact(): Promise<boolean> {
    return this.loop.compactSession(this.session.id);
  }

  async setModel(model: string): Promise<void> {
    if (this.api) await this.api.patchSession(this.session.id, { model });
    await this.store.updateSession(this.session.id, { model });
    this.session.model = model;
  }

  async setMode(mode: PermissionMode): Promise<void> {
    if (this.api) await this.api.patchSession(this.session.id, { permissionMode: mode });
    this.mode = mode;
  }

  async listSessions(): Promise<SessionInfo[]> {
    if (this.api) return this.api.sessions(SESSION_LIST_LIMIT);
    return this.store instanceof JsonlStore ? this.store.list(SESSION_LIST_LIMIT) : [];
  }

  async close(): Promise<void> {
    this.current?.abort();
    // best effort: unsent events are only for live viewers
    await this.forwarder?.flush().catch(() => {});
    await this.lease?.release();
    await this.mcp?.close();
    this.subAbort.abort();
  }

  // ---------- startup: server mode ----------
  private async startServerSession(
    api: ExaApi,
    creds: Credentials,
    env: WorkspaceEnv,
  ): Promise<void> {
    await this.applyPolicy(api, creds);
    const orgDefaultModel = String(this.settings["models.default"] ?? DEFAULT_MODEL);
    const model = this.opts.model ?? orgDefaultModel;
    const { info, history } = await this.openServerSession(api, env, model);
    this.mode = (info.permissionMode as PermissionMode) ?? "default";
    await this.connectSync(api, info.id);
    this.store = await this.makeStore(info.storageMode, info, history ?? []);
    this.session = (await this.store.getSession(info.id))!;
    void api.subscribe(info.id, (e) => this.onRemote(e), this.subAbort.signal);
  }

  /** Verify the signed policy bundle against the key pinned at login, then adopt it. */
  private async applyPolicy(api: ExaApi, creds: Credentials): Promise<void> {
    const signed = await api.policy();
    if (!(await verifyPolicy(signed, creds.policyKey))) {
      throw new Error(
        "policy bundle signature does not match the pinned server key — refusing to run (re-run `exa login` if the server key was rotated)",
      );
    }
    if (signed.bundle.expiresAt < Date.now())
      throw new Error("policy bundle expired — check your clock");
    this.rules = signed.bundle.rules;
    this.serverChecked = new Set(signed.bundle.serverChecked);
    this.settings = signed.bundle.settings;
  }

  private async openServerSession(
    api: ExaApi,
    env: WorkspaceEnv,
    model: string,
  ): Promise<OpenedSession> {
    if (this.opts.resume) {
      const got = await api.session(this.opts.resume);
      if (got.info.loopHost !== "client")
        throw new Error("that session runs on the server; open it in the web client");
      return { info: got.info, history: got.messages };
    }
    const info = await api.createSession({
      loopHost: "client",
      storageMode: this.opts.storage,
      model,
      agent: this.agent,
      directory: env.cwd,
      permissionMode: this.opts.mode,
    });
    return { info, history: null };
  }

  /** Take the session lease and start forwarding events to the server. */
  private async connectSync(api: ExaApi, sessionId: string): Promise<void> {
    this.lease = new LeaseKeeper(api, sessionId, LEASE_TTL_MS, () =>
      this.io.notice(
        "lost the session lease — another client took over; further changes won't sync",
      ),
    );
    await this.lease.acquire();
    this.forwarder = new EventForwarder(api, sessionId, this.lease, {
      onError: (e) => {
        if (this.forwarder!.failures === SYNC_FAILURE_NOTICE_AT)
          this.io.notice(`sync to server failing: ${(e as Error).message}`);
      },
    });
  }

  private async makeStore(
    mode: StorageMode,
    info: SessionInfo,
    history: MessageWithParts[],
  ): Promise<SessionStore> {
    if (mode === "server") {
      const m = new MirrorStore(this.forwarder!);
      await m.seed(info, history);
      return m;
    }
    const store = mode === "local" ? new JsonlStore(join(EXA_HOME, "sessions")) : new MemoryStore();
    if (!(await store.getSession(info.id))) await store.createSession(info);
    return store;
  }

  // ---------- startup: local mode ----------
  /** No server: JSONL or in-memory storage and local rules only. */
  private async startLocalSession(env: WorkspaceEnv): Promise<void> {
    this.mode = this.opts.mode ?? "default";
    this.rules = [...builtinRules(), ...(this.opts.localRules ?? [])];
    const storage: StorageMode = this.opts.storage === "none" ? "none" : "local";
    this.store =
      storage === "local" ? new JsonlStore(join(EXA_HOME, "sessions")) : new MemoryStore();
    const existing = this.opts.resume ? await this.store.getSession(this.opts.resume) : null;
    if (this.opts.resume && !existing)
      throw new Error(`session ${this.opts.resume} not found locally`);
    if (existing) {
      this.session = existing;
      return;
    }
    this.session = newLocalSession({
      directory: env.cwd,
      agent: this.agent,
      model: this.opts.model ?? DEFAULT_MODEL,
      storageMode: storage,
    });
    await this.store.createSession(this.session);
  }

  // ---------- startup: shared ----------
  private async startMcp(root: string): Promise<void> {
    const servers = await loadMcpServers(root);
    if (!Object.keys(servers).length) return;
    this.mcp = new McpManager(servers, root);
    this.mcpTools = await this.mcp.start();
    for (const e of this.mcp.errors) {
      const error = e.error.slice(0, MCP_ERROR_PREVIEW_CHARS);
      this.io.notice(`MCP server "${e.name}" failed to start: ${error}`);
    }
  }

  /** Agents, skills and custom commands; local definitions win over the org's on name clashes. */
  private async loadDefinitions(root: string): Promise<void> {
    if (this.api) await this.loadOrgDefinitions(this.api);
    for (const a of await loadLocalAgents(root)) this.agents.register(a);
    this.commands = await loadLocalCommands(root);
    this.agents.require(this.agent);
  }

  /** Org/user agents + skills published on the server; unavailable lists count as empty. */
  private async loadOrgDefinitions(api: ExaApi): Promise<void> {
    const [orgAgents, orgSkills] = await Promise.all([
      api.agents().catch(() => []),
      api.skills().catch(() => []),
    ]);
    for (const a of orgAgents) this.agents.register(agentFromSpec(a));
    this.orgSkills = orgSkills;
  }

  private makeModel(): ModelPort {
    if (this.api) return { stream: (req, signal) => this.api!.modelStream(req, signal) };
    const gw = new Gateway({
      ports: localPorts(this.opts.env ?? process.env),
      pool: this.opts.env ?? (process.env as Record<string, string | undefined>),
    });
    return {
      stream: (req, signal) =>
        gw.stream({ tenantId: "local", userId: "local", sessionId: req.sessionId }, req, signal),
    };
  }

  private buildLoop(env: WorkspaceEnv, model: ModelPort): AgentLoop {
    // never snapshot the whole home directory or filesystem root with git
    const isUnsafeRoot = env.root === homedir() || env.root === "/";
    const sinks = this.forwarder ? new TeeSink([this.bus, this.forwarder]) : this.bus;
    const skills = mergeSkills(new LocalSkills(env.root), this.orgSkills);
    return new AgentLoop({
      model,
      store: this.store,
      events: sinks,
      tools: new ToolRegistry([...builtinTools({ question: true }), ...this.mcpTools]),
      agents: this.agents,
      permissions: this.permissionsConfig(),
      env: () => env,
      hooks: new HookRunner([secretScrubHook]),
      instructions: combineInstructions(
        new LocalInstructions(env.root, env.cwd, this.opts.instructions ?? []),
        this.mcp,
      ),
      skills,
      snapshots: isUnsafeRoot ? undefined : new GitSnapshots(env.root, join(EXA_HOME, "snapshots")),
      outputDir: join(EXA_HOME, "tool-output", this.session.id),
      services: {
        fileTimes: new FileTimes(),
        todos: new TodoStore(),
        skills,
        questions: {
          ask: (sid, qs, signal) => this.io.ask(sid, qs, signal),
        } satisfies QuestionPort,
      },
      config: this.loopLimits(),
    });
  }

  private permissionsConfig() {
    const approvals: ApprovalPort = { request: (req, signal) => this.approve(req, signal) };
    return {
      rules: () => this.rules,
      mode: () => this.mode,
      approvals,
      authorizer: this.api ? remoteAuthorizer(this.api) : undefined,
      serverChecked: this.serverChecked,
    };
  }

  /** Limits from the org policy settings (local mode: defaults). */
  private loopLimits() {
    return {
      maxSteps: Number(this.settings["loop.maxSteps"] ?? DEFAULT_MAX_STEPS),
      maxCostUsd: Number(this.settings["loop.maxCostUsd"] ?? DEFAULT_MAX_COST_USD),
      maxDepth: Number(this.settings["subagent.maxDepth"] ?? DEFAULT_MAX_SUBAGENT_DEPTH),
    };
  }

  // ---------- approvals and remote events ----------
  /** Terminal prompt races with answers from other attached clients (web/phone). */
  private async approve(req: PermissionRequest, signal?: AbortSignal): Promise<PermissionReply> {
    if (!this.forwarder) {
      const r = await this.io.approve(req, signal ?? new AbortController().signal);
      return r ?? "reject";
    }
    this.forwarder.publish(makeEvent("permission.asked", req.sessionId, { request: req }));
    await this.forwarder.flush();
    const winner = await this.raceApprovals(req, signal);
    const reply = winner.r ?? "reject";
    if (winner.from === "local") {
      this.forwarder.publish(
        makeEvent("permission.replied", req.sessionId, { requestId: req.id, reply, by: "cli" }),
      );
    } else {
      this.io.notice(`answered from another device: ${reply}`);
    }
    return reply;
  }

  /** First answer wins: the terminal prompt or a permission.replied event from the server. */
  private async raceApprovals(req: PermissionRequest, signal?: AbortSignal) {
    const ac = new AbortController();
    signal?.addEventListener("abort", () => ac.abort(), { once: true });
    const remote = new Promise<PermissionReply>((res) => this.pendingRemote.set(req.id, res));
    const local = this.io.approve(req, ac.signal).then((r) => r);
    const winner = await Promise.race([
      remote.then((r) => ({ r, from: "remote" as const })),
      local.then((r) => ({ r, from: "local" as const })),
    ]);
    this.pendingRemote.delete(req.id);
    ac.abort();
    return winner;
  }

  private onRemote(e: ExaEvent): void {
    if (e.type === "permission.replied") {
      const d = e.data as { requestId: string; reply: PermissionReply; by?: string };
      if (d.by !== "cli") this.pendingRemote.get(d.requestId)?.(d.reply);
    } else if (e.type === "session.abort") {
      if (this.current) {
        this.current.abort();
        this.io.notice("turn aborted from another device");
      }
    }
  }

  /** Messages before the current revert point (all of them when nothing is reverted). */
  private async visibleMessages(): Promise<MessageWithParts[]> {
    const msgs = await this.store.messages(this.session.id);
    const revert = this.session.revert;
    if (!revert) return msgs;
    return msgs.slice(
      0,
      msgs.findIndex((m) => m.info.id === revert.messageId),
    );
  }
}

// ---------- helpers ----------
function newLocalSession(
  fields: Pick<SessionInfo, "directory" | "agent" | "model" | "storageMode">,
): SessionInfo {
  const now = Date.now();
  return {
    id: newId(),
    tenantId: "local",
    userId: "local",
    projectId: null,
    parentId: null,
    title: null,
    directory: fields.directory,
    agent: fields.agent,
    model: fields.model,
    loopHost: "client",
    storageMode: fields.storageMode,
    status: "active",
    revert: null,
    tokens: zeroTokens(),
    cost: 0,
    time: { created: now, updated: now },
  };
}
