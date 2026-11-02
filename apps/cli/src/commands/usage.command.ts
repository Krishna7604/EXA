// `exa usage`: daily model usage and cost from the server.

import type { ExaApi } from "../services/api.service.ts";

// ---------- constants ----------
const USAGE_DAYS = 30;
const MODEL_COLUMN_WIDTH = 40;
const REQUESTS_COLUMN_WIDTH = 5;
const COST_DECIMALS = 4;

// ---------- command ----------
export async function showUsage(api: ExaApi | null): Promise<void> {
  if (!api) return void console.log("usage needs a server login");
  for (const u of await api.usage(USAGE_DAYS)) {
    const day = String(u.day).slice(0, 10);
    const model = u.model_used.padEnd(MODEL_COLUMN_WIDTH);
    const requests = String(u.requests).padStart(REQUESTS_COLUMN_WIDTH);
    console.log(`${day}  ${model} ${requests} req  $${Number(u.cost).toFixed(COST_DECIMALS)}`);
  }
}
