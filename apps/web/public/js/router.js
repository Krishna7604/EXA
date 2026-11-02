// Hash routing: #/ (new chat), #/s/<id> (a chat), #/settings, #/device?code=...

import { $ } from "./helpers/dom.helper.js";
import { boot, showLogin } from "./services/auth.service.js";
import { state } from "./state.js";
import { newChatView, openSession } from "./views/chat.view.js";
import { show } from "./views/layout.view.js";
import { openSettings } from "./views/settings.view.js";

// ---------- constants ----------
const SESSION_ROUTE = /^#\/s\/([0-9a-f-]{36})/;

// ---------- routing ----------
export async function route() {
  const hash = location.hash || "#/";
  if (!state.token) {
    state.pendingHash = hash.startsWith("#/device") ? hash : null;
    return showLogin();
  }
  if (!state.me) await boot();
  if (hash.startsWith("#/device")) return showDevice(hash);
  if (hash.startsWith("#/settings")) return openSettings();
  const m = hash.match(SESSION_ROUTE);
  if (m) return openSession(m[1]);
  return newChatView();
}

// ---------- helpers ----------
/** Device approval page; prefills the code from the link. */
function showDevice(hash) {
  show("device");
  const code = new URLSearchParams(hash.split("?")[1] ?? "").get("code");
  if (code) $("#device-form").code.value = code;
}
