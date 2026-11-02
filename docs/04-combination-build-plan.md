# Combination Build Plan - TS Core + Python Workers

Date: 2026-09-18
Goal: production hybrid harness. TS orchestrates, Python specializes. All knowledge stays in `exa/docs/`.

## Architecture

```
exa/
  docs/               # knowledge base (this folder)
  harness/            # code (to scaffold)
    CLAUDE.md
    agent.config.json
    mcp.json
    src/ (TS+Bun)     # loop, tools, hooks, router, TUI, observability
      agent.ts renderer.ts router.ts hooks.ts subagents.ts observability.ts
      tools/ read.ts write.ts shell.ts grep.ts websearch.ts
      memory/ session.ts compaction.ts
    python-workers/ (Python+uv) # specialists via MCP
      pyproject.toml
      rag_server.py   # pgvector search
      eval_server.py  # rerank / evals / pandas
    skills/
      coding/SKILL.md rag-expert/SKILL.md
```

Flow: `User -> TS agent.ts (callModel) -> local TS tools OR MCP -> Python worker -> return JSON -> TS merges -> hooks log/approve -> Router picks model -> Observability logs cost/latency`.

Contract: Python workers are stateless MCP tools. TS owns session, approvals, fallback, state. Correlation ID per call for tracing.

## Tech Stack (locked)
- TS: Bun, `@openrouter/agent`, `zod`, MCP TS SDK
- Python: `uv`, `fastmcp`, `fastapi` (if HTTP needed), `pgvector` / `chromadb`
- Router: OpenRouter with `fallbacks: [mini -> frontier]`, safe retry on 429/5xx only if no mutating tool ran
- Memory: `session.jsonl` + `./work/` + sqlite/pgvector later

## Phased Plan

### Phase 0 - Setup (0.5 day)
- [ ] `bun init exa/harness`, `uv init python-workers`, git init
- [ ] `agent.config.json` (model, maxSteps 50, maxCost 1.0), `CLAUDE.md` v1, `.env` (KEYS)
- [ ] Decide MVP use-case: coding agent vs RAG assistant vs headless API
- Done when: `bun run start` + `uv run pytest` both pass empty.

### Phase 1 - TS Core MVP (1-2 days)
- [ ] `src/agent.ts` loop via `callModel` + streaming renderer
- [ ] 5 tools: read, write, edit, glob/grep, shell (with readonly/destructive flags)
- [ ] `session.jsonl` persistence + `/new /model /export` commands
- [ ] `hooks.ts`: deny `rm -rf`, askHuman on destructive, log all, redact PII
- Done when: can edit files in test repo, resume session, blocked destructive cmd in demo.

### Phase 2 - Python Worker 1 (1 day)
- [ ] `rag_server.py` FastMCP with 1 tool: `rag_search(query) -> docs[]` (stub first, pgvector next)
- [ ] `eval_server.py` with `rerank(query, docs)` stub
- [ ] `uv run` stdio smoke test
- Done when: `echo '{"tool":"rag_search"}' | uv run rag_server.py` returns JSON.

### Phase 3 - MCP Wiring (0.5 day)
- [ ] `mcp.json`: `{"servers":[{"name":"rag-py","cmd":"uv run python-workers/rag_server.py"}]}`
- [ ] TS auto-discovers Python tools, same approval/logging path
- [ ] Add `SKILL.md` for when to call Python vs local (saves 5-10 calls)
- Done when: TS prompt "search docs for X" triggers Python worker end-to-end.

### Phase 4 - Memory / Skills / Sub-agents (1-2 days)
- [ ] `compaction.ts`: summarize at 80% context
- [ ] 2 skills: `coding`, `rag-expert`
- [ ] `subagents.ts`: researcher (Python RAG) + coder (TS) in parallel, main merges
- Done when: long task uses sub-agents, context stays under limit.

### Phase 5 - Router + Observability + Eval (1 day)
- [ ] `router.ts`: auto route mini->frontier + fallback + cost tracking
- [ ] `observability.ts`: log tokens/cost/latency/tool trace per run
- [ ] Eval set: 10 golden tasks, track pass rate per harness change
- Done when: dashboard shows cost saved vs all-frontier, eval passes >80%.

### Phase 6 - Harden & Ship (0.5 day)
- [ ] Dockerfile (bun + uv layers), `README` runbook, update `exa/docs/conversation-log.md`
- [ ] Safe retry rule enforced, secret redaction test
- Done when: fresh clone -> `bun install && uv sync && bun run start` works.

Total: ~5-7 days solo, MVP usable end of Phase 3 (~3 days).

## What NOT to build yet
No auth UI, no vector scaling, no multi-user, no custom gateway - use OpenRouter/Portkey until eval proves need.

## Next decision needed
1. MVP use-case?
2. TUI vs headless API?
3. Which Python worker first - RAG or evals?
