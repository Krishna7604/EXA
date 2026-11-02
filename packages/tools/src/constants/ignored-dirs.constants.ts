// Directory names every tree-walking tool (list, glob, grep) skips: VCS metadata, dependency
// folders, build output and tool caches.

// ---------- constants ----------
export const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  ".hg",
  ".svn",
  "dist",
  "build",
  ".next",
  ".turbo",
  ".cache",
  "__pycache__",
  ".venv",
  "venv",
  "target",
  ".idea",
  ".vscode",
  "coverage",
  ".pytest_cache",
  ".mypy_cache",
  ".gradle",
  "vendor",
]);
