// Tools page: connectors (remote MCP servers) that give exa access to the user's apps. Add one
// with its URL and secret headers (write-only), test it to see its tools, pause or remove it.

import { $, el } from "../helpers/dom.helper.js";
import { icon } from "../helpers/icons.helper.js";
import { api } from "../services/api.service.js";
import { isAdmin } from "../services/auth.service.js";
import { closeStream } from "../services/events.service.js";
import { state } from "../state.js";
import { show } from "./layout.view.js";
import { openMenu } from "./menu.view.js";
import { toast, toastError } from "./toast.view.js";

// ---------- constants ----------
const TOOLS_SHOWN = 24;

let connectors = [];

// ---------- tools page ----------
export async function openConnectors() {
  closeStream();
  state.current = null;
  show("connectors");
  $("#connectors-root").replaceChildren(
    pageHead(),
    el("div", { id: "connector-editor" }),
    el("div", { id: "connector-list" }),
    builtins(),
  );
  await load();
}

// ---------- helpers ----------
function pageHead() {
  return el(
    "header",
    { class: "page-head" },
    el(
      "div",
      {},
      el("h1", {}, "Tools"),
      el(
        "p",
        { class: "lede" },
        "Connect exa to the apps you use, like email, calendar, notes or code, through MCP servers. exa asks you before it uses a connected tool.",
      ),
    ),
    el(
      "button",
      { class: "btn primary", type: "button", onclick: () => openEditor(null) },
      icon("plus", "sm"),
      "Add connector",
    ),
  );
}

/** What exa can always do, so the page explains the whole toolset, not just add-ons. */
function builtins() {
  const items = [
    ["globe", "Web search and reading", "Finds current information and reads the pages it cites."],
    ["memory", "Memory", "Remembers your preferences and facts across chats."],
    ["clock", "Scheduled tasks", "Runs your recurring work on time, even when you're away."],
    ["list", "Plans and helpers", "Breaks big jobs into steps and hands parts to helper agents."],
  ];
  return el(
    "section",
    { class: "section" },
    el("div", { class: "section-head" }, el("h3", {}, "Built in")),
    el(
      "div",
      { class: "rows" },
      ...items.map(([ic, name, what]) =>
        el(
          "div",
          { class: "row-item" },
          icon(ic),
          el(
            "div",
            { class: "main-col" },
            el("div", { class: "name" }, name),
            el("div", { class: "meta" }, what),
          ),
        ),
      ),
    ),
  );
}

async function load() {
  try {
    connectors = await api("GET", "/v1/connectors");
    render();
  } catch (e) {
    $("#connector-list").replaceChildren(el("p", { class: "error" }, e.message));
  }
}

function render() {
  const list = $("#connector-list");
  if (!connectors.length)
    return list.replaceChildren(
      el(
        "div",
        { class: "empty" },
        el("h3", {}, "No connectors yet"),
        el(
          "p",
          {},
          "Add the URL of a remote MCP server, plus any header it needs to sign in (usually Authorization). exa connects to it in every new chat.",
        ),
      ),
    );
  list.replaceChildren(el("div", { class: "rows" }, ...connectors.map(connectorRow)));
}

function connectorRow(c) {
  const toggle = el("input", {
    type: "checkbox",
    "aria-label": `Use ${c.name}`,
    onchange: (e) => patch(c, { enabled: e.target.checked }),
  });
  toggle.checked = c.enabled;
  const result = el("div", { class: "tool-list hidden" });
  const meta = [el("span", {}, c.url)];
  if (c.scope === "tenant") meta.push(el("span", { class: "pill iris" }, "Whole organization"));
  if (c.secretHeaders?.length) meta.push(el("span", {}, `Sends ${c.secretHeaders.join(", ")}`));
  const canEdit = c.scope === "user" || isAdmin();
  return el(
    "div",
    {},
    el(
      "div",
      { class: "row-item" },
      el("label", { class: "switch" }, toggle, el("span")),
      el(
        "div",
        { class: "main-col" },
        el("div", { class: "name" }, c.name),
        el("div", { class: "meta" }, ...meta),
      ),
      el(
        "div",
        { class: "actions" },
        el("button", { class: "btn sm", type: "button", onclick: () => test(c, result) }, "Test"),
        canEdit
          ? el(
              "button",
              {
                class: "btn quiet icon-only",
                type: "button",
                "aria-label": `More for ${c.name}`,
                onclick: (e) => rowMenu(e.currentTarget, c),
              },
              icon("more"),
            )
          : null,
      ),
    ),
    result,
  );
}

function rowMenu(anchor, c) {
  openMenu(anchor, [
    { label: "Edit", icon: "edit", onSelect: () => openEditor(c) },
    "-",
    {
      label: "Remove",
      icon: "trash",
      danger: true,
      onSelect: () =>
        openMenu(anchor, [
          { meta: `Remove ${c.name}? Its stored headers are deleted too.` },
          { label: "Remove connector", icon: "trash", danger: true, onSelect: () => remove(c) },
          { label: "Keep it", icon: "x", onSelect: () => {} },
        ]),
    },
  ]);
}

async function test(c, box) {
  box.classList.remove("hidden");
  box.replaceChildren(el("span", { class: "faint small" }, `Connecting to ${c.name}…`));
  try {
    const r = await api("POST", `/v1/connectors/${c.id}/test`);
    if (!r.ok)
      return box.replaceChildren(
        el(
          "span",
          { class: "pill rose" },
          el("span", { class: "led" }),
          r.error ?? "Couldn't connect",
        ),
      );
    const tools = r.tools
      .slice(0, TOOLS_SHOWN)
      .map((t) => el("span", { class: "pill", title: t.description ?? "" }, t.name));
    const more =
      r.tools.length > TOOLS_SHOWN
        ? [el("span", { class: "faint small" }, `and ${r.tools.length - TOOLS_SHOWN} more`)]
        : [];
    box.replaceChildren(
      el(
        "span",
        { class: "pill fern" },
        el("span", { class: "led" }),
        `Connected, ${r.tools.length} tools`,
      ),
      ...tools,
      ...more,
    );
  } catch (e) {
    box.replaceChildren(el("span", { class: "pill rose" }, e.message));
  }
}

async function patch(c, body) {
  try {
    const updated = await api("PATCH", `/v1/connectors/${c.id}`, body);
    connectors = connectors.map((x) => (x.id === c.id ? updated : x));
    render();
  } catch (e) {
    toastError(e.message);
    render();
  }
}

async function remove(c) {
  try {
    await api("DELETE", `/v1/connectors/${c.id}`);
    connectors = connectors.filter((x) => x.id !== c.id);
    render();
    toast(`Removed ${c.name}.`);
  } catch (e) {
    toastError(e.message);
  }
}

// ---------- editor ----------
function openEditor(c) {
  const f = {
    name: el("input", {
      required: true,
      // browsers compile `pattern` with the `v` flag, where a bare "-" in a class is invalid
      pattern: "[A-Za-z0-9][A-Za-z0-9_\\-]{0,39}",
      value: c?.name ?? "",
      placeholder: "gmail",
      disabled: !!c,
    }),
    url: el("input", {
      type: "url",
      required: true,
      value: c?.url ?? "",
      placeholder: "https://mcp.example.com/mcp",
    }),
    scope: el(
      "select",
      {},
      el("option", { value: "user" }, "Just me"),
      el("option", { value: "tenant" }, "Whole organization"),
    ),
    headers: el("div", { class: "header-rows" }),
    error: el("p", { class: "error" }),
  };
  f.scope.value = c?.scope ?? "user";
  f.scope.disabled = !!c || !isAdmin();
  addHeaderRow(f.headers, c ? "" : "Authorization");
  const hint = c?.secretHeaders?.length
    ? `Leave empty to keep the stored ${c.secretHeaders.join(", ")}. Anything you enter replaces them.`
    : "Stored encrypted. You won't be able to see the values again.";
  $("#connector-editor").replaceChildren(
    el(
      "form",
      { class: "sheet", onsubmit: (e) => save(e, c, f) },
      el("h3", {}, c ? `Edit ${c.name}` : "Add a connector"),
      el(
        "div",
        { class: "form-row" },
        el("label", { class: "field" }, "Name", f.name),
        el("label", { class: "field" }, "Who can use it", f.scope),
      ),
      el("label", { class: "field" }, "Server URL", f.url),
      el("div", { class: "field" }, "Headers", el("span", { class: "hint" }, hint), f.headers),
      el(
        "div",
        {},
        el(
          "button",
          { class: "btn quiet sm", type: "button", onclick: () => addHeaderRow(f.headers, "") },
          icon("plus", "sm"),
          "Add header",
        ),
      ),
      f.error,
      el(
        "div",
        { class: "form-actions" },
        el("button", { class: "btn primary", type: "submit" }, c ? "Save changes" : "Add and test"),
        el("button", { class: "btn quiet", type: "button", onclick: closeEditor }, "Cancel"),
      ),
    ),
  );
  (c ? f.url : f.name).focus();
}

function addHeaderRow(box, name) {
  const row = el(
    "div",
    { class: "header-row" },
    el("input", {
      placeholder: "Header",
      value: name,
      "aria-label": "Header name",
      autocomplete: "off",
    }),
    el("input", {
      type: "password",
      placeholder: "Value, e.g. Bearer …",
      "aria-label": "Header value",
      autocomplete: "off",
    }),
    el(
      "button",
      {
        class: "btn quiet icon-only",
        type: "button",
        "aria-label": "Remove header",
        onclick: () => row.remove(),
      },
      icon("x", "sm"),
    ),
  );
  box.append(row);
}

function closeEditor() {
  $("#connector-editor").replaceChildren();
}

function headersOf(box) {
  const headers = {};
  for (const row of box.querySelectorAll(".header-row")) {
    const [name, value] = row.querySelectorAll("input");
    if (name.value.trim() && value.value) headers[name.value.trim()] = value.value;
  }
  return headers;
}

async function save(e, c, f) {
  e.preventDefault();
  const headers = headersOf(f.headers);
  try {
    if (c) {
      const body = { url: f.url.value.trim() };
      if (Object.keys(headers).length) body.headers = headers;
      await api("PATCH", `/v1/connectors/${c.id}`, body);
    } else {
      await api("POST", "/v1/connectors", {
        name: f.name.value.trim(),
        url: f.url.value.trim(),
        scope: f.scope.value,
        headers,
      });
    }
    closeEditor();
    await load();
    toast(c ? "Connector saved." : "Connector added. Testing it now.");
    if (!c) testLatest(f.name.value.trim());
  } catch (err) {
    f.error.textContent = err.message;
  }
}

/** After adding, run the test on the new row so the user sees its tools right away. */
function testLatest(name) {
  const c = connectors.find((x) => x.name === name);
  const row = [...document.querySelectorAll("#connector-list .row-item")].find(
    (r) => r.querySelector(".name")?.textContent === name,
  );
  const box = row?.parentElement?.querySelector(".tool-list");
  if (c && box) test(c, box);
}
