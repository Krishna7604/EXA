// Live session events: the SSE subscription (with reconnect) and applying events to the open chat.

import { $ } from "../helpers/dom.helper.js";
import { md } from "../helpers/markdown.helper.js";
import { state } from "../state.js";
import { alertLine, renderApprovals } from "../views/approvals.view.js";
import { openSession, renderHeader } from "../views/chat.view.js";
import { rerenderMessage } from "../views/messages.view.js";
import { refreshSessions } from "../views/sidebar.view.js";

// ---------- constants ----------
const INITIAL_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 10000;
const TODO_MARKS = { pending: "☐", in_progress: "◐", completed: "☑", cancelled: "☒" };

// ---------- event stream ----------
export function closeStream() {
  state.stream?.abort();
  state.stream = null;
}

/** Follow a session's events from `after`, reconnecting with backoff until closeStream(). */
export async function subscribe(id, after) {
  const ac = new AbortController();
  state.stream = ac;
  let last = after;
  let backoff = INITIAL_BACKOFF_MS;
  while (!ac.signal.aborted) {
    try {
      const res = await fetch(`/v1/sessions/${id}/events`, {
        headers: { authorization: `Bearer ${state.token}`, "last-event-id": String(last ?? 0) },
        signal: ac.signal,
      });
      if (!res.ok) throw new Error(String(res.status));
      backoff = INITIAL_BACKOFF_MS;
      for await (const e of readEvents(res.body)) {
        if (e.seq) last = e.seq;
        applyEvent(e);
      }
    } catch (_err) {
      if (ac.signal.aborted) return;
      // dropped or refused: retry after the backoff
    }
    await new Promise((r) => setTimeout(r, backoff));
    backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
  }
}

// ---------- helpers ----------
/** Parse an SSE body into JSON events (frames end with a blank line; `data:` lines joined). */
async function* readEvents(body) {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buf += dec.decode(value, { stream: true });
    let end = buf.indexOf("\n\n");
    while (end !== -1) {
      const data = frameData(buf.slice(0, end));
      buf = buf.slice(end + 2);
      if (data) yield JSON.parse(data);
      end = buf.indexOf("\n\n");
    }
  }
}

function frameData(frame) {
  return frame
    .split("\n")
    .filter((l) => l.startsWith("data:"))
    .map((l) => l.slice(5).trimStart())
    .join("\n");
}

function applyEvent(e) {
  const c = state.current;
  if (!c || e.sessionId !== c.info.id) return;
  if (e.seq) c.seq = e.seq;
  if (Object.hasOwn(EVENT_HANDLERS, e.type)) EVENT_HANDLERS[e.type](c, e.data);
}

/** Event type → (current chat, event data) handler; other event types are ignored. */
const EVENT_HANDLERS = {
  "message.updated": onMessageUpdated,
  "message.part.updated": onPartUpdated,
  "message.part.delta": onPartDelta,
  "message.removed": (c, d) => {
    c.messages.delete(d.messageId);
    document.querySelector(`[data-msg="${d.messageId}"]`)?.remove();
  },
  "permission.asked": (c, d) => {
    c.approvals.set(d.request.id, d.request);
    renderApprovals();
  },
  "permission.replied": (c, d) => {
    c.approvals.delete(d.requestId);
    renderApprovals();
  },
  "session.status": (c, d) => {
    c.busy = d.status !== "idle";
    renderHeader();
  },
  "session.idle": (c) => {
    c.busy = false;
    renderHeader();
    refreshSessions().catch(() => {});
  },
  "session.updated": (c, d) => {
    Object.assign(c.info, d.info);
    renderHeader();
    if (d.info.title) refreshSessions().catch(() => {});
  },
  "session.error": (_c, d) => alertLine(d.error.message),
  "todo.updated": (_c, d) => renderTodos(d.todos),
  "session.resync": (c) => openSession(c.info.id),
};

function onMessageUpdated(c, d) {
  const cur = c.messages.get(d.info.id);
  if (cur) cur.info = d.info;
  else c.messages.set(d.info.id, { info: d.info, parts: new Map() });
  rerenderMessage(d.info.id);
}

function onPartUpdated(c, d) {
  const m = c.messages.get(d.part.messageId) ?? addPlaceholderMessage(c, d.part.messageId);
  const prev = m.parts.get(d.part.id);
  // keep streamed text if the update is the empty opening snapshot
  const isTextual = d.part.type === "text" || d.part.type === "reasoning";
  if (prev && isTextual && prev.text && !d.part.text) return;
  m.parts.set(d.part.id, d.part);
  rerenderMessage(m.info.id);
}

/** A part can arrive before its message; create a stub assistant message for it. */
function addPlaceholderMessage(c, messageId) {
  const m = {
    info: { id: messageId, role: "assistant", model: c.info.model },
    parts: new Map(),
  };
  c.messages.set(messageId, m);
  return m;
}

function onPartDelta(c, d) {
  const m = c.messages.get(d.messageId);
  const p = m?.parts.get(d.partId);
  if (!p) return;
  p.text = (p.text ?? "") + d.delta;
  if (p.type !== "text") return;
  const node = document.querySelector(`[data-part="${d.partId}"]`);
  if (node) node.innerHTML = md(p.text);
  else rerenderMessage(m.info.id);
}

function renderTodos(todos) {
  const box = $("#todos");
  box.textContent = todos.map((t) => `${TODO_MARKS[t.status] ?? "·"} ${t.content}`).join("   ");
  box.classList.toggle("hidden", !todos.length);
}
