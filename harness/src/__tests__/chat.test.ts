// Chat command tests: execCommand without a TTY — /new switches files,
// messages persist to the active session, /export writes a local transcript.
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

const savedAgentModel: string | undefined = process.env.AGENT_MODEL;
const realLog = console.log;
let logs: string[] = [];

beforeEach(() => {
  logs = [];
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
  delete process.env.AGENT_MODEL;
});

afterEach(() => {
  console.log = realLog;
  if (savedAgentModel === undefined) delete process.env.AGENT_MODEL;
  else process.env.AGENT_MODEL = savedAgentModel;
});

class CaptureRenderer extends ConsoleRenderer {
  readonly items: Item[] = [];
  override render(item: Item): void {
    this.items.push(item);
  }
  override message(role: ChatRole, text: string, meta?: MessageMeta): void {
    this.items.push({ type: "message", role, text, meta } as Item);
  }
}

class CaptureLogger extends RunLogger {
  override async logRun(): Promise<void> {
    // record nothing — stubbed chat never hits disk
  }
}

class StubOpenRouter extends OpenRouterClient {
  override async chat(_model: string, _system: string, _messages: ChatMsg[], _max: number) {
    return { text: "stub reply", ms: 1, usage: { inputTokens: 3, outputTokens: 2 } };
  }
}

async function chatApp(): Promise<{ app: CliApp; dir: string; sessions: SessionManager; session: SessionStore }> {
  const dir = await mkdtemp(join(tmpdir(), "exa-chat-"));
  return { ...(await chatAppIn(dir)), dir };
}

async function chatAppIn(dir: string): Promise<{ app: CliApp; sessions: SessionManager; session: SessionStore }> {
  const env = { OPENROUTER_API_KEY: "sk-or-test" } as NodeJS.ProcessEnv;
  const catalog = new ProviderCatalog();
  const keystore = new Keystore(env, catalog);
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
    logger: new CaptureLogger(keystore),
  });
  const app = new CliApp({ agent, router, keystore, openrouter, config: { model: "openai/gpt-5-mini" }, sessions, session, renderer: new ConsoleRenderer({ color: false }) }, []);
  await app.openSession({ resume: false, chat: false });
  return { app, sessions, session };
}

describe("chat commands", () => {
  test("/exit quits, unknown slash lists commands, text chats", async () => {
    const { app, dir } = await chatApp();
    try {
      expect(await app.execCommand("/exit")).toBe("exit");
      expect(await app.execCommand("/bogus")).toBe("continue");
      expect(logs.join("\n")).toContain("unknown command");
      expect(await app.execCommand("hello chat")).toBe("continue");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("resuming replays the old chat before going live", async () => {
    const dir = await mkdtemp(join(tmpdir(), "exa-chat-"));
    try {
      const first = await chatAppIn(dir);
      await first.app.execCommand("remember this line");
      const id = (await first.sessions.list())[0].id;
      const second = await chatAppIn(dir);
      logs.length = 0;
      await second.app.openSession({ resume: false, chat: false, sessionId: id });
      const out = logs.join("\n");
      expect(out).toContain("replaying 2 earlier turns");
      expect(out).toContain("remember this line");
      expect(out).toContain("stub reply");
      expect(out).toContain("live from here");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("/resume <id> and bare /resume switch back with replay; bad id stays put", async () => {
    const dir = await mkdtemp(join(tmpdir(), "exa-chat-"));
    try {
      const first = await chatAppIn(dir);
      await first.app.execCommand("resume me please");
      const id = (await first.sessions.list())[0].id;
      const second = await chatAppIn(dir);
      await second.app.execCommand("/new");
      logs.length = 0;
      expect(await second.app.execCommand(`/resume ${id}`)).toBe("continue");
      expect(logs.join("\n")).toContain("resumed session=");
      expect(logs.join("\n")).toContain("resume me please");
      await second.app.execCommand("/new");
      logs.length = 0;
      expect(await second.app.execCommand("/resume nope-id")).toBe("continue");
      expect(logs.join("\n")).toContain('unknown session "nope-id"');
      logs.length = 0;
      expect(await second.app.execCommand("/resume")).toBe("continue");
      expect(logs.join("\n")).toContain("resumed session=");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("/sessions lists both sessions newest-first with current marked", async () => {
    const { app, dir, sessions } = await chatApp();
    try {
      const first = (await sessions.list())[0].id;
      await app.execCommand("/new");
      const second = (await sessions.list())[0].id;
      logs.length = 0;
      expect(await app.execCommand("/sessions")).toBe("continue");
      const out = logs.join("\n");
      expect(out).toContain(first);
      expect(out).toContain(second);
      expect(out).toContain(`${second} *`);
      expect(out.indexOf(second) < out.indexOf(first)).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("/new switches to a fresh file, /export writes a local transcript", async () => {
    const { app, dir, session } = await chatApp();
    try {
      const first = session.getFile();
      await app.execCommand("first message");
      expect(await app.execCommand("/new")).toBe("continue");
      expect(session.getFile()).not.toBe(first);
      await app.execCommand("second session says hi");
      expect(await app.execCommand("/export")).toBe("continue");
      const md = await readFile(join(dir, `${session.getFile().split("/").pop()?.replace(".jsonl", "")}.md`), "utf8");
      expect(md).toContain("second session says hi");
      expect(md).not.toContain("first message");
      expect(logs.join("\n")).toContain("exported 2 turns");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
