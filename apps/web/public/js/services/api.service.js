// JSON calls to the exa /v1 API with the bearer token; a 401 signs the user out.

import { state } from "../state.js";
import { logout } from "./auth.service.js";

// ---------- constants ----------
const HTTP_UNAUTHORIZED = 401;
const HTTP_NO_CONTENT = 204;

// ---------- api ----------
export async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: {
      ...(state.token ? { authorization: `Bearer ${state.token}` } : {}),
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === HTTP_UNAUTHORIZED) {
    logout();
    throw new Error("session expired — sign in again");
  }
  if (res.status === HTTP_NO_CONTENT) return null;
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error?.message ?? `${res.status} ${res.statusText}`);
  return data;
}
