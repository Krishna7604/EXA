// Class-level tests: CliApp offline commands (/model, /keys) with injected env.
// Sessions go to an isolated tmpdir — never the real work/. Captures console.log;
// never hits the network.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CliApp, completeSlash } from "../cli.js";
import { ServiceContainer } from "../container.js";
import { SessionManager } from "../memory/sessions.js";

const savedAgentModel: string | undefined = process.env.AGENT_MODEL;
const realLog = console.log;
let logs: string[] = [];
const tmpDirs: string[] = [];

beforeEach(() => {
  logs = [];
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
  process.env.AGENT_MODEL = "openai/gpt-5-mini";
});

afterEach(async () => {
  console.log = realLog;
  if (savedAgentModel === undefined) delete process.env.AGENT_MODEL;
  else process.env.AGENT_MODEL = savedAgentModel;
  while (tmpDirs.length > 0) {
    const d = tmpDirs.pop();
    if (d) await rm(d, { recursive: true, force: true });
  }
});

function appFor(env: Record<string, string>, argv: string[]): CliApp {
  const c = ServiceContainer.create({ ...env } as NodeJS.ProcessEnv);
  const dir = join(tmpdir(), `exa-cli-${Date.now()}-${Math.floor(Math.random() * 0xffff)}`);
  tmpDirs.push(dir);
  // Repoint the container's shared session store so agent + CLI write to tmp.
  c.session.setFile(join(dir, "scratch.jsonl"));
  const sessions = new SessionManager(dir);
  return new CliApp(
    { agent: c.agent, router: c.router, keystore: c.keystore, openrouter: c.openrouter, config: c.config, sessions, session: c.session, renderer: c.renderer },
    argv,
  );
}

describe("CliApp", () => {
  test("/model prints the resolved openrouter route + fallbacks", async () => {
    await appFor({ OPENROUTER_API_KEY: "sk-or-test" }, ["-p", "/model"]).run();
    const out = logs.join("\n");
    expect(out).toContain("session=");
    expect(out).toContain("route: openai/gpt-5-mini via openrouter");
    expect(out).toContain("fallbacks:");
  });

  test("/keys shows presence only, never values", async () => {
    await appFor({ OPENROUTER_API_KEY: "sk-or-test" }, ["-p", "/keys"]).run();
    const out = logs.join("\n");
    expect(out).toContain("openrouter");
    expect(out).not.toContain("sk-or-test");
  });
});

describe("completeSlash", () => {
  test("completes /commands, leaves chat text alone", () => {
    expect(completeSlash("/")[0].sort()).toEqual(
      ["/exit", "/export", "/keys", "/model", "/jev", "/providers", "/add-key", "/models", "/use", "/setup", "/new", "/quit", "/resume", "/sessions"].sort(),
    );
    expect(completeSlash("/e")[0].sort()).toEqual(["/exit", "/export"].sort());
    expect(completeSlash("/s")[0]).toEqual(["/setup", "/sessions"]);
    expect(completeSlash("hello")[0]).toEqual([]);
  });
});
