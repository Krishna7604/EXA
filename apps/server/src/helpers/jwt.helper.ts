// HS256 JSON Web Tokens for browser sessions: sign and verify with a shared secret.

// ---------- constants ----------
const enc = new TextEncoder();
const dec = new TextDecoder();

// ---------- jwt ----------
export class Jwt {
  private readonly key: Promise<CryptoKey>;

  constructor(secret: string) {
    this.key = crypto.subtle.importKey(
      "raw",
      enc.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign", "verify"],
    );
  }

  async sign(claims: Record<string, unknown>, ttlSec: number): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    const head = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
    const payload = b64url(JSON.stringify({ ...claims, iat: now, exp: now + ttlSec }));
    const signed = enc.encode(`${head}.${payload}`);
    const sig = new Uint8Array(await crypto.subtle.sign("HMAC", await this.key, signed));
    return `${head}.${payload}.${b64url(sig)}`;
  }

  /** Claims of a valid, unexpired HS256 token; null for anything else. */
  // biome-ignore lint/suspicious/noExplicitAny: JWT claims are free-form JSON
  async verify(token: string): Promise<Record<string, any> | null> {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const [head, payload, sig] = parts;
    try {
      const header = JSON.parse(dec.decode(fromB64url(head)));
      if (header.alg !== "HS256") return null;
      const signed = enc.encode(`${head}.${payload}`);
      const ok = await crypto.subtle.verify("HMAC", await this.key, fromB64url(sig), signed);
      if (!ok) return null;
      const claims = JSON.parse(dec.decode(fromB64url(payload)));
      if (typeof claims.exp !== "number" || claims.exp < Date.now() / 1000) return null;
      return claims;
    } catch {
      // Malformed base64/JSON: treat exactly like a bad signature.
      return null;
    }
  }
}

// ---------- helpers ----------
function b64url(b: Uint8Array | string): string {
  return Buffer.from(typeof b === "string" ? enc.encode(b) : b).toString("base64url");
}

function fromB64url(s: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(Buffer.from(s, "base64url"));
}
