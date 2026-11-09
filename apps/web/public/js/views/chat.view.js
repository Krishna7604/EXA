// The chat view: the home screen (greeting, suggestions, coming-up tasks), opening a chat, its
// header and options menu, and sending prompts.

import { $, el } from "../helpers/dom.helper.js";
import { icon } from "../helpers/icons.helper.js";
import { dateTime, relativeTime } from "../helpers/time.helper.js";
import { api } from "../services/api.service.js";
import { closeStream, subscribe } from "../services/events.service.js";
import { state } from "../state.js";
import { renderApprovals } from "./approvals.view.js";
import { show } from "./layout.view.js";
import { openMenu } from "./menu.view.js";
import { renderAll } from "./messages.view.js";
import { refreshSessions } from "./sidebar.view.js";
import { toast, toastError } from "./toast.view.js";

// ---------- constants ----------
const COST_DECIMALS = 3;
const UPCOMING_SHOWN = 3;
const MORNING_ENDS = 12;
const AFTERNOON_ENDS = 18;
/** Starters on the home screen; `href` ones go to a page instead of filling the composer. */
const SUGGESTIONS = [
  {
    icon: "list",
    label: "Plan my week",
    text: "Help me plan my week. Ask me what's on my plate, then lay out a realistic day-by-day plan.",
  },
  {
    icon: "globe",
    label: "Research something",
    text: "Research  and give me a short brief with the key facts and links to sources.",
  },
  { icon: "pen", label: "Draft a message", text: "Draft a short, friendly email to  about " },
  { icon: "clock", label: "Set up a daily briefing", href: "#/tasks?new=briefing" },
  {
    icon: "memory",
    label: "What do you know about me?",
    text: "What do you remember about me? List it by topic.",
  },
];

/** Increments on every openSession; a load that finishes after a newer one started is dropped. */
let openSeq = 0;

// ---------- chat view ----------
export function newChatView() {
  closeStream();
  state.current = null;
  show("chat");
  $("#view-chat").classList.add("is-home");
  $("#chat-title").textContent = "New chat";
  $("#chat-badges").replaceChildren();
  $("#messages").replaceChildren(greeting());
  $("#approvals").replaceChildren();
  $("#todos").classList.add("hidden");
  showComposer(true);
  setSendMode(false);
  $("#model-select").value = state.me?.settings?.["models.default"] ?? "exa";
  $("#mode-select").value = "default";
  renderSuggestions();
  renderUpcoming().catch(() => {});
  refreshSessionsQuietly();
  $("#prompt").focus();
}

/** Load a chat, render it, and follow its live events. */
export async function openSession(id) {
  closeStream();
  show("chat");
  leaveHome();
  const load = ++openSeq;
  const data = await api("GET", `/v1/sessions/${id}`);
  // a newer open (another click, back/forward) started while this one loaded: it wins
  if (load !== openSeq) return;
  state.current = toCurrentChat(data);
  renderHeader();
  renderAll();
  renderApprovals();
  showComposerFor(state.current.info, !!data.messages);
  refreshSessionsQuietly();
  subscribe(id, state.current.seq);
}

export function renderHeader() {
  const c = state.current;
  if (!c) return;
  $("#chat-title").textContent = c.info.title ?? "New chat";
  $("#chat-badges").replaceChildren(...headerBadges(c));
  selectModel(c.info.model);
  $("#mode-select").value = c.info.permissionMode ?? "default";
  setSendMode(c.busy);
}

/** Send a prompt, creating a chat first when none is open. */
export async function send(text) {
  let c = state.current;
  if (!c) {
    const info = await api("POST", "/v1/sessions", {
      loopHost: "server",
      model: $("#model-select").value,
      permissionMode: $("#mode-select").value,
    });
    // pushState doesn't fire hashchange, so the router won't open this chat a second time
    history.pushState(null, "", `#/s/${info.id}`);
    await openSession(info.id);
    c = state.current;
  }
  c.busy = true;
  renderHeader();
  await api("POST", `/v1/sessions/${c.info.id}/prompt`, { text });
}

export function openChatMenu(anchor) {
  const c = state.current;
  if (!c) return;
  const items = [{ label: "Rename", icon: "edit", onSelect: startRename }];
  if (c.info.loopHost === "server")
    items.push({ label: "Summarize to free up context", icon: "list", onSelect: compact });
  items.push("-", {
    label: "Delete chat",
    icon: "trash",
    danger: true,
    onSelect: () => confirmDelete(anchor),
  });
  openMenu(anchor, items);
}

/** Put the send button in "stop" mode while the agent is working. */
export function setSendMode(isBusy) {
  const btn = $("#send-btn");
  btn.classList.toggle("stop", isBusy);
  btn.setAttribute("aria-label", isBusy ? "Stop" : "Send");
  btn.replaceChildren(icon(isBusy ? "stop" : "send"));
}

// ---------- helpers ----------
function leaveHome() {
  $("#view-chat").classList.remove("is-home");
  $("#suggestions").classList.add("hidden");
  $("#upcoming").classList.add("hidden");
}

function refreshSessionsQuietly() {
  refreshSessions().catch(() => {});
}

function greeting() {
  const name = firstName();
  const hello = `${partOfDay()}${name ? `, ${name}` : ""}.`;
  return el(
    "div",
    { class: "home" },
    el("h1", { class: "greeting" }, hello, el("br"), el("span", {}, "What should I take care of?")),
  );
}

function partOfDay() {
  const h = new Date().getHours();
  if (h < MORNING_ENDS) return "Good morning";
  if (h < AFTERNOON_ENDS) return "Good afternoon";
  return "Good evening";
}

function firstName() {
  const u = state.me?.user;
  const raw = u?.displayName?.split(/\s+/)[0] ?? u?.email?.split("@")[0]?.split(/[._-]/)[0] ?? "";
  return raw ? raw[0].toUpperCase() + raw.slice(1) : "";
}

function renderSuggestions() {
  const box = $("#suggestions");
  box.replaceChildren(...SUGGESTIONS.map(suggestionButton));
  box.classList.remove("hidden");
}

function suggestionButton(s) {
  const onclick = () => {
    if (s.href) {
      location.hash = s.href;
      return;
    }
    const t = $("#prompt");
    t.value = s.text;
    t.dispatchEvent(new Event("input"));
    t.focus();
    const gap = s.text.indexOf("  ");
    const caret = gap === -1 ? s.text.length : gap + 1;
    t.setSelectionRange(caret, caret);
  };
  return el(
    "button",
    { class: "suggestion", type: "button", onclick },
    icon(s.icon, "sm"),
    s.label,
  );
}

/** The next few scheduled task runs, so the home screen shows what exa will do on its own. */
async function renderUpcoming() {
  const box = $("#upcoming");
  state.tasks = await api("GET", "/v1/tasks");
  const next = state.tasks
    .filter((t) => t.enabled && t.nextRunAt)
    .sort((a, b) => a.nextRunAt - b.nextRunAt)
    .slice(0, UPCOMING_SHOWN);
  if (!next.length || state.current) return;
  const rows = next.map((t) =>
    el(
      "a",
      { href: "#/tasks", title: dateTime(t.nextRunAt) },
      el("span", { class: "when" }, relativeTime(t.nextRunAt)),
      el("span", { class: "name" }, t.name),
    ),
  );
  box.replaceChildren(el("h4", {}, "Coming up"), ...rows);
  box.classList.remove("hidden");
}

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

function showComposer(isVisible) {
  $("#composer").classList.toggle("hidden", !isVisible);
  $("#readonly-note").classList.toggle("hidden", isVisible);
}

/** Chats run by the CLI on a device can be followed and approved here, not typed into. */
function showComposerFor(info, hasStoredMessages) {
  const isClient = info.loopHost === "client";
  showComposer(!isClient);
  if (hasStoredMessages || !isClient) return;
  $("#messages").replaceChildren(
    el(
      "div",
      { class: "empty" },
      el(
        "p",
        {},
        "This chat isn't stored on the server. Its activity shows up here while the device is connected.",
      ),
    ),
  );
}

function headerBadges(c) {
  const badges = [];
  if (c.busy)
    badges.push(el("span", { class: "pill iris live" }, el("span", { class: "led" }), "Working"));
  if (c.info.taskId)
    badges.push(el("span", { class: "pill" }, icon("clock", "sm"), "Scheduled run"));
  if (c.info.loopHost === "client")
    badges.push(el("span", { class: "pill" }, icon("terminal", "sm"), c.info.directory ?? "CLI"));
  if (Number(c.info.cost) > 0)
    badges.push(el("span", { class: "pill", title: "Cost of this chat" }, formatCost(c.info.cost)));
  return badges;
}

/** "$0.012", or "<$0.001" for a chat that has barely cost anything. */
function formatCost(cost) {
  const n = Number(cost);
  const smallest = 10 ** -COST_DECIMALS;
  return n < smallest ? `<$${smallest.toFixed(COST_DECIMALS)}` : `$${n.toFixed(COST_DECIMALS)}`;
}

/** Select the chat's model, adding it to the picker if it isn't listed. */
function selectModel(model) {
  const sel = $("#model-select");
  sel.value = model;
  if (sel.value === model) return;
  sel.append(el("option", { value: model }, model));
  sel.value = model;
}

function startRename() {
  const title = $("#chat-title");
  const input = el("input", {
    class: "chat-title-input",
    value: state.current.info.title ?? "",
    "aria-label": "Chat title",
  });
  let isDone = false;
  const finish = async (save) => {
    if (isDone) return;
    isDone = true;
    const next = input.value.trim();
    input.replaceWith(title);
    if (!save || !next || next === state.current.info.title) return;
    await api("PATCH", `/v1/sessions/${state.current.info.id}`, { title: next }).catch((e) =>
      toastError(e.message),
    );
    state.current.info.title = next;
    renderHeader();
    refreshSessionsQuietly();
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") finish(true);
    if (e.key === "Escape") finish(false);
  });
  input.addEventListener("blur", () => finish(true));
  title.replaceWith(input);
  input.select();
}

async function compact() {
  try {
    await api("POST", `/v1/sessions/${state.current.info.id}/compact`);
    toast("Summarized the earlier conversation.");
  } catch (e) {
    toastError(e.message);
  }
}

function confirmDelete(anchor) {
  openMenu(anchor, [
    { meta: "Delete this chat and everything stored for it? This can't be undone." },
    { label: "Delete permanently", icon: "trash", danger: true, onSelect: deleteChat },
    { label: "Keep it", icon: "x", onSelect: () => {} },
  ]);
}

async function deleteChat() {
  const c = state.current;
  try {
    await api("DELETE", `/v1/sessions/${c.info.id}`);
    toast("Chat deleted.");
    location.hash = "#/";
  } catch (e) {
    toastError(e.message);
  }
}
