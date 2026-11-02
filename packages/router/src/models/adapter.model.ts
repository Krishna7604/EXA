// Shapes every wire adapter shares: the injectable fetch and the per-call adapter options.

// ---------- types ----------
export type FetchFn = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface AdapterOpts {
  model: string;
  key?: string;
  baseURL: string;
  headers?: Record<string, string>;
  fetch?: FetchFn;
  signal: AbortSignal;
}
