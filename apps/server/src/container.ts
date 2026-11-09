// Composition root for the server: opens the database and constructs every repository, the
// model gateway, policy, runtime and domain service exactly once. Controllers are built from
// these in routes/api.routes.ts.

import { EventBus } from "@exa/core";
import { type Backend, Gateway, KeyVault } from "@exa/router";
import { type Db, migrate, openDb } from "@exa/store";
import { createSearchPort } from "@exa/tools";
import type { ServerConfig } from "./config/env.config.ts";
import { PARTITION_MONTHS_AHEAD } from "./constants/limits.constants.ts";
import { Jwt } from "./helpers/jwt.helper.ts";
import { ConfigRepo } from "./repositories/config.repository.ts";
import { ConnectorRepo } from "./repositories/connector.repository.ts";
import { ExtensionsRepo } from "./repositories/extensions.repository.ts";
import { IdentityRepo } from "./repositories/identity.repository.ts";
import { MaintenanceRepo } from "./repositories/maintenance.repository.ts";
import { MemoryRepo } from "./repositories/memory.repository.ts";
import { SessionRepo } from "./repositories/session.repository.ts";
import { TaskRepo } from "./repositories/task.repository.ts";
import { TelemetryWriter } from "./repositories/telemetry.repository.ts";
import { ApprovalBroker } from "./runtime/approval-broker.ts";
import { ServerRuntime } from "./runtime/server-runtime.ts";
import { AccountService } from "./services/account.service.ts";
import { AuthService } from "./services/auth.service.ts";
import { ClientSyncService } from "./services/client-sync.service.ts";
import { ConnectorService } from "./services/connector.service.ts";
import { ExtensionService } from "./services/extension.service.ts";
import { CachedGatewayPorts } from "./services/gateway-ports.service.ts";
import { KeyService } from "./services/key.service.ts";
import { MemoryService } from "./services/memory.service.ts";
import { ModelService } from "./services/model.service.ts";
import { OidcVerifier } from "./services/oidc-verifier.service.ts";
import { PolicyService } from "./services/policy.service.ts";
import { PolicySigner } from "./services/policy-signer.service.ts";
import { PrincipalService } from "./services/principal.service.ts";
import type { ServiceDeps } from "./services/service-deps.ts";
import { SessionService } from "./services/session.service.ts";
import { SettingsService } from "./services/settings.service.ts";
import { SettingsCache } from "./services/settings-cache.service.ts";
import { TaskService } from "./services/task.service.ts";
import { UsageService } from "./services/usage.service.ts";

// ---------- constants ----------
/** Ring-buffer size per session for resumable event streams. */
const EVENT_BUS_CAPACITY = 5000;

// ---------- types ----------
export interface Services extends ServiceDeps {
  db: Db & { exec(sql: string): Promise<void> };
  sessionService: SessionService;
  clientSyncService: ClientSyncService;
  modelService: ModelService;
  authService: AuthService;
  accountService: AccountService;
  settingsService: SettingsService;
  keyService: KeyService;
  usageService: UsageService;
  extensionService: ExtensionService;
  memoryService: MemoryService;
  taskService: TaskService;
  connectorService: ConnectorService;
  close(): Promise<void>;
}

export interface ServicesOptions {
  fetch?: typeof fetch;
  /** Overrides the env-derived vault; pass null to disable BYOK. */
  vault?: KeyVault | null;
}

type Repos = Pick<
  ServiceDeps,
  "identity" | "config" | "sessions" | "extensions" | "memories" | "connectors" | "telemetry"
>;

// ---------- composition root ----------
export async function createServices(
  cfg: ServerConfig,
  opts: ServicesOptions = {},
): Promise<Services> {
  const db = await openDatabase(cfg);
  const repos = createRepos(db);
  const deps = await createDeps(cfg, repos, opts);
  const sessionService = new SessionService(deps);
  return {
    ...deps,
    db,
    sessionService,
    taskService: new TaskService(deps, { tasks: new TaskRepo(db), sessions: sessionService }),
    clientSyncService: new ClientSyncService(deps),
    modelService: new ModelService(deps),
    authService: new AuthService(deps),
    accountService: new AccountService(deps),
    settingsService: new SettingsService(deps),
    keyService: new KeyService(deps),
    usageService: new UsageService(deps),
    extensionService: new ExtensionService(deps),
    memoryService: new MemoryService(deps),
    connectorService: new ConnectorService({ ...deps, fetch: opts.fetch }),
    async close() {
      await deps.runtime.shutdown();
      await deps.telemetry.stop();
      await db.close();
    },
  };
}

// ---------- helpers ----------
async function openDatabase(cfg: ServerConfig) {
  const db = await openDb({ url: cfg.databaseUrl, dataDir: cfg.dbDir });
  await migrate(db);
  await new MaintenanceRepo(db).ensurePartitions(PARTITION_MONTHS_AHEAD);
  return db;
}

function createRepos(db: Db): Repos {
  const telemetry = new TelemetryWriter(db, {
    onError: (e) => console.error("[exa-server] telemetry flush failed", e),
  });
  telemetry.start();
  return {
    identity: new IdentityRepo(db),
    config: new ConfigRepo(db),
    sessions: new SessionRepo(db),
    extensions: new ExtensionsRepo(db),
    memories: new MemoryRepo(db),
    connectors: new ConnectorRepo(db),
    telemetry,
  };
}

async function createDeps(
  cfg: ServerConfig,
  repos: Repos,
  opts: ServicesOptions,
): Promise<ServiceDeps> {
  const { identity, config, sessions, extensions, telemetry } = repos;
  const vault = resolveVault(opts);
  const settings = new SettingsCache(config);
  const ports = new CachedGatewayPorts({ config, telemetry, vault, settings });
  const backends = await loadBackends(cfg);
  // biome-ignore lint/suspicious/noExplicitAny: test fetch stubs don't match Bun's fetch type
  const gateway = new Gateway({ ports, pool: cfg.pool, backends, fetch: opts.fetch as any });
  const bus = new EventBus(EVENT_BUS_CAPACITY);
  const signer = await PolicySigner.load(cfg.dataDir, process.env.EXA_POLICY_SIGNING_KEY);
  const policy = new PolicyService(config, identity, signer);
  const principals = new PrincipalService(new Jwt(cfg.jwtSecret), identity);
  const oidc = cfg.oidc ? new OidcVerifier(cfg.oidc.issuer, cfg.oidc.audience, opts.fetch) : null;
  const approvals = new ApprovalBroker(sessions, bus, telemetry, cfg.approvalTimeoutMs);
  // Stateless, like the MemoryService on Services; this one serves the chats' memory ports.
  const memory = new MemoryService(repos);
  // Stateless too; this one connects each live chat's enabled connectors.
  const connectors = new ConnectorService({ ...repos, cfg, vault, fetch: opts.fetch });
  const runtime = new ServerRuntime({
    cfg,
    gateway,
    sessions,
    extensions,
    policy,
    bus,
    approvals,
    telemetry,
    memoryFor: (tenantId, userId) => memory.portFor(tenantId, userId),
    search: createSearchPort(cfg.search, opts.fetch),
    connectorsFor: (subject) => connectors.connectFor(subject),
  });
  return {
    cfg,
    ...repos,
    vault,
    gateway,
    bus,
    policy,
    signer,
    principals,
    oidc,
    approvals,
    runtime,
    settings: (subject) => settings.resolve(subject),
    invalidate(tenantId) {
      settings.invalidate(tenantId);
      ports.invalidate(tenantId);
    },
  };
}

/** An explicit option wins; otherwise the env master key, else BYOK stays disabled. */
function resolveVault(opts: ServicesOptions): KeyVault | null {
  if (opts.vault !== undefined) return opts.vault;
  try {
    return KeyVault.fromEnv();
  } catch {
    // No master key configured: BYOK is disabled until one is set.
    return null;
  }
}

/** EXA_BACKENDS is either inline JSON (starts with "[") or a path to a JSON file. */
async function loadBackends(cfg: ServerConfig): Promise<Backend[] | undefined> {
  if (!cfg.backendsJson) return undefined;
  const isInline = cfg.backendsJson.trim().startsWith("[");
  const raw = isInline ? cfg.backendsJson : await Bun.file(cfg.backendsJson).text();
  return JSON.parse(raw) as Backend[];
}
