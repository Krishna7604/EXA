// BYOK key vault: envelope encryption. Each secret gets a random 256-bit data key (DEK);
// the secret is AES-256-GCM encrypted with the DEK, and the DEK is wrapped with the master
// key of the current version. The tenant id is bound in as AAD so a ciphertext copied to
// another tenant's row fails to decrypt. Plaintext keys never touch the database or logs.
//
// Master keys: EXA_MASTER_KEYS="1:<base64-32-bytes>,2:<base64-32-bytes>" (highest = current),
// or EXA_MASTER_KEY=<base64> as version 1. Swap the KeyWrapper for KMS in production.

// ---------- constants ----------
const enc = new TextEncoder();
const dec = new TextDecoder();

// ---------- types ----------
export interface SealedSecret {
  ciphertext: Uint8Array; // iv(12) || ct+tag
  wrappedDek: Uint8Array; // iv(12) || ct+tag
  keyVersion: number;
  last4: string;
}

// ---------- key vault ----------
export class KeyVault {
  private readonly masters = new Map<number, Promise<CryptoKey>>();
  readonly currentVersion: number;

  constructor(masterKeys: Record<number, Uint8Array>) {
    const versions = Object.keys(masterKeys).map(Number);
    if (!versions.length)
      throw new Error("vault: no master key configured (EXA_MASTER_KEY / EXA_MASTER_KEYS)");
    for (const v of versions) this.masters.set(v, importAes(masterKeys[v]));
    this.currentVersion = Math.max(...versions);
  }

  static fromEnv(env: Record<string, string | undefined> = process.env): KeyVault {
    const keys: Record<number, Uint8Array> = {};
    if (env.EXA_MASTER_KEYS) {
      for (const part of env.EXA_MASTER_KEYS.split(",")) {
        const [v, k] = part.split(":");
        if (v && k) keys[Number(v)] = b64(k.trim());
      }
    } else if (env.EXA_MASTER_KEY) keys[1] = b64(env.EXA_MASTER_KEY.trim());
    return new KeyVault(keys);
  }

  static generateMasterKey(): string {
    return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");
  }

  private master(v: number): Promise<CryptoKey> {
    const k = this.masters.get(v);
    if (!k) throw new Error(`vault: master key version ${v} not available`);
    return k;
  }

  async encrypt(tenantId: string, plaintext: string): Promise<SealedSecret> {
    const dekRaw = crypto.getRandomValues(new Uint8Array(32));
    const dek = await importAes(dekRaw);
    const ciphertext = await seal(dek, enc.encode(plaintext), `secret:${tenantId}`);
    const wrappedDek = await seal(
      await this.master(this.currentVersion),
      dekRaw,
      `dek:${tenantId}`,
    );
    dekRaw.fill(0);
    return { ciphertext, wrappedDek, keyVersion: this.currentVersion, last4: plaintext.slice(-4) };
  }

  async decrypt(
    tenantId: string,
    s: Pick<SealedSecret, "ciphertext" | "wrappedDek" | "keyVersion">,
  ): Promise<string> {
    const dekRaw = await open(await this.master(s.keyVersion), s.wrappedDek, `dek:${tenantId}`);
    const dek = await importAes(dekRaw);
    dekRaw.fill(0);
    return dec.decode(await open(dek, s.ciphertext, `secret:${tenantId}`));
  }

  /** Re-wrap a DEK under the current master version (rotation without touching ciphertext). */
  async rewrap(tenantId: string, s: SealedSecret): Promise<SealedSecret> {
    if (s.keyVersion === this.currentVersion) return s;
    const dekRaw = await open(await this.master(s.keyVersion), s.wrappedDek, `dek:${tenantId}`);
    const wrappedDek = await seal(
      await this.master(this.currentVersion),
      dekRaw,
      `dek:${tenantId}`,
    );
    dekRaw.fill(0);
    return { ...s, wrappedDek, keyVersion: this.currentVersion };
  }
}

// ---------- helpers ----------
function b64(s: string): Uint8Array {
  return Uint8Array.from(Buffer.from(s, "base64"));
}

async function importAes(raw: Uint8Array): Promise<CryptoKey> {
  if (raw.length !== 32) throw new Error("vault: keys must be 32 bytes");
  return crypto.subtle.importKey("raw", raw as Uint8Array<ArrayBuffer>, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

async function seal(key: CryptoKey, data: Uint8Array, aad: string): Promise<Uint8Array> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: enc.encode(aad) },
      key,
      data as Uint8Array<ArrayBuffer>,
    ),
  );
  const out = new Uint8Array(12 + ct.length);
  out.set(iv);
  out.set(ct, 12);
  return out;
}

async function open(key: CryptoKey, blob: Uint8Array, aad: string): Promise<Uint8Array> {
  return new Uint8Array(
    await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: blob.slice(0, 12), additionalData: enc.encode(aad) },
      key,
      blob.slice(12),
    ),
  );
}
