// The transport contract MCP clients talk through, plus the JSON-RPC shapes both
// transports (stdio and HTTP) share.

// ---------- constants ----------
export const MCP_PROTOCOL_VERSION = "2025-06-18";

// ---------- types ----------
export interface JsonRpcError {
  code: number;
  message: string;
}

/** Any JSON-RPC message: a response (id + result/error) or a request/notification (method). */
export interface JsonRpcMessage {
  id?: number | string;
  method?: string;
  result?: unknown;
  error?: JsonRpcError;
}

// ---------- transport ----------
export abstract class Transport {
  /** Send a request (resolves with its `result`) or, with expectResponse=false, a notification. */
  abstract send(
    msg: Record<string, unknown>,
    expectResponse: boolean,
    timeoutMs: number,
  ): Promise<unknown>;
  abstract close(): Promise<void>;
}

export function rpcError(error: JsonRpcError): Error {
  return new Error(`MCP error ${error.code}: ${error.message}`);
}
