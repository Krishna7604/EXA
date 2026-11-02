// Server configuration from the environment. Secrets are read once at boot.

import { homedir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_APPROVAL_TIMEOUT_MS,
  DEFAULT_MAX_BODY_BYTES,
} from "../constants/limits.constants.ts";

// ---------- constants ----------
const DEFAULT_PORT = 4317;
const DEFAULT_HOST = "127.0.0.1";
const MIN_JWT_SECRET_CHARS = 32;
const DEFAULT_SANDBOX_IMAGE = "oven/bun:1-debian";
const DEFAULT_OIDC_AUDIENCE = "exa";
const DEFAULT_IDLE_RUNTIME_MS = 30 * 60_000;

/** Provider env vars the platform pool picks up (each may be overridden as EXA_POOL_<NAME>). */
const POOL_VARS = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "GOOGLE_GENERATIVE_AI_KEY",
  "GEMINI_API_KEY",
  "GROQ_API_KEY",
  "DEEPSEEK_API_KEY",
  "XAI_API_KEY",
  "MISTRAL_API_KEY",
  "TOGETHER_API_KEY",
  "CEREBRAS_API_KEY",
  "OPENCODE_API_KEY",
  "AWS_BEARER_TOKEN_BEDROCK",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "BEDROCK_REGION",
  "AWS_REGION",
  "OLLAMA_BASE_URL",
];

// ---------- types ----------
type Env = Record<string, string | undefined>;

export interface ServerConfig {
  port: number;
  host: string;
  publicUrl: string;
  databaseUrl?: string;
  /** PGlite data dir when no DATABASE_URL (single-node / dev). Empty = in-memory. */
  dbDir?: string;
  dataDir: string;
  jwtSecret: string;
  devAuth: boolean;
  corsOrigins: string[];
  sandboxRoot: string;
  sandboxShell: "none" | "docker";
  sandboxImage: string;
  /** Platform pool credentials for the `exa` model (provider env vars). */
  pool: Record<string, string | undefined>;
  backendsJson?: string;
  oidc?: { issuer: string; audience: string; tenantClaim?: string; defaultTenant?: string };
  maxBodyBytes: number;
  approvalTimeoutMs: number;
  idleRuntimeMs: number;
}

// ---------- load config ----------
export function loadConfig(env: Env = process.env): ServerConfig {
  const dataDir = env.EXA_DATA_DIR ?? join(homedir(), ".exa", "server");
  const devAuth = env.EXA_DEV_AUTH === "1";
  const port = Number(env.PORT ?? env.EXA_PORT ?? DEFAULT_PORT);
  const host = env.EXA_HOST ?? DEFAULT_HOST;
  const jwtSecret = loadJwtSecret(env, devAuth);
  return {
    port,
    host,
    publicUrl: env.EXA_PUBLIC_URL ?? defaultPublicUrl(host, port),
    databaseUrl: env.DATABASE_URL || undefined,
    dbDir: dbDirFrom(env, dataDir),
    dataDir,
    jwtSecret,
    devAuth,
    corsOrigins: splitList(env.EXA_CORS_ORIGINS),
    sandboxRoot: env.EXA_SANDBOX_ROOT ?? join(dataDir, "sandboxes"),
    sandboxShell: env.EXA_SANDBOX_SHELL === "docker" ? "docker" : "none",
    sandboxImage: env.EXA_SANDBOX_IMAGE ?? DEFAULT_SANDBOX_IMAGE,
    pool: poolFrom(env),
    backendsJson: env.EXA_BACKENDS,
    oidc: oidcFrom(env),
    maxBodyBytes: Number(env.EXA_MAX_BODY_BYTES ?? DEFAULT_MAX_BODY_BYTES),
    approvalTimeoutMs: Number(env.EXA_APPROVAL_TIMEOUT_MS ?? DEFAULT_APPROVAL_TIMEOUT_MS),
    idleRuntimeMs: Number(env.EXA_IDLE_RUNTIME_MS ?? DEFAULT_IDLE_RUNTIME_MS),
  };
}

// ---------- helpers ----------
/** Required (≥32 chars) in production; dev gets a predictable insecure fallback. */
function loadJwtSecret(env: Env, devAuth: boolean): string {
  const isProduction = env.NODE_ENV === "production";
  let secret = env.EXA_JWT_SECRET ?? "";
  if (!secret) {
    if (!devAuth && isProduction) throw new Error("EXA_JWT_SECRET is required in production");
    secret = `dev-insecure-secret-change-me-${env.USER ?? "exa"}`;
  }
  if (secret.length < MIN_JWT_SECRET_CHARS && isProduction)
    throw new Error("EXA_JWT_SECRET must be at least 32 characters");
  return secret;
}

function defaultPublicUrl(host: string, port: number): string {
  const publicHost = host === "0.0.0.0" ? "localhost" : host;
  return `http://${publicHost}:${port}`;
}

/** EXA_DB_DIR=memory means an in-memory PGlite; unset means a directory under dataDir. */
function dbDirFrom(env: Env, dataDir: string): string | undefined {
  if (env.EXA_DB_DIR === "memory") return undefined;
  return env.EXA_DB_DIR ?? join(dataDir, "pg");
}

function splitList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function poolFrom(env: Env): Record<string, string | undefined> {
  const pool: Record<string, string | undefined> = {};
  for (const name of POOL_VARS) {
    const value = env[`EXA_POOL_${name}`] ?? env[name];
    if (value) pool[name] = value;
  }
  return pool;
}

function oidcFrom(env: Env): ServerConfig["oidc"] {
  if (!env.EXA_OIDC_ISSUER) return undefined;
  return {
    issuer: env.EXA_OIDC_ISSUER,
    audience: env.EXA_OIDC_AUDIENCE ?? DEFAULT_OIDC_AUDIENCE,
    tenantClaim: env.EXA_OIDC_TENANT_CLAIM,
    defaultTenant: env.EXA_OIDC_DEFAULT_TENANT,
  };
}
