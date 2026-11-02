// Tools slice — arg shapes. No runtime code; import with `import type`.
export interface ReadArgs extends Record<string, unknown> {
  path: string;
}

export interface WriteArgs extends Record<string, unknown> {
  path: string;
  content: string;
}

export interface EditArgs extends Record<string, unknown> {
  path: string;
  oldString: string;
  newString: string;
}

export interface GlobArgs extends Record<string, unknown> {
  pattern: string;
}

export interface GrepArgs extends Record<string, unknown> {
  pattern: string;
  dir?: string;
}

export interface ShellArgs extends Record<string, unknown> {
  cmd: string;
}
