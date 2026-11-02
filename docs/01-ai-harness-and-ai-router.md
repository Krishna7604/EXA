# AI Harness and AI Router - Explained

Date: 2026-09-16
Source discussion: "what is ai harness and ai router"

## 1. AI Harness

The scaffolding around an LLM that turns it from a chat model into an agent.

Model alone = raw reasoning / brain. No eyes, no hands, no memory, no guardrails.
Harness = instructions + tools + memory + skills + sub-agents + safety hooks to direct that power to do work.

Quote: "The agent is actually the harness." - Praveen Akkiraju, Insight Partners.

Evidence it matters:
- Claude Opus 4.5 on CORE-Bench: 78% in Claude Code harness vs 42% in SmolAgents harness (-36 pts).
- Stanford / Tsinghua: same model, different harness = up to 6x variance.

### Six building blocks (IBM 2026 consensus)

1. **Instructions** - identity + rules. e.g. `CLAUDE.md`, `GEMINI.md` in repo root with codebase rules, style, build commands. Auto-loaded into context.
2. **Tools** - hands. Native: file read/write, bash, web search. Enterprise: CRM, ERP, ticketing connectors, DB query, API calls.
3. **MCP Servers** - standard way to connect agents to external systems. Exposes tools/data/resources via common interface any MCP-compatible agent understands. Avoids custom integration per model/app.
4. **Memory and State** - recall. Session memory (single conversation), persistent memory (across sessions), working FS (files/outputs). Plus state tracking (what step am I on). Uses compaction/summarization to save context window.
5. **Skills** - domain expertise / reusable instructions. How to use which tools for a specific task. Codify expert knowledge once, reuse across agents. Reduces exploratory calls, tokens, errors.
6. **Hooks and Sub-Agents** - safety + scale. Hooks intercept tool calls to log / approve / modify / block / redact. Sub-agents delegate parallel subtasks (researcher, analyzer, writer) then main agent merges.

Gartner forecast: by end 2026, 40% of enterprise apps will have task-specific AI agents. Harness quality = competitive advantage.

## 2. AI Router

Layer between app and multiple LLMs that picks which model serves each request.

```
App -> AI Router -> OpenAI / Anthropic / Google / Mistral / DeepSeek / xAI / Meta / Groq
```

Routes on:
- cost (simple -> mini/cheap, hard -> frontier)
- latency, quality, region, business rules (e.g. CEL expressions)
- availability + fallback / retry

Provides:
- One OpenAI-compatible API endpoint, swap models with string change
- Dashboard: token spend, cost, latency, fallback attempts
- A/B testing, caching, load balancing, BYOK (bring your own keys), governance

Examples 2026:
- OpenRouter (broadest catalog), Portkey, LiteLLM (self-hosted), Vercel AI Gateway
- Inworld Router (220+ 3P + 1P optimized, voice-aware, CEL conditional routing)
- Orq.ai Router, AI Router (airouter.io), Ramp Router (fintech, free 2026 + $26 credit)
- MAIA Router

Gateway vs Router: gateway = unified access + failover. Router = + intelligent selection. Most modern tools do both.

Note: "AI Router" hardware also exists (e.g. ZTE Tianyi Home AI Router WiFi-7 with AI agent for diagnostics), but in software context it means LLM routing above.
