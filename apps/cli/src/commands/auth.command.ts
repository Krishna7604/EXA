// Account commands: `exa login` (device or dev login), `exa logout` and `exa whoami`.

import type { CliFlags } from "../config/args.config.ts";
import { clearCredentials, saveCredentials } from "../config/exa-home.config.ts";
import { promptLine } from "../helpers/prompt-line.helper.ts";
import type { Credentials } from "../models/config.model.ts";
import { ExaApi } from "../services/api.service.ts";
import { color } from "../ui/color.ts";

// ---------- constants ----------
const DEFAULT_SERVER = "http://127.0.0.1:4317";
const MS_PER_SECOND = 1000;

// ---------- types ----------
interface LoginResult {
  token: string;
  tenant: string;
  email: string;
}

// ---------- commands ----------
/** Log in to a server and store credentials plus the pinned policy key. */
export async function login(flags: CliFlags): Promise<void> {
  const server = resolveServer(flags);
  const api = new ExaApi(server, null);
  const key = await api.policyKey().catch((e) => {
    throw new Error(`cannot reach ${server}: ${(e as Error).message}`);
  });
  const result = flags.dev ? await devLogin(api, flags) : await deviceLogin(api);
  await saveCredentials({ server, ...result, policyKey: key.publicKey });
  console.log(`${color.green("✓")} logged in as ${result.email} (${result.tenant}) on ${server}`);
}

export async function logout(): Promise<void> {
  await clearCredentials();
  console.log("logged out");
}

export async function whoami(api: ExaApi | null, creds: Credentials | null): Promise<void> {
  if (!api) return void console.log("not logged in (local mode)");
  const me = await api.me();
  console.log(`${me.user.email} · ${me.tenant.slug} (${me.role}) · ${creds!.server}`);
}

// ---------- helpers ----------
function resolveServer(flags: CliFlags): string {
  const server = flags.server ?? process.env.EXA_SERVER ?? DEFAULT_SERVER;
  return server.replace(/\/$/, "");
}

function hostName(fallback: string): string {
  return process.env.HOSTNAME ?? process.env.USER ?? fallback;
}

/** Dev auth: log in by email + org slug, then mint a long-lived CLI token. */
async function devLogin(api: ExaApi, flags: CliFlags): Promise<LoginResult> {
  const email = flags.email ?? (await promptLine("email: "));
  const tenant = flags.tenant ?? (await promptLine("organization slug: "));
  const session = await api.devLogin(email, tenant);
  api.setToken(session.token);
  const { token } = await api.createToken(`exa-cli@${hostName("host")}`);
  return { token, tenant, email };
}

/** Device flow: show a code to approve in the browser, then poll until approved. */
async function deviceLogin(api: ExaApi): Promise<LoginResult> {
  const d = await api.deviceStart(`exa-cli on ${hostName("this machine")}`);
  const code = color.bold(color.cyan(d.userCode));
  console.log(
    `\n  Open ${color.bold(d.verificationUriComplete)}\n  and confirm the code ${code}\n`,
  );
  const deadline = Date.now() + d.expiresIn * MS_PER_SECOND;
  for (;;) {
    if (Date.now() > deadline) throw new Error("login timed out");
    await Bun.sleep(d.interval * MS_PER_SECOND);
    const r = await api.devicePoll(d.deviceCode);
    if (r === "pending") continue;
    return { token: r.token, tenant: r.tenant.slug, email: r.user.email };
  }
}
