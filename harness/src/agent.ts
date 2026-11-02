// exa harness — agent loop. Bedrock + OpenRouter are live inference paths.
// CONTEXT IS PROVIDER-INDEPENDENT: system prompt (CLAUDE.md) + session history
// are built once here and passed unchanged to whichever provider the router picks.
// Types live in ./types.ts and ./memory/types.ts.
import { readFile } from "node:fs/promises";
import configJson from "../agent.config.json";
import { defaultRenderer, type ConsoleRenderer } from "./renderer.js";
import { defaultRouter, type ModelRouter } from "./router.js";
import { defaultSession, type SessionStore } from "./memory/session.js";
import type { SessionTurn } from "./memory/types.js";
import { defaultBedrock, type BedrockClient } from "./router/bedrock.js";
import { defaultOpenRouter, type OpenRouterClient } from "./router/openrouter.js";
import type { ChatMsg } from "./router/types.js";
import { defaultLogger, type RunLogger } from "./observability.js";
import { estimateTokens, priceFor } from "./observability/pricing.js";
import type { AgentConfig, AgentDeps } from "./types.js";

export function historyToMessages(turns: SessionTurn[], limit = 20): ChatMsg[] {
  const out: ChatMsg[] = [];
  for (const t of turns.slice(-limit)) {
    const role = t.role === "agent" || t.role === "assistant" ? "assistant" : t.role === "user" ? "user" : null;
    const text = typeof t.text === "string" ? t.text : null;
    if (role && text) out.push({ role, text: text.slice(0, 4000) });
  }
  // Bedrock Converse requires the conversation to start with a user turn —
  // the last-N slice can otherwise begin mid-exchange as the session grows.
  while (out.length > 0 && out[0].role !== "user") out.shift();
  return out;
}

export class Agent {
  constructor(private readonly deps: AgentDeps) {}

  private async systemPrompt(): Promise<string> {
    try {
      const f = this.deps.config.systemPromptFile ?? "./CLAUDE.md";
      return await readFile(f.startsWith("./") ? f.slice(2) : f, "utf8");
    } catch {
      return "You are the exa coding agent.";
    }
  }

  async runAgent(userMessage: string, correlationId: string): Promise<{ ok: boolean; model: string; answered: boolean }> {
    const model = await this.deps.router.pickModelSmart(userMessage);
    const route = this.deps.router.resolveRoute(model); // throws with setup hint when creds missing
    const maxTokens = this.deps.config.maxTokens ?? 2048;
    const at = new Date().toLocaleTimeString();
    await this.deps.session.appendTurn({ role: "user", text: userMessage, correlationId, ts: Date.now() });
    this.deps.renderer.message("user", userMessage, { estimatedTokens: estimateTokens(userMessage), time: at });

    if (route.provider !== "bedrock" && route.provider !== "openrouter") {
      const note = this.deps.router.describeRoute(route);
      this.deps.renderer.message("agent", `ready (${note}, steps<=${this.deps.config.maxSteps}) — live inference for ${route.provider} lands in Phase 1. Use an openrouter/... slug or /providers to switch.`, {
        model,
        time: new Date().toLocaleTimeString(),
      });
      return { ok: true, model, answered: false };
    }

    const system = await this.systemPrompt();
    const messages = historyToMessages(await this.deps.session.loadSession()); // includes the turn just appended
    let attempt = 0;
    for (;;) {
      try {
        const { text, ms, usage } =
          route.provider === "bedrock"
            ? await this.deps.bedrock.converse(route.directModel, system, messages, maxTokens)
            : await this.deps.openrouter.chat(route.directModel, system, messages, maxTokens);
        const costUsd = priceFor(route.directModel, usage);
        this.deps.renderer.message("agent", text, {
          model: route.directModel,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          costUsd,
          ms,
          time: new Date().toLocaleTimeString(),
        });
        await this.deps.session.appendTurn({ role: "agent", text, correlationId, model, ms, ts: Date.now() });
        await this.deps.logger.logRun({
          correlationId,
          model,
          provider: route.provider,
          region: route.region,
          ms,
          chars: text.length,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          costUsd,
        });
        return { ok: true, model, answered: true };
      } catch (e) {
        const status = (e as { status?: number }).status ?? 0;
        if (attempt === 0 && this.deps.router.shouldRetry(status, false)) {
          attempt++;
          await new Promise((r) => setTimeout(r, 1000 * attempt));
          continue;
        }
        throw e;
      }
    }
  }

  async resumeSession(): Promise<SessionTurn[]> {
    return this.deps.session.loadSession();
  }
}

export const defaultAgent = new Agent({
  config: configJson as AgentConfig,
  router: defaultRouter,
  session: defaultSession,
  bedrock: defaultBedrock,
  openrouter: defaultOpenRouter,
  renderer: defaultRenderer,
  logger: defaultLogger,
});

export async function runAgent(
  userMessage: string,
  correlationId: string,
): Promise<{ ok: boolean; model: string; answered: boolean }> {
  return defaultAgent.runAgent(userMessage, correlationId);
}

export async function resumeSession(): Promise<SessionTurn[]> {
  return defaultAgent.resumeSession();
}
