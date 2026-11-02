// Data kept in ~/.exa: login credentials and local preferences.

import type { PermissionRule } from "@exa/protocol";

export interface Credentials {
  server: string;
  token: string;
  tenant: string;
  email: string;
  /** Pinned policy-signing public key (trust on first use at login). */
  policyKey: string;
}

export interface LocalConfig {
  model?: string;
  agent?: string;
  permissionMode?: string;
  storageMode?: string;
  /** Extra local rules for --local mode (no server policy). */
  rules?: PermissionRule[];
  instructions?: string[];
}
