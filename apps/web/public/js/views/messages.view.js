// Renders chat messages and their parts (text, tools, patches, summaries) into #messages.

import { $, el } from "../helpers/dom.helper.js";
import { md } from "../helpers/markdown.helper.js";
import { state } from "../state.js";

// ---------- constants ----------
const MAX_TOOL_OUTPUT_CHARS = 20000;
const SUMMARY_PREVIEW_CHARS = 400;
/** Keep following new output when the view is within this many pixels of the bottom. */
const STICK_TO_BOTTOM_PX = 120;
/** Tool input fields tried in order for a one-line label (after the tool's own title). */
const TOOL_LABEL_KEYS = ["description", "command", "filePath", "pattern", "url"];

let rafPending = new Set();

// ---------- messages view ----------
export function renderAll() {
  const box = $("#messages");
  const msgs = [...state.current.messages.values()].sort((a, b) =>
    a.info.id < b.info.id ? -1 : 1,
  );
  box.replaceChildren(...msgs.map(messageView));
  box.scrollTop = box.scrollHeight;
}

/** Re-render a message on the next animation frame (batched across streaming updates). */
export function rerenderMessage(id) {
  rafPending.add(id);
  if (rafPending.size > 1) return;
  requestAnimationFrame(flushRerenders);
}

export function messageView(m) {
  return m.info.role === "user" ? userMessageView(m) : assistantMessageView(m);
}

// ---------- helpers ----------
function flushRerenders() {
  const box = $("#messages");
  const shouldStick = box.scrollHeight - box.scrollTop - box.clientHeight < STICK_TO_BOTTOM_PX;
  for (const mid of rafPending) {
    const m = state.current?.messages.get(mid);
    if (!m) continue;
    const old = box.querySelector(`[data-msg="${mid}"]`);
    const fresh = messageView(m);
    if (old) {
      old.replaceWith(fresh);
    } else {
      box.querySelector(".muted.center")?.remove();
      box.append(fresh);
    }
  }
  rafPending = new Set();
  if (shouldStick) box.scrollTop = box.scrollHeight;
}

function userMessageView(m) {
  const text = [...m.parts.values()]
    .filter((p) => p.type === "text")
    .map((p) => p.text)
    .join("\n");
  if (m.info.summary)
    return el(
      "div",
      { class: "msg" },
      el("div", { class: "summary-msg" }, "Summary: ", text.slice(0, SUMMARY_PREVIEW_CHARS), "…"),
    );
  return el(
    "div",
    { class: "msg user", "data-msg": m.info.id },
    el("div", { class: "bubble" }, text),
  );
}

function assistantMessageView(m) {
  const node = el("div", { class: "msg assistant", "data-msg": m.info.id });
  for (const p of m.parts.values()) {
    const v = partView(p);
    if (!v) continue;
    if (p.type === "text") v.innerHTML = md(p.text);
    node.append(v);
  }
  if (m.info.error) node.append(el("div", { class: "err" }, m.info.error.message));
  const usage = usageLine(m);
  if (usage) node.append(usage);
  return node;
}

/** Model + tokens + cost under a finished answer (skipped for turns that used tools). */
function usageLine(m) {
  if (!m.info.time?.completed || !m.info.tokens) return null;
  const parts = [...m.parts.values()];
  const sf = parts.find((p) => p.type === "step-finish");
  if (!sf || parts.some((p) => p.type === "tool")) return null;
  const { input, output } = m.info.tokens;
  return el(
    "div",
    { class: "usage-line" },
    `${sf.modelUsed ?? m.info.model} · ${input}→${output} tok · $${Number(m.info.cost).toFixed(4)}`,
  );
}

function partView(p) {
  switch (p.type) {
    case "text":
      return el("div", { class: "text", "data-part": p.id });
    case "reasoning":
      return el("div", { class: "thinking" }, "thinking…");
    case "tool":
      return toolView(p);
    case "patch":
      return el("div", { class: "tool ok" }, `changed ${p.files.length} file(s)`);
    case "compaction":
      return el(
        "div",
        { class: "summary-msg" },
        "Earlier conversation was summarized to free context.",
      );
    default:
      return null;
  }
}

function toolView(p) {
  const st = p.state;
  const node = el(
    "div",
    { class: `tool ${toolStatusClass(st.status)}` },
    `${p.tool} ${toolLabel(st)}`,
  );
  if (st.status === "completed" && st.output)
    node.append(
      el(
        "details",
        {},
        el("summary", {}, "output"),
        el("pre", {}, st.output.slice(0, MAX_TOOL_OUTPUT_CHARS)),
      ),
    );
  if (st.status === "error") node.append(el("div", { class: "err" }, st.error));
  return node;
}

function toolStatusClass(status) {
  if (status === "completed") return "ok";
  if (status === "error") return "err";
  return "run";
}

/** First truthy of the tool's title and its label fields, like a chain of `||`. */
function toolLabel(st) {
  const input = st.input ?? {};
  if (st.title) return st.title;
  const key = TOOL_LABEL_KEYS.find((k) => input[k]);
  return key ? input[key] : "";
}
