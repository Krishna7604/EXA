// AWS Signature Version 4 request signing (no AWS SDK). Used for Bedrock when the credential is
// an access key pair rather than a bearer API key.
import { createHash, createHmac } from "node:crypto";

// ---------- constants ----------
const ALGORITHM = "AWS4-HMAC-SHA256";
const SCOPE_TERMINATOR = "aws4_request";

// ---------- types ----------
export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

export interface SignV4Opts {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body: string;
  region: string;
  service: string;
  creds: AwsCredentials;
  now?: Date;
  /** Sign x-amz-content-sha256 (AWS services accept it; off only for the canonical test vectors). */
  contentSha256Header?: boolean;
}

interface CanonicalRequest {
  text: string;
  signedHeaders: string;
}

// ---------- signing ----------
/** Returns the request headers plus the AWS date/token headers and `Authorization`. */
export function signV4(opts: SignV4Opts): Record<string, string> {
  const amzDate = toAmzDate(opts.now ?? new Date());
  const date = amzDate.slice(0, 8);
  const payloadHash = sha256hex(opts.body);
  const headers = withAwsHeaders(opts, amzDate, payloadHash);
  const canonical = canonicalRequest(opts, headers, payloadHash);
  const scope = `${date}/${opts.region}/${opts.service}/${SCOPE_TERMINATOR}`;
  const toSign = [ALGORITHM, amzDate, scope, sha256hex(canonical.text)].join("\n");
  const signature = createHmac("sha256", signingKey(opts, date)).update(toSign).digest("hex");
  const credential = `${opts.creds.accessKeyId}/${scope}`;
  return {
    ...headers,
    Authorization: `${ALGORITHM} Credential=${credential}, SignedHeaders=${canonical.signedHeaders}, Signature=${signature}`,
  };
}

// ---------- helpers ----------
const sha256hex = (s: string | Uint8Array) => createHash("sha256").update(s).digest("hex");
const hmac = (k: string | Buffer, s: string) => createHmac("sha256", k).update(s).digest();

/** "2015-08-30T12:36:00.000Z" → "20150830T123600Z". */
function toAmzDate(now: Date): string {
  return now.toISOString().replace(/[:-]|\.\d{3}/g, "");
}

function withAwsHeaders(
  opts: SignV4Opts,
  amzDate: string,
  payloadHash: string,
): Record<string, string> {
  const shaHeader: Record<string, string> =
    opts.contentSha256Header === false ? {} : { "x-amz-content-sha256": payloadHash };
  const token = opts.creds.sessionToken;
  const tokenHeader: Record<string, string> = token ? { "x-amz-security-token": token } : {};
  return {
    ...opts.headers,
    host: opts.url.host,
    "x-amz-date": amzDate,
    ...shaHeader,
    ...tokenHeader,
  };
}

function canonicalRequest(
  opts: SignV4Opts,
  headers: Record<string, string>,
  payloadHash: string,
): CanonicalRequest {
  const lower = Object.fromEntries(
    Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v.trim().replace(/\s+/g, " ")]),
  );
  const signed = Object.keys(lower).sort();
  const signedHeaders = signed.join(";");
  const text = [
    opts.method,
    canonicalPath(opts.url),
    canonicalQuery(opts.url),
    signed.map((k) => `${k}:${lower[k]}\n`).join(""),
    signedHeaders,
    payloadHash,
  ].join("\n");
  return { text, signedHeaders };
}

/** Non-S3 services: each path segment is URI-encoded (again). */
function canonicalPath(url: URL): string {
  return url.pathname
    .split("/")
    .map((seg) => encodeRfc3986(seg))
    .join("/");
}

function canonicalQuery(url: URL): string {
  return [...url.searchParams.entries()]
    .map(([k, v]) => `${encodeRfc3986(k)}=${encodeRfc3986(v)}`)
    .sort()
    .join("&");
}

function signingKey(opts: SignV4Opts, date: string): Buffer {
  const kDate = hmac(`AWS4${opts.creds.secretAccessKey}`, date);
  return hmac(hmac(hmac(kDate, opts.region), opts.service), SCOPE_TERMINATOR);
}

function encodeRfc3986(s: string): string {
  return encodeURIComponent(s).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}
