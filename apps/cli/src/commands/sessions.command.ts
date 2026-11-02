// `exa sessions`: list recent server sessions.

import type { ExaApi } from "../services/api.service.ts";
import { color } from "../ui/color.ts";

// ---------- constants ----------
const SESSION_LIMIT = 30;

// ---------- command ----------
export async function listSessions(api: ExaApi | null): Promise<void> {
  if (!api) {
    console.log("sessions list needs a server login; local sessions live in ~/.exa/sessions");
    return;
  }
  for (const s of await api.sessions(SESSION_LIMIT)) {
    const updated = new Date(s.time.updated).toLocaleString();
    const title = s.title ?? color.gray("(untitled)");
    console.log(`${s.id}  ${updated}  ${s.loopHost}/${s.storageMode}  ${title}`);
  }
}
