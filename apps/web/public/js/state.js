// Shared client state: auth token, current user, chats, the open chat, tasks and the live stream.

import { store, TOKEN_KEY } from "./helpers/storage.helper.js";

// ---------- state ----------
export const state = {
  token: store.get(TOKEN_KEY),
  me: null,
  sessions: [],
  models: null,
  current: null, // { info, messages: Map, approvals: Map, busy, seq }
  stream: null,
  /** Scheduled tasks, loaded for the Tasks page and the home screen's "coming up" list. */
  tasks: null,
  /** Device-approval link opened while signed out; restored after login. */
  pendingHash: null,
};
