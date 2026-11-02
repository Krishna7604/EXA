// .env persistence — upsert KEY=VALUE lines, preserving comments.
// Used by /add-key + /use so terminal selections survive restarts.
// Never reads secrets into logs; callers only pass the one key being saved.
import { readFile, writeFile } from "node:fs/promises";

export function upsertEnvLine(content: string, key: string, value: string): string {
  const line = `${key}=${value}`;
  const re = new RegExp(`^${key}=.*$`, "m");
  if (re.test(content)) return content.replace(re, line);
  const trimmed = content.endsWith("\n") || content.length === 0 ? content : `${content}\n`;
  return `${trimmed}${line}\n`;
}

export async function saveKeysToEnvFile(file: string, entries: Record<string, string>): Promise<void> {
  let content = "";
  try {
    content = await readFile(file, "utf8");
  } catch {
    content = "";
  }
  for (const [k, v] of Object.entries(entries)) content = upsertEnvLine(content, k, v);
  await writeFile(file, content, "utf8");
}

export function envFilePath(): string {
  return process.env.EXA_ENV_FILE ?? ".env";
}
