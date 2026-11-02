# Ideal AI Harness System - Full Architecture with Examples

Date: 2026-09-16
Source discussion: "i want build the ai harness with entire system of harness, with all the component that have the in the ideal harness should have"

Goal: production-ready harness you can ship as product or internal platform.

## High-level Diagram

```
User Prompt
    |
[ Instructions ] -> system prompt + CLAUDE.md / AGENTS.md
    |
[ Agent Loop ] <-> [ AI Router -> LLM 1 / 2 / 3 ]
    |                 ^ picks model by cost/latency/quality
    |---> [ Tools ] + [ MCP Servers ]
    |---> [ Memory + State ]
    |---> [ Skills ]
    |---> [ Hooks ] -> approve / deny / log / redact
    |---> [ Sub-Agents ] -> parallel delegation
    |
[ Observability / Eval ]
```

Patterns drawn from: pi-mono coding agent, Claude Code, Codex CLI.

## Project Scaffold

```
my-harness/
  CLAUDE.md              # 1. Instructions
  agent.config.json      # defaults + model + limits
  mcp.json               # 3. MCP Servers
  src/
    agent.ts             # loop (inner layer)
    renderer.ts          # TUI / output
    tools/               # 2. Tools
      read.ts write.ts edit.ts glob.ts grep.ts shell.ts
      websearch.ts datetime.ts
    memory/              # 4. Memory + State
      session.jsonl compaction.ts vector.ts
    skills/              # 5. Skills
      pdf-expert/SKILL.md
      coding/SKILL.md
    hooks.ts             # 6a. Hooks
    subagents.ts         # 6b. Sub-Agents
    router.ts            # model routing + fallback
    observability.ts     # logging / cost / trace
```

## 1. Agent Loop (core - don't hand-roll)

Use SDK: OpenRouter Agent SDK `callModel`, Anthropic SDK, LangGraph, etc.

```ts
// src/agent.ts
import { OpenRouter } from '@openrouter/agent';
import type { Item } from '@openrouter/agent';
import { stepCountIs, maxCost } from '@openrouter/agent';
import { tools } from './tools/index.js';

const client = new OpenRouter({ apiKey: process.env.KEY });

const result = client.callModel({
  model: config.model, // e.g. "anthropic/claude-opus" or "router:auto"
  instructions: config.systemPrompt,
  input: userMessage,
  tools,
  stopWhen: [stepCountIs(50), maxCost(1.0)]
});

for await (const item of result.getItemsStream()) {
  render(item); // message | function_call | function_call_output | reasoning
}
```

Handles: model call -> tool parse -> zod validate -> execute -> feed back -> repeat until stop.

TUI vs Headless:
- TUI: REPL + customizable banners, tool display (emoji/grouped/minimal), input styles, loaders, slash commands `/model /new /export`
- Headless: CLI `--prompt`, stdin pipe, NDJSON output, `--output-schema` JSON Schema validation via Ajv, HTTP server / queue worker template

## 2. Instructions

`CLAUDE.md` in repo root, auto-loaded:

```md
# Identity: You are backend coding agent
# Rules: use pnpm, strict TS, no any, run `pnpm test` before done
# Style: conventional commits, small diffs
```

Composition: static (file) + dynamic (git status, pwd, date) -> systemPrompt.

## 3. Tools

One file per tool with Zod schema:

```ts
// src/tools/shell.ts
tool({
  name: "shell",
  description: "run command",
  schema: z.object({ cmd: z.string() }),
  execute: async ({cmd}) => exec(cmd),
  metadata: { readonly: false, destructive: true }
})
```

Include:
- Local: read, write, edit, glob, grep, shell
- Server: `serverTool({ type: 'openrouter:web_search' })` - zero client code, executed server-side
- Enterprise connectors: salesforce_update, jira_create, postgres_query

Flag tools: `readonly` vs `destructive` (Claude Code pattern) for approval gates.

## 4. MCP Servers

```json
// mcp.json
{
  "servers": [
    {"name":"github","cmd":"npx @modelcontextprotocol/server-github"},
    {"name":"postgres","cmd":"npx mcp-server-postgres $DB_URL"}
  ]
}
```

## 5. Memory + State

- `session.jsonl` - every message persisted, reloadable as `Item[]` to resume
- `./work/` - working FS for artifacts
- sqlite / pgvector - persistent facts across sessions
- `compaction.ts` - when >80% context, summarize old turns, keep key points, discard detail
- State: current plan, todo list, progress tracker

Config layers (Codex CLI pattern):
defaults < `agent.config.json` < ENV (`AGENT_MODEL=openai/gpt-5 npm start`)

## 6. Skills

`skills/pdf-expert/SKILL.md`:
```md
---
name: pdf-expert
when: user asks about PDFs
---
Use pdftotext first, not raw read. Then...
```

Benefit: saves 5-10 exploratory calls per task, lower tokens, fewer errors, consistent quality. Share via `gh skill install`.

## 7. Hooks + Sub-Agents

```ts
// hooks.ts
onPreToolUse("shell", async (call) => {
  if (call.args.cmd.includes("rm -rf")) return deny("blocked");
  if (isDestructive(call)) return askHuman();
  log(call); return allowAndRedactPII(call);
})
```

Sub-agents:
```ts
spawnSubAgent("research codebase");
spawnSubAgent("write tests");
// main merges results
```

Enables delegation + parallel work.

## 8. Router + Prod Hardening

```ts
fallbacks: [{ model: "openai/gpt-5-mini" }, { model: "openai/gpt-5" }]
// Safe retry on 429/5xx with exponential backoff
// ONLY if no mutating tool ran yet (else throw to avoid double-execute)
```

Observability:
- tokens, cost, latency, tool trace per run
- `/export` to Markdown
- Eval harness: run benchmark set, track pass rate per harness change

## Quick Start (OpenRouter skills)

```bash
gh skill install OpenRouterTeam/skills create-agent-tui
# or
gh skill install OpenRouterTeam/skills create-headless-agent
# then tell agent what to build, then:
bun install && bun run start
# headless:
bun install && bun run src/cli.ts -m '~anthropic/claude-opus-latest' -p "What's in this repo?"
```

References:
- https://community.ibm.com/community/user/blogs/philip-dsouza/2026/07/13/why-the-ai-harness-is-now-key-to-enterprise-ai-suc
- https://openrouter.ai/blog/tutorials/create-agent-harness-with-agent-sdk
- https://github.com/OpenRouterTeam/skills
- https://github.com/badlogic/pi-mono, https://github.com/openai/codex
