// Policy signing: the server's Ed25519 key (from EXA_POLICY_SIGNING_KEY or generated once and
// persisted in the data dir), bundle signatures for client loops, and signature verification.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { canonicalJson, type PolicyBundle, type SignedPolicyBundle } from "@exa/protocol";

// ---------- constants ----------
const KEY_FILE_NAME = "policy-signing-key.pkcs8";
const KEY_ID_HEX_CHARS = 16;
const ED25519 = { name: "Ed25519" };
const KEY_DIR_MODE = 0o700;
const KEY_FILE_MODE = 0o600;

const enc = new TextEncoder();

// ---------- policy signer ----------
export class PolicySigner {
  private constructor(
    private readonly privateKey: CryptoKey,
    readonly publicKeyB64: string,
    readonly keyId: string,
  ) {}

  /** Ed25519 key from EXA_POLICY_SIGNING_KEY (pkcs8 b64) or generated + persisted in dataDir. */
  static async load(dataDir: string, envKey?: string): Promise<PolicySigner> {
    const pkcs8 = envKey ? fromBase64(envKey) : await loadOrCreateKey(dataDir);
    const privateKey = await crypto.subtle.importKey(
      "pkcs8",
      pkcs8 as Uint8Array<ArrayBuffer>,
      ED25519,
      true,
      ["sign"],
    );
    const publicKeyB64 = await publicKeyOf(privateKey);
    return new PolicySigner(privateKey, publicKeyB64, await keyIdOf(publicKeyB64));
  }

  async sign(bundle: PolicyBundle): Promise<SignedPolicyBundle> {
    const payload = enc.encode(canonicalJson(bundle));
    const sig = new Uint8Array(await crypto.subtle.sign(ED25519, this.privateKey, payload));
    return { bundle, signature: Buffer.from(sig).toString("base64"), keyId: this.keyId };
  }
}

export async function verifyBundle(
  signed: SignedPolicyBundle,
  publicKeyB64: string,
): Promise<boolean> {
  const publicKey = await crypto.subtle.importKey(
    "raw",
    Buffer.from(publicKeyB64, "base64"),
    ED25519,
    false,
    ["verify"],
  );
  return crypto.subtle.verify(
    ED25519,
    publicKey,
    Buffer.from(signed.signature, "base64"),
    enc.encode(canonicalJson(signed.bundle)),
  );
}

// ---------- helpers ----------
/** Reads the persisted signing key; on first boot (no file yet) generates and persists one. */
async function loadOrCreateKey(dataDir: string): Promise<Uint8Array> {
  const file = join(dataDir, KEY_FILE_NAME);
  try {
    return fromBase64((await readFile(file, "utf8")).trim());
  } catch {
    const pair = (await crypto.subtle.generateKey(ED25519, true, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
    await mkdir(dataDir, { recursive: true, mode: KEY_DIR_MODE });
    await writeFile(file, Buffer.from(pkcs8).toString("base64"), { mode: KEY_FILE_MODE });
    return pkcs8;
  }
}

/** Derives the public key via JWK export (`x` is the raw public key). */
async function publicKeyOf(privateKey: CryptoKey): Promise<string> {
  const jwk = (await crypto.subtle.exportKey("jwk", privateKey)) as JsonWebKey;
  return Buffer.from(jwk.x!, "base64url").toString("base64");
}

async function keyIdOf(publicKeyB64: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", Buffer.from(publicKeyB64, "base64"));
  return Buffer.from(digest).toString("hex").slice(0, KEY_ID_HEX_CHARS);
}

function fromBase64(b64: string): Uint8Array {
  return new Uint8Array(Buffer.from(b64, "base64"));
}
