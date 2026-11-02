// Verifies the server's signed policy bundle (Ed25519 over canonical JSON) against the pinned key.

import { canonicalJson, type SignedPolicyBundle } from "@exa/protocol";

// ---------- constants ----------
const ALGORITHM = { name: "Ed25519" } as const;

// ---------- verify ----------
/** True only when the signature matches; malformed keys or signatures count as a mismatch. */
export async function verifyPolicy(
  signed: SignedPolicyBundle,
  publicKeyB64: string,
): Promise<boolean> {
  try {
    const pub = await crypto.subtle.importKey(
      "raw",
      Buffer.from(publicKeyB64, "base64"),
      ALGORITHM,
      false,
      ["verify"],
    );
    return await crypto.subtle.verify(
      ALGORITHM,
      pub,
      Buffer.from(signed.signature, "base64"),
      new TextEncoder().encode(canonicalJson(signed.bundle)),
    );
  } catch {
    return false;
  }
}
