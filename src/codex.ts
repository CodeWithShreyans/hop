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
  codexUsageSchema,
  oauthRefreshResponseSchema,
  parseOrThrow,
  type CodexAuth,
  type CodexUsage,
  type Kind,
} from "./schemas.ts";
import { atomicWrite, codexHome, copyFile0600, decodeJwt } from "./store.ts";

const OAUTH_TOKEN_URL = "https://auth.openai.com/oauth/token";
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";

export const codexAuthPath = (): string => path.join(codexHome(), "auth.json");
export const codexAccountsDir = (): string => path.join(codexHome(), "accounts");
const profilePath = (name: string): string => path.join(codexAccountsDir(), `${name}.json`);

export type CodexActive =
  | { state: "managed"; name: string }
  | { state: "managed-missing"; name: string }
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
  const name = path.basename(target).replace(/\.json$/, "");
  const resolved = path.resolve(path.dirname(auth), target);
  return existsSync(resolved) ? { state: "managed", name } : { state: "managed-missing", name };
}

export function listCodexProfiles(): string[] {
  if (!existsSync(codexAccountsDir())) return [];
  return readdirSync(codexAccountsDir())
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.replace(/\.json$/, ""))
    .sort();
}

export function readCodexProfile(name: string): CodexAuth {
  return parseOrThrow(codexAuthSchema, JSON.parse(readFileSync(profilePath(name), "utf-8")), `codex profile "${name}"`);
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

/** Adopt the current live login as a named profile. Returns whether an already-managed link was forked. */
export function adoptCodex(name: string): { forkedFrom: string | null; auth: CodexAuth } {
  assertFileStoreMode();
  const auth = codexAuthPath();
  if (!existsSync(auth) && !isSymlink(auth)) {
    throw new Error("No active Codex login found. Run `codex login` first, then `hop add <name> --tool codex`.");
  }
  const raw = readFileSync(auth, "utf-8"); // follows a symlink transparently
  const parsed = parseOrThrow(codexAuthSchema, JSON.parse(raw), "codex auth.json");
  if (!parsed.tokens && !parsed.OPENAI_API_KEY) {
    throw new Error("Codex auth.json has no credentials (neither OAuth tokens nor an API key).");
  }

  const active = readActiveCodex();
  const forkedFrom = active.state === "managed" ? active.name : null;

  // Write the profile from the current effective bytes, then point auth.json at it atomically.
  copyFile0600(auth, profilePath(name)); // copyFileSync follows symlinks → captures live content
  atomicSymlink(path.join("accounts", `${name}.json`), auth);
  return { forkedFrom, auth: parsed };
}

export function switchCodex(name: string): void {
  assertFileStoreMode();
  if (!existsSync(profilePath(name))) {
    throw new Error(`No Codex profile "${name}". Available: ${listCodexProfiles().join(", ") || "(none)"}`);
  }
  atomicSymlink(path.join("accounts", `${name}.json`), codexAuthPath());
}

function isSymlink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

/** Refresh an INACTIVE profile's tokens (safe — nothing else holds them). Persists the rotated result. */
export async function refreshCodexProfile(name: string): Promise<CodexAuth> {
  const auth = readCodexProfile(name);
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
  atomicWrite(profilePath(name), `${JSON.stringify(updated, null, 2)}\n`);
  return updated;
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
