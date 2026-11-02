// What every domain service may depend on: repos, the model gateway, the event bus, policy,
// the server runtime and the cached settings lookup. Built once by the composition root.

import type { EventBus } from "@exa/core";
import type { Gateway, KeyVault } from "@exa/router";
import type { ServerConfig } from "../config/env.config.ts";
import type { ResolvedSettings } from "../models/settings.model.ts";
import type { Subject } from "../models/subject.model.ts";
import type { ConfigRepo } from "../repositories/config.repository.ts";
import type { ExtensionsRepo } from "../repositories/extensions.repository.ts";
import type { IdentityRepo } from "../repositories/identity.repository.ts";
import type { SessionRepo } from "../repositories/session.repository.ts";
import type { TelemetryWriter } from "../repositories/telemetry.repository.ts";
import type { ApprovalBroker } from "../runtime/approval-broker.ts";
import type { ServerRuntime } from "../runtime/server-runtime.ts";
import type { OidcVerifier } from "./oidc-verifier.service.ts";
import type { PolicyService } from "./policy.service.ts";
import type { PolicySigner } from "./policy-signer.service.ts";
import type { PrincipalService } from "./principal.service.ts";

// ---------- types ----------
export interface ServiceDeps {
  cfg: ServerConfig;
  identity: IdentityRepo;
  config: ConfigRepo;
  sessions: SessionRepo;
  extensions: ExtensionsRepo;
  telemetry: TelemetryWriter;
  /** Null when BYOK is disabled (no master key configured). */
  vault: KeyVault | null;
  gateway: Gateway;
  bus: EventBus;
  policy: PolicyService;
  signer: PolicySigner;
  principals: PrincipalService;
  oidc: OidcVerifier | null;
  approvals: ApprovalBroker;
  runtime: ServerRuntime;
  /** Cached settings resolution (≈15 s); call `invalidate` after changing settings. */
  settings(subject: Subject): Promise<ResolvedSettings>;
  /** Drop every cached lookup for a tenant (settings, BYOK credentials, quota state). */
  invalidate(tenantId: string): void;
}
