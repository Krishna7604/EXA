// Sign-in screen, loading the signed-in user, the account menu, and sign-out.

import { $ } from "../helpers/dom.helper.js";
import { store, TOKEN_KEY } from "../helpers/storage.helper.js";
import { route } from "../router.js";
import { state } from "../state.js";
import { show } from "../views/layout.view.js";
import { openMenu } from "../views/menu.view.js";
import { fillModelSelect, refreshSessions } from "../views/sidebar.view.js";
import { api } from "./api.service.js";
import { closeStream } from "./events.service.js";

// ---------- constants ----------
const ADMIN_ROLES = ["owner", "admin"];
const NO_SIGN_IN_MESSAGE =
  "Email sign-in is off on this server. Start it with `bun run dev` for local use, or paste an API token from `exa login`.";

// ---------- auth ----------
export function isAdmin() {
  return ADMIN_ROLES.includes(state.me?.role);
}

export async function showLogin() {
  show("login");
  try {
    const cfg = await (await fetch("/v1/auth/config")).json();
    $("#dev-login").classList.toggle("hidden", !cfg.devAuth);
    $("#login-divider").classList.toggle("hidden", !cfg.devAuth);
    $("#login-error").textContent = cfg.devAuth || cfg.oidc ? "" : NO_SIGN_IN_MESSAGE;
  } catch {
    $("#login-error").textContent = "Can't reach the exa server. Check that it's running.";
  }
}

/** Load the user, models and chats after sign-in. */
export async function boot() {
  state.me = await api("GET", "/v1/me");
  const { user, tenant, role } = state.me;
  $("#me-button").textContent = initials(user.displayName || user.email);
  $("#me-button").title = `${user.email} (${role})`;
  $("#panel-foot").textContent = tenant.name || tenant.slug;
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
  state.tasks = null;
  store.set(TOKEN_KEY, null);
  closeStream();
  showLogin();
}

export function openAccountMenu(anchor) {
  const { user, tenant, role } = state.me;
  openMenu(anchor, [
    { meta: user.email },
    { meta: `${role[0].toUpperCase()}${role.slice(1)} in ${tenant.name || tenant.slug}` },
    "-",
    { label: "Settings", icon: "settings", onSelect: () => (location.hash = "#/settings") },
    { label: "Sign out", icon: "logout", onSelect: logout },
  ]);
}

// ---------- helpers ----------
function initials(name) {
  const base = name.split("@")[0];
  const parts = base.split(/[\s._-]+/).filter(Boolean);
  const letters = parts.length > 1 ? parts[0][0] + parts[1][0] : base.slice(0, 2);
  return letters.toUpperCase();
}
