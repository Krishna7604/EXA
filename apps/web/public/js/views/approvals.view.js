// Approval requests for the open chat: what the agent wants to do, and the user's answer.
// Shown in marigold above the composer — the one place the agent is waiting on the user.

import { $, el } from "../helpers/dom.helper.js";
import { icon } from "../helpers/icons.helper.js";
import { api } from "../services/api.service.js";
import { state } from "../state.js";
import { toastError } from "./toast.view.js";

// ---------- constants ----------
/** How a permission reads in the request ("exa wants to …"). */
const PERMISSION_PHRASES = {
  bash: "run a command",
  edit: "change files",
  webfetch: "open a web page",
  websearch: "search the web",
  external_directory: "work outside its folder",
  doom_loop: "repeat the same action again",
  memory: "update its memory",
  task: "hand work to a helper agent",
};

// ---------- approvals view ----------
export function renderApprovals() {
  const pending = [...(state.current?.approvals.values() ?? [])];
  $("#approvals").replaceChildren(...pending.map(approvalView));
}

/** Show an error inside the open chat (for errors from the agent run itself). */
export function chatError(message) {
  $("#messages").append(
    el("div", { class: "msg" }, el("div", { class: "err" }, icon("alert", "sm"), message)),
  );
}

// ---------- helpers ----------
function approvalView(a) {
  const button = (cls, reply, label) =>
    el("button", { class: cls, type: "button", onclick: () => answer(a.id, reply) }, label);
  const what = PERMISSION_PHRASES[a.permission] ?? `use ${a.permission}`;
  // the title usually names the target already; only list patterns it doesn't mention
  const patterns = (a.patterns ?? []).filter((p) => p && p !== "*" && !a.title?.includes(p));
  return el(
    "div",
    { class: "approval", role: "alert" },
    el(
      "div",
      { class: "ask" },
      icon("alert"),
      el(
        "div",
        {},
        el("strong", {}, `exa wants to ${what}`),
        el("div", { class: "muted small" }, a.title),
      ),
    ),
    patterns.length ? el("pre", { class: "pats" }, patterns.join("\n")) : null,
    el(
      "div",
      { class: "row-actions" },
      button("btn primary", "once", "Allow once"),
      button("btn", "always", "Allow for this chat"),
      button("btn danger", "reject", "Deny"),
    ),
  );
}

async function answer(id, reply) {
  const c = state.current;
  try {
    await api("POST", `/v1/sessions/${c.info.id}/permissions/${id}`, { reply });
  } catch (e) {
    toastError(e.message);
  }
  c.approvals.delete(id);
  renderApprovals();
}
