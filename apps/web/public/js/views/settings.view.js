// Settings page: account, appearance, defaults, bring-your-own model keys, usage, and the
// organization's policy and permission rules (admins only).

import { $, el } from "../helpers/dom.helper.js";
import { icon } from "../helpers/icons.helper.js";
import { applyTheme, savedTheme } from "../helpers/theme.helper.js";
import { api } from "../services/api.service.js";
import { isAdmin, logout } from "../services/auth.service.js";
import { closeStream } from "../services/events.service.js";
import { state } from "../state.js";
import { show } from "./layout.view.js";
import { fillModelSelect } from "./sidebar.view.js";
import { toast, toastError } from "./toast.view.js";

// ---------- constants ----------
const USAGE_DAYS = 30;
const USAGE_ROWS_SHOWN = 30;
const COST_DECIMALS = 4;
const PROVIDERS = [
  ["anthropic", "Anthropic"],
  ["openai", "OpenAI"],
  ["openrouter", "OpenRouter"],
  ["google", "Google Gemini"],
  ["groq", "Groq"],
  ["deepseek", "DeepSeek"],
  ["xai", "xAI"],
  ["mistral", "Mistral"],
  ["together", "Together"],
  ["cerebras", "Cerebras"],
  ["bedrock", "Amazon Bedrock"],
  ["opencode", "OpenCode Zen"],
];
const STORAGE_CHOICES = [
  ["server", "Keep every chat on the server"],
  ["local", "Keep CLI chats on my device"],
  ["none", "Don't keep chats"],
];
const THEMES = [
  ["system", "Match system"],
  ["light", "Light"],
  ["dark", "Dark"],
];

// ---------- settings page ----------
export async function openSettings() {
  closeStream();
  state.current = null;
  show("settings");
  const root = $("#settings-root");
  root.replaceChildren(
    el("header", { class: "page-head" }, el("div", {}, el("h1", {}, "Settings"))),
    accountSection(),
    appearanceSection(),
    defaultsSection(),
    keysSection(),
    el("section", { class: "section split", id: "usage-section" }),
  );
  if (isAdmin()) root.append(orgSection(), rulesSection());
  await Promise.all([loadKeys(), loadUsage(), isAdmin() ? loadOrg() : null]);
}

// ---------- sections ----------
function section(title, about, ...body) {
  return el(
    "section",
    { class: "section split" },
    el("div", { class: "about" }, el("h3", {}, title), about ? el("p", {}, about) : null),
    el("div", { class: "form-grid" }, ...body),
  );
}

function accountSection() {
  const { user, tenant, role } = state.me;
  const kv = el(
    "dl",
    { class: "kv" },
    el("dt", {}, "Email"),
    el("dd", {}, user.email),
    el("dt", {}, "Organization"),
    el("dd", {}, tenant.name || tenant.slug),
    el("dt", {}, "Role"),
    el("dd", {}, role),
  );
  const signOut = el(
    "button",
    { class: "btn", type: "button", onclick: logout },
    icon("logout", "sm"),
    "Sign out",
  );
  return section("Account", null, kv, el("div", {}, signOut));
}

function appearanceSection() {
  const group = el("div", { class: "segmented", role: "radiogroup", "aria-label": "Theme" });
  const paint = () => {
    for (const b of group.children) b.classList.toggle("on", b.dataset.theme === savedTheme());
  };
  for (const [value, label] of THEMES) {
    const onclick = () => {
      applyTheme(value);
      paint();
    };
    group.append(
      el("button", { type: "button", role: "radio", "data-theme": value, onclick }, label),
    );
  }
  paint();
  return section("Appearance", "Saved in this browser.", el("div", {}, group));
}

function defaultsSection() {
  const s = state.me.settings;
  const isStorageLocked = new Set(state.me.locked).has("storage.mode");
  const model = el(
    "select",
    { id: "pref-model" },
    ...[...$("#model-select").options].map((o) => el("option", { value: o.value }, o.textContent)),
  );
  model.value = s["models.default"] ?? "exa";
  const storage = el(
    "select",
    { id: "pref-storage", disabled: isStorageLocked },
    ...STORAGE_CHOICES.map(([v, l]) => el("option", { value: v }, l)),
  );
  storage.value = s["storage.mode"] ?? "server";
  const note = el(
    "span",
    { class: "note" },
    isStorageLocked ? "Chat storage is set by your organization." : "",
  );
  const save = el(
    "button",
    { class: "btn", type: "button", onclick: () => savePrefs(model, storage) },
    "Save defaults",
  );
  return section(
    "Defaults",
    "Used for new chats and scheduled tasks unless you pick something else.",
    el(
      "div",
      { class: "form-row" },
      el("label", { class: "field" }, "Model", model),
      el("label", { class: "field" }, "Chat history", storage),
    ),
    el("div", { class: "form-actions" }, save, note),
  );
}

function keysSection() {
  const provider = el(
    "select",
    { name: "provider", required: true },
    ...PROVIDERS.map(([v, l]) => el("option", { value: v }, l)),
  );
  const key = el("input", {
    name: "key",
    type: "password",
    placeholder: "API key",
    required: true,
    autocomplete: "off",
  });
  const scope = el(
    "select",
    { name: "scope" },
    el("option", { value: "user" }, "Just me"),
    el("option", { value: "tenant" }, "Whole organization"),
  );
  const form = el(
    "form",
    { class: "form-grid", onsubmit: (e) => saveKey(e, { provider, key, scope }) },
    el(
      "div",
      { class: "form-row" },
      el("label", { class: "field" }, "Provider", provider),
      el("label", { class: "field" }, "Key", key),
      el("label", { class: "field" }, "For", scope),
    ),
    el("p", { class: "error", id: "key-error" }),
    el("div", {}, el("button", { class: "btn primary", type: "submit" }, "Save key")),
  );
  return section(
    "Model keys",
    "Use your own provider account. Keys are encrypted on the server and only decrypted to call the provider.",
    el("div", { id: "keys-list", class: "rows" }),
    form,
  );
}

function orgSection() {
  const storage = el(
    "select",
    { id: "org-storage" },
    el("option", { value: "" }, "Let each person choose"),
    ...STORAGE_CHOICES.filter(([v]) => v !== "local").map(([v, l]) =>
      el("option", { value: v }, l),
    ),
  );
  const lock = el("input", { type: "checkbox", id: "org-storage-lock" });
  const webtools = el(
    "select",
    { id: "org-webtools" },
    el("option", { value: "chat" }, "Assistant: web, memory, tasks, connectors (no files)"),
    el("option", { value: "agent" }, "Workspace: adds files and code in a private sandbox"),
  );
  const models = el("input", {
    id: "org-models",
    placeholder: "exa*, openai/*  (empty allows all)",
  });
  return section(
    "Organization",
    "Applies to everyone in your organization.",
    el(
      "div",
      { class: "form-row" },
      el("label", { class: "field" }, "Chat history", storage),
      el("label", { class: "check" }, lock, "Lock for everyone"),
    ),
    el("label", { class: "field" }, "Web chats can use", webtools),
    el("label", { class: "field" }, "Allowed models", models),
    el(
      "div",
      {},
      el(
        "button",
        { class: "btn", type: "button", onclick: saveOrgSettings },
        "Save organization settings",
      ),
    ),
  );
}

function rulesSection() {
  const permission = el("input", { name: "permission", placeholder: "bash", required: true });
  const pattern = el("input", { name: "pattern", placeholder: "git push *", required: true });
  const action = el(
    "select",
    { name: "action" },
    el("option", {}, "deny"),
    el("option", {}, "ask"),
    el("option", {}, "allow"),
  );
  const locked = el("input", { type: "checkbox", name: "locked", checked: true });
  const form = el(
    "form",
    { class: "form-grid", onsubmit: (e) => addRule(e, { permission, pattern, action, locked }) },
    el(
      "div",
      { class: "form-row" },
      el("label", { class: "field" }, "Permission", permission),
      el("label", { class: "field" }, "Pattern", pattern),
      el("label", { class: "field" }, "Action", action),
    ),
    el(
      "div",
      { class: "form-actions" },
      el("label", { class: "check" }, locked, "Locked (people can't override it)"),
      el("button", { class: "btn", type: "submit" }, "Add rule"),
    ),
  );
  return section(
    "Permission rules",
    "What the agent may do without asking, must ask about, or may never do.",
    el("div", { id: "rules-list", class: "rows" }),
    form,
  );
}

// ---------- loading ----------
async function loadKeys() {
  const keys = await api("GET", "/v1/keys").catch(() => []);
  const rows = keys.map((k) =>
    el(
      "div",
      { class: "row-item" },
      el(
        "div",
        { class: "main-col" },
        el("div", { class: "name" }, providerName(k.provider)),
        el(
          "div",
          { class: "meta" },
          `${k.ownerScope === "tenant" ? "Organization" : "You"}, ending in ${k.last4 ?? "…"}`,
        ),
      ),
      removeButton(`Remove ${k.provider} key`, async () => {
        await api("DELETE", `/v1/keys/${k.id}`);
        await loadKeys();
      }),
    ),
  );
  $("#keys-list").replaceChildren(
    ...(rows.length
      ? rows
      : [el("p", { class: "faint small" }, "No keys yet. exa uses your organization's models.")]),
  );
  if (!state.me.byokAvailable)
    $("#key-error").textContent =
      "Your own keys are turned off on this server (no master key is configured).";
}

async function loadUsage() {
  const rows = await api("GET", `/v1/usage?days=${USAGE_DAYS}`).catch(() => []);
  const total = rows.reduce((a, r) => a + Number(r.cost), 0);
  const requests = rows.reduce((a, r) => a + Number(r.requests), 0);
  const totals = el(
    "div",
    { class: "usage-total" },
    stat(`$${total.toFixed(COST_DECIMALS)}`, "Spent"),
    stat(String(requests), "Model calls"),
  );
  const table = el(
    "table",
    { class: "table" },
    el(
      "thead",
      {},
      el(
        "tr",
        {},
        el("th", {}, "Day"),
        el("th", {}, "Model"),
        el("th", { class: "num" }, "Calls"),
        el("th", { class: "num" }, "Cost"),
      ),
    ),
    el(
      "tbody",
      {},
      ...rows
        .slice(0, USAGE_ROWS_SHOWN)
        .map((r) =>
          el(
            "tr",
            {},
            el("td", {}, String(r.day).slice(0, 10)),
            el("td", {}, r.model_used),
            el("td", { class: "num" }, String(r.requests)),
            el("td", { class: "num" }, `$${Number(r.cost).toFixed(COST_DECIMALS)}`),
          ),
        ),
    ),
  );
  $("#usage-section").replaceChildren(
    el("div", { class: "about" }, el("h3", {}, "Usage"), el("p", {}, `Last ${USAGE_DAYS} days.`)),
    el(
      "div",
      { class: "form-grid" },
      totals,
      rows.length ? table : el("p", { class: "faint small" }, "No model calls yet."),
    ),
  );
}

async function loadOrg() {
  const st = await api("GET", "/v1/settings");
  const isTenantStorage = st.source["storage.mode"] === "tenant";
  $("#org-storage").value = isTenantStorage ? (st.values["storage.mode"] ?? "") : "";
  $("#org-storage-lock").checked = st.locked.includes("storage.mode");
  $("#org-webtools").value = st.values["web.tools"] ?? "chat";
  $("#org-models").value = (st.values["models.allowed"] ?? []).join(", ");
  const rules = (await api("GET", "/v1/rules")).filter((r) => r.scope === "tenant");
  const rows = rules.map((r) =>
    el(
      "div",
      { class: "row-item" },
      el(
        "div",
        { class: "main-col" },
        el("div", { class: "name mono" }, `${r.permission}  ${r.pattern}`),
        el("div", { class: "meta" }, `${r.action}${r.locked ? ", locked" : ""}`),
      ),
      removeButton("Remove rule", async () => {
        await api("DELETE", `/v1/rules/${r.id}`);
        await loadOrg();
      }),
    ),
  );
  $("#rules-list").replaceChildren(
    ...(rows.length
      ? rows
      : [el("p", { class: "faint small" }, "No organization rules. The built-in defaults apply.")]),
  );
}

// ---------- saving ----------
async function savePrefs(model, storage) {
  try {
    await api("PUT", "/v1/settings", { scope: "user", key: "models.default", value: model.value });
    if (!storage.disabled)
      await api("PUT", "/v1/settings", {
        scope: "user",
        key: "storage.mode",
        value: storage.value,
      });
    state.me = await api("GET", "/v1/me");
    toast("Defaults saved.");
  } catch (e) {
    toastError(e.message);
  }
}

async function saveKey(e, f) {
  e.preventDefault();
  try {
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
    toast("Key saved.");
  } catch (err) {
    $("#key-error").textContent = err.message;
  }
}

async function saveOrgSettings() {
  const storage = $("#org-storage").value || null;
  const models = $("#org-models")
    .value.split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  try {
    await putOrgSetting("storage.mode", storage, $("#org-storage-lock").checked && !!storage);
    await putOrgSetting("web.tools", $("#org-webtools").value);
    await putOrgSetting("models.allowed", models);
    state.me = await api("GET", "/v1/me");
    await loadOrg();
    toast("Organization settings saved.");
  } catch (e) {
    toastError(e.message);
  }
}

async function addRule(e, f) {
  e.preventDefault();
  try {
    await api("POST", "/v1/rules", {
      scope: "tenant",
      permission: f.permission.value.trim(),
      pattern: f.pattern.value.trim(),
      action: f.action.value,
      locked: f.locked.checked,
    });
    f.pattern.value = "";
    await loadOrg();
  } catch (err) {
    toastError(err.message);
  }
}

// ---------- helpers ----------
/** `locked` is only sent when given, matching the API's optional field. */
function putOrgSetting(key, value, locked) {
  const body = { scope: "tenant", key, value };
  if (locked !== undefined) body.locked = locked;
  return api("PUT", "/v1/settings", body);
}

function stat(value, label) {
  return el("div", {}, el("div", { class: "num" }, value), el("div", { class: "lbl" }, label));
}

function providerName(id) {
  return PROVIDERS.find(([v]) => v === id)?.[1] ?? id;
}

function removeButton(label, onclick) {
  return el(
    "button",
    { class: "btn quiet sm", type: "button", "aria-label": label, onclick },
    "Remove",
  );
}
