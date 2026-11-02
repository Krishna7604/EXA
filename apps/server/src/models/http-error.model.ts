// The typed error every layer throws for a request that can't be served. It carries only an
// HTTP status, a stable error code and a message; helpers/http.helper.ts turns it into JSON.
import { ERROR_CODES } from "../constants/errors.constants.ts";

// ---------- http error ----------
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code: string = ERROR_CODES.generic,
    readonly extra?: Record<string, unknown>,
  ) {
    super(message);
  }
}
