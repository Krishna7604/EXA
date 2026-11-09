// exa web client: chat with the server-hosted agent, follow and approve CLI sessions, and manage
// tasks, memory, connectors and settings. No build step; talks to the same /v1 API as the CLI.
// Entry module (loaded by index.html as type="module"): wires DOM events, then routes.

import { $ } from "./js/helpers/dom.helper.js";
import { hydrateIcons } from "./js/helpers/icons.helper.js";
import { store, TOKEN_KEY } from "./js/helpers/storage.helper.js";
import { applyTheme, toggleTheme } from "./js/helpers/theme.helper.js";
import { route } from "./js/router.js";
import { api } from "./js/services/api.service.js";
import { boot, finishLogin, openAccountMenu } from "./js/services/auth.service.js";
import { state } from "./js/state.js";
import { newChatView, openChatMenu, send } from "./js/views/chat.view.js";
import { togglePanel } from "./js/views/layout.view.js";
import { wireCopyButtons } from "./js/views/messages.view.js";
import { wireSearch } from "./js/views/sidebar.view.js";
import { toastError } from "./js/views/toast.view.js";

// ---------- constants ----------
const PROMPT_MAX_HEIGHT_PX = 240;

// ---------- wiring ----------
applyTheme();
hydrateIcons();
wireLogin();
wireComposer();
wireChatControls();
wireShell();
wireSearch();
wireCopyButtons();
window.addEventListener("hashchange", () => route().catch((e) => toastError(e.message)));
route().catch((e) => console.error(e));

// ---------- login ----------
function wireLogin() {
  $("#dev-login").addEventListener("submit", onDevLogin);
  $("#token-login").addEventListener("submit", onTokenLogin);
  $("#device-form").addEventListener("submit", onDeviceApprove);
}

async function onDevLogin(ev) {
  ev.preventDefault();
  const f = ev.target;
  try {
    const r = await fetch("/v1/auth/dev-login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: f.email.value, tenant: f.tenant.value }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error?.message ?? "Sign-in failed");
    state.token = j.token;
    store.set(TOKEN_KEY, j.token);
    await finishLogin();
  } catch (e) {
    $("#login-error").textContent = e.message;
  }
}

/** Sign in with a pasted API token; it is only saved once /v1/me accepts it. */
async function onTokenLogin(ev) {
  ev.preventDefault();
  state.token = ev.target.token.value.trim();
  try {
    await boot();
    store.set(TOKEN_KEY, state.token);
    await finishLogin();
  } catch (e) {
    state.token = null;
    $("#login-error").textContent = e.message;
  }
}

async function onDeviceApprove(ev) {
  ev.preventDefault();
  const result = $("#device-result");
  try {
    await api("POST", "/v1/auth/device/approve", {
      userCode: ev.target.code.value.trim().toUpperCase(),
    });
    result.className = "notice ok";
    result.textContent = "Device connected. You can go back to your terminal.";
  } catch (e) {
    result.className = "notice bad";
    result.textContent = e.message;
  }
}

// ---------- composer ----------
function wireComposer() {
  $("#composer").addEventListener("submit", onComposerSubmit);
  $("#prompt").addEventListener("input", autosize);
  $("#prompt").addEventListener("keydown", (e) => {
    // Enter sends, Shift+Enter adds a newline; ignore Enter while an IME is composing
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      $("#composer").requestSubmit();
    }
  });
}

/** The send button doubles as "stop" while the agent works. */
async function onComposerSubmit(ev) {
  ev.preventDefault();
  if (state.current?.busy) return abort();
  const t = $("#prompt").value.trim();
  if (!t) return;
  $("#prompt").value = "";
  autosize();
  try {
    await send(t);
  } catch (e) {
    toastError(e.message);
  }
}

function autosize() {
  const t = $("#prompt");
  t.style.height = "auto";
  t.style.height = `${Math.min(t.scrollHeight, PROMPT_MAX_HEIGHT_PX)}px`;
}

function abort() {
  if (!state.current) return;
  api("POST", `/v1/sessions/${state.current.info.id}/abort`).catch((e) => toastError(e.message));
}

// ---------- chat controls ----------
function wireChatControls() {
  $("#new-chat").addEventListener("click", (e) => {
    if (location.hash !== "#/" && location.hash !== "") return;
    e.preventDefault();
    newChatView();
  });
  $("#chat-more").addEventListener("click", (e) => openChatMenu(e.currentTarget));
  $("#model-select").addEventListener("change", (e) => patchSession({ model: e.target.value }));
  $("#mode-select").addEventListener("change", (e) =>
    patchSession({ permissionMode: e.target.value }),
  );
}

/** Apply a model/approval-mode change to the open chat (no-op on the home screen). */
async function patchSession(patch) {
  if (!state.current) return;
  await api("PATCH", `/v1/sessions/${state.current.info.id}`, patch).catch((err) =>
    toastError(err.message),
  );
}

// ---------- shell ----------
function wireShell() {
  $("#toggle-panel").addEventListener("click", () => togglePanel(true));
  $("#scrim").addEventListener("click", () => togglePanel(false));
  $("#session-list").addEventListener("click", () => togglePanel(false));
  $("#theme-toggle").addEventListener("click", toggleTheme);
  $("#me-button").addEventListener("click", (e) => openAccountMenu(e.currentTarget));
  document.addEventListener("keydown", (e) => {
    const isSearchShortcut = (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k";
    if (!isSearchShortcut || $("#app").classList.contains("bare")) return;
    e.preventDefault();
    if (!location.hash.startsWith("#/s/") && location.hash !== "#/" && location.hash)
      location.hash = "#/";
    $("#chat-search").focus();
  });
}
