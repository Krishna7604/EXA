// Bring-your-own provider keys: sealed with the server's KeyVault at rest; only the last four
// characters are ever returned.

import type { api } from "@exa/protocol";
import { getProvider } from "@exa/router";
import type { z } from "zod";
import { ERROR_CODES } from "../constants/errors.constants.ts";
import { isAdmin } from "../helpers/role.helper.ts";
import { HttpError } from "../models/http-error.model.ts";
import type { Principal } from "../models/principal.model.ts";
import type { ServiceDeps } from "./service-deps.ts";

// ---------- types ----------
type PutProviderKeyInput = z.infer<typeof api.PutProviderKeyBody>;

// ---------- key service ----------
export class KeyService {
  constructor(private readonly deps: ServiceDeps) {}

  list(p: Principal) {
    return this.deps.config.listKeys({ tenantId: p.tenantId, userId: p.userId });
  }

  /** BYOK needs a master key on the server; without one every key write is refused (503). */
  assertEnabled(): void {
    if (this.deps.vault) return;
    throw new HttpError(
      503,
      "BYOK is disabled: the server has no EXA_MASTER_KEY configured",
      ERROR_CODES.byokDisabled,
    );
  }

  async put(p: Principal, input: PutProviderKeyInput) {
    this.assertEnabled();
    if (!getProvider(input.provider))
      throw new HttpError(400, `unknown provider "${input.provider}"`, ERROR_CODES.validation);
    if (input.scope === "tenant" && !isAdmin(p))
      throw new HttpError(403, "only admins can set organization keys", ERROR_CODES.forbidden);
    const settings = await this.deps.settings(p);
    if (settings.values["byok.enabled"] === false)
      throw new HttpError(
        403,
        "your organization has disabled bring-your-own-key",
        ERROR_CODES.forbidden,
      );
    const sealed = await this.deps.vault!.encrypt(p.tenantId, input.key.trim());
    const id = await this.deps.config.putKey(
      { tenantId: p.tenantId, userId: p.userId },
      { ownerScope: input.scope, provider: input.provider, label: input.label, ...sealed },
    );
    this.deps.invalidate(p.tenantId);
    this.deps.telemetry.recordAudit({
      tenantId: p.tenantId,
      actorUserId: p.userId,
      action: "key.created",
      target: `${input.scope}:${input.provider}`,
      meta: { last4: sealed.last4 },
    });
    return { id, provider: input.provider, scope: input.scope, last4: sealed.last4 };
  }

  /** Admins may revoke org keys; everyone may revoke their own. */
  async revoke(p: Principal, keyId: string): Promise<void> {
    const owner = { tenantId: p.tenantId, userId: p.userId };
    const revoked = await this.deps.config.revokeKey(owner, keyId, isAdmin(p));
    if (!revoked) throw new HttpError(404, "key not found", ERROR_CODES.notFound);
    this.deps.invalidate(p.tenantId);
    this.deps.telemetry.recordAudit({
      tenantId: p.tenantId,
      actorUserId: p.userId,
      action: "key.revoked",
      target: keyId,
    });
  }
}
