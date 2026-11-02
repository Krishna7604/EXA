// Where a new session's message content lives ("none" | "local" | "server"), given what the
// client asked for, the org's settings and which side runs the agent loop.

import type { LoopHost, StorageMode } from "@exa/protocol";
import { ERROR_CODES } from "../constants/errors.constants.ts";
import { HttpError } from "../models/http-error.model.ts";
import type { ResolvedSettings } from "../models/settings.model.ts";

// ---------- constants ----------
const ALL_STORAGE_MODES: StorageMode[] = ["none", "local", "server"];

// ---------- storage mode ----------
/**
 * Precedence: a locked org mode, then the requested mode, then the org default, then the
 * host default. Throws when the caller explicitly asked for something that can't be honoured.
 */
export function resolveStorageMode(
  settings: ResolvedSettings,
  loopHost: LoopHost,
  requested?: StorageMode,
): StorageMode {
  const configuredAllowed = settings.values["storage.allowed"] as StorageMode[] | undefined;
  const allowed = configuredAllowed ?? ALL_STORAGE_MODES;
  const orgDefault = settings.values["storage.mode"] as StorageMode | null;
  const lockedMode = settings.locked.has("storage.mode") ? orgDefault : null;
  const hostDefault: StorageMode = loopHost === "client" ? "local" : "none";
  let mode: StorageMode = lockedMode ?? requested ?? orgDefault ?? hostDefault;

  // "local" means content stays on the client, which a server loop doesn't have.
  if (mode === "local" && loopHost === "server") {
    if (requested === "local" && !lockedMode) {
      throw new HttpError(
        400,
        'storage mode "local" needs a client loop (heavy client)',
        ERROR_CODES.badStorageMode,
      );
    }
    mode = "none";
  }
  if (allowed.includes(mode)) return mode;
  if (requested) {
    throw new HttpError(
      403,
      `storage mode "${mode}" is not allowed by your organization`,
      ERROR_CODES.forbidden,
    );
  }
  return firstUsableMode(allowed, loopHost);
}

// ---------- helpers ----------
function firstUsableMode(allowed: StorageMode[], loopHost: LoopHost): StorageMode {
  const usable = allowed.find((m) => m !== "local" || loopHost === "client");
  return usable ?? "none";
}
