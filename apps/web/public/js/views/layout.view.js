// Switches between the top-level views (login, device approval, chat, settings).

import { $ } from "../helpers/dom.helper.js";

// ---------- constants ----------
const VIEWS = ["login", "device", "chat", "settings"];

// ---------- view switching ----------
export function show(view) {
  for (const v of VIEWS) $(`#view-${v}`).classList.toggle("hidden", v !== view);
  const isLogin = view === "login";
  $("#sidebar").classList.toggle("hidden", isLogin);
  $("#app").classList.toggle("no-sidebar", isLogin);
  $("#app").classList.remove("menu-open");
}
