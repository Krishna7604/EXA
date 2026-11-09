// Machine-readable error codes returned as `{ error: { code } }`. Clients match on these, so
// the string values must never change.

// ---------- constants ----------
export const ERROR_CODES = {
  generic: "error",
  internal: "internal",
  upstream: "upstream",
  notFound: "not_found",
  methodNotAllowed: "method_not_allowed",
  unauthorized: "unauthorized",
  forbidden: "forbidden",
  rateLimited: "rate_limited",
  validation: "validation",
  badJson: "bad_json",
  tooLarge: "too_large",
  conflict: "conflict",
  /** A per-user collection is full (e.g. memories); the body's `limit` says how many. */
  limitReached: "limit_reached",
  locked: "locked",
  badStorageMode: "bad_storage_mode",
  wrongHost: "wrong_host",
  leaseHeld: "lease_held",
  leaseLost: "lease_lost",
  byokDisabled: "byok_disabled",
  modelError: "model_error",
  noTenant: "no_tenant",
  authorizationPending: "authorization_pending",
  accessDenied: "access_denied",
  expiredToken: "expired_token",
} as const;

// ---------- types ----------
export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];
