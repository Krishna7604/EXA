// Shared client state: auth token, current user, session list and the open chat.

import { store, TOKEN_KEY } from "./helpers/storage.helper.js";

// ---------- state ----------
export const state = {
  token: store.get(TOKEN_KEY),
  me: null,
  sessions: [],
  models: null,
  current: null, // { info, messages: Map, approvals: Map, busy, seq }
  stream: null,
  /** Device-approval link opened while signed out; restored after login. */
  pendingHash: null,
};
