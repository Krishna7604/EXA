// Response shapes returned by the exa server API.

export interface Me {
  user: { id: string; email: string };
  tenant: { id: string; slug: string };
  role: string;
  settings: Record<string, unknown>;
  locked: string[];
  byokAvailable: boolean;
}

export interface DevLoginResult {
  token: string;
  tenant: { id: string; slug: string };
  user: { id: string; email: string };
}

export interface DeviceStartResult {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  expiresIn: number;
  interval: number;
}

export interface DeviceToken {
  token: string;
  tenant: { slug: string };
  user: { email: string };
}

export interface ModelCatalog {
  exa: { available: boolean; tiers: Array<{ id: string; tier: string; backends: number }> };
  providers: Array<{ id: string; label: string; source: string }>;
}

export interface ProviderKey {
  id: string;
  provider: string;
  ownerScope: string;
  last4: string | null;
}

export interface UsageRow {
  day: string;
  model_used: string;
  requests: number;
  input: number;
  output: number;
  cost: number;
}

export interface PublishedSkill {
  name: string;
  description: string;
  body: string;
  scope: string;
}
