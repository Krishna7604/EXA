// Settings view: personal preferences, BYOK keys, usage, and org policy (admins only).

import { $, el } from "../helpers/dom.helper.js";
import { api } from "../services/api.service.js";
import { isAdmin } from "../services/auth.service.js";
import { closeStream } from "../services/events.service.js";
import { state } from "../state.js";
import { show } from "./layout.view.js";
import { fillModelSelect } from "./sidebar.view.js";

// ---------- constants ----------
const USAGE_DAYS = 30;
const USAGE_ROWS_SHOWN = 30;
const COST_DECIMALS = 4;

// ---------- settings view ----------
export async function openSettings() {
  closeStream();
  show("settings");
  const s = state.me.settings;
  const locked = new Set(state.me.locked);
  const isStorageLocked = locked.has("storage.mode");
  $("#pref-model").value = s["models.default"] ?? "";
  $("#pref-storage").value = s["storage.mode"] ?? "";
  $("#pref-storage").disabled = isStorageLocked;
  $("#prefs-note").textContent = isStorageLocked ? "Chat storage is set by your organization." : "";
  await Promise.all([loadKeys(), loadUsage(), loadOrg()]);
}

export async function loadKeys() {
  const keys = await api("GET", "/v1/keys").catch(() => []);
  const rows = keys.length
    ? keys.map(keyRow)
    : [el("div", { class: "muted small" }, "No keys yet.")];
  $("#keys-list").replaceChildren(...rows);
  if (!state.me.byokAvailable)
    $("#key-error").textContent = "BYOK is disabled on this server (no master key configured).";
}

export async function loadOrg() {
  if (!isAdmin()) return;
  const st = await api("GET", "/v1/settings");
  const isTenantStorage = st.source["storage.mode"] === "tenant";
  $("#org-storage").value = isTenantStorage ? (st.values["storage.mode"] ?? "") : "";
  $("#org-storage-lock").checked = st.locked.includes("storage.mode");
  $("#org-webtools").value = st.values["web.tools"] ?? "chat";
  $("#org-models").value = (st.values["models.allowed"] ?? []).join(", ");
  const rules = (await api("GET", "/v1/rules")).filter((r) => r.scope === "tenant");
  $("#rules-list").replaceChildren(...rules.map(ruleRow));
}

/** Add a BYOK key from the form, then refresh keys and the model picker. */
export async function saveKey(f) {
  await api("PUT", "/v1/keys", {
    provider: f.provider.value,
    key: f.key.value,
    scope: f.scope.value,
  });
  f.key.value = "";
  $("#key-error").textContent = "";
  await loadKeys();
  state.models = await api("GET", "/v1/models").catch(() => state.models);
  fillModelSelect();
}

export async function savePrefs() {
  const model = $("#pref-model").value.trim();
  if (model)
    await api("PUT", "/v1/settings", { scope: "user", key: "models.default", value: model });
  if (!$("#pref-storage").disabled)
    await api("PUT", "/v1/settings", {
      scope: "user",
      key: "storage.mode",
      value: $("#pref-storage").value || null,
    });
  state.me = await api("GET", "/v1/me");
}

export async function saveOrgSettings() {
  const storage = $("#org-storage").value || null;
  await putOrgSetting("storage.mode", storage, $("#org-storage-lock").checked && !!storage);
  await putOrgSetting("web.tools", $("#org-webtools").value);
  const models = $("#org-models")
    .value.split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  await putOrgSetting("models.allowed", models);
  state.me = await api("GET", "/v1/me");
  await loadOrg();
}

export async function addRule(f) {
  await api("POST", "/v1/rules", {
    scope: "tenant",
    permission: f.permission.value.trim(),
    pattern: f.pattern.value.trim(),
    action: f.action.value,
    locked: f.locked.checked,
  });
  f.pattern.value = "";
  await loadOrg();
}

// ---------- helpers ----------
async function loadUsage() {
  const rows = await api("GET", `/v1/usage?days=${USAGE_DAYS}`).catch(() => []);
  const total = rows.reduce((a, r) => a + Number(r.cost), 0);
  const requests = rows.reduce((a, r) => a + r.requests, 0);
  $("#usage").replaceChildren(
    el(
      "div",
      { class: "muted small" },
      `Total: $${total.toFixed(COST_DECIMALS)} · ${requests} requests`,
    ),
    ...rows.slice(0, USAGE_ROWS_SHOWN).map(usageRow),
  );
}

/** `locked` is only sent when given, matching the API's optional field. */
function putOrgSetting(key, value, locked) {
  const body = { scope: "tenant", key, value };
  if (locked !== undefined) body.locked = locked;
  return api("PUT", "/v1/settings", body);
}

function keyRow(k) {
  const owner = k.ownerScope === "tenant" ? "organization" : "you";
  return el(
    "div",
    { class: "item" },
    el("span", {}, el("b", {}, k.provider), ` · ${owner} · …${k.last4 ?? ""}`),
    removeButton(async () => {
      await api("DELETE", `/v1/keys/${k.id}`);
      return loadKeys();
    }),
  );
}

function ruleRow(r) {
  const locked = r.locked ? "  (locked)" : "";
  return el(
    "div",
    { class: "item" },
    el("span", { class: "mono" }, `${r.permission}  ${r.pattern}  →  ${r.action}${locked}`),
    removeButton(async () => {
      await api("DELETE", `/v1/rules/${r.id}`);
      return loadOrg();
    }),
  );
}

function usageRow(r) {
  return el(
    "div",
    { class: "item" },
    el("span", {}, `${String(r.day).slice(0, 10)} · ${r.model_used}`),
    el("span", { class: "muted" }, `${r.requests} req · $${Number(r.cost).toFixed(COST_DECIMALS)}`),
  );
}

function removeButton(onclick) {
  return el("button", { class: "btn ghost", onclick }, "Remove");
}
