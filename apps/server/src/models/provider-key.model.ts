// BYOK provider key shapes. Keys are only ever held as ciphertext + a wrapped data key.

// ---------- types ----------
export type KeyOwnerScope = "tenant" | "user";

export interface NewProviderKey {
  ownerScope: KeyOwnerScope;
  provider: string;
  label?: string;
  ciphertext: Uint8Array;
  wrappedDek: Uint8Array;
  keyVersion: number;
  last4: string;
}

export interface StoredProviderKey {
  id: string;
  ownerScope: KeyOwnerScope;
  ciphertext: Uint8Array;
  wrappedDek: Uint8Array;
  keyVersion: number;
}

export interface ProviderKeySummary {
  id: string;
  provider: string;
  ownerScope: string;
  label: string | null;
  last4: string | null;
  createdAt: string;
  lastUsedAt: string | null;
}
