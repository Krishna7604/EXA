// The chat list beside the chat view: chats grouped by day, a live "running" mark, search across
// every stored chat, and the model picker's options.

import { $, el } from "../helpers/dom.helper.js";
import { icon } from "../helpers/icons.helper.js";
import { dayGroup } from "../helpers/time.helper.js";
import { api } from "../services/api.service.js";
import { state } from "../state.js";

// ---------- constants ----------
const SESSION_LIST_LIMIT = 80;
const SEARCH_DEBOUNCE_MS = 280;
const MIN_SEARCH_CHARS = 2;
const SEARCH_LIMIT = 20;
const HTML_ENTITIES = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'" };
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
const KEY_SOURCES = { byok_user: "your key", byok_tenant: "org key", pool: "org pool" };

let searchTimer = null;
let searchSeq = 0;

// ---------- model picker ----------
export function fillModelSelect() {
  const sel = $("#model-select");
  sel.replaceChildren();
  const add = (value, label) => sel.append(el("option", { value }, label));
  add("exa", "Auto");
  add("exa/fast", "Fast");
  add("exa/strong", "Strong");
  for (const p of state.models?.providers ?? []) {
    const model = PROVIDER_DEFAULT_MODELS[p.id];
    if (!model) continue;
    add(model, `${model.split("/").slice(1).join("/")} (${KEY_SOURCES[p.source] ?? p.source})`);
  }
}

// ---------- chat list ----------
export async function refreshSessions() {
  state.sessions = await api("GET", `/v1/sessions?limit=${SESSION_LIST_LIMIT}`);
  renderSessions();
}

export function renderSessions() {
  const box = $("#session-list");
  if (!state.sessions.length) {
    box.replaceChildren(el("p", { class: "group-label" }, "Your chats will appear here."));
    return;
  }
  const nodes = [];
  let group = null;
  for (const s of state.sessions) {
    const g = dayGroup(s.time?.updated ?? Date.now());
    if (g !== group) {
      group = g;
      nodes.push(el("div", { class: "group-label" }, g));
    }
    nodes.push(sessionLink(s));
  }
  box.replaceChildren(...nodes);
}

/** Mark the open chat as running (or not) without reloading the list. */
export function markRunning(sessionId, isRunning) {
  const link = document.querySelector(`.session-item[data-id="${sessionId}"]`);
  link?.classList.toggle("running", isRunning);
}

// ---------- search ----------
export function wireSearch() {
  $("#chat-search").addEventListener("input", (e) => {
    clearTimeout(searchTimer);
    const q = e.target.value.trim();
    if (q.length < MIN_SEARCH_CHARS) return showSearch(null);
    searchTimer = setTimeout(() => runSearch(q), SEARCH_DEBOUNCE_MS);
  });
  $("#chat-search").addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    e.target.value = "";
    showSearch(null);
  });
}

// ---------- helpers ----------
function sessionLink(s) {
  const isActive = state.current?.info.id === s.id;
  const isRunning = isActive && state.current?.busy;
  const cls = ["session-item", isActive && "active", isRunning && "running"].filter(Boolean);
  return el(
    "a",
    { class: cls.join(" "), href: `#/s/${s.id}`, title: s.title ?? "", "data-id": s.id },
    el("span", { class: "title" }, s.title ?? "New chat"),
    kindIcon(s),
  );
}

/** Scheduled runs and CLI chats get a small mark; regular web chats none. */
function kindIcon(s) {
  if (s.taskId) return icon("clock", "sm");
  if (s.loopHost === "client") return icon("terminal", "sm");
  return null;
}

async function runSearch(q) {
  const seq = ++searchSeq;
  const titleHits = state.sessions.filter((s) =>
    (s.title ?? "").toLowerCase().includes(q.toLowerCase()),
  );
  const textHits = await api(
    "GET",
    `/v1/search?q=${encodeURIComponent(q)}&limit=${SEARCH_LIMIT}`,
  ).catch(() => []);
  if (seq !== searchSeq) return;
  showSearch({ q, titleHits, textHits });
}

function showSearch(result) {
  const box = $("#search-results");
  $("#session-list").classList.toggle("hidden", !!result);
  box.classList.toggle("hidden", !result);
  if (!result) return box.replaceChildren();
  const { titleHits, textHits } = result;
  const nodes = [];
  if (titleHits.length)
    nodes.push(el("div", { class: "group-label" }, "Titles"), ...titleHits.map(sessionLink));
  if (textHits.length)
    nodes.push(el("div", { class: "group-label" }, "In conversations"), ...textHits.map(hitLink));
  if (!nodes.length)
    nodes.push(el("p", { class: "group-label" }, `Nothing matches "${result.q}".`));
  box.replaceChildren(...nodes);
}

function hitLink(h) {
  return el(
    "a",
    { class: "search-hit", href: `#/s/${h.sessionId}` },
    el("span", {}, h.sessionTitle ?? "Untitled chat"),
    el("span", { class: "snippet" }, ...snippetNodes(h.snippet)),
  );
}

/**
 * The server sends snippets HTML-escaped with `<b>` around matches. Build DOM nodes from that
 * instead of using innerHTML, so nothing else in the snippet can ever become markup.
 */
function snippetNodes(snippet) {
  const nodes = [];
  const parts = String(snippet ?? "").split(/(<b>|<\/b>)/);
  let isBold = false;
  for (const part of parts) {
    if (part === "<b>" || part === "</b>") {
      isBold = part === "<b>";
      continue;
    }
    const text = part.replace(/&(amp|lt|gt|quot|#39);/g, (e) => HTML_ENTITIES[e]);
    nodes.push(isBold ? el("b", {}, text) : document.createTextNode(text));
  }
  return nodes;
}
