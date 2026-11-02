// Sidebar: the session list and the model picker's options.

import { $, el } from "../helpers/dom.helper.js";
import { api } from "../services/api.service.js";
import { state } from "../state.js";

// ---------- constants ----------
const SESSION_LIST_LIMIT = 60;
/** Model offered for each provider the user has a key (or org pool) for. */
const PROVIDER_DEFAULT_MODELS = {
  anthropic: "anthropic/claude-sonnet-4-5",
  openai: "openai/gpt-5",
  openrouter: "openrouter/anthropic/claude-sonnet-4.5",
  google: "google/gemini-2.5-pro",
  groq: "groq/llama-3.3-70b-versatile",
  deepseek: "deepseek/deepseek-chat",
  xai: "xai/grok-4",
  mistral: "mistral/mistral-large-latest",
  bedrock: "bedrock/us.anthropic.claude-sonnet-4-5-20250929-v1:0",
};

// ---------- sidebar view ----------
export function fillModelSelect() {
  const sel = $("#model-select");
  sel.replaceChildren();
  const add = (v, label) => sel.append(el("option", { value: v }, label));
  add("exa", "exa (auto)");
  add("exa/fast", "exa · fast");
  add("exa/strong", "exa · strong");
  for (const p of state.models?.providers ?? []) {
    const model = PROVIDER_DEFAULT_MODELS[p.id];
    if (!model) continue;
    const source = p.source.replace("byok_", "your key: ").replace("pool", "org pool");
    add(model, `${model} (${source})`);
  }
}

export async function refreshSessions() {
  state.sessions = await api("GET", `/v1/sessions?limit=${SESSION_LIST_LIMIT}`);
  $("#session-list").replaceChildren(...state.sessions.map(sessionLink));
}

// ---------- helpers ----------
function sessionLink(s) {
  const isActive = state.current?.info.id === s.id;
  return el(
    "a",
    {
      class: `session-item${isActive ? " active" : ""}`,
      href: `#/s/${s.id}`,
      title: s.title ?? "",
    },
    s.title ?? "Untitled",
    el("span", { class: "tag" }, s.loopHost === "client" ? "cli" : ""),
  );
}
