// Renders chat messages into #messages: user bubbles, the agent's replies (markdown), and its
// activity as a trail of plain-language steps ("Searched the web for …") with expandable output.

import { $, el } from "../helpers/dom.helper.js";
import { icon } from "../helpers/icons.helper.js";
import { md } from "../helpers/markdown.helper.js";
import { state } from "../state.js";

// ---------- constants ----------
const MAX_TOOL_OUTPUT_CHARS = 20000;
const SUMMARY_PREVIEW_CHARS = 400;
const COST_DECIMALS = 4;
/** Keep following new output when the view is within this many pixels of the bottom. */
const STICK_TO_BOTTOM_PX = 140;
/** How each tool reads in the activity trail: verbs while running / when done, and its subject. */
const TOOL_PHRASES = {
  websearch: ["Searching the web for", "Searched the web for", "query"],
  webfetch: ["Reading", "Read", "url"],
  memory_save: ["Remembering", "Remembered", "topic"],
  memory_forget: ["Forgetting a memory", "Forgot a memory", null],
  recall: ["Looking back for", "Looked back for", "query"],
  todowrite: ["Updating the plan", "Updated the plan", null],
  task: ["Handing off", "Handed off", "description"],
  skill: ["Loading the skill", "Loaded the skill", "name"],
  tool_search: ["Looking up tools", "Looked up tools", null],
  question: ["Asking", "Asked", null],
  read: ["Reading", "Read", "filePath"],
  write: ["Writing", "Wrote", "filePath"],
  edit: ["Editing", "Edited", "filePath"],
  apply_patch: ["Applying changes", "Applied changes", null],
  bash: ["Running", "Ran", "command"],
  glob: ["Finding files", "Found files", "pattern"],
  grep: ["Searching files for", "Searched files for", "pattern"],
  list: ["Listing", "Listed", "path"],
};
/** Errors the user can fix themselves: [pattern in the error text, what to do]. */
const ERROR_HINTS = [
  [
    /\b402\b|more credits|insufficient (credits|quota|balance)/i,
    "The model provider's account is out of credits. Add credits there, or add your own key in Settings, then send your message again.",
  ],
  [
    /\b401\b|invalid api key|incorrect api key|unauthorized/i,
    "The model provider rejected the API key. Check the key in Settings or the server's environment.",
  ],
  [
    /\b429\b|rate limit/i,
    "The model provider is rate-limiting requests. Wait a moment and send your message again.",
  ],
];

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

/** Render streamed text into an existing text part without rebuilding the message. */
export function updateTextPart(partId, text) {
  const node = document.querySelector(`[data-part="${partId}"]`);
  if (!node) return false;
  const box = $("#messages");
  const shouldStick = isNearBottom(box);
  node.innerHTML = md(text);
  if (shouldStick) box.scrollTop = box.scrollHeight;
  return true;
}

/** Copy buttons inside code blocks (delegated, since replies are rendered as HTML). */
export function wireCopyButtons() {
  $("#messages").addEventListener("click", async (e) => {
    const btn = e.target.closest(".copy-btn");
    if (!btn) return;
    const code = btn.closest(".codeblock")?.querySelector("code")?.textContent ?? "";
    await navigator.clipboard?.writeText(code).catch(() => {});
    btn.textContent = "Copied";
    setTimeout(() => (btn.textContent = "Copy"), 1500);
  });
}

// ---------- helpers ----------
function flushRerenders() {
  const box = $("#messages");
  const shouldStick = isNearBottom(box);
  for (const mid of rafPending) {
    const m = state.current?.messages.get(mid);
    if (!m) continue;
    const old = box.querySelector(`[data-msg="${mid}"]`);
    const fresh = messageView(m);
    if (old) old.replaceWith(fresh);
    else box.append(fresh);
  }
  rafPending = new Set();
  if (shouldStick) box.scrollTop = box.scrollHeight;
}

function isNearBottom(box) {
  return box.scrollHeight - box.scrollTop - box.clientHeight < STICK_TO_BOTTOM_PX;
}

function userMessageView(m) {
  const text = [...m.parts.values()]
    .filter((p) => p.type === "text")
    .map((p) => p.text)
    .join("\n");
  if (m.info.summary)
    return el(
      "div",
      { class: "msg", "data-msg": m.info.id },
      el(
        "div",
        { class: "summary-msg" },
        "Summary of the earlier conversation: ",
        `${text.slice(0, SUMMARY_PREVIEW_CHARS)}…`,
      ),
    );
  return el(
    "div",
    { class: "msg user", "data-msg": m.info.id },
    el("div", { class: "bubble" }, text),
  );
}

function assistantMessageView(m) {
  const node = el("div", { class: "msg assistant", "data-msg": m.info.id });
  const isDone = !!m.info.time?.completed;
  let steps = null;
  for (const p of m.parts.values()) {
    if (p.type === "tool") {
      steps ??= node.appendChild(el("div", { class: "steps" }));
      steps.append(toolStep(p));
      continue;
    }
    const v = partView(p, isDone);
    if (!v) continue;
    steps = null;
    node.append(v);
  }
  if (!isDone && !m.parts.size) node.append(el("div", { class: "thinking" }, "Working on it"));
  if (m.info.error) {
    node.append(errorView(m.info.error.message));
    return node;
  }
  const usage = usageLine(m);
  if (usage) node.append(usage);
  return node;
}

/** The error, plus what to do about it when it's one the user can fix. */
function errorView(message) {
  const hint = ERROR_HINTS.find(([pattern]) => pattern.test(message))?.[1];
  return el(
    "div",
    { class: "err" },
    icon("alert", "sm"),
    el("div", {}, hint ? el("strong", { class: "err-hint" }, hint) : null, el("div", {}, message)),
  );
}

function partView(p, isDone) {
  switch (p.type) {
    case "text": {
      // a step can open with an empty text part; drawing it would split the activity trail
      if (isDone && !p.text?.trim()) return null;
      const node = el("div", { class: "prose", "data-part": p.id });
      node.innerHTML = md(p.text ?? "");
      return node;
    }
    case "reasoning":
      return isDone ? null : el("div", { class: "thinking" }, "Thinking");
    case "patch":
      return el(
        "div",
        { class: "usage-line" },
        `Changed ${p.files.length} file${p.files.length === 1 ? "" : "s"}`,
      );
    case "compaction":
      return el(
        "div",
        { class: "summary-msg" },
        "The earlier conversation was summarized to make room.",
      );
    default:
      return null;
  }
}

function toolStep(p) {
  const st = p.state;
  const status = stepStatus(st.status);
  const line = [el("span", { class: "status" }), stepLabel(p.tool, st)];
  const hasOutput = st.status === "completed" && st.output;
  if (!hasOutput && st.status !== "error")
    return el("div", { class: `step ${status}` }, el("div", { class: "step-line" }, ...line));
  const body = [];
  if (hasOutput) body.push(el("pre", {}, st.output.slice(0, MAX_TOOL_OUTPUT_CHARS)));
  if (st.status === "error") body.push(el("p", { class: "step-err" }, st.error));
  return el(
    "details",
    { class: `step ${status}` },
    el("summary", {}, ...line, icon("chevron", "sm")),
    ...body,
  );
}

function stepStatus(status) {
  if (status === "completed") return "ok";
  if (status === "error") return "err";
  return "run";
}

/** "Searched the web for <b>best ramen in Pune</b>" — falls back to the tool's own title. */
function stepLabel(tool, st) {
  const isRunning = st.status !== "completed" && st.status !== "error";
  const phrase = TOOL_PHRASES[tool];
  const verb = phrase ? phrase[isRunning ? 0 : 1] : `${isRunning ? "Using" : "Used"} ${tool}`;
  const subject = stepSubject(tool, phrase?.[2], st);
  return el(
    "span",
    { class: "label" },
    verb,
    subject ? " " : "",
    subject ? el("b", {}, subject) : "",
  );
}

function stepSubject(tool, key, st) {
  const input = st.input ?? {};
  const value = key ? input[key] : null;
  if (tool === "webfetch" && value) return hostOf(value);
  if (value) return String(value);
  if (!TOOL_PHRASES[tool] && st.title) return st.title;
  return "";
}

function hostOf(url) {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    // not a URL: show it as written
    return url;
  }
}

/** Model, tokens and cost under a finished answer (skipped for turns that used tools). */
function usageLine(m) {
  if (!m.info.time?.completed || !m.info.tokens) return null;
  const parts = [...m.parts.values()];
  const finish = parts.find((p) => p.type === "step-finish");
  if (!finish || parts.some((p) => p.type === "tool")) return null;
  const { input, output } = m.info.tokens;
  const cost = `$${Number(m.info.cost ?? 0).toFixed(COST_DECIMALS)}`;
  return el(
    "div",
    { class: "usage-line" },
    `${finish.modelUsed ?? m.info.model}, ${input + output} tokens, ${cost}`,
  );
}
