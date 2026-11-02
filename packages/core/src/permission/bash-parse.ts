// Minimal POSIX-ish shell tokenizer for permission checks. Permissions match the
// PARSED subcommands, not the raw string: `git commit -m "rm -rf /"` is one `git commit`
// command, while `ls && rm -rf x` is two. Unparseable input is reported so callers can
// fall back to asking.

// ---------- constants ----------
const OPERATORS = ["&&", "||", ";;", "|&", ";", "|", "&", "\n"];
const WORD_SEPARATORS = new Set([" ", "\t", "\r"]);
/** Leading `VAR=value` words are environment assignments, not the command. */
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const FD_NUMBER = /^\d+$/;
const FD_DUP_CHAR = /[0-9-]/;
/** Nested `$(...)` / backticks deeper than this make the input unparseable. */
const MAX_NESTING_DEPTH = 4;
/** Placeholder command for a bare redirection such as `> file`. */
const NO_OP_COMMAND = ":";

// Commands whose first N words identify the action (for "always allow" patterns).
const ARITY: Record<string, number> = {
  git: 2,
  npm: 2,
  pnpm: 2,
  yarn: 2,
  bun: 2,
  cargo: 2,
  go: 2,
  docker: 2,
  kubectl: 2,
  gh: 3,
  pip: 2,
  uv: 2,
  make: 2,
  brew: 2,
  deno: 2,
  npx: 2,
  bunx: 2,
  python: 2,
  python3: 2,
  node: 2,
  terraform: 2,
  aws: 3,
  gcloud: 3,
};
/** Subcommands that take one more identifying word: `npm run test`. */
const ARITY3: Record<string, Set<string>> = {
  npm: new Set(["run"]),
  pnpm: new Set(["run"]),
  yarn: new Set(["run"]),
  bun: new Set(["run"]),
};

// ---------- types ----------
export interface ParsedCommand {
  /** Normalized command: words joined by single spaces, leading VAR=x assignments removed. */
  text: string;
  words: string[];
  /** Files written via `>` / `>>` redirections. */
  writes: string[];
}

export interface ParseResult {
  commands: ParsedCommand[];
  ok: boolean;
  error?: string;
}

// ---------- parse ----------
export function parseShell(input: string, depth = 0): ParseResult {
  return new ShellParser(input, depth).parse();
}

/** Prefix used when the user picks "always": `git status *`, `npm run test *`, `ls *`. */
export function commandPrefix(cmd: ParsedCommand): string {
  const [head, second] = cmd.words;
  let n = ARITY[head] ?? 1;
  if (second && ARITY3[head]?.has(second)) n = 3;
  return cmd.words.slice(0, Math.min(n, cmd.words.length)).join(" ");
}

// ---------- shell parser ----------
/** Input that cannot be tokenized at all (unterminated quote or substitution). */
class ShellSyntaxError extends Error {}

class ShellParser {
  private readonly commands: ParsedCommand[] = [];
  private words: string[] = [];
  private writes: string[] = [];
  /** The word being built, and whether one has started (an empty "" still counts). */
  private cur = "";
  private hasCur = false;
  private i = 0;
  /** What the next word is: a redirect target (written or read) rather than an argument. */
  private pendingRedirect: null | "write" | "read" = null;
  private ok = true;
  private error: string | undefined;

  constructor(
    private readonly input: string,
    private readonly depth: number,
  ) {}

  parse(): ParseResult {
    try {
      while (this.i < this.input.length) this.step();
    } catch (e) {
      if (e instanceof ShellSyntaxError)
        return { commands: this.commands, ok: false, error: e.message };
      throw e;
    }
    this.pushCommand();
    return { commands: this.commands, ok: this.ok, error: this.error };
  }

  /** Consumes one token-level construct at `i`. */
  private step(): void {
    const { input, i } = this;
    const ch = input[i];
    const op = OPERATORS.find((o) => input.startsWith(o, i));
    if (op) this.endCommand(op.length);
    else if (WORD_SEPARATORS.has(ch)) this.endWord();
    else if (ch === "#" && !this.hasCur) this.skipComment();
    else if (ch === "\\") this.readEscape();
    else if (ch === "'") this.readSingleQuoted();
    else if (ch === '"') this.readDoubleQuoted();
    else if (this.startsSubstitution(i)) this.readSubstitution();
    // `)` ends a subshell (or a case pattern): always a command boundary when unquoted.
    // Subshell / group delimiters at a word start are command boundaries too.
    else if (ch === ")" || this.isGroupDelimiter(ch)) this.endCommand(1);
    else if (ch === ">" || ch === "<") this.readRedirect(ch);
    else this.readPlainChar(ch);
  }

  private endWord(): void {
    this.pushWord();
    this.i++;
  }

  private readPlainChar(ch: string): void {
    this.append(ch);
    this.i++;
  }

  private endCommand(length: number): void {
    this.pushCommand();
    this.i += length;
  }

  private skipComment(): void {
    while (this.i < this.input.length && this.input[this.i] !== "\n") this.i++;
  }

  private readEscape(): void {
    const next = this.input[this.i + 1];
    if (this.i + 1 < this.input.length && next !== "\n") this.append(next);
    this.i += 2;
  }

  private readSingleQuoted(): void {
    const end = this.input.indexOf("'", this.i + 1);
    if (end === -1) throw new ShellSyntaxError("unterminated single quote");
    this.append(this.input.slice(this.i + 1, end));
    this.i = end + 1;
  }

  /** Double quotes keep `\` escapes and still run substitutions inside them. */
  private readDoubleQuoted(): void {
    const { input } = this;
    let j = this.i + 1;
    let text = "";
    while (j < input.length && input[j] !== '"') {
      if (input[j] === "\\" && j + 1 < input.length) {
        text += input[j + 1];
        j += 2;
      } else if (this.startsSubstitution(j)) {
        const close = this.parseSubstitution(j);
        text += input.slice(j, close + 1);
        j = close + 1;
      } else {
        text += input[j];
        j++;
      }
    }
    if (j >= input.length) throw new ShellSyntaxError("unterminated double quote");
    this.append(text);
    this.i = j + 1;
  }

  private readSubstitution(): void {
    const close = this.parseSubstitution(this.i);
    this.append(this.input.slice(this.i, close + 1));
    this.i = close + 1;
  }

  private startsSubstitution(at: number): boolean {
    const ch = this.input[at];
    return ch === "`" || (ch === "$" && this.input[at + 1] === "(");
  }

  /** Parses the `$(...)` or backtick body at `at` as nested commands; returns its closing index. */
  private parseSubstitution(at: number): number {
    const isBacktick = this.input[at] === "`";
    const close = isBacktick ? this.input.indexOf("`", at + 1) : matchParen(this.input, at + 1);
    if (close === -1) {
      throw new ShellSyntaxError(isBacktick ? "unterminated backtick" : "unterminated $(");
    }
    const bodyStart = at + (isBacktick ? 1 : 2);
    this.parseNested(this.input.slice(bodyStart, close));
    return close;
  }

  private parseNested(src: string): void {
    if (this.depth > MAX_NESTING_DEPTH) {
      this.ok = false;
      this.error = "nesting too deep";
      return;
    }
    const result = parseShell(src, this.depth + 1);
    if (!result.ok) {
      this.ok = false;
      this.error = result.error;
    }
    this.commands.push(...result.commands);
  }

  /** `(` and `}` at a word start, or `{` followed by whitespace / end of input. */
  private isGroupDelimiter(ch: string): boolean {
    if (this.hasCur) return false;
    if (ch === "(" || ch === "}") return true;
    if (ch !== "{") return false;
    const next = this.input[this.i + 1];
    return next === " " || next === "\n" || this.i + 1 === this.input.length;
  }

  private readRedirect(ch: ">" | "<"): void {
    const { input } = this;
    // fd prefix like 2> or 2>&1
    if (this.hasCur && FD_NUMBER.test(this.cur)) {
      this.cur = "";
      this.hasCur = false;
    } else this.pushWord();
    let j = this.i + 1;
    if (input[j] === ">" || input[j] === "|") j++;
    if (input[j] === "&") {
      // >&2 or 2>&1: duplicate fd, no file
      j++;
      while (j < input.length && FD_DUP_CHAR.test(input[j])) j++;
      this.i = j;
      return;
    }
    if (ch === "<" && input[j] === "<") {
      // heredoc: skip the delimiter word, body is data
      this.pendingRedirect = "read";
      this.i = j + 1;
      return;
    }
    this.pendingRedirect = ch === ">" ? "write" : "read";
    this.i = j;
  }

  private append(text: string): void {
    this.cur += text;
    this.hasCur = true;
  }

  private pushWord(): void {
    if (!this.hasCur) return;
    if (this.pendingRedirect === "write") this.writes.push(this.cur);
    else if (this.pendingRedirect === null) this.words.push(this.cur);
    this.pendingRedirect = null;
    this.cur = "";
    this.hasCur = false;
  }

  private pushCommand(): void {
    this.pushWord();
    // strip leading env assignments
    let k = 0;
    while (k < this.words.length && ENV_ASSIGNMENT.test(this.words[k])) k++;
    const words = this.words.slice(k);
    if (words.length) this.commands.push({ text: words.join(" "), words, writes: this.writes });
    else if (this.writes.length) {
      this.commands.push({ text: NO_OP_COMMAND, words: [NO_OP_COMMAND], writes: this.writes });
    }
    this.words = [];
    this.writes = [];
  }
}

// ---------- helpers ----------
/** Index of the `)` closing the `(` at `open` (skipping single-quoted text), or -1. */
function matchParen(s: string, open: number): number {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === "(") depth++;
    else if (s[i] === ")") {
      depth--;
      if (depth === 0) return i;
    } else if (s[i] === "'") {
      const e = s.indexOf("'", i + 1);
      if (e === -1) return -1;
      i = e;
    }
  }
  return -1;
}
