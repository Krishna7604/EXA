// ~/.exa: credentials (0600) and local preferences.

import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Credentials, LocalConfig } from "../models/config.model.ts";

// ---------- constants ----------
export const EXA_HOME = process.env.EXA_HOME ?? join(homedir(), ".exa");
const DIR_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

// ---------- credentials ----------
export async function loadCredentials(): Promise<Credentials | null> {
  return readJson<Credentials>(credFile());
}

export async function saveCredentials(c: Credentials): Promise<void> {
  await mkdir(EXA_HOME, { recursive: true, mode: DIR_MODE });
  await writeFile(credFile(), JSON.stringify(c, null, 2), { mode: PRIVATE_FILE_MODE });
  // writeFile's mode only applies on create; tighten an existing file too
  await chmod(credFile(), PRIVATE_FILE_MODE);
}

export async function clearCredentials(): Promise<void> {
  await rm(credFile(), { force: true });
}

// ---------- local config ----------
export async function loadLocalConfig(): Promise<LocalConfig> {
  return (await readJson<LocalConfig>(cfgFile())) ?? {};
}

export async function saveLocalConfig(c: LocalConfig): Promise<void> {
  await mkdir(EXA_HOME, { recursive: true, mode: DIR_MODE });
  await writeFile(cfgFile(), JSON.stringify(c, null, 2), { mode: PRIVATE_FILE_MODE });
}

// ---------- helpers ----------
function credFile(): string {
  return join(EXA_HOME, "credentials.json");
}

function cfgFile(): string {
  return join(EXA_HOME, "config.json");
}

/** Parsed JSON, or null when the file is missing or invalid. */
async function readJson<T>(f: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(f, "utf8")) as T;
  } catch {
    return null;
  }
}
