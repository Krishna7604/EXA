// `exa keys` / `exa keys add <provider>`: list or add bring-your-own provider keys.

import { promptLine } from "../helpers/prompt-line.helper.ts";
import type { ExaApi } from "../services/api.service.ts";
import { color } from "../ui/color.ts";

// ---------- constants ----------
/** Move the cursor up one line and clear it, so the pasted key doesn't stay on screen. */
const ERASE_PREVIOUS_LINE = "\x1b[1A\x1b[2K";
const PROVIDER_COLUMN_WIDTH = 12;
const SCOPE_COLUMN_WIDTH = 7;

// ---------- command ----------
/** `args` are the positionals after `keys`. */
export async function keysCommand(api: ExaApi | null, args: string[]): Promise<void> {
  if (!api) {
    console.log(
      "BYOK keys are stored on the server; in --local mode set provider env vars instead",
    );
    return;
  }
  if (args[0] === "add") return addKey(api, args[1]);
  return listKeys(api);
}

// ---------- helpers ----------
async function addKey(api: ExaApi, providerArg: string | undefined): Promise<void> {
  const provider = providerArg ?? (await promptLine("provider: "));
  const key = await promptLine(
    `${provider} API key (input hidden is not supported; paste and press enter): `,
  );
  const r = await api.putKey(provider, key);
  process.stdout.write(ERASE_PREVIOUS_LINE);
  console.log(`${color.green("✓")} saved ${provider} key …${r.last4}`);
}

async function listKeys(api: ExaApi): Promise<void> {
  for (const k of await api.keys()) {
    const provider = k.provider.padEnd(PROVIDER_COLUMN_WIDTH);
    const scope = k.ownerScope.padEnd(SCOPE_COLUMN_WIDTH);
    console.log(`${provider} ${scope} …${k.last4 ?? ""}  ${color.gray(k.id)}`);
  }
}
