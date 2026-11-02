// Which HTTP statuses from a model provider are worth retrying.

// ---------- constants ----------
/** Timeout, conflict, too-early and rate-limit responses are worth retrying. */
const RETRYABLE_STATUSES = new Set([408, 409, 425, 429]);
const SERVER_ERROR_MIN = 500;
const SERVER_ERROR_MAX = 600;
/** Status 0 means the request never got a response (network failure). */
const NO_RESPONSE_STATUS = 0;

// ---------- retry ----------
export function isRetryableStatus(status: number): boolean {
  if (RETRYABLE_STATUSES.has(status)) return true;
  if (status >= SERVER_ERROR_MIN && status < SERVER_ERROR_MAX) return true;
  return status === NO_RESPONSE_STATUS;
}
