// Tasks page: prompts exa runs on a schedule. List with enable switches, run-now and history;
// an editor with a plain-language schedule picker (or raw cron); templates to start from.

import { $, el } from "../helpers/dom.helper.js";
import { icon } from "../helpers/icons.helper.js";
import {
  dateTime,
  describeCron,
  fromCron,
  localTimezone,
  relativeTime,
  toCron,
  weekdayNames,
} from "../helpers/time.helper.js";
import { api } from "../services/api.service.js";
import { closeStream } from "../services/events.service.js";
import { state } from "../state.js";
import { show } from "./layout.view.js";
import { openMenu } from "./menu.view.js";
import { toast, toastError } from "./toast.view.js";

// ---------- constants ----------
const RUNS_SHOWN = 8;
const REPEATS = [
  ["daily", "Every day"],
  ["weekdays", "Weekdays"],
  ["weekly", "Every week"],
  ["hourly", "Every hour"],
  ["custom", "Custom (cron)"],
];
const TEMPLATES = {
  briefing: {
    name: "Morning briefing",
    prompt:
      "Give me a short morning briefing: the most important news in technology and AI since yesterday, anything notable in markets, and today's weather where I live (check your memory for my city). Keep it under 200 words, with links to sources.",
    schedule: "0 8 * * 1-5",
  },
};
const STATUS_PILLS = {
  ok: ["fern", "Last run fine"],
  error: ["rose", "Last run failed"],
  running: ["iris live", "Running"],
};
const RUN_LABELS = { running: "Running", ok: "Finished", error: "Failed" };

// ---------- tasks page ----------
export async function openTasks(hash = "#/tasks") {
  closeStream();
  state.current = null;
  show("tasks");
  const root = $("#tasks-root");
  root.replaceChildren(
    pageHead(),
    el("div", { id: "task-editor" }),
    el("div", { id: "task-list" }),
  );
  await loadTasks();
  const template = new URLSearchParams(hash.split("?")[1] ?? "").get("new");
  if (template) openEditor(TEMPLATES[template] ?? null);
}

// ---------- helpers ----------
function pageHead() {
  return el(
    "header",
    { class: "page-head" },
    el(
      "div",
      {},
      el("h1", {}, "Tasks"),
      el(
        "p",
        { class: "lede" },
        "Work exa does for you on a schedule. Each run becomes a chat you can open, and nothing that needs your approval happens without you.",
      ),
    ),
    el(
      "button",
      { class: "btn primary", type: "button", onclick: () => openEditor(null) },
      icon("plus", "sm"),
      "New task",
    ),
  );
}

async function loadTasks() {
  try {
    state.tasks = await api("GET", "/v1/tasks");
  } catch (e) {
    $("#task-list").replaceChildren(el("p", { class: "error" }, e.message));
    return;
  }
  renderList();
}

function renderList() {
  const list = $("#task-list");
  if (!state.tasks.length) return list.replaceChildren(emptyState());
  list.replaceChildren(el("div", { class: "rows" }, ...state.tasks.map(taskRow)));
}

function emptyState() {
  return el(
    "div",
    { class: "empty" },
    el("h3", {}, "No tasks yet"),
    el(
      "p",
      {},
      "Give exa something to do regularly, like a weekday news briefing, a weekly summary of a topic you follow, or a reminder to review your goals.",
    ),
    el(
      "div",
      { class: "form-actions" },
      el(
        "button",
        { class: "btn", type: "button", onclick: () => openEditor(TEMPLATES.briefing) },
        "Start from a morning briefing",
      ),
    ),
  );
}

function taskRow(t) {
  const toggle = el("input", {
    type: "checkbox",
    "aria-label": `Run ${t.name} on schedule`,
    onchange: (e) => setEnabled(t, e.target.checked),
  });
  toggle.checked = t.enabled;
  const history = el("div", { class: "runs hidden" });
  const meta = [el("span", {}, `${describeCron(t.schedule)} (${t.timezone})`)];
  if (t.enabled && t.nextRunAt)
    meta.push(el("span", { title: dateTime(t.nextRunAt) }, `Next ${relativeTime(t.nextRunAt)}`));
  if (!t.enabled) meta.push(el("span", {}, "Paused"));
  const pill = STATUS_PILLS[t.lastStatus];
  if (pill)
    meta.push(el("span", { class: `pill ${pill[0]}` }, el("span", { class: "led" }), pill[1]));
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
        el("div", { class: "name" }, t.name),
        el("div", { class: "task-prompt" }, t.prompt),
        el("div", { class: "meta" }, ...meta),
      ),
      el(
        "div",
        { class: "actions" },
        el(
          "button",
          { class: "btn sm", type: "button", onclick: () => runNow(t) },
          icon("play", "sm"),
          "Run now",
        ),
        el(
          "button",
          {
            class: "btn quiet icon-only",
            type: "button",
            "aria-label": `More for ${t.name}`,
            onclick: (e) => taskMenu(e.currentTarget, t, history),
          },
          icon("more"),
        ),
      ),
    ),
    history,
  );
}

function taskMenu(anchor, t, history) {
  openMenu(anchor, [
    { label: "Run history", icon: "list", onSelect: () => toggleHistory(t, history) },
    { label: "Edit", icon: "edit", onSelect: () => openEditor(t) },
    "-",
    { label: "Delete task", icon: "trash", danger: true, onSelect: () => confirmDelete(anchor, t) },
  ]);
}

function confirmDelete(anchor, t) {
  openMenu(anchor, [
    { meta: `Delete "${t.name}"? Its past runs stay in your chats.` },
    { label: "Delete task", icon: "trash", danger: true, onSelect: () => deleteTask(t) },
    { label: "Keep it", icon: "x", onSelect: () => {} },
  ]);
}

async function toggleHistory(t, box) {
  box.classList.toggle("hidden");
  if (box.classList.contains("hidden")) return;
  box.replaceChildren(el("p", { class: "faint small" }, "Loading runs…"));
  const runs = await api("GET", `/v1/tasks/${t.id}/runs`).catch((e) => {
    toastError(e.message);
    return [];
  });
  const rows = runs.slice(0, RUNS_SHOWN).map(runRow);
  box.replaceChildren(
    ...(rows.length ? rows : [el("p", { class: "faint small" }, "No runs yet.")]),
  );
}

function runRow(r) {
  const pill = STATUS_PILLS[r.status] ?? ["", r.status];
  const label = RUN_LABELS[r.status] ?? r.status;
  const attrs = { class: "run-row" };
  if (r.sessionId) attrs.href = `#/s/${r.sessionId}`;
  return el(
    r.sessionId ? "a" : "div",
    attrs,
    el("span", { class: "when" }, dateTime(r.time.started)),
    el("span", { class: `pill ${pill[0]}` }, el("span", { class: "led" }), label),
    el(
      "span",
      { class: "grow faint" },
      r.error ?? (r.trigger === "manual" ? "Run by you" : "On schedule"),
    ),
    r.cost ? el("span", { class: "faint" }, `$${Number(r.cost).toFixed(3)}`) : null,
  );
}

async function setEnabled(t, isEnabled) {
  try {
    const updated = await api("PATCH", `/v1/tasks/${t.id}`, { enabled: isEnabled });
    replaceTask(updated);
    toast(isEnabled ? `"${t.name}" will run on schedule.` : `Paused "${t.name}".`);
  } catch (e) {
    toastError(e.message);
    renderList();
  }
}

async function runNow(t) {
  try {
    const { sessionId } = await api("POST", `/v1/tasks/${t.id}/run`);
    toast(`Started "${t.name}".`);
    if (sessionId) location.hash = `#/s/${sessionId}`;
  } catch (e) {
    toastError(e.message);
  }
}

async function deleteTask(t) {
  try {
    await api("DELETE", `/v1/tasks/${t.id}`);
    state.tasks = state.tasks.filter((x) => x.id !== t.id);
    renderList();
    toast(`Deleted "${t.name}".`);
  } catch (e) {
    toastError(e.message);
  }
}

function replaceTask(updated) {
  state.tasks = state.tasks.map((x) => (x.id === updated.id ? updated : x));
  renderList();
}

// ---------- editor ----------
/** `task`: an existing task (edit), a template (prefill), or null (blank). */
function openEditor(task) {
  const isEdit = !!task?.id;
  const sched = fromCron(task?.schedule ?? "0 8 * * *");
  const f = editorFields(task, sched);
  const preview = el("p", { class: "cron-preview" });
  const refresh = () => {
    syncScheduleFields(f);
    preview.textContent = `${describeCron(toCron(scheduleOf(f)))} (${f.timezone.value || "UTC"})`;
  };
  for (const input of [f.repeat, f.time, f.day, f.cron, f.timezone])
    input.addEventListener("input", refresh);
  const error = el("p", { class: "error" });
  const sheet = el(
    "form",
    { class: "sheet", onsubmit: (e) => saveTask(e, task, f, error) },
    el("h3", {}, isEdit ? `Edit "${task.name}"` : "New task"),
    el("label", { class: "field" }, "Name", f.name),
    el("label", { class: "field" }, "What should exa do?", f.prompt),
    el(
      "div",
      { class: "task-when" },
      el("label", { class: "field" }, "Repeat", f.repeat),
      el("label", { class: "field", "data-for": "time" }, "Time", f.time),
      el("label", { class: "field", "data-for": "day" }, "Day", f.day),
      el("label", { class: "field", "data-for": "cron" }, "Cron expression", f.cron),
      el("label", { class: "field" }, "Time zone", f.timezone),
    ),
    preview,
    el("label", { class: "field" }, "Model", f.model),
    error,
    el(
      "div",
      { class: "form-actions" },
      el(
        "button",
        { class: "btn primary", type: "submit" },
        isEdit ? "Save changes" : "Create task",
      ),
      el("button", { class: "btn quiet", type: "button", onclick: closeEditor }, "Cancel"),
    ),
  );
  $("#task-editor").replaceChildren(sheet);
  refresh();
  f.name.focus();
}

function closeEditor() {
  $("#task-editor").replaceChildren();
}

function editorFields(task, sched) {
  const zones = el(
    "datalist",
    { id: "tz-list" },
    ...timezones().map((z) => el("option", { value: z })),
  );
  document.body.querySelector("#tz-list")?.remove();
  document.body.append(zones);
  return {
    name: el("input", {
      required: true,
      maxlength: 120,
      value: task?.name ?? "",
      placeholder: "Morning briefing",
    }),
    prompt: textarea(task?.prompt ?? ""),
    repeat: select(REPEATS, sched.repeat),
    time: el("input", { type: "time", value: sched.time }),
    day: select(
      weekdayNames().map((d, i) => [String(i), d]),
      String(sched.day),
    ),
    cron: el("input", { class: "mono", value: sched.cron ?? "", placeholder: "0 8 * * 1-5" }),
    timezone: el("input", {
      list: "tz-list",
      value: task?.timezone ?? localTimezone(),
      required: true,
    }),
    model: modelSelect(task?.model ?? ""),
  };
}

function syncScheduleFields(f) {
  const repeat = f.repeat.value;
  const showField = (name, isVisible) => {
    f[name].closest(".field").classList.toggle("hidden", !isVisible);
  };
  showField("time", repeat !== "custom");
  showField("day", repeat === "weekly");
  showField("cron", repeat === "custom");
}

function scheduleOf(f) {
  return {
    repeat: f.repeat.value,
    time: f.time.value,
    day: Number(f.day.value),
    cron: f.cron.value,
  };
}

async function saveTask(e, task, f, error) {
  e.preventDefault();
  const body = {
    name: f.name.value.trim(),
    prompt: f.prompt.value.trim(),
    schedule: toCron(scheduleOf(f)),
    timezone: f.timezone.value.trim() || "UTC",
    model: f.model.value || null,
  };
  try {
    const isEdit = !!task?.id;
    const saved = isEdit
      ? await api("PATCH", `/v1/tasks/${task.id}`, body)
      : await api("POST", "/v1/tasks", body);
    if (isEdit) replaceTask(saved);
    else {
      state.tasks = [saved, ...state.tasks];
      renderList();
    }
    closeEditor();
    toast(
      isEdit
        ? "Task saved."
        : `Created "${saved.name}". Next run ${relativeTime(saved.nextRunAt)}.`,
    );
  } catch (err) {
    error.textContent = err.message;
  }
}

function textarea(value) {
  const t = el("textarea", {
    rows: 4,
    required: true,
    maxlength: 20000,
    placeholder:
      "Summarize the top stories about … and send me the three that matter most, with links.",
  });
  t.value = value;
  return t;
}

function select(options, value) {
  const s = el("select", {}, ...options.map(([v, label]) => el("option", { value: v }, label)));
  s.value = value;
  return s;
}

/** The composer's model choices, plus "your default". */
function modelSelect(value) {
  const options = [
    ["", "Your default model"],
    ...[...$("#model-select").options].map((o) => [o.value, o.textContent]),
  ];
  const s = select(options, value);
  if (value && s.value !== value) {
    s.append(el("option", { value }, value));
    s.value = value;
  }
  return s;
}

function timezones() {
  try {
    return Intl.supportedValuesOf("timeZone");
  } catch {
    // older browsers: free text still works, the server validates it
    return [localTimezone(), "UTC"];
  }
}
