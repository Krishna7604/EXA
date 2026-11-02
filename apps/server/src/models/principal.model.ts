// The authenticated caller of a request: which tenant, which user, which role, and how they
// signed in (browser session or API token).
import type { Role } from "./identity.model.ts";

// ---------- types ----------
export interface Principal {
  tenantId: string;
  userId: string;
  role: Role;
  kind: "web" | "token";
  tokenId?: string;
  device?: string;
}
