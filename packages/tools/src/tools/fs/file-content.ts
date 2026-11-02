// Content checks shared by the file tools: line counting and binary detection.

// ---------- constants ----------
/** How many leading bytes to scan for a NUL when sniffing binary files. */
const BINARY_SNIFF_BYTES = 8000;

// ---------- file content ----------
export function countLines(s: string): number {
  return s ? s.split("\n").length : 0;
}

export function isBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, BINARY_SNIFF_BYTES);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}
