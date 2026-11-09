// Toasts: short confirmations and errors in the corner, gone after a few seconds.

import { $, el } from "../helpers/dom.helper.js";
import { icon } from "../helpers/icons.helper.js";

// ---------- constants ----------
const TOAST_MS = 4200;
const ERROR_TOAST_MS = 7000;

// ---------- toasts ----------
export function toast(message) {
  show(el("div", { class: "toast" }, icon("check", "sm"), el("span", {}, message)), TOAST_MS);
}

export function toastError(message) {
  const body = el(
    "div",
    { class: "toast error", role: "alert" },
    icon("alert", "sm"),
    el("span", {}, message),
  );
  show(body, ERROR_TOAST_MS);
}

// ---------- helpers ----------
function show(node, ms) {
  $("#toasts").append(node);
  setTimeout(() => node.remove(), ms);
}
