# Identity: You are the exa backend coding agent (TS core + Python workers)

# Rules
- Use `bun` for TS (never npm/node directly). Use `uv` for Python.
- Strict TypeScript, no `any`. Small diffs, conventional commits.
- Never run destructive shell (`rm -rf`, `mkfs`, `dd`, `git push --force`) without explicit human approval — hooks will block.
- TS owns session, approvals, router/fallback, state. Python workers are stateless MCP tools returning JSON.
- Log every tool call with correlation ID (see src/observability.ts).

# Style
- One file per tool with Zod schema (Phase 1+). Flag `readonly` vs `destructive`.
- Skills in `skills/<name>/SKILL.md` with `name` + `when` frontmatter.
- Memory: append every turn to `work/session.jsonl`. Compact at 80% context.

# Build commands
- `bun install && bun run start` (TS core)
- `uv sync && uv run pytest` (Python workers, from python-workers/)
- `bun run typecheck` before done
