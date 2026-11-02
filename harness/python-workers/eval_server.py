"""Eval worker — exposes rerank as MCP tool (Phase 2).

Contract: stateless. TS core passes {query, docs} -> gets ranked docs back.
Real cross-encoder rerank lands in Phase 5 with eval set.
"""

from __future__ import annotations


def rerank(query: str, docs: list[str]) -> list[dict]:
    scored = sorted(
        ({"text": d, "score": len(set(query.lower().split()) & set(d.lower().split()))} for d in docs),
        key=lambda r: r["score"],
        reverse=True,
    )
    return [{"rank": i + 1, **r} for i, r in enumerate(scored)]


def _serve_mcp() -> None:
    from fastmcp import FastMCP

    mcp = FastMCP("evals")

    @mcp.tool()
    def rerank_tool(query: str, docs: list[str]) -> list[dict]:
        return rerank(query, docs)

    mcp.run()


if __name__ == "__main__":
    _serve_mcp()
