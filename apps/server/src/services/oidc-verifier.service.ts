// OIDC ID-token verification for an external IdP: RS256/ES256 signatures checked against the
// issuer's JWKS (discovered via .well-known/openid-configuration and cached for an hour).

import { ERROR_CODES } from "../constants/errors.constants.ts";
import { HttpError } from "../models/http-error.model.ts";

// ---------- constants ----------
const JWKS_TTL_MS = 3600_000;
/** Tolerated clock skew when checking `exp`. */
const CLOCK_SKEW_SEC = 60;

const enc = new TextEncoder();
const dec = new TextDecoder();

// ---------- types ----------
interface Jwk {
  kid?: string;
  kty: string;
  alg?: string;
  n?: string;
  e?: string;
  crv?: string;
  x?: string;
  y?: string;
}

// biome-ignore lint/suspicious/noExplicitAny: ID-token claims are free-form JSON
type Claims = Record<string, any>;

export interface VerifiedIdentity {
  /** `issuer|sub`, stable across email changes. */
  sub: string;
  email: string;
  name?: string;
  claims: Claims;
}

interface VerificationKey {
  key: CryptoKey;
  algorithm: AlgorithmIdentifier | EcdsaParams;
}

// ---------- oidc verifier ----------
export class OidcVerifier {
  private jwks: { fetchedAt: number; keys: Jwk[] } | null = null;

  constructor(
    private readonly issuer: string,
    private readonly audience: string,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  async verify(idToken: string): Promise<VerifiedIdentity> {
    const [head, payload, sig] = idToken.split(".");
    if (!head || !payload || !sig) throw unauthorized("malformed id token");
    const header = JSON.parse(dec.decode(fromB64url(head)));
    const claims: Claims = JSON.parse(dec.decode(fromB64url(payload)));
    const jwk = (await this.keys()).find((k) => !header.kid || k.kid === header.kid);
    if (!jwk) throw unauthorized("unknown signing key");
    const { key, algorithm } = await importVerificationKey(header.alg, jwk);
    const signed = enc.encode(`${head}.${payload}`);
    const ok = await crypto.subtle.verify(algorithm, key, fromB64url(sig), signed);
    if (!ok) throw unauthorized("bad id token signature");
    this.checkClaims(claims);
    return { sub: `${claims.iss}|${claims.sub}`, email: claims.email, name: claims.name, claims };
  }

  private async keys(): Promise<Jwk[]> {
    if (this.jwks && Date.now() - this.jwks.fetchedAt < JWKS_TTL_MS) return this.jwks.keys;
    const discoveryUrl = `${this.issuer.replace(/\/$/, "")}/.well-known/openid-configuration`;
    const discovery = await (await this.fetchFn(discoveryUrl)).json();
    const jwks = await (await this.fetchFn(discovery.jwks_uri)).json();
    this.jwks = { fetchedAt: Date.now(), keys: jwks.keys ?? [] };
    return this.jwks.keys;
  }

  private checkClaims(claims: Claims): void {
    const now = Date.now() / 1000;
    if (claims.iss !== this.issuer) throw unauthorized("issuer mismatch");
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!audiences.includes(this.audience)) throw unauthorized("audience mismatch");
    if (typeof claims.exp !== "number" || claims.exp < now - CLOCK_SKEW_SEC)
      throw unauthorized("id token expired");
    if (!claims.email || claims.email_verified === false)
      throw unauthorized("verified email required");
  }
}

// ---------- helpers ----------
async function importVerificationKey(alg: string, jwk: Jwk): Promise<VerificationKey> {
  if (alg === "RS256") {
    const params = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" };
    const key = await crypto.subtle.importKey("jwk", jwk as JsonWebKey, params, false, ["verify"]);
    return { key, algorithm: "RSASSA-PKCS1-v1_5" };
  }
  if (alg === "ES256") {
    const params = { name: "ECDSA", namedCurve: "P-256" };
    const key = await crypto.subtle.importKey("jwk", jwk as JsonWebKey, params, false, ["verify"]);
    return { key, algorithm: { name: "ECDSA", hash: "SHA-256" } };
  }
  throw unauthorized(`unsupported alg ${alg}`);
}

function unauthorized(message: string): HttpError {
  return new HttpError(401, message, ERROR_CODES.unauthorized);
}

function fromB64url(s: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(Buffer.from(s, "base64url"));
}
