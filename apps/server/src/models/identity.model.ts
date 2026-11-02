// Identity entities: tenants (organizations), users, memberships, API tokens and the CLI
// device-code login state.

// ---------- types ----------
export type Role = "owner" | "admin" | "member" | "viewer";

export interface Tenant {
  id: string;
  slug: string;
  name: string;
  plan: string;
  status: string;
  policyVersion: number;
}

export interface User {
  id: string;
  email: string;
  displayName: string | null;
}

export interface Membership {
  tenantId: string;
  userId: string;
  role: Role;
  status: string;
}

export interface NewApiToken {
  tenantId: string;
  userId: string;
  name?: string;
  deviceName?: string;
  scopes?: string[];
  ttlDays?: number;
}

/** A valid API token resolved back to its owner. */
export interface VerifiedApiToken {
  id: string;
  tenantId: string;
  userId: string;
  scopes: string[];
}

export interface NewDeviceCode {
  deviceCode: string;
  userCode: string;
  expiresIn: number;
}

export type DevicePollResult =
  | { status: "pending" | "expired" | "denied" }
  | { status: "approved"; tenantId: string; userId: string; clientName: string };
