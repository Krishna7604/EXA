// Building AgentDefs from outside sources: markdown files (agents/*.md) and stored/API specs.

import type { PermissionAction, PermissionRule, Tier } from "@exa/protocol";
import type { AgentDef } from "../models/agent.model.ts";
import { rule } from "./agent-rule.ts";

// ---------- constants ----------
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;
const PERMISSION_HEADER = /^permission:\s*$/;
const NESTED_ENTRY = /^\s+([\w-]+):\s*(.+)$/;
const TOP_LEVEL_ENTRY = /^([\w-]+):\s*(.*)$/;
const SURROUNDING_QUOTES = /^["']|["']$/g;

// ---------- agent parsing ----------
/** Parse an agent definition from markdown with YAML-ish frontmatter (agents/*.md). */
export function parseAgentMarkdown(name: string, text: string): AgentDef {
  const { fields, permission, body } = parseFrontmatter(text);
  if (!fields.description) throw new Error(`agent ${name}: description is required`);
  const rules: PermissionRule[] = [];
  for (const [key, value] of Object.entries(permission)) {
    if (isPermissionAction(value)) rules.push(rule(key, "*", value));
  }
  const mode = fields.mode === "primary" || fields.mode === "subagent" ? fields.mode : "all";
  return {
    name,
    description: fields.description,
    mode,
    hidden: fields.hidden === "true",
    prompt: body.trim(),
    rules,
    model: fields.model || undefined,
    temperature: fields.temperature ? Number(fields.temperature) : undefined,
    steps: fields.steps ? Number(fields.steps) : undefined,
    tier: parseTier(fields.tier),
  };
}

/** Build an agent from a stored/API definition (permission map → agent-layer rules). */
export function agentFromSpec(d: {
  name: string;
  description: string;
  mode: "primary" | "subagent" | "all";
  hidden?: boolean;
  prompt: string;
  permission?: Record<string, "allow" | "ask" | "deny"> | null;
  model?: string | null;
  tier?: string | null;
  temperature?: number | null;
  steps?: number | null;
}): AgentDef {
  return {
    name: d.name,
    description: d.description,
    mode: d.mode,
    hidden: !!d.hidden,
    prompt: d.prompt,
    rules: Object.entries(d.permission ?? {}).map(([k, v]) => rule(k, "*", v)),
    model: d.model ?? undefined,
    tier: parseTier(d.tier),
    temperature: d.temperature ?? undefined,
    steps: d.steps ?? undefined,
  };
}

// ---------- helpers ----------
function isPermissionAction(value: string): value is PermissionAction {
  return value === "allow" || value === "ask" || value === "deny";
}

function parseTier(value: string | null | undefined): Tier | undefined {
  return value === "fast" || value === "balanced" || value === "strong" ? value : undefined;
}

/** Splits `---` frontmatter into top-level fields, the nested `permission:` map and the body. */
function parseFrontmatter(text: string): {
  fields: Record<string, string>;
  permission: Record<string, string>;
  body: string;
} {
  const fields: Record<string, string> = {};
  const permission: Record<string, string> = {};
  const match = text.match(FRONTMATTER);
  if (!match) return { fields, permission, body: text };
  let inPermission = false;
  for (const line of match[1].split(/\r?\n/)) {
    if (PERMISSION_HEADER.test(line)) {
      inPermission = true;
      continue;
    }
    const nested = line.match(NESTED_ENTRY);
    if (inPermission && nested) {
      permission[nested[1]] = nested[2].trim();
      continue;
    }
    inPermission = false;
    const entry = line.match(TOP_LEVEL_ENTRY);
    if (entry) fields[entry[1]] = entry[2].trim().replace(SURROUNDING_QUOTES, "");
  }
  return { fields, permission, body: match[2] };
}
