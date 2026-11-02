// Finding an edit's target text in a file: exact match first, then line-ending and
// whitespace-tolerant fallbacks so near-miss copies from the model still land.

// ---------- types ----------
export interface TextRange {
  start: number;
  end: number;
}

// ---------- locate ----------
/** Locate `find` in `content`: exact first, then line-ending and whitespace-tolerant fallbacks. */
export function locate(content: string, find: string): Array<{ start: number; end: number }> {
  const exact = findAll(content, find);
  if (exact.length) return exact;
  // CRLF files edited with LF strings
  if (content.includes("\r\n") && !find.includes("\r\n")) {
    const crlf = findAll(content, find.replace(/\n/g, "\r\n"));
    if (crlf.length) return crlf;
  }
  return findTrimmedBlock(content, find);
}

// ---------- helpers ----------
function findAll(content: string, needle: string): TextRange[] {
  const out: TextRange[] = [];
  if (!needle) return out;
  let i = content.indexOf(needle);
  while (i !== -1) {
    out.push({ start: i, end: i + needle.length });
    i = content.indexOf(needle, i + needle.length);
  }
  return out;
}

/** Line-trimmed block match: same lines modulo leading/trailing whitespace. */
function findTrimmedBlock(content: string, find: string): TextRange[] {
  const findLines = find.replace(/\r\n/g, "\n").split("\n");
  while (findLines.length && findLines[findLines.length - 1].trim() === "") findLines.pop();
  if (!findLines.length) return [];
  const lines = content.split("\n");
  const offsets = lineOffsets(lines);
  const hits: TextRange[] = [];
  for (let i = 0; i + findLines.length <= lines.length; i++) {
    if (!blockMatchesAt(lines, findLines, i)) continue;
    const last = i + findLines.length - 1;
    hits.push({ start: offsets[i], end: offsets[last] + stripCr(lines[last]).length });
  }
  return hits;
}

/** Character offset of the start of each line. */
function lineOffsets(lines: string[]): number[] {
  const offsets: number[] = [];
  let acc = 0;
  for (const l of lines) {
    offsets.push(acc);
    acc += l.length + 1;
  }
  return offsets;
}

function blockMatchesAt(lines: string[], findLines: string[], at: number): boolean {
  for (let j = 0; j < findLines.length; j++) {
    if (stripCr(lines[at + j]).trim() !== findLines[j].trim()) return false;
  }
  return true;
}

function stripCr(line: string): string {
  return line.replace(/\r$/, "");
}
