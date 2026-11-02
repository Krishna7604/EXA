// Sign-in screen, loading the signed-in user, and sign-out.

import { $ } from "../helpers/dom.helper.js";
import { store, TOKEN_KEY } from "../helpers/storage.helper.js";
import { route } from "../router.js";
import { state } from "../state.js";
import { show } from "../views/layout.view.js";
import { fillModelSelect, refreshSessions } from "../views/sidebar.view.js";
import { api } from "./api.service.js";
import { closeStream } from "./events.service.js";

// ---------- constants ----------
const ADMIN_ROLES = ["owner", "admin"];
const NO_SIGN_IN_MESSAGE =
  "Email sign-in is off on this server. Start it with `bun run dev` (local), or paste an API token from `exa login`.";

// ---------- auth ----------
export function isAdmin() {
  return ADMIN_ROLES.includes(state.me.role);
}

export async function showLogin() {
  show("login");
  try {
    const cfg = await (await fetch("/v1/auth/config")).json();
    $("#dev-login").classList.toggle("hidden", !cfg.devAuth);
    $("#login-error").textContent = cfg.devAuth || cfg.oidc ? "" : NO_SIGN_IN_MESSAGE;
  } catch {
    $("#login-error").textContent = "Cannot reach the exa server.";
  }
}

/** Load the user, models and sessions after sign-in. */
export async function boot() {
  state.me = await api("GET", "/v1/me");
  $("#tenant-label").textContent = state.me.tenant.slug;
  $("#user-label").textContent = `${state.me.user.email} · ${state.me.role}`;
  for (const n of document.querySelectorAll(".admin-only"))
    n.classList.toggle("hidden", !isAdmin());
  state.models = await api("GET", "/v1/models").catch(() => null);
  fillModelSelect();
  await refreshSessions();
}

/** Return to the page the user wanted before signing in. */
export async function finishLogin() {
  location.hash = state.pendingHash ?? "#/";
  await route();
}

export function logout() {
  state.token = null;
  state.me = null;
  store.set(TOKEN_KEY, null);
  closeStream();
  showLogin();
}
