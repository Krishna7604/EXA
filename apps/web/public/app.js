// exa light client: chat UI over the exa server (server loop) + live viewer/approver for
// client-loop sessions. No build step; talks to the same /v1 API as the CLI.
// Entry module (loaded by index.html as type="module"): wires DOM events, then routes.

import { $ } from "./js/helpers/dom.helper.js";
import { store, TOKEN_KEY } from "./js/helpers/storage.helper.js";
import { route } from "./js/router.js";
import { api } from "./js/services/api.service.js";
import { boot, finishLogin, logout } from "./js/services/auth.service.js";
import { state } from "./js/state.js";
import { alertLine } from "./js/views/approvals.view.js";
import { newChatView, send } from "./js/views/chat.view.js";
import { addRule, saveKey, saveOrgSettings, savePrefs } from "./js/views/settings.view.js";
import { refreshSessions } from "./js/views/sidebar.view.js";

// ---------- constants ----------
const PROMPT_MAX_HEIGHT_PX = 220;
const FORGET_CONFIRM = "Delete this chat and everything stored for it? This can't be undone.";

// ---------- wiring ----------
wireLogin();
wireComposer();
wireChatControls();
wireSettings();
window.addEventListener("hashchange", () => route().catch((e) => alertLine(e.message)));
route().catch((e) => console.error(e));

// ---------- login ----------
function wireLogin() {
  $("#dev-login").addEventListener("submit", onDevLogin);
  $("#token-login").addEventListener("submit", onTokenLogin);
  $("#device-form").addEventListener("submit", onDeviceApprove);
  $("#logout").addEventListener("click", logout);
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
    if (!r.ok) throw new Error(j.error?.message ?? "login failed");
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
  try {
    await api("POST", "/v1/auth/device/approve", {
      userCode: ev.target.code.value.trim().toUpperCase(),
    });
    $("#device-result").textContent = "✓ Device connected. You can return to your terminal.";
  } catch (e) {
    $("#device-result").textContent = e.message;
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

async function onComposerSubmit(ev) {
  ev.preventDefault();
  const t = $("#prompt").value.trim();
  if (!t) return;
  $("#prompt").value = "";
  autosize();
  try {
    await send(t);
  } catch (e) {
    alertLine(e.message);
  }
}

function autosize() {
  const t = $("#prompt");
  t.style.height = "auto";
  t.style.height = `${Math.min(t.scrollHeight, PROMPT_MAX_HEIGHT_PX)}px`;
}

// ---------- chat controls ----------
function wireChatControls() {
  $("#new-chat").addEventListener("click", () => {
    location.hash = "#/";
    newChatView();
  });
  $("#toggle-sidebar").addEventListener("click", () => $("#app").classList.toggle("menu-open"));
  $("#abort-btn").addEventListener("click", onAbort);
  $("#forget-btn").addEventListener("click", onForget);
  $("#model-select").addEventListener("change", (e) => patchSession({ model: e.target.value }));
  $("#mode-select").addEventListener("change", (e) =>
    patchSession({ permissionMode: e.target.value }),
  );
}

function onAbort() {
  if (!state.current) return;
  api("POST", `/v1/sessions/${state.current.info.id}/abort`).catch((e) => alertLine(e.message));
}

async function onForget() {
  const c = state.current;
  if (!c || !confirm(FORGET_CONFIRM)) return;
  await api("DELETE", `/v1/sessions/${c.info.id}`);
  location.hash = "#/";
  await refreshSessions();
}

/** Apply a model/mode change to the open chat (no-op on the new-chat screen). */
async function patchSession(patch) {
  if (!state.current) return;
  await api("PATCH", `/v1/sessions/${state.current.info.id}`, patch).catch((err) =>
    alertLine(err.message),
  );
}

// ---------- settings ----------
function wireSettings() {
  $("#open-settings").addEventListener("click", () => {
    location.hash = "#/settings";
  });
  $("#close-settings").addEventListener("click", () => history.back());
  $("#key-form").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    try {
      await saveKey(ev.target);
    } catch (e) {
      $("#key-error").textContent = e.message;
    }
  });
  $("#save-prefs").addEventListener("click", async () => {
    try {
      await savePrefs();
      $("#prefs-note").textContent = "Saved.";
    } catch (e) {
      $("#prefs-note").textContent = e.message;
    }
  });
  $("#save-org").addEventListener("click", saveOrgSettings);
  $("#rule-form").addEventListener("submit", (ev) => {
    ev.preventDefault();
    return addRule(ev.target);
  });
}
