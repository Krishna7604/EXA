// Model gateway and policy for client loops: open a model stream, list available models,
// hand out the signed policy bundle, and the server-side authorize check for tool calls.

import type {
  api,
  ModelError,
  ModelRequest,
  PermissionMode,
  SignedPolicyBundle,
} from "@exa/protocol";
import type { Gateway } from "@exa/router";
import type { z } from "zod";
import { ERROR_CODES } from "../constants/errors.constants.ts";
import { isAdmin } from "../helpers/role.helper.ts";
import { HttpError } from "../models/http-error.model.ts";
import type { Principal } from "../models/principal.model.ts";
import type { ServiceDeps } from "./service-deps.ts";

// ---------- constants ----------
const BAD_GATEWAY = 502;
const EXA_TIERS = ["fast", "balanced", "strong"] as const;
const MAX_AUDIT_TARGET_CHARS = 500;

// ---------- types ----------
type AuthorizeInput = z.infer<typeof api.AuthorizeBody>;
type ModelChunks = ReturnType<Gateway["stream"]>;

/** A model stream whose first chunk has already arrived (so errors surfaced as HTTP errors). */
export interface OpenedModelStream {
  first: IteratorResult<unknown>;
  rest: ModelChunks;
}

// ---------- model service ----------
export class ModelService {
  constructor(private readonly deps: ServiceDeps) {}

  /** Pulls the first chunk before committing to 200 so policy/key/quota errors get real statuses. */
  async openStream(
    p: Principal,
    req: ModelRequest,
    signal: AbortSignal,
  ): Promise<OpenedModelStream> {
    if (req.sessionId) await this.assertOwnSession(p, req.sessionId);
    const principal = { tenantId: p.tenantId, userId: p.userId, sessionId: req.sessionId };
    const chunks = this.deps.gateway.stream(principal, req, signal);
    try {
      return { first: await chunks.next(), rest: chunks };
    } catch (e) {
      throw modelHttpError(e as ModelError);
    }
  }

  /** The `exa` tiers with live backend counts, BYOK providers, and (admins only) raw backends. */
  async catalog(p: Principal) {
    const available = await this.deps.gateway.available({ tenantId: p.tenantId, userId: p.userId });
    const backends = this.deps.gateway.exa.status();
    const tiers = EXA_TIERS.map((tier) => ({
      id: tier === "balanced" ? "exa" : `exa/${tier}`,
      tier,
      backends: backends.filter((b) => b.tier === tier && b.available).length,
    }));
    return {
      exa: { available: available.exa, tiers },
      providers: available.providers,
      backends: isAdmin(p) ? backends : undefined,
    };
  }

  policyKey(): { publicKey: string; keyId: string; alg: "Ed25519" } {
    const signer = this.deps.signer;
    return { publicKey: signer.publicKeyB64, keyId: signer.keyId, alg: "Ed25519" };
  }

  policyBundle(p: Principal, projectId: string | null): Promise<SignedPolicyBundle> {
    return this.deps.policy.bundle({ tenantId: p.tenantId, userId: p.userId, projectId });
  }

  async authorize(p: Principal, input: AuthorizeInput) {
    const session = await this.assertOwnSession(p, input.sessionId);
    const subject = { tenantId: p.tenantId, userId: p.userId, projectId: session.projectId };
    const settings = await this.deps.settings(subject);
    const mode = this.deps.policy.effectiveMode(settings, session.permissionMode) as PermissionMode;
    const result = await this.deps.policy.authorize(subject, input, mode);
    this.deps.telemetry.recordAudit({
      tenantId: p.tenantId,
      actorUserId: p.userId,
      sessionId: input.sessionId,
      device: p.tokenId,
      action: "tool.authorize",
      target: `${input.tool}: ${input.patterns.join(" && ")}`.slice(0, MAX_AUDIT_TARGET_CHARS),
      decision: result.action,
      meta: result.reason ? { reason: result.reason } : undefined,
    });
    return result;
  }

  private async assertOwnSession(p: Principal, sessionId: string) {
    const session = await this.deps.sessions.get(p.tenantId, sessionId);
    if (!session || session.userId !== p.userId)
      throw new HttpError(404, "session not found", ERROR_CODES.notFound);
    return session;
  }
}

// ---------- helpers ----------
function modelHttpError(err: ModelError): HttpError {
  const status = err.status && err.status >= 400 ? err.status : BAD_GATEWAY;
  return new HttpError(status, err.message, ERROR_CODES.modelError, { retryable: !!err.retryable });
}
