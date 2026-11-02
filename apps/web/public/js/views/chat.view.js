// The chat view: start a new chat, open an existing one, its header, and sending prompts.

import { $, el } from "../helpers/dom.helper.js";
import { api } from "../services/api.service.js";
import { closeStream, subscribe } from "../services/events.service.js";
import { state } from "../state.js";
import { renderApprovals } from "./approvals.view.js";
import { show } from "./layout.view.js";
import { renderAll } from "./messages.view.js";
import { refreshSessions } from "./sidebar.view.js";

// ---------- constants ----------
const COST_DECIMALS = 4;

// ---------- chat view ----------
export function newChatView() {
  closeStream();
  state.current = null;
  show("chat");
  $("#chat-title").textContent = "New chat";
  $("#chat-badges").replaceChildren();
  $("#messages").replaceChildren(
    el(
      "div",
      { class: "muted center" },
      el("p", {}, "Start a conversation. Tools run in a private sandbox for this chat."),
    ),
  );
  $("#approvals").replaceChildren();
  $("#todos").classList.add("hidden");
  $("#composer").classList.remove("hidden");
  $("#readonly-note").classList.add("hidden");
  $("#abort-btn").classList.add("hidden");
  $("#forget-btn").classList.add("hidden");
  $("#model-select").value = state.me?.settings?.["models.default"] ?? "exa";
  $("#prompt").focus();
}

/** Load a session, render it, and follow its live events. */
export async function openSession(id) {
  closeStream();
  show("chat");
  const data = await api("GET", `/v1/sessions/${id}`);
  state.current = toCurrentChat(data);
  renderHeader();
  renderAll();
  renderApprovals();
  showComposerFor(state.current.info, !!data.messages);
  await refreshSessions();
  subscribe(id, state.current.seq);
}

export function renderHeader() {
  const c = state.current;
  if (!c) return;
  $("#chat-title").textContent = c.info.title ?? "Untitled";
  $("#chat-badges").replaceChildren(...headerBadges(c));
  selectModel(c.info.model);
  $("#mode-select").value = c.info.permissionMode ?? "default";
  $("#abort-btn").classList.toggle("hidden", !c.busy);
}

/** Send a prompt, creating a server-loop session first when no chat is open. */
export async function send(text) {
  let c = state.current;
  if (!c) {
    const info = await api("POST", "/v1/sessions", {
      loopHost: "server",
      model: $("#model-select").value,
      permissionMode: $("#mode-select").value,
    });
    location.hash = `#/s/${info.id}`;
    await openSession(info.id);
    c = state.current;
  }
  c.busy = true;
  renderHeader();
  await api("POST", `/v1/sessions/${c.info.id}/prompt`, { text });
}

// ---------- helpers ----------
function toCurrentChat(data) {
  const cur = {
    info: data.info,
    messages: new Map(),
    approvals: new Map(),
    busy: data.busy,
    seq: data.lastSeq ?? 0,
  };
  for (const m of data.messages ?? [])
    cur.messages.set(m.info.id, { info: m.info, parts: new Map(m.parts.map((p) => [p.id, p])) });
  for (const a of data.pendingApprovals ?? []) cur.approvals.set(a.id, a);
  return cur;
}

/** Sessions run by a CLI on a device are read-only here. */
function showComposerFor(info, hasStoredMessages) {
  const isClient = info.loopHost === "client";
  $("#composer").classList.toggle("hidden", isClient);
  $("#readonly-note").classList.toggle("hidden", !isClient);
  $("#forget-btn").classList.remove("hidden");
  if (hasStoredMessages || !isClient) return;
  $("#messages").replaceChildren(
    el(
      "p",
      { class: "muted center" },
      "This chat isn't stored on the server. Live activity will appear here while the device is connected.",
    ),
  );
}

function headerBadges(c) {
  const where = c.info.loopHost === "client" ? `device · ${c.info.directory ?? ""}` : "sandbox";
  const badges = [
    el("span", { class: "badge" }, where),
    el("span", { class: "badge" }, `storage: ${c.info.storageMode}`),
    el("span", { class: "badge" }, `$${Number(c.info.cost ?? 0).toFixed(COST_DECIMALS)}`),
  ];
  if (c.busy) badges.unshift(el("span", { class: "badge live" }, "● running"));
  return badges;
}

/** Select the session's model, adding it to the picker if it isn't listed. */
function selectModel(model) {
  const sel = $("#model-select");
  sel.value = model;
  if (sel.value === model) return;
  sel.append(el("option", { value: model }, model));
  sel.value = model;
}
