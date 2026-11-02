// BYOK keystore — user-supplied keys only, never hardcoded, never logged.
// Sources: injected env (defaults to process.env; Bun auto-loads harness/.env).
// Display helpers only report presence ("set"/"missing"), never values.
// Types live in ./types.ts.

import { defaultCatalog, type ProviderCatalog } from "./providers.js";
import type { BedrockAuth, ProviderDef, ProviderId } from "./types.js";

export class Keystore {
  constructor(
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly catalog: ProviderCatalog = defaultCatalog,
  ) {}

  envValue(def: ProviderDef): string | undefined {
    for (const name of def.envVars) {
      const v = this.env[name]?.trim();
      if (v) return v;
    }
    return undefined;
  }

  hasKey(id: ProviderId): boolean {
    if (id === "bedrock") return this.bedrockAuth() !== null;
    const def = this.catalog.getProvider(id);
    return this.envValue(def) !== undefined;
  }

  requireKey(id: ProviderId): string {
    if (id === "bedrock") {
      const auth = this.bedrockAuth();
      if (!auth) {
        throw new Error(
          "missing Bedrock credentials. Option A (simplest): AWS_BEARER_TOKEN_BEDROCK=<bedrock-api-key> " +
            "Option B (SigV4): AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY (+ optional AWS_SESSION_TOKEN). " +
            "Set region via BEDROCK_REGION or AWS_REGION (default us-east-1). " +
            "Put them in harness/.env (see .env.example). Docs: https://docs.aws.amazon.com/bedrock/latest/userguide/api-keys.html",
        );
      }
      return auth.kind === "bearer" ? auth.token : auth.accessKeyId;
    }
    const def = this.catalog.getProvider(id);
    const v = this.envValue(def);
    if (!v) {
      throw new Error(
        `missing API key for ${def.label}. Set ${def.envVars.join(" or ")} in harness/.env (see .env.example). Docs: ${def.docs}`,
      );
    }
    return v;
  }

  /** First env var for a provider — the one /add-key writes. */
  primaryEnvVar(id: ProviderId): string {
    if (id === "bedrock") return "AWS_BEARER_TOKEN_BEDROCK";
    return this.catalog.getProvider(id).envVars[0];
  }

  /** Store a key in-memory for this run (persisted to .env by the CLI layer). */
  setKey(id: ProviderId, value: string): string {
    const name = this.primaryEnvVar(id);
    this.env[name] = value;
    return name;
  }

  /** Presence map for UI — { bedrock: true, openai: false, ... }. No secret values. */
  keyStatus(): Record<ProviderId, boolean> {
    return Object.fromEntries(this.catalog.list().map((p) => [p.id, this.hasKey(p.id)])) as Record<
      ProviderId,
      boolean
    >;
  }

  /** Providers with a key set — used to filter fallback chains. */
  availableProviders(): ProviderId[] {
    return this.catalog.list().filter((p) => this.hasKey(p.id)).map((p) => p.id);
  }

  /** Redact every known credential value out of text before logging/persisting. */
  redact(text: string): string {
    let out = text;
    const seen = new Set<string>();
    for (const p of this.catalog.list()) {
      for (const name of p.envVars) {
        const v = this.env[name]?.trim();
        if (v && v.length >= 4 && !seen.has(v)) {
          seen.add(v);
          if (out.includes(v)) out = out.split(v).join("***REDACTED***");
        }
        // redact `KEY=secret` style fragments generically
        out = out.replace(new RegExp(`${name}\\s*=\\s*['"]?[^\\s'"]+`, "g"), `${name}=***REDACTED***`);
      }
    }
    return out;
  }

  /** Region for bedrock-runtime endpoint. BEDROCK_REGION wins, then AWS_REGION. */
  bedrockRegion(): string {
    return this.env.BEDROCK_REGION?.trim() || this.env.AWS_REGION?.trim() || "us-east-1";
  }

  bedrockAuth(): BedrockAuth | null {
    const bearer = this.env.AWS_BEARER_TOKEN_BEDROCK?.trim();
    if (bearer) return { kind: "bearer", token: bearer };
    const accessKeyId = this.env.AWS_ACCESS_KEY_ID?.trim();
    const secretAccessKey = this.env.AWS_SECRET_ACCESS_KEY?.trim();
    if (accessKeyId && secretAccessKey) {
      return { kind: "sigv4", accessKeyId, secretAccessKey, sessionToken: this.env.AWS_SESSION_TOKEN?.trim() || undefined };
    }
    return null;
  }
}

export const defaultKeystore = new Keystore();

export function envValue(def: ProviderDef): string | undefined {
  return defaultKeystore.envValue(def);
}

export function hasKey(id: ProviderId): boolean {
  return defaultKeystore.hasKey(id);
}

export function requireKey(id: ProviderId): string {
  return defaultKeystore.requireKey(id);
}

/** Presence map for UI — { bedrock: true, openai: false, ... }. No secret values. */
export function keyStatus(): Record<ProviderId, boolean> {
  return defaultKeystore.keyStatus();
}

/** Providers with a key set — used to filter fallback chains. */
export function availableProviders(): ProviderId[] {
  return defaultKeystore.availableProviders();
}

/** Redact every known credential value out of text before logging/persisting. */
export function redact(text: string): string {
  return defaultKeystore.redact(text);
}

/** Region for bedrock-runtime endpoint. BEDROCK_REGION wins, then AWS_REGION. */
export function bedrockRegion(): string {
  return defaultKeystore.bedrockRegion();
}

export function bedrockAuth(): BedrockAuth | null {
  return defaultKeystore.bedrockAuth();
}
