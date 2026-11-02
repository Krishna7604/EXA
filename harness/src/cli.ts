// CLI entry — one-shot `-p` plus an interactive chat REPL.
// Sessions: one file per launch in work/sessions/ (local only). /new starts
// another, --resume/--session pick up an old one, /export writes a transcript.
// Provider setup: /providers lists, /add-key stores, /models shows pricing,
// /use switches, /setup runs the guided wizard.
import { createInterface } from "node:readline/promises";
import { writeFile } from "node:fs/promises";
import configJson from "../agent.config.json";
import { ServiceContainer } from "./container.js";
import type { SessionInfo } from "./memory/types.js";
import type { CliDeps, HarnessConfig } from "./types.js";
import { formatModelPrice, modelsFor, type CuratedModel } from "./router/model-catalog.js";
import { envFilePath, saveKeysToEnvFile } from "./router/envfile.js";
import type { ProviderId } from "./router/types.js";

interface CliOptions {
  prompt?: string;
  resume: boolean;
  sessionId?: string;
  chat: boolean;
}

export type AskFn = (prompt: string) => Promise<string>;

/** Slash commands with Tab completion in the REPL. */
export const SLASH_COMMANDS = [
  "/model",
  "/jev",
  "/keys",
  "/providers",
  "/add-key",
  "/models",
  "/use",
  "/setup",
  "/new",
  "/resume",
  "/sessions",
  "/export",
  "/exit",
  "/quit",
];

/** Readline completer — completes /commands, leaves chat text alone. */
export function completeSlash(line: string): [string[], string] {
  if (!line.startsWith("/")) return [[], line];
  return [SLASH_COMMANDS.filter((c) => c.startsWith(line)), line];
}

function parseArgv(argv: string[]): CliOptions {
  const opts: CliOptions = { resume: false, chat: false };
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-p" && i + 1 < argv.length) {
      opts.prompt = argv[++i];
    } else if (a === "--resume") {
      opts.resume = true;
    } else if (a === "--session" && i + 1 < argv.length) {
      opts.sessionId = argv[++i];
    } else if (a === "--chat") {
      opts.chat = true;
    } else {
      rest.push(a);
    }
  }
  if (opts.prompt === undefined && rest.length > 0) opts.prompt = rest.join(" ");
  return opts;
}

interface DisplayModel {
  slug: string;
  label: string;
  inputPerMtok: number | null;
  outputPerMtok: number | null;
}

export class CliApp {
  private current: SessionInfo | null = null;
  private lastModels: DisplayModel[] = [];

  constructor(
    private readonly deps: CliDeps,
    private readonly argv: string[],
  ) {}

  private showKeys(): void {
    const status = this.deps.keystore.keyStatus();
    console.log("provider keys (.env presence, values never shown):");
    for (const [id, ok] of Object.entries(status)) console.log(`  ${ok ? "set" : "---"}  ${id}`);
    console.log("Setup: /providers to pick, /add-key <provider> <key> to store, or /setup for the guided flow.");
  }

  private printRoute(): void {
    const { router, config } = this.deps;
    const model = process.env.AGENT_MODEL ?? config.model;
    let route = model;
    try {
      route = router.describeRoute(router.resolveRoute(model));
    } catch (e) {
      route = `${model} (no key yet: ${(e as Error).message.split(".")[0]})`;
    }
    console.log(`route=${route} maxSteps=${config.maxSteps} maxCost=${config.maxCost}`);
  }

  /** Numbered provider list with key presence + current-model marker. */
  private showProviders(): void {
    // Catalog order is the source of truth — keyStatus preserves it.
    const status = this.deps.keystore.keyStatus();
    const ids = Object.keys(status) as ProviderId[];
    const current = process.env.AGENT_MODEL ?? this.deps.config.model;
    console.log("providers (pick with /use <provider> or /setup):");
    ids.forEach((id, i) => {
      const mark = current.startsWith(`${id}/`) || (id === "openrouter" && !current.includes("/")) ? " *" : "";
      console.log(`  ${i + 1}. ${id}${mark} · ${status[id] ? "key set" : "no key"} · env ${this.deps.keystore.primaryEnvVar(id)}`);
    });
    console.log("Add a key: /add-key <provider> <key>  — then /models <provider> to see pricing.");
  }

  private resolveProviderToken(token: string): ProviderId | null {
    const status = this.deps.keystore.keyStatus();
    const ids = Object.keys(status) as ProviderId[];
    const t = token.trim().toLowerCase();
    if (/^\d+$/.test(t)) {
      const n = Number(t);
      return ids[n - 1] ?? null;
    }
    return ids.find((id) => id.toLowerCase() === t) ?? null;
  }

  private async persistKey(provider: ProviderId, value: string): Promise<void> {
    const envVar = this.deps.keystore.setKey(provider, value);
    process.env[envVar] = value;
    try {
      await saveKeysToEnvFile(envFilePath(), { [envVar]: value });
      console.log(`saved ${provider} key to ${envFilePath()} (${envVar}=***).`);
    } catch (e) {
      console.log(`key set for this run only — could not write ${envFilePath()}: ${(e as Error).message}`);
    }
  }

  private async persistModel(slug: string): Promise<void> {
    process.env.AGENT_MODEL = slug;
    this.deps.config.model = slug;
    try {
      await saveKeysToEnvFile(envFilePath(), { AGENT_MODEL: slug });
    } catch {
      // in-memory selection still applies for this run
    }
    try {
      console.log(`using ${this.deps.router.describeRoute(this.deps.router.resolveRoute(slug))}`);
    } catch (e) {
      console.log(`selected ${slug} — ${(e as Error).message.split(".")[0]}. Add the key with /add-key.`);
    }
  }

  /** /add-key <provider> [key] — key never echoed. */
  private async addKeyCommand(args: string, ask?: AskFn): Promise<void> {
    const [provTok, ...keyParts] = args.split(/\s+/).filter(Boolean);
    if (!provTok) {
      console.log("usage: /add-key <provider> <key>  — e.g. /add-key openrouter sk-or-...");
      this.showProviders();
      return;
    }
    const provider = this.resolveProviderToken(provTok);
    if (!provider) {
      console.log(`unknown provider "${provTok}".`);
      this.showProviders();
      return;
    }
    let key = keyParts.join(" ").trim();
    if (!key && ask) key = (await ask(`paste ${provider} key (input visible, never logged): `)).trim();
    if (!key) {
      console.log(`usage: /add-key ${provider} <key>`);
      return;
    }
    await this.persistKey(provider, key);
    console.log(`key set for ${provider} — values never shown. Next: /models ${provider}`);
  }

  /** /models [provider|all] — live OpenRouter pricing when possible, else curated. */
  private async listModelsCommand(arg: string): Promise<void> {
    const token = arg.trim().toLowerCase() || "openrouter";
    const provider: string = token === "all" ? "all" : token;
    let models: DisplayModel[] = [];

    if ((provider === "openrouter" || provider === "all") && this.deps.keystore.hasKey("openrouter")) {
      try {
        const live = await this.deps.openrouter.listModels();
        const rows = provider === "all" ? live : live;
        models = rows.slice(0, 40).map((m) => ({
          slug: m.id,
          label: m.name,
          inputPerMtok: m.promptPerMtok,
          outputPerMtok: m.completionPerMtok,
        }));
        console.log(`models (live OpenRouter, showing ${models.length} — /use <n|slug>):`);
      } catch (e) {
        console.log(`live catalog failed (${(e as Error).message.split(":")[0]}) — curated fallback:`);
      }
    }
    if (models.length === 0) {
      const curated: CuratedModel[] = modelsFor(provider === "all" ? "all" : provider);
      const fallback = curated.length > 0 ? curated : modelsFor("all");
      models = fallback.map((m) => ({ slug: m.slug, label: m.label, inputPerMtok: m.inputPerMtok, outputPerMtok: m.outputPerMtok }));
      console.log(`models (curated pricing, ${provider} — /use <n|slug>):`);
    }
    this.lastModels = models;
    models.forEach((m, i) => {
      console.log(`  ${i + 1}. ${m.slug} — ${m.label} · ${formatModelPrice(m)}`);
    });
    console.log("select: /use <number|slug>  — e.g. /use 3 or /use openai/gpt-5-mini");
  }

  /** /use <number|provider|slug> — number picks from the last /models list. */
  private async useCommand(arg: string, ask?: AskFn): Promise<void> {
    let sel = arg.trim();
    if (!sel && ask) sel = (await ask("use which model (number from /models, or slug)? ")).trim();
    if (!sel) {
      console.log("usage: /use <number|slug> — run /models first, then /use 3");
      return;
    }
    if (/^\d+$/.test(sel)) {
      const m = this.lastModels[Number(sel) - 1];
      if (!m) {
        console.log(`no model #${sel} — run /models first.`);
        return;
      }
      await this.persistModel(m.slug);
      return;
    }
    const maybeProvider = this.resolveProviderToken(sel);
    if (maybeProvider) {
      // Bare provider -> show its models instead of guessing a slug.
      await this.listModelsCommand(maybeProvider);
      return;
    }
    await this.persistModel(sel);
  }

  /** Guided wizard: provider -> key -> models+cost -> select. */
  async setupWizard(ask: AskFn): Promise<void> {
    this.showProviders();
    const provAns = (await ask("provider [number/id, default openrouter]: ")).trim() || "openrouter";
    const provider = this.resolveProviderToken(provAns);
    if (!provider) {
      console.log(`unknown provider "${provAns}".`);
      return;
    }
    if (!this.deps.keystore.hasKey(provider)) {
      const key = (await ask(`paste ${provider} key (input visible, never logged — Enter to skip): `)).trim();
      if (key) await this.persistKey(provider, key);
      else console.log(`skipped — ${provider} stays keyless (curated pricing only).`);
    } else {
      console.log(`${provider} key already set.`);
    }
    await this.listModelsCommand(provider);
    const pick = (await ask("model [number/slug]: ")).trim();
    if (!pick) {
      console.log("no selection — run /use <n|slug> anytime.");
      return;
    }
    await this.useCommand(pick);
  }

  /** Open (or resume) the session for this launch and point the store at it. */
  async openSession(opts: CliOptions): Promise<SessionInfo> {
    const { sessions, session } = this.deps;
    let info: SessionInfo;
    if (opts.sessionId) {
      info = await sessions.info(opts.sessionId);
    } else if (opts.resume) {
      info = (await sessions.latest()) ?? (await sessions.create());
    } else {
      info = await sessions.create();
    }
    session.setFile(info.file);
    this.current = info;
    console.log(`session=${info.id} turns=${info.turns} file=${info.file}`);
    await this.replay();
    return info;
  }

  /** Print the active session's earlier turns (if any) before going live. */
  private async replay(): Promise<void> {
    const { agent, renderer } = this.deps;
    if ((this.current?.turns ?? 0) === 0) return;
    renderer.info(`--- replaying ${this.current?.turns} earlier turns ---`);
    for (const t of await agent.resumeSession()) {
      if (typeof t.text !== "string") continue;
      if (t.role === "user") {
        renderer.message("user", t.text);
      } else if (t.role === "agent") {
        renderer.message("agent", t.text, {
          model: typeof t.model === "string" ? t.model : undefined,
          ms: typeof t.ms === "number" ? t.ms : undefined,
        });
      }
    }
    renderer.info("--- live from here ---");
  }

  /** One input line. Returns "exit" only for /exit|/quit. Testable without a TTY. */
  async execCommand(line: string, ask?: AskFn): Promise<"continue" | "exit"> {
    const { agent, router, sessions, session } = this.deps;
    if (line === "/exit" || line === "/quit") return "exit";
    if (line === "/model") {
      this.printRoute();
      const model = process.env.AGENT_MODEL ?? this.deps.config.model;
      try {
        console.log(`route: ${this.deps.router.describeRoute(this.deps.router.resolveRoute(model))}`);
      } catch {
        // printRoute already showed the no-key hint
      }
      console.log(`fallbacks: ${router.fallbacks().join(", ")}`);
      return "continue";
    }
    if (line === "/jev" || line.startsWith("/jev ")) {
      const prompt = line === "/jev" ? "hello" : line.slice("/jev".length).trim();
      const jev = this.deps.jev;
      if (!jev || !jev.isAvailable()) {
        console.log("jev needs an OpenRouter key — /add-key openrouter <key> first.");
        return "continue";
      }
      try {
        const r = await jev.decide(prompt, {
          effort: {
            type: "choice",
            instructions: "How much reasoning does this request need?",
            criteria: { trivial: "greetings, one-line facts", heavy: "coding, debugging, planning" },
          },
        });
        console.log(`jev(${r.model}): effort=${r.answers.effort?.choice} conf=${(r.answers.effort?.confidence ?? 0).toFixed(2)} cost=${r.costUsd ?? "n/a"}`);
      } catch (e) {
        console.log(`jev error: ${(e as Error).message}`);
      }
      return "continue";
    }
    if (line === "/keys") {
      this.showKeys();
      return "continue";
    }
    if (line === "/providers") {
      this.showProviders();
      return "continue";
    }
    if (line === "/add-key" || line.startsWith("/add-key ")) {
      await this.addKeyCommand(line.slice("/add-key".length).trim(), ask);
      return "continue";
    }
    if (line === "/models" || line.startsWith("/models ")) {
      await this.listModelsCommand(line.slice("/models".length).trim());
      return "continue";
    }
    if (line === "/use" || line.startsWith("/use ")) {
      await this.useCommand(line.slice("/use".length).trim(), ask);
      return "continue";
    }
    if (line === "/setup") {
      if (!ask) {
        console.log("run /setup inside the chat REPL — or stepwise: /providers, /add-key <p> <k>, /models <p>, /use <n>.");
        return "continue";
      }
      await this.setupWizard(ask);
      return "continue";
    }
    if (line === "/new") {
      const info = await sessions.create();
      session.setFile(info.file);
      this.current = info;
      console.log(`session=${info.id} (fresh) file=${info.file}`);
      return "continue";
    }
    if (line === "/resume" || line.startsWith("/resume ")) {
      const id = line.slice("/resume".length).trim();
      let info: SessionInfo | null = null;
      if (id) {
        try {
          info = await sessions.info(id);
        } catch {
          info = null;
        }
        if (!info) {
          console.log(`unknown session "${id}" — see /sessions for ids.`);
          return "continue";
        }
      } else {
        info = await sessions.latest();
        if (!info) {
          console.log("no sessions yet — you are on a fresh one.");
          return "continue";
        }
      }
      session.setFile(info.file);
      this.current = info;
      console.log(`resumed session=${info.id} turns=${info.turns} file=${info.file}`);
      await this.replay();
      return "continue";
    }
    if (line === "/sessions") {
      const all = await sessions.list();
      if (all.length === 0) {
        console.log("no sessions yet.");
        return "continue";
      }
      console.log("sessions (newest first) — resume with `--session <id>` or `--resume`:");
      for (const s of all) {
        const mark = s.id === this.current?.id ? " *" : "";
        console.log(`  ${s.id}${mark} · ${s.turns} turns · ${new Date(s.mtimeMs).toLocaleString()}`);
      }
      return "continue";
    }
    if (line === "/export") {
      const id = this.current?.id ?? "session";
      const turns = await agent.resumeSession();
      const md = [`# session ${id}`, ""];
      for (const t of turns) {
        const role = typeof t.role === "string" ? t.role : "unknown";
        const text = typeof t.text === "string" ? t.text : "";
        md.push(`## ${role}`, "", text, "");
      }
      const out = sessions.exportFileFor(id);
      await writeFile(out, md.join("\n"), "utf8");
      console.log(`exported ${turns.length} turns -> ${out}`);
      return "continue";
    }
    if (line.startsWith("/")) {
      console.log("unknown command. Commands: /model /keys /providers /add-key /models /use /setup /new /resume /sessions /export /exit");
      return "continue";
    }
    const correlationId = `run-${Date.now().toString(36)}`;
    try {
      await agent.runAgent(line, correlationId);
    } catch (e) {
      console.error(`error: ${(e as Error).message.split("\n")[0]}`);
    }
    return "continue";
  }

  private async repl(): Promise<void> {
    const { renderer } = this.deps;
    const id = this.current?.id ?? "session";
    renderer.welcome("v0.4.0 · BYOK Bedrock-first + OpenRouter");
    console.log(`chat on ${id} — type /exit to quit. Commands: /model /keys /providers /add-key /models /use /setup /new /resume /sessions /export /exit`);
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: process.stdin.isTTY ?? false,
      completer: completeSlash,
    });
    const ask: AskFn = (prompt) => rl.question(prompt);
    let alive = true;
    rl.on("close", () => {
      alive = false;
    });
    try {
      while (alive) {
        let raw: string;
        try {
          raw = await rl.question(renderer.chatPrompt(id));
        } catch {
          break; // EOF on a pipe
        }
        const line = raw.trim();
        if (!line) continue;
        const action = await this.execCommand(line, ask);
        if (action === "exit") break;
      }
    } finally {
      rl.close();
    }
    this.deps.renderer.info("bye — session saved locally. `--resume` to pick it back up.");
  }

  async run(): Promise<void> {
    console.log("exa-harness v0.4.0 (BYOK multi-provider, Bedrock first)");
    const opts = parseArgv(this.argv);
    try {
      await this.openSession(opts);
    } catch {
      console.log(`unknown session "${opts.sessionId}" — no such file.`);
      const ids = (await this.deps.sessions.list()).map((s) => s.id);
      console.log(ids.length > 0 ? `available: ${ids.join(", ")}` : "no sessions yet — drop the flag to start fresh.");
      return;
    }
    this.printRoute();
    if (opts.prompt) {
      await this.execCommand(opts.prompt);
      return;
    }
    if (opts.chat || process.stdin.isTTY) {
      await this.repl();
      return;
    }
    console.log('Usage: bun run start [--chat] [--resume|--session <id>] [-p "message"]');
    console.log("No prompt and no TTY — nothing to do. Commands: /model /keys /providers /models /use /setup /new /export /exit");
    this.showKeys();
  }
}

async function main(): Promise<void> {
  const container = ServiceContainer.create();
  const app = new CliApp(
    {
      agent: container.agent,
      router: container.router,
      keystore: container.keystore,
      openrouter: container.openrouter,
      jev: container.jev,
      config: configJson as HarnessConfig,
      sessions: container.sessions,
      session: container.session,
      renderer: container.renderer,
    },
    process.argv.slice(2),
  );
  await app.run();
}

if (import.meta.main) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
