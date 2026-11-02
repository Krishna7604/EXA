import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../app.ts";
import { loadConfig } from "../config/env.config.ts";
import { createServices, type Services } from "../container.ts";

const ISSUER = "https://idp.example";
let kp: CryptoKeyPair;
let jwk: JsonWebKey;
let s: Services;
let app: ReturnType<typeof createApp>;
let dir: string;

const b64url = (b: Uint8Array | string) =>
  Buffer.from(typeof b === "string" ? new TextEncoder().encode(b) : b).toString("base64url");
async function idToken(claims: Record<string, unknown>, key = kp.privateKey) {
  const h = b64url(JSON.stringify({ alg: "RS256", kid: "k1", typ: "JWT" }));
  const now = Math.floor(Date.now() / 1000);
  const p = b64url(
    JSON.stringify({
      iss: ISSUER,
      aud: "exa",
      sub: "u-1",
      email: "sso@corp.dev",
      email_verified: true,
      iat: now,
      exp: now + 300,
      ...claims,
    }),
  );
  const sig = new Uint8Array(
    await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(`${h}.${p}`)),
  );
  return `${h}.${p}.${b64url(sig)}`;
}

beforeAll(async () => {
  kp = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  jwk = {
    ...((await crypto.subtle.exportKey("jwk", kp.publicKey)) as JsonWebKey),
    kid: "k1",
  } as JsonWebKey;
  const fetchFn = (async (u: any) => {
    const url = String(u);
    if (url.endsWith("/.well-known/openid-configuration"))
      return Response.json({ issuer: ISSUER, jwks_uri: `${ISSUER}/jwks` });
    if (url.endsWith("/jwks")) return Response.json({ keys: [jwk] });
    return new Response("nope", { status: 404 });
  }) as unknown as typeof fetch;
  dir = await mkdtemp(join(tmpdir(), "exa-oidc-"));
  s = await createServices(
    loadConfig({
      EXA_DATA_DIR: dir,
      EXA_DB_DIR: "memory",
      EXA_JWT_SECRET: "x".repeat(40),
      EXA_OIDC_ISSUER: ISSUER,
      EXA_OIDC_AUDIENCE: "exa",
      EXA_OIDC_TENANT_CLAIM: "org",
    }),
    { fetch: fetchFn, vault: null },
  );
  app = createApp(s);
});
afterAll(async () => {
  await s.close();
  await rm(dir, { recursive: true, force: true });
});

const login = async (token: string) => {
  const r = await app.fetch(
    new Request("http://x/v1/auth/oidc", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ idToken: token }),
    }),
  );
  return { status: r.status, body: (await r.json()) as any };
};

describe("OIDC login", () => {
  test("valid token → tenant from claim, first user becomes owner, session works", async () => {
    const r = await login(await idToken({ org: "corp" }));
    expect(r.status).toBe(200);
    expect(r.body.role).toBe("owner");
    const me = await app.fetch(
      new Request("http://x/v1/me", { headers: { authorization: `Bearer ${r.body.token}` } }),
    );
    expect(((await me.json()) as any).tenant.slug).toBe("corp");
    const second = await login(await idToken({ org: "corp", sub: "u-2", email: "two@corp.dev" }));
    expect(second.body.role).toBe("member");
  });

  test("rejects bad signature, wrong audience, wrong issuer, expired, unverified email", async () => {
    const other = (await crypto.subtle.generateKey(
      {
        name: "RSASSA-PKCS1-v1_5",
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-256",
      },
      true,
      ["sign", "verify"],
    )) as CryptoKeyPair;
    expect((await login(await idToken({ org: "corp" }, other.privateKey))).status).toBe(401);
    expect((await login(await idToken({ org: "corp", aud: "someone-else" }))).status).toBe(401);
    expect((await login(await idToken({ org: "corp", iss: "https://evil" }))).status).toBe(401);
    expect((await login(await idToken({ org: "corp", exp: 1000 }))).status).toBe(401);
    expect((await login(await idToken({ org: "corp", email_verified: false }))).status).toBe(401);
  });

  test("dev login is off unless explicitly enabled", async () => {
    const r = await app.fetch(
      new Request("http://x/v1/auth/dev-login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "a@b.dev", tenant: "t" }),
      }),
    );
    expect(r.status).toBe(404);
  });
});
