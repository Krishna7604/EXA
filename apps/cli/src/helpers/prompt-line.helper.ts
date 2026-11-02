// One-off line prompt on the terminal, for commands that run outside the interactive session.

import { createInterface } from "node:readline/promises";

/** Ask a single question on stdin and return the trimmed answer. */
export async function promptLine(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}
