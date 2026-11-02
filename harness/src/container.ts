// Service container — composition root. This is where future changes happen:
// swap a provider, memory store, or logger here and every consumer follows.
// Nothing inside src/ imports this file (one-way wiring), so there are no cycles.
// Types live in ./types.ts.
import configJson from "../agent.config.json";
import { Agent } from "./agent.js";
import { HookManager } from "./hooks.js";
import { Compactor } from "./memory/compaction.js";
import { SessionStore } from "./memory/session.js";
import { SessionManager } from "./memory/sessions.js";
import { RunLogger } from "./observability.js";
import { ConsoleRenderer } from "./renderer.js";
import { ModelRouter } from "./router.js";
import { BedrockClient } from "./router/bedrock.js";
import { Keystore } from "./router/keystore.js";
import { OpenRouterClient } from "./router/openrouter.js";
import { ProviderCatalog } from "./router/providers.js";
import { SubAgentManager } from "./subagents.js";
import { JevClient } from "./router/typesafe.js";
import { EditTool } from "./tools/edit.js";
import { GlobTool } from "./tools/glob.js";
import { GrepTool } from "./tools/grep.js";
import { ReadTool } from "./tools/read.js";
import { ShellTool } from "./tools/shell.js";
import { ToolRegistry } from "./tools/tool.js";
import { WriteTool } from "./tools/write.js";
import type { HarnessConfig } from "./types.js";

export class ServiceContainer {
  private constructor(
    public readonly config: HarnessConfig,
    public readonly catalog: ProviderCatalog,
    public readonly keystore: Keystore,
    public readonly bedrock: BedrockClient,
    public readonly openrouter: OpenRouterClient,
    public readonly jev: JevClient,
    public readonly router: ModelRouter,
    public readonly session: SessionStore,
    public readonly sessions: SessionManager,
    public readonly compactor: Compactor,
    public readonly hooks: HookManager,
    public readonly renderer: ConsoleRenderer,
    public readonly logger: RunLogger,
    public readonly subagents: SubAgentManager,
    public readonly tools: ToolRegistry,
    public readonly agent: Agent,
  ) {}

  /** Build the full graph. Pass a custom env map in tests; defaults to process.env. */
  static create(env: NodeJS.ProcessEnv = process.env): ServiceContainer {
    const config = configJson as HarnessConfig;
    const catalog = new ProviderCatalog();
    const keystore = new Keystore(env, catalog);
    const bedrock = new BedrockClient(keystore);
    const openrouter = new OpenRouterClient(keystore);
    const jev = new JevClient(keystore);
    const router = new ModelRouter(catalog, keystore, bedrock, config, jev);
    const session = new SessionStore();
    const sessions = new SessionManager();
    const compactor = new Compactor(config.compactionThreshold ?? 0.8);
    const hooks = new HookManager(jev);
    const renderer = new ConsoleRenderer();
    const logger = new RunLogger(keystore);
    const subagents = new SubAgentManager();
    const tools = new ToolRegistry([
      new ReadTool(),
      new WriteTool(),
      new EditTool(),
      new GlobTool(),
      new GrepTool(),
      new ShellTool(hooks),
    ]);
    const agent = new Agent({ config, router, session, bedrock, openrouter, renderer, logger });
    return new ServiceContainer(
      config,
      catalog,
      keystore,
      bedrock,
      openrouter,
      jev,
      router,
      session,
      sessions,
      compactor,
      hooks,
      renderer,
      logger,
      subagents,
      tools,
      agent,
    );
  }
}
