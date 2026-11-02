// Size, count and time limits shared by more than one server module.

// ---------- constants ----------
/** Default cap for a JSON request body (config default and the body parser's fallback). */
export const DEFAULT_MAX_BODY_BYTES = 8 * 1024 * 1024;

/** How many months of usage/audit partitions are created ahead (boot + maintenance). */
export const PARTITION_MONTHS_AHEAD = 2;

/** How long a permission request waits for an answer (config default and approval-row TTL). */
export const DEFAULT_APPROVAL_TIMEOUT_MS = 15 * 60_000;
