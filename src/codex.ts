import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import * as path from "node:path";
import {
  codexAuthSchema,
  codexJwtClaimsSchema,
  codexResetCreditsSchema,
  codexUsageSchema,
  oauthRefreshResponseSchema,
  parseOrThrow,
  type CodexAuth,
  type CodexUsage,
  type Kind,
} from "./schemas.ts";
import { atomicWrite, codexHome, copyFile0600, decodeJwt, parseProfileKey, profileKey, NAME_RE } from "./store.ts";

const OAUTH_TOKEN_URL = "https://auth.openai.com/oauth/token";
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const USAGE_URL = process.env.HOP_CODEX_USAGE_URL ?? "https://chatgpt.com/backend-api/wham/usage";
const RESET_CREDITS_URL =
  process.env.HOP_CODEX_RESET_CREDITS_URL ?? "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits";

export const codexAuthPath = (): string => path.join(codexHome(), "auth.json");
export const codexAccountsDir = (): string => path.join(codexHome(), "accounts");
const profilePath = (name: string, kind: Kind): string => path.join(codexAccountsDir(), `${profileKey(name, kind)}.json`);

export type CodexActive =
  | { state: "managed"; name: string; kind: Kind }
  | { state: "managed-missing"; name: string; kind: Kind }
  | { state: "unmanaged" }
  | { state: "logged-out" };

/** `codex` refuses to co-manage credentials when they live in the OS keyring. Guard against silent no-ops. */
export function assertFileStoreMode(): void {
  const cfg = path.join(codexHome(), "config.toml");
  if (!existsSync(cfg)) return;
  const match = readFileSync(cfg, "utf-8").match(/^\s*cli_auth_credentials_store\s*=\s*"(\w+)"/m);
  const mode = match?.[1];
  if (mode === "keyring" || mode === "auto") {
    throw new Error(
      `Codex credentials are in the OS keyring (cli_auth_credentials_store = "${mode}"); hop manages the file store.\n` +
        `Set cli_auth_credentials_store = "file" in ${cfg} and re-run \`codex login\`, then retry.`,
    );
  }
}

export function readActiveCodex(): CodexActive {
  const auth = codexAuthPath();
  let stat;
  try {
    stat = lstatSync(auth);
  } catch {
    return { state: "logged-out" };
  }
  if (!stat.isSymbolicLink()) return { state: "unmanaged" };
  const target = readlinkSync(auth);
  const parsed = parseProfileKey(path.basename(target).replace(/\.json$/, ""));
  if (!parsed) return { state: "unmanaged" };
  const resolved = path.resolve(path.dirname(auth), target);
  return existsSync(resolved) ? { state: "managed", ...parsed } : { state: "managed-missing", ...parsed };
}

export function listCodexProfiles(): { name: string; kind: Kind }[] {
  if (!existsSync(codexAccountsDir())) return [];
  return readdirSync(codexAccountsDir())
    .filter((f) => f.endsWith(".json"))
    .map((f) => parseProfileKey(f.replace(/\.json$/, "")))
    .filter((p) => p !== null)
    .sort((a, b) => profileKey(a.name, a.kind).localeCompare(profileKey(b.name, b.kind)));
}

export function readCodexProfile(name: string, kind: Kind): CodexAuth {
  return parseOrThrow(
    codexAuthSchema,
    JSON.parse(readFileSync(profilePath(name, kind), "utf-8")),
    `codex profile "${name}" (${kind})`,
  );
}

export function codexIdentity(auth: CodexAuth): { kind: Kind; email?: string; plan?: string; accountId?: string } {
  if (auth.tokens?.id_token) {
    const claims = decodeJwt(auth.tokens.id_token, codexJwtClaimsSchema);
    const authClaim = claims?.["https://api.openai.com/auth"];
    return {
      kind: "sub",
      email: claims?.email ?? undefined,
      plan: authClaim?.chatgpt_plan_type ?? undefined,
      accountId: authClaim?.chatgpt_account_id ?? auth.tokens.account_id ?? undefined,
    };
  }
  return { kind: "api" };
}

let symlinkCounter = 0;
function atomicSymlink(relTarget: string, linkPath: string): void {
  const tmp = `${linkPath}.tmp-${process.pid}-${symlinkCounter++}`;
  try {
    unlinkSync(tmp);
  } catch {
    /* no leftover */
  }
  symlinkSync(relTarget, tmp);
  renameSync(tmp, linkPath);
}

/** Adopt the current live login as a named profile (kind derived from its content). */
export function adoptCodex(name: string): { forkedFrom: string | null; kind: Kind; auth: CodexAuth } {
  assertFileStoreMode();
  if (!NAME_RE.test(name)) throw new Error(`Invalid profile name "${name}" (use letters, digits, - and _).`);
  const auth = codexAuthPath();
  if (!existsSync(auth) && !isSymlink(auth)) {
    throw new Error("No active Codex login found. Run `codex login` first, then `hop add <name> --tool codex`.");
  }
  const raw = readFileSync(auth, "utf-8"); // follows a symlink transparently
  const parsed = parseOrThrow(codexAuthSchema, JSON.parse(raw), "codex auth.json");
  if (!parsed.tokens && !parsed.OPENAI_API_KEY) {
    throw new Error("Codex auth.json has no credentials (neither OAuth tokens nor an API key).");
  }
  const kind: Kind = parsed.tokens ? "sub" : "api";

  const active = readActiveCodex();
  const forkedFrom = active.state === "managed" ? profileKey(active.name, active.kind) : null;

  // Write the profile from the current effective bytes, then point auth.json at it atomically.
  copyFile0600(auth, profilePath(name, kind)); // copyFileSync follows symlinks → captures live content
  atomicSymlink(path.join("accounts", `${profileKey(name, kind)}.json`), auth);
  return { forkedFrom, kind, auth: parsed };
}

/** Create an API-billing profile (what `codex login --api-key` would write). Without an explicit
 *  key, pulls OPENAI_API_KEY from the live auth.json — i.e. from a native `codex login --api-key`. */
export function createCodexApiProfile(name: string, apiKey: string | undefined): { source: "given" | "live login" } {
  if (!NAME_RE.test(name)) throw new Error(`Invalid profile name "${name}" (use letters, digits, - and _).`);
  let key = apiKey ?? null;
  let source: "given" | "live login" = "given";
  if (!key && existsSync(codexAuthPath())) {
    const live = parseOrThrow(codexAuthSchema, JSON.parse(readFileSync(codexAuthPath(), "utf-8")), "codex auth.json");
    if (live.OPENAI_API_KEY) {
      key = live.OPENAI_API_KEY;
      source = "live login";
    }
  }
  if (!key) {
    throw new Error(
      "No API key found: pass --key sk-…, set HOP_API_KEY, or run `codex login --api-key …` first so hop can pull it from auth.json.",
    );
  }
  atomicWrite(profilePath(name, "api"), `${JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: key }, null, 2)}\n`);
  return { source };
}

export function switchCodex(name: string, kind: Kind): void {
  assertFileStoreMode();
  if (!existsSync(profilePath(name, kind))) {
    const available = listCodexProfiles()
      .map((p) => profileKey(p.name, p.kind))
      .join(", ");
    throw new Error(`No Codex profile "${name}" (${kind}). Available: ${available || "(none)"}`);
  }
  // Never rename over an unmanaged (regular-file) login — that would destroy uncaptured credentials.
  if (existsSync(codexAuthPath()) && !isSymlink(codexAuthPath())) {
    throw new Error("Codex has an unmanaged login in auth.json. Capture it first: `hop add <name> --tool codex`.");
  }
  atomicSymlink(path.join("accounts", `${profileKey(name, kind)}.json`), codexAuthPath());
}

function isSymlink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

/** Refresh an INACTIVE profile's tokens (safe — nothing else holds them). Persists the rotated result. */
export async function refreshCodexProfile(name: string, kind: Kind): Promise<CodexAuth> {
  const auth = readCodexProfile(name, kind);
  if (!auth.tokens?.refresh_token) return auth;
  const res = await fetch(OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: CLIENT_ID,
      grant_type: "refresh_token",
      refresh_token: auth.tokens.refresh_token,
      scope: "openid profile email",
    }),
  });
  if (!res.ok) throw new Error(`Codex token refresh failed (HTTP ${res.status}) for "${name}".`);
  const body = parseOrThrow(oauthRefreshResponseSchema, await res.json(), "codex refresh response");
  const updated: CodexAuth = {
    ...auth,
    tokens: {
      ...auth.tokens,
      access_token: body.access_token ?? auth.tokens.access_token,
      refresh_token: body.refresh_token ?? auth.tokens.refresh_token,
      id_token: body.id_token ?? auth.tokens.id_token,
    },
    last_refresh: new Date().toISOString(),
  };
  atomicWrite(profilePath(name, kind), `${JSON.stringify(updated, null, 2)}\n`);
  return updated;
}

/** On-demand usage-limit reset credits, counted the way CodexBar does: status "available" and
 *  unexpired. (The codex binary also carries the sibling …/consume endpoint for redeeming.) */
export async function fetchCodexResetCredits(
  accessToken: string,
  accountId: string | undefined,
): Promise<{ available: number; nextExpiryMs: number | null }> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    Accept: "application/json",
    "User-Agent": "codex-cli",
    "OpenAI-Beta": "codex-1",
    originator: "Codex Desktop",
  };
  if (accountId) headers["ChatGPT-Account-ID"] = accountId;
  const res = await fetch(RESET_CREDITS_URL, { headers });
  if (!res.ok) throw new Error(`Codex reset-credits query failed (HTTP ${res.status}).`);
  const body = parseOrThrow(codexResetCreditsSchema, await res.json(), "codex reset-credits response");
  const now = Date.now();
  const expiries: number[] = [];
  let available = 0;
  for (const credit of body.credits ?? []) {
    const expiresAt = credit.expires_at ? Date.parse(credit.expires_at) : null;
    if (credit.status !== "available" || (expiresAt !== null && expiresAt <= now)) continue;
    available++;
    if (expiresAt !== null) expiries.push(expiresAt - now);
  }
  return { available, nextExpiryMs: expiries.length ? Math.min(...expiries) : null };
}

export async function fetchCodexUsage(accessToken: string, accountId: string | undefined): Promise<CodexUsage> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    "User-Agent": "codex-cli",
    Accept: "application/json",
  };
  if (accountId) headers["ChatGPT-Account-Id"] = accountId;
  const res = await fetch(USAGE_URL, { headers });
  if (!res.ok) throw new Error(`Codex usage query failed (HTTP ${res.status}).`);
  return parseOrThrow(codexUsageSchema, await res.json(), "codex usage response");
}
