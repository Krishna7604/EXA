// Authorizer port that asks the server to authorize server-checked tool calls.

import type { AuthorizerPort } from "@exa/core";
import type { ExaApi } from "../services/api.service.ts";

export function remoteAuthorizer(api: ExaApi): AuthorizerPort {
  return { authorize: (req) => api.authorize(req) };
}
