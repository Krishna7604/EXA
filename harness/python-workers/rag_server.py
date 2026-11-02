"""RAG worker — exposes rag_search as MCP tool (Phase 2).

Contract: stateless. Input JSON -> output JSON. TS core owns session/approvals.
pgvector wiring lands in Phase 2b; stub returns ranked echo so e2e works offline.
"""

from __future__ import annotations

import json
import sys


def rag_search(query: str, top_k: int = 5) -> list[dict]:
    """Stub ranker — replace body with pgvector/chroma lookup in Phase 2b."""
    return [
        {"rank": i + 1, "score": round(1.0 / (i + 1), 3), "text": f"[stub] {query} :: doc {i + 1}"}
        for i in range(max(0, min(top_k, 5)))
    ]


def _serve_mcp() -> None:
    try:
        from fastmcp import FastMCP
    except ImportError:
        # Offline smoke mode: read {"tool": "rag_search", ...} from stdin, print JSON.
        # satisfies Phase 0: echo '{"tool":"rag_search"}' | uv run rag_server.py
        raw = sys.stdin.read().strip() or "{}"
        try:
            req = json.loads(raw)
        except json.JSONDecodeError:
            req = {}
        print(json.dumps(rag_search(req.get("query", req.get("tool", "smoke")), 3)))
        return
    mcp = FastMCP("rag")

    @mcp.tool()
    def rag_search_tool(query: str, top_k: int = 5) -> list[dict]:
        return rag_search(query, top_k)

    mcp.run()


if __name__ == "__main__":
    if "--smoke" in sys.argv:
        print(json.dumps(rag_search("smoke", 3)))
    else:
        _serve_mcp()
