// Class-level tests: Agent openrouter live path with a stubbed client and an
// isolated temp session file. No network — stub returns canned text+usage.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, historyToMessages } from "../agent.js";
import { SessionStore } from "../memory/session.js";
import { RunLogger } from "../observability.js";
import { ConsoleRenderer, type ChatRole } from "../renderer.js";
import type { MessageMeta } from "../types.js";
import { BedrockClient } from "../router/bedrock.js";
import { Keystore } from "../router/keystore.js";
import { OpenRouterClient } from "../router/openrouter.js";
import { ProviderCatalog } from "../router/providers.js";
import { ModelRouter } from "../router.js";
import type { ChatMsg } from "../router/types.js";

const savedAgentModel: string | undefined = process.env.AGENT_MODEL;

beforeEach(() => {
  delete process.env.AGENT_MODEL;
});

afterEach(() => {
  if (savedAgentModel === undefined) delete process.env.AGENT_MODEL;
  else process.env.AGENT_MODEL = savedAgentModel;
});

class CaptureRenderer extends ConsoleRenderer {
  readonly blocks: Array<{ role: ChatRole; text: string; meta?: MessageMeta }> = [];
  override message(role: ChatRole, text: string, meta?: MessageMeta): void {
    this.blocks.push({ role, text, meta });
  }
}

class CaptureLogger extends RunLogger {
  readonly entries: Record<string, unknown>[] = [];
  override async logRun(entry: Record<string, unknown>): Promise<void> {
    this.entries.push(entry);
  }
}

describe("historyToMessages", () => {
  test("drops leading agent turns so the conversation starts with user (Bedrock requires it)", () => {
    const msgs = historyToMessages([
      { role: "agent", text: "stale reply" },
      { role: "user", text: "hi" },
      { role: "agent", text: "hello" },
    ]);
    expect(msgs[0]).toMatchObject({ role: "user" });
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant"]);
  });

  test("maps agent->assistant, truncates long text, honors limit", () => {
    const msgs = historyToMessages(
      [
        { role: "user", text: "a" },
        { role: "agent", text: "x".repeat(5000) },
        { role: "system", text: "dropped" },
      ],
      3,
    );
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(msgs[1].text.length).toBe(4000);
    // slice with no user turn at all collapses to [] (nothing Converse-usable)
    expect(
      historyToMessages(
        [
          { role: "agent", text: "x".repeat(5000) },
          { role: "system", text: "dropped" },
        ],
        2,
      ),
    ).toEqual([]);
  });
});

describe("Agent (openrouter stub path)", () => {
  test("live openrouter call persists both turns and logs usage", async () => {
    const dir = await mkdtemp(join(tmpdir(), "exa-agent-"));
    try {
      const env = { OPENROUTER_API_KEY: "sk-or-test" } as NodeJS.ProcessEnv;
      const catalog = new ProviderCatalog();
      const keystore = new Keystore(env, catalog);
      const bedrock = new BedrockClient(keystore);
      class StubOpenRouter extends OpenRouterClient {
        override async chat(_model: string, _system: string, _messages: ChatMsg[], _max: number) {
          return { text: "stub reply", ms: 5, usage: { inputTokens: 10, outputTokens: 5 } };
        }
      }
      const openrouter = new StubOpenRouter(keystore);
      const router = new ModelRouter(catalog, keystore, bedrock, { model: "openai/gpt-5-mini" });
      const session = new SessionStore(join(dir, "session.jsonl"));
      const renderer = new CaptureRenderer();
      const logger = new CaptureLogger(keystore);
      const agent = new Agent({ config: { model: "openai/gpt-5-mini", maxSteps: 50 }, router, session, bedrock, openrouter, renderer, logger });

      const res = await agent.runAgent("hello test", "corr-1");
      expect(res).toMatchObject({ ok: true, answered: true });
      expect(renderer.blocks.length).toBe(2);
      expect(renderer.blocks[0].role).toBe("user");
      expect(renderer.blocks[0].text).toBe("hello test");
      expect(renderer.blocks[0].meta?.estimatedTokens).toBeGreaterThan(0);
      expect(renderer.blocks[1].role).toBe("agent");
      expect(renderer.blocks[1].text).toBe("stub reply");
      expect(logger.entries.length).toBe(1);
      const turns = await session.loadSession();
      expect(turns.length).toBe(2);
      expect(turns[0]).toMatchObject({ role: "user", text: "hello test", correlationId: "corr-1" });
      expect(turns[1]).toMatchObject({ role: "agent", text: "stub reply" });
      expect(await agent.resumeSession()).toEqual(turns);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
