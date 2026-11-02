// SSRF guard for outbound fetches: rejects hosts that are, or resolve to, private,
// loopback, link-local or cloud-metadata addresses.

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

// ---------- constants ----------
const PRIVATE_HOSTNAMES = new Set(["localhost", "metadata.google.internal"]);
const PRIVATE_HOST_SUFFIXES = [".localhost", ".internal"];
/** Loopback, RFC1918 10/8 and 192.168/16, link-local, and "this network". */
const PRIVATE_IPV4_PREFIX = /^(127\.|10\.|192\.168\.|169\.254\.|0\.)/;
/** RFC1918 172.16/12 is 172.16.x.x–172.31.x.x. */
const RFC1918_172 = /^172\.(\d+)\./;
const RFC1918_172_MIN = 16;
const RFC1918_172_MAX = 31;
/** Carrier-grade NAT, 100.64/10. */
const CGNAT_IPV4 = /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./;
const IPV6_LOOPBACK_OR_ANY = new Set(["::1", "::"]);
const IPV6_UNIQUE_LOCAL = /^f[cd][0-9a-f]{2}:/;
const IPV6_LINK_LOCAL_PREFIX = "fe80:";

// ---------- guard ----------
/** Resolve and reject private/link-local targets (blocks DNS names that point inside). */
export async function assertPublicHost(hostname: string): Promise<void> {
  if (isPrivateHost(hostname))
    throw new Error("Fetching private/internal network addresses is not allowed.");
  if (isIP(stripBrackets(hostname))) return;
  let addrs: Array<{ address: string }>;
  try {
    addrs = await lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new Error(`Could not resolve ${hostname}`);
  }
  if (addrs.some((a) => isPrivateHost(a.address)))
    throw new Error(`${hostname} resolves to a private/internal address; blocked.`);
}

// ---------- helpers ----------
function isPrivateHost(host: string): boolean {
  const h = stripBrackets(host.toLowerCase()).replace(/^::ffff:/, "");
  return isPrivateName(h) || isPrivateIpv4(h) || isPrivateIpv6(h);
}

function isPrivateName(h: string): boolean {
  return PRIVATE_HOSTNAMES.has(h) || PRIVATE_HOST_SUFFIXES.some((s) => h.endsWith(s));
}

function isPrivateIpv4(h: string): boolean {
  if (PRIVATE_IPV4_PREFIX.test(h)) return true;
  const m = h.match(RFC1918_172);
  if (m && Number(m[1]) >= RFC1918_172_MIN && Number(m[1]) <= RFC1918_172_MAX) return true;
  return CGNAT_IPV4.test(h);
}

function isPrivateIpv6(h: string): boolean {
  return (
    IPV6_LOOPBACK_OR_ANY.has(h) || IPV6_UNIQUE_LOCAL.test(h) || h.startsWith(IPV6_LINK_LOCAL_PREFIX)
  );
}

function stripBrackets(host: string): string {
  return host.replace(/^\[|\]$/g, "");
}
