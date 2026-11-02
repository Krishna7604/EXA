// Provider picker CLI tests — /providers /add-key /models /use /setup offline.
// EXA_ENV_FILE points at a tmp file so no real .env is touched. OpenRouter
// live calls are stubbed via fetch injection on the container client.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "../agent.js";
import { CliApp } from "../cli.js";
import { SessionStore } from "../memory/session.js";
import { SessionManager } from "../memory/sessions.js";
import { RunLogger } from "../observability.js";
import { ConsoleRenderer, type ChatRole } from "../renderer.js";
import { BedrockClient } from "../router/bedrock.js";
import { Keystore } from "../router/keystore.js";
import { OpenRouterClient } from "../router/openrouter.js";
import { ProviderCatalog } from "../router/providers.js";
import { ModelRouter } from "../router.js";
import type { ChatMsg } from "../router/types.js";
import type { Item, MessageMeta } from "../types.js";

const realLog = console.log;
const realEnvFile = process.env.EXA_ENV_FILE;
const realAgentModel = process.env.AGENT_MODEL;
let logs: string[] = [];
let dir = "";
let envFile = "";

class CaptureRenderer extends ConsoleRenderer {
  readonly items: Item[] = [];
  override message(role: ChatRole, text: string, meta?: MessageMeta): void {
    this.items.push({ type: "message", role, text, meta } as Item);
  }
}

class StubOpenRouter extends OpenRouterClient {
  override async listModels(): Promise<Array<{ id: string; name: string; promptPerMtok: number | null; completionPerMtok: number | null; context: number | null }>> {
    return [
      { id: "openai/gpt-5-mini", name: "GPT-5 mini", promptPerMtok: 0.25, completionPerMtok: 2, context: 400000 },
      { id: "google/gemini-2.5-flash", name: "Flash", promptPerMtok: 0.3, completionPerMtok: 2.5, context: 1000000 },
    ];
  }
  override async chat(_m: string, _s: string, _msgs: ChatMsg[], _max: number) {
    return { text: "stub reply", ms: 1, usage: { inputTokens: 4, outputTokens: 3 } };
  }
}

async function providerApp(env: Record<string, string>): Promise<CliApp> {
  const catalog = new ProviderCatalog();
  const keystore = new Keystore({ ...env } as NodeJS.ProcessEnv, catalog);
  const bedrock = new BedrockClient(keystore);
  const openrouter = new StubOpenRouter(keystore);
  const router = new ModelRouter(catalog, keystore, bedrock, { model: "openai/gpt-5-mini" });
  const sessions = new SessionManager(dir);
  const session = new SessionStore(join(dir, "scratch.jsonl"));
  const agent = new Agent({
    config: { model: "openai/gpt-5-mini", maxSteps: 50 },
    router,
    session,
    bedrock,
    openrouter,
    renderer: new CaptureRenderer(),
    logger: new RunLogger(keystore, join(dir, "runs.jsonl")),
  });
  const app = new CliApp(
    { agent, router, keystore, openrouter, config: { model: "openai/gpt-5-mini" }, sessions, session, renderer: new ConsoleRenderer({ color: false }) },
    [],
  );
  await app.openSession({ resume: false, chat: false });
  return app;
}

beforeEach(async () => {
  logs = [];
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
  dir = await mkdtemp(join(tmpdir(), "exa-prov-"));
  envFile = join(dir, ".env");
  process.env.EXA_ENV_FILE = envFile;
  delete process.env.AGENT_MODEL;
});

afterEach(async () => {
  console.log = realLog;
  if (realEnvFile === undefined) delete process.env.EXA_ENV_FILE;
  else process.env.EXA_ENV_FILE = realEnvFile;
  if (realAgentModel === undefined) delete process.env.AGENT_MODEL;
  else process.env.AGENT_MODEL = realAgentModel;
  await rm(dir, { recursive: true, force: true });
});

describe("provider picker", () => {
  test("/providers lists with key presence", async () => {
    const app = await providerApp({ OPENROUTER_API_KEY: "sk-or-test" });
    logs.length = 0;
    await app.execCommand("/providers");
    const out = logs.join("\n");
    expect(out).toContain("openrouter");
    expect(out).toContain("key set");
    expect(out).toContain("bedrock");
  });

  test("/add-key stores without echoing + persists to env file", async () => {
    const app = await providerApp({});
    logs.length = 0;
    await app.execCommand("/add-key openrouter sk-or-secret-123");
    expect(logs.join("\n")).not.toContain("sk-or-secret-123");
    expect(process.env.OPENROUTER_API_KEY).toBe("sk-or-secret-123");
    expect(await readFile(envFile, "utf8")).toContain("OPENROUTER_API_KEY=sk-or-secret-123");
  });

  test("/models uses live list when keyed, curated fallback otherwise", async () => {
    const keyed = await providerApp({ OPENROUTER_API_KEY: "sk-or-test" });
    logs.length = 0;
    await keyed.execCommand("/models openrouter");
    expect(logs.join("\n")).toContain("live OpenRouter");
    expect(logs.join("\n")).toContain("openai/gpt-5-mini");

    const bare = await providerApp({});
    logs.length = 0;
    await bare.execCommand("/models openrouter");
    expect(logs.join("\n")).toContain("curated");
  });

  test("/use <n> picks from last /models + persists model", async () => {
    const app = await providerApp({ OPENROUTER_API_KEY: "sk-or-test" });
    await app.execCommand("/models openrouter");
    logs.length = 0;
    await app.execCommand("/use 2");
    expect(process.env.AGENT_MODEL).toBe("google/gemini-2.5-flash");
    expect(await readFile(envFile, "utf8")).toContain("AGENT_MODEL=google/gemini-2.5-flash");
    expect(logs.join("\n")).toContain("google/gemini-2.5-flash");
  });

  test("/use <slug> works directly, chat then answers via OpenRouter", async () => {
    const app = await providerApp({ OPENROUTER_API_KEY: "sk-or-test" });
    await app.execCommand("/use openai/gpt-5-mini");
    logs.length = 0;
    await app.execCommand("hello via or");
    expect(logs.join("\n")).not.toContain("sk-or-test");
  });

  test("/setup wizard: provider -> key -> model", async () => {
    const app = await providerApp({});
    const answers = ["1", "sk-or-wizard", "1"];
    let i = 0;
    logs.length = 0;
    await app.setupWizard(async () => answers[i++] ?? "");
    expect(process.env.OPENROUTER_API_KEY).toBe("sk-or-wizard");
    expect(process.env.AGENT_MODEL).toBe("openai/gpt-5-mini");
    expect(logs.join("\n")).not.toContain("sk-or-wizard");
  });
});
