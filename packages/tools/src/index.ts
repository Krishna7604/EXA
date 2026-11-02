// @exa/tools: the built-in agent tools (tools/<area>/<name>.tool.ts), MCP integration, and the
// local workspace services (env, instructions, skills, snapshots, custom agents/commands).
// Internal modules (file-content, path-suggest, git-run, config-markdown, grep-search,
// mcp transports, ...) are deliberately not re-exported.

import type { ToolSpec } from "@exa/core";
import { questionTool } from "./tools/agent/question.tool.ts";
import { skillTool } from "./tools/agent/skill.tool.ts";
import { todoTool } from "./tools/agent/todo.tool.ts";
import { editTool } from "./tools/fs/edit.tool.ts";
import { listTool } from "./tools/fs/list.tool.ts";
import { readTool } from "./tools/fs/read.tool.ts";
import { writeTool } from "./tools/fs/write.tool.ts";
import { applyPatchTool } from "./tools/patch/apply-patch.tool.ts";
import { globTool } from "./tools/search/glob.tool.ts";
import { grepTool } from "./tools/search/grep.tool.ts";
import { bashTool } from "./tools/shell/bash.tool.ts";
import { webfetchTool } from "./tools/web/webfetch.tool.ts";

// ---------- shared constants + helpers ----------
export * from "./constants/ignored-dirs.constants.ts";
export * from "./helpers/file-times.helper.ts";
export * from "./helpers/paths.helper.ts";
export * from "./helpers/shell-env.helper.ts";
// ---------- mcp ----------
export * from "./mcp/mcp.client.ts";
export * from "./mcp/mcp.config.ts";
export * from "./mcp/mcp.manager.ts";
export { mcpToolSpecs } from "./mcp/mcp-tools.ts";
// ---------- tools ----------
export * from "./tools/agent/question.tool.ts";
export * from "./tools/agent/skill.tool.ts";
export * from "./tools/agent/todo.tool.ts";
export * from "./tools/fs/edit.tool.ts";
export * from "./tools/fs/list.tool.ts";
export * from "./tools/fs/read.tool.ts";
export * from "./tools/fs/text-locate.ts";
export * from "./tools/fs/write.tool.ts";
export * from "./tools/patch/apply-patch.tool.ts";
export * from "./tools/patch/patch-apply.ts";
export * from "./tools/patch/patch-parse.ts";
export * from "./tools/search/glob.tool.ts";
export * from "./tools/search/grep.tool.ts";
export * from "./tools/shell/bash.tool.ts";
export * from "./tools/shell/bash-asks.ts";
export * from "./tools/shell/local-shell.ts";
export * from "./tools/web/html-to-text.ts";
export * from "./tools/web/network-guard.ts";
export * from "./tools/web/webfetch.tool.ts";
// ---------- workspace ----------
export * from "./workspace/env-detect.ts";
export * from "./workspace/frontmatter.ts";
export * from "./workspace/git-snapshots.ts";
export * from "./workspace/local-agents.ts";
export * from "./workspace/local-commands.ts";
export * from "./workspace/local-instructions.ts";
export * from "./workspace/local-skills.ts";

// ---------- builtin tool set ----------
export interface BuiltinToolOptions {
  shell?: boolean;
  web?: boolean;
  question?: boolean;
  /** Filesystem tools (read/write/edit/apply_patch/list/glob/grep). Defaults to true. */
  files?: boolean;
}

/**
 * Built-in tool set. The server sandbox drops `bash` unless an isolated runner is configured.
 * `files: false` yields a toolless-of-disk agent: it can still reason, call the web, keep todos and
 * delegate to subagents, but there is no code path that reads or writes a file.
 */
export function builtinTools(opts: BuiltinToolOptions = {}): ToolSpec[] {
  const tools: ToolSpec[] = opts.files === false ? [todoTool, skillTool] : fileTools();
  if (opts.shell !== false) tools.push(bashTool);
  if (opts.web !== false) tools.push(webfetchTool);
  if (opts.question) tools.push(questionTool);
  return tools;
}

// ---------- helpers ----------
function fileTools(): ToolSpec[] {
  return [
    readTool,
    writeTool,
    editTool,
    applyPatchTool,
    listTool,
    globTool,
    grepTool,
    todoTool,
    skillTool,
  ];
}
