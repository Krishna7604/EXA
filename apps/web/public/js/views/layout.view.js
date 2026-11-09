// Switches between the top-level views and keeps the shell in step: which rail item is active,
// whether the chat list shows, and the sign-in screens without any chrome.

import { $ } from "../helpers/dom.helper.js";

// ---------- constants ----------
const VIEWS = ["login", "device", "chat", "tasks", "memory", "connectors", "settings"];
/** Views shown without the rail and chat list. */
const BARE_VIEWS = new Set(["login", "device"]);
/** Views that keep the chat list beside them. */
const PANEL_VIEWS = new Set(["chat"]);

// ---------- view switching ----------
export function show(view) {
  for (const v of VIEWS) $(`#view-${v}`).classList.toggle("hidden", v !== view);
  const app = $("#app");
  app.classList.toggle("bare", BARE_VIEWS.has(view));
  app.classList.toggle("no-panel", !BARE_VIEWS.has(view) && !PANEL_VIEWS.has(view));
  app.classList.remove("menu-open");
  for (const a of document.querySelectorAll("[data-nav]"))
    a.classList.toggle("active", a.dataset.nav === view);
  const title = view === "chat" ? "exa" : `${view[0].toUpperCase()}${view.slice(1)} · exa`;
  document.title = view === "connectors" ? "Tools · exa" : title;
}

/** Open or close the chat list drawer (small screens). */
export function togglePanel(isOpen) {
  $("#app").classList.toggle("menu-open", isOpen);
}
