# Language Choice & Hybrid TS + Python

Date: 2026-09-18
Source: Q - what language will be good and how / which has better community support / can we mix?

## TL;DR
- **Ship full harness in TypeScript + Bun.** Best community for harness engineering.
- **Use Python as workers** for RAG / evals / data, called from TS via MCP or HTTP.
- You CAN mix - this is the recommended prod pattern, not either/or.

## 1. Which language has better community support?

### TypeScript wins for harness (loop + ship)
- Loop / Tools / Hooks / Sub-agents / TUI / Router: TS clear winner.
  Examples: Claude Code, Codex CLI, pi-mono, OpenRouter Agent SDK `callModel`, Vercel AI SDK, `create-agent-tui` / `create-headless-agent` skills are all TS/Bun.
- TUI/CLI libs: Ink, Commander, streaming, Zod validation - TS only.
- Router/Gateway prod: Portkey, Orq, Vercel Gateway (TS). LiteLLM proxy (Python) is the exception.
- MCP client/harness examples skew TS in 2025-2026.

### Python wins for data slice
- Memory / RAG / Vector / Evals: LangChain, LangGraph, LlamaIndex, SmolAgents, pandas, notebooks, pgvector examples.
- Research benchmarks, academic code, StackOverflow ML volume.

### Verdict
- Python = bigger overall ML community.
- TypeScript = bigger harness-engineering community.
- For all 6 blocks together as one shippable product: **TypeScript**.

## 2. Why CAN we do part TS + part Python? How.

Yes. Don't pick one. Use TS as orchestrator, Python as specialist.

```
[ TS Core - orchestrator ]
  agent.ts (callModel loop)
  tools/, hooks.ts, router.ts, TUI
    |
    |-- MCP stdio --> [ Python Worker 1: RAG search ]
    |-- MCP stdio --> [ Python Worker 2: evals / rerank ]
    |-- HTTP -------> [ Python API: embeddings, pandas ]
    |-- spawn ------> [ Python sub-agent for data task ]
```

TS stays in control of state, approvals, cost, fallback. Python just does its job and returns JSON.

### Option A: MCP server (best)
```json
// mcp.json (read by TS harness)
{
  "servers": [
    {"name":"rag-py","cmd":"uv run python-workers/rag_server.py"},
    {"name":"evals-py","cmd":"uv run python-workers/eval_server.py"}
  ]
}
```
```python
# python-workers/rag_server.py
from mcp.server.fastmcp import FastMCP
mcp = FastMCP("rag")
@mcp.tool()
def rag_search(query: str) -> str:
    return search_pgvector(query)
mcp.run()
```
TS auto-discovers `rag_search` as a tool, no custom glue. Same auth/logging/hooks apply.

### Option B: HTTP microservice
TS `fetch("http://localhost:8000/rerank", {query, docs})` -> Python FastAPI. Good if Python team already has API.

### Option C: Sub-agent delegation
TS main agent spawns `python eval_agent.py --prompt "..."` for isolated data job, merges result.

## 3. Recommended split

Keep in TS:
- agent loop, instructions composition, session.jsonl, compaction, hooks/approvals, router/fallback, observability, TUI/CLI/API.

Move to Python when:
- need LangChain/LlamaIndex, heavy pandas/numpy, custom embeddings/rerank, notebook experimentation, existing Python codebase.

```
my-harness/
  src/ (TS - core)
  python-workers/
    pyproject.toml + uv.lock
    rag_server.py (MCP)
    eval_server.py (MCP)
  mcp.json
```

## 4. Costs of hybrid (when NOT to do it)
- Two toolchains: `bun + uv`, two Docker layers, two test suites.
- Debugging crosses process boundary (log correlation IDs needed).
- Latency: stdio/HTTP hop ~5-50ms - fine for RAG, bad for tight loop tool called 100x.

Rule: start 100% TS. Extract to Python only when you hit a library that is Python-only or 10x better. Most teams end at 80% TS / 20% Python.
