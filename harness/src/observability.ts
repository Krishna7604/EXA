// Observability — Phase 5: tokens, cost, latency, tool trace per run.
// Keys are redacted before console/persist — never write secrets to runs.jsonl.
// Types live in ./types.ts.
import { appendFile, mkdir } from "node:fs/promises";
import { defaultKeystore, type Keystore } from "./router/keystore.js";
import type { RunEntry } from "./types.js";

export class RunLogger {
  constructor(
    private readonly keystore: Keystore = defaultKeystore,
    private readonly file: string = "work/runs.jsonl",
  ) {}

  async logRun(entry: RunEntry): Promise<void> {
    await mkdir("work", { recursive: true });
    const safe = JSON.parse(this.keystore.redact(JSON.stringify({ ts: Date.now(), ...entry }))) as Record<string, unknown>;
    await appendFile(this.file, JSON.stringify(safe) + "\n");
    console.log(`[obs] run=${String(safe.correlationId ?? "?")} model=${String(safe.model ?? "?")} ms=${String(safe.ms ?? "?")}`);
  }
}

export const defaultLogger = new RunLogger();

export async function logRun(entry: RunEntry): Promise<void> {
  return defaultLogger.logRun(entry);
}
