// Parser for the "*** Begin Patch" envelope used by apply_patch (Add / Delete / Update File
// sections with @@ hunks of " ", "-" and "+" lines).

// ---------- constants ----------
const BEGIN_MARKER = "*** Begin Patch";
const END_MARKER = "*** End Patch";
const SECTION_PREFIX = "*** ";
const END_OF_FILE_MARKER = "*** End of File";
const MOVE_TO_PREFIX = "*** Move to: ";
const ADD_FILE_HEADER = /^\*\*\* Add File: (.+)$/;
const DELETE_FILE_HEADER = /^\*\*\* Delete File: (.+)$/;
const UPDATE_FILE_HEADER = /^\*\*\* Update File: (.+)$/;
const HUNK_HEADER_PREFIX = "@@";

// ---------- types ----------
export interface PatchChunk {
  old: string[];
  new: string[];
}

export type PatchOp =
  | { kind: "add"; path: string; content: string }
  | { kind: "delete"; path: string }
  | { kind: "update"; path: string; moveTo?: string; chunks: PatchChunk[] };

type UpdateOp = Extract<PatchOp, { kind: "update" }>;

/** The patch's lines plus a read position, advanced by the section parsers. */
interface Cursor {
  lines: string[];
  i: number;
}

// ---------- parse ----------
export function parsePatch(text: string): PatchOp[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const begin = lines.findIndex((l) => l.trim() === BEGIN_MARKER);
  if (begin === -1) throw new Error('patch must start with "*** Begin Patch"');
  const cur: Cursor = { lines, i: begin + 1 };
  const ops: PatchOp[] = [];
  while (cur.i < lines.length) {
    const line = lines[cur.i];
    if (line.trim() === END_MARKER) return ops;
    const op = parseSection(cur);
    if (op) {
      ops.push(op);
      continue;
    }
    if (line.trim() !== "") throw new Error(`unexpected patch line: ${line}`);
    cur.i++;
  }
  throw new Error('patch must end with "*** End Patch"');
}

// ---------- helpers ----------
/** Parse the file section starting at the cursor, or return null if the line isn't a header. */
function parseSection(cur: Cursor): PatchOp | null {
  const line = cur.lines[cur.i];
  const add = line.match(ADD_FILE_HEADER);
  if (add) return parseAddFile(cur, add[1].trim());
  const del = line.match(DELETE_FILE_HEADER);
  if (del) {
    cur.i++;
    return { kind: "delete", path: del[1].trim() };
  }
  const update = line.match(UPDATE_FILE_HEADER);
  if (update) return parseUpdateFile(cur, update[1].trim());
  return null;
}

function parseAddFile(cur: Cursor, path: string): PatchOp {
  const content: string[] = [];
  cur.i++;
  while (cur.i < cur.lines.length && !cur.lines[cur.i].startsWith(SECTION_PREFIX)) {
    const line = cur.lines[cur.i];
    if (!line.startsWith("+")) throw new Error(`Add File lines must start with "+": ${line}`);
    content.push(line.slice(1));
    cur.i++;
  }
  return { kind: "add", path, content: content.join("\n") + (content.length ? "\n" : "") };
}

function parseUpdateFile(cur: Cursor, path: string): UpdateOp {
  const op: UpdateOp = { kind: "update", path, chunks: [] };
  cur.i++;
  if (cur.lines[cur.i]?.startsWith(MOVE_TO_PREFIX)) {
    op.moveTo = cur.lines[cur.i].slice(MOVE_TO_PREFIX.length).trim();
    cur.i++;
  }
  let chunk: PatchChunk | null = null;
  while (cur.i < cur.lines.length && !isSectionEnd(cur.lines[cur.i])) {
    chunk = parseHunkLine(op, chunk, cur.lines[cur.i]);
    cur.i++;
  }
  return op;
}

/** Any "*** " line ends an Update section, except the "*** End of File" marker. */
function isSectionEnd(line: string): boolean {
  return line.startsWith(SECTION_PREFIX) && !line.startsWith(END_OF_FILE_MARKER);
}

/** Apply one line of an Update section; returns the chunk subsequent lines belong to. */
function parseHunkLine(op: UpdateOp, chunk: PatchChunk | null, line: string): PatchChunk | null {
  if (line.startsWith(HUNK_HEADER_PREFIX)) return startChunk(op);
  if (line.startsWith(END_OF_FILE_MARKER)) return chunk; // marker only
  const target = chunk ?? startChunk(op);
  const tag = line[0] ?? " ";
  const body = line.slice(1);
  if (tag === " " || line === "") {
    target.old.push(body);
    target.new.push(body);
  } else if (tag === "-") target.old.push(body);
  else if (tag === "+") target.new.push(body);
  else throw new Error(`invalid patch line: ${line}`);
  return target;
}

function startChunk(op: UpdateOp): PatchChunk {
  const chunk: PatchChunk = { old: [], new: [] };
  op.chunks.push(chunk);
  return chunk;
}
