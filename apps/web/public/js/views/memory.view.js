// Memory page: what exa remembers about the user, grouped by topic. Search it, add to it, and
// correct or delete anything; each memory links back to the chat it was learned in.

import { $, el } from "../helpers/dom.helper.js";
import { icon } from "../helpers/icons.helper.js";
import { relativeTime } from "../helpers/time.helper.js";
import { api } from "../services/api.service.js";
import { closeStream } from "../services/events.service.js";
import { state } from "../state.js";
import { show } from "./layout.view.js";
import { openMenu } from "./menu.view.js";
import { toast, toastError } from "./toast.view.js";

// ---------- constants ----------
const SEARCH_DEBOUNCE_MS = 250;

let memories = [];
let searchTimer = null;

// ---------- memory page ----------
export async function openMemory() {
  closeStream();
  state.current = null;
  show("memory");
  const search = el("input", {
    type: "search",
    placeholder: "Search memories",
    "aria-label": "Search memories",
    oninput: onSearch,
  });
  $("#memory-root").replaceChildren(
    pageHead(),
    el("div", { id: "memory-editor" }),
    el("label", { class: "search" }, icon("search"), search),
    el("div", { id: "memory-list" }),
  );
  await load("");
}

// ---------- helpers ----------
function pageHead() {
  return el(
    "header",
    { class: "page-head" },
    el(
      "div",
      {},
      el("h1", {}, "Memory"),
      el(
        "p",
        { class: "lede" },
        "What exa remembers about you across chats. It picks things up as you talk, and you can add, correct or delete anything here.",
      ),
    ),
    el(
      "button",
      { class: "btn primary", type: "button", onclick: () => openEditor(null) },
      icon("plus", "sm"),
      "Add memory",
    ),
  );
}

function onSearch(e) {
  clearTimeout(searchTimer);
  const q = e.target.value.trim();
  searchTimer = setTimeout(() => load(q), SEARCH_DEBOUNCE_MS);
}

async function load(q) {
  try {
    memories = await api("GET", q ? `/v1/memories?q=${encodeURIComponent(q)}` : "/v1/memories");
    render(q);
  } catch (e) {
    $("#memory-list").replaceChildren(el("p", { class: "error" }, e.message));
  }
}

function render(q) {
  const list = $("#memory-list");
  if (!memories.length)
    return list.replaceChildren(
      q ? el("p", { class: "faint" }, `No memories match "${q}".`) : emptyState(),
    );
  const byTopic = new Map();
  for (const m of memories) {
    const key = m.topic.trim();
    byTopic.set(key, [...(byTopic.get(key) ?? []), m]);
  }
  const topics = [...byTopic.keys()].sort((a, b) => a.localeCompare(b));
  list.replaceChildren(
    ...topics.map((t) =>
      el("section", { class: "memory-topic" }, el("h4", {}, t), ...byTopic.get(t).map(memoryRow)),
    ),
  );
}

function emptyState() {
  return el(
    "div",
    { class: "empty" },
    el("h3", {}, "Nothing saved yet"),
    el(
      "p",
      {},
      'Tell exa about yourself in any chat, like "I\'m vegetarian" or "I work 10 to 6, India time", and it will remember. You can also add things here.',
    ),
  );
}

function memoryRow(m) {
  const source = m.sourceSessionId
    ? el("span", {}, "Learned in ", el("a", { href: `#/s/${m.sourceSessionId}` }, "a chat"))
    : el("span", {}, "Added by you");
  return el(
    "div",
    { class: "memory-item" },
    el(
      "div",
      { class: "content" },
      el("div", {}, m.content),
      el("div", { class: "meta" }, source, `, updated ${relativeTime(m.time.updated)}`),
    ),
    el(
      "div",
      { class: "actions" },
      el(
        "button",
        {
          class: "btn quiet icon-only",
          type: "button",
          "aria-label": "Edit memory",
          onclick: () => openEditor(m),
        },
        icon("edit", "sm"),
      ),
      el(
        "button",
        {
          class: "btn quiet icon-only",
          type: "button",
          "aria-label": "Delete memory",
          onclick: (e) => confirmDelete(e.currentTarget, m),
        },
        icon("trash", "sm"),
      ),
    ),
  );
}

function openEditor(m) {
  const topic = el("input", {
    required: true,
    maxlength: 80,
    value: m?.topic ?? "",
    placeholder: "Food, work hours, family…",
  });
  const content = el("textarea", {
    rows: 3,
    required: true,
    maxlength: 2000,
    placeholder: "I'm vegetarian and don't eat eggs.",
  });
  content.value = m?.content ?? "";
  const error = el("p", { class: "error" });
  const onsubmit = (e) => save(e, m, { topic, content, error });
  $("#memory-editor").replaceChildren(
    el(
      "form",
      { class: "sheet", onsubmit },
      el("h3", {}, m ? "Edit memory" : "Add a memory"),
      el("div", { class: "form-row" }, el("label", { class: "field" }, "Topic", topic)),
      el("label", { class: "field" }, "What exa should remember", content),
      error,
      el(
        "div",
        { class: "form-actions" },
        el("button", { class: "btn primary", type: "submit" }, m ? "Save changes" : "Save memory"),
        el("button", { class: "btn quiet", type: "button", onclick: closeEditor }, "Cancel"),
      ),
    ),
  );
  (m ? content : topic).focus();
}

function closeEditor() {
  $("#memory-editor").replaceChildren();
}

async function save(e, m, f) {
  e.preventDefault();
  const body = { topic: f.topic.value.trim(), content: f.content.value.trim() };
  try {
    if (m) await api("PUT", `/v1/memories/${m.id}`, body);
    else await api("POST", "/v1/memories", body);
    closeEditor();
    toast(m ? "Memory updated." : "Saved. exa will use this from now on.");
    await load("");
  } catch (err) {
    f.error.textContent = err.message;
  }
}

function confirmDelete(anchor, m) {
  openMenu(anchor, [
    { meta: "Forget this? exa won't use it again." },
    { label: "Forget it", icon: "trash", danger: true, onSelect: () => remove(m) },
    { label: "Keep it", icon: "x", onSelect: () => {} },
  ]);
}

async function remove(m) {
  try {
    await api("DELETE", `/v1/memories/${m.id}`);
    memories = memories.filter((x) => x.id !== m.id);
    render("");
    toast("Forgotten.");
  } catch (e) {
    toastError(e.message);
  }
}
