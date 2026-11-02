// Permission prompts for the open chat: render pending approvals and send the user's answer.

import { $, el } from "../helpers/dom.helper.js";
import { api } from "../services/api.service.js";
import { state } from "../state.js";

// ---------- approvals view ----------
export function renderApprovals() {
  const pending = [...(state.current?.approvals.values() ?? [])];
  $("#approvals").replaceChildren(...pending.map(approvalView));
}

/** Show an error line at the bottom of the chat. */
export function alertLine(msg) {
  $("#messages").append(el("div", { class: "err" }, msg));
}

// ---------- helpers ----------
function approvalView(a) {
  const button = (cls, reply, label) =>
    el("button", { class: cls, onclick: () => answer(a.id, reply) }, label);
  return el(
    "div",
    { class: "approval" },
    el(
      "div",
      {},
      el("b", {}, "Permission needed "),
      el("span", { class: "muted" }, a.permission),
      " — ",
      a.title,
    ),
    el("div", { class: "pats" }, (a.patterns ?? []).join("\n")),
    el(
      "div",
      { class: "row" },
      button("btn primary", "once", "Allow once"),
      button("btn", "always", "Always (this chat)"),
      button("btn danger", "reject", "Deny"),
    ),
  );
}

async function answer(id, reply) {
  const c = state.current;
  try {
    await api("POST", `/v1/sessions/${c.info.id}/permissions/${id}`, { reply });
  } catch (e) {
    alertLine(e.message);
  }
  c.approvals.delete(id);
  renderApprovals();
}
