import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import {
  claudeKeychainSchema,
  claudeOauthAccountSchema,
  claudeProfileSchema,
  claudeUsageSchema,
  oauthRefreshResponseSchema,
  parseOrThrow,
  type ClaudeAiOauth,
  type ClaudeKeychain,
  type ClaudeOauthAccount,
  type ClaudeProfile,
  type ClaudeUsage,
  type Kind,
} from "./schemas.ts";
import {
  atomicWrite,
  backup,
  claudeApiKeyService,
  claudeCredentialsService,
  claudeJsonPath,
  claudeSettingsPath,
  clearJournal,
  errMsg,
  hopHome,
  keychainAccount,
  loadRegistry,
  parseProfileKey,
  profileKey,
  readJsonFile,
  runningPids,
  saveRegistry,
  writeJournal,
  NAME_RE,
} from "./store.ts";

const CLAUDE_TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const CLAUDE_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const CLAUDE_USAGE_URL = process.env.HOP_CLAUDE_USAGE_URL ?? "https://api.anthropic.com/api/oauth/usage";

const jsonObjectSchema = z.record(z.string(), z.unknown());

/* ── macOS keychain via the `security` CLI (same call shapes Claude Code uses) ── */

async function runSecurity(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["security", ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code: await proc.exited, stdout, stderr };
}

function decodeSecurityValue(s: string): string {
  if (s.length > 0 && s.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(s)) {
    try {
      const decoded = Buffer.from(s, "hex").toString("utf-8");
      if (decoded.trimStart().startsWith("{")) return decoded;
    } catch {
      /* fall through to raw */
    }
  }
  return s;
}

export async function securityFind(service: string, account: string): Promise<string | null> {
  const { code, stdout } = await runSecurity(["find-generic-password", "-a", account, "-w", "-s", service]);
  return code === 0 ? decodeSecurityValue(stdout.trim()) : null;
}

export async function securityAdd(service: string, account: string, value: string): Promise<void> {
  const hex = Buffer.from(value, "utf-8").toString("hex");
  const { code, stderr } = await runSecurity(["add-generic-password", "-U", "-a", account, "-s", service, "-X", hex]);
  if (code !== 0) throw new Error(`Keychain write failed for "${service}": ${stderr.trim()}`);
}

export async function securityDelete(service: string, account: string): Promise<void> {
  await runSecurity(["delete-generic-password", "-a", account, "-s", service]);
}

export async function readClaudeKeychain(): Promise<{ raw: string; parsed: ClaudeKeychain } | null> {
  const raw = await securityFind(claudeCredentialsService(), keychainAccount());
  if (raw === null) return null;
  return { raw, parsed: parseOrThrow(claudeKeychainSchema, JSON.parse(raw), "Claude keychain payload") };
}

/** Set (or remove) only `claudeAiOauth`, byte-preserving `mcpOAuth` and any other keys in the blob. */
export async function writeClaudeOauth(oauth: ClaudeAiOauth | null): Promise<void> {
  const current = await readClaudeKeychain();
  const base: Record<string, unknown> = current ? { ...current.parsed } : {};
  if (oauth) base.claudeAiOauth = oauth;
  else delete base.claudeAiOauth;
  await securityAdd(claudeCredentialsService(), keychainAccount(), JSON.stringify(base));
}

/* ── OAuth refresh + usage ───────────────────────────────────────────────── */

export async function refreshClaudeToken(oauth: ClaudeAiOauth): Promise<ClaudeAiOauth> {
  const res = await fetch(CLAUDE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: oauth.refreshToken,
      client_id: CLAUDE_CLIENT_ID,
      scope: (oauth.scopes ?? ["user:inference", "user:profile"]).join(" "),
    }),
  });
  if (!res.ok) throw new Error(`Claude token refresh failed (HTTP ${res.status}).`);
  const body = parseOrThrow(oauthRefreshResponseSchema, await res.json(), "claude refresh response");
  return {
    ...oauth,
    accessToken: body.access_token ?? oauth.accessToken,
    refreshToken: body.refresh_token ?? oauth.refreshToken,
    expiresAt: body.expires_in ? Date.now() + body.expires_in * 1000 : oauth.expiresAt,
  };
}

export async function fetchClaudeUsage(accessToken: string): Promise<ClaudeUsage> {
  const res = await fetch(CLAUDE_USAGE_URL, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
      "anthropic-beta": "oauth-2025-04-20",
      "User-Agent": "claude-cli/hop",
    },
  });
  if (!res.ok) throw new Error(`Claude usage query failed (HTTP ${res.status}).`);
  return parseOrThrow(claudeUsageSchema, await res.json(), "claude usage response");
}

/* ── hop-side profile files + ~/.claude.json + settings.json ─────────────── */

const claudeProfileDir = (): string => path.join(hopHome(), "claude");
const claudeProfilePath = (name: string, kind: Kind): string =>
  path.join(claudeProfileDir(), `${profileKey(name, kind)}.json`);

export function listClaudeProfiles(): { name: string; kind: Kind }[] {
  if (!existsSync(claudeProfileDir())) return [];
  return readdirSync(claudeProfileDir())
    .filter((f) => f.endsWith(".json"))
    .map((f) => parseProfileKey(f.replace(/\.json$/, "")))
    .filter((p) => p !== null)
    .sort((a, b) => profileKey(a.name, a.kind).localeCompare(profileKey(b.name, b.kind)));
}

export const readClaudeProfile = (name: string, kind: Kind): ClaudeProfile =>
  readJsonFile(claudeProfilePath(name, kind), claudeProfileSchema, `claude profile "${name}" (${kind})`);

export const writeClaudeProfile = (p: ClaudeProfile): void =>
  atomicWrite(claudeProfilePath(p.name, p.kind), `${JSON.stringify(p, null, 2)}\n`);

function readClaudeJsonRaw(): Record<string, unknown> {
  const p = claudeJsonPath();
  if (!existsSync(p)) return {};
  return { ...parseOrThrow(jsonObjectSchema, JSON.parse(readFileSync(p, "utf-8")), "~/.claude.json") };
}

export function readClaudeOauthAccount(): ClaudeOauthAccount | null {
  const oa = readClaudeJsonRaw().oauthAccount;
  if (oa === undefined || oa === null) return null;
  const res = claudeOauthAccountSchema.safeParse(oa);
  return res.success ? res.data : null;
}

/** Surgically patch identity keys, preserving the rest of the (large, live-written) file. */
export function patchClaudeJsonIdentity(oauthAccount: ClaudeOauthAccount | null): void {
  const raw = readClaudeJsonRaw();
  if (oauthAccount) raw.oauthAccount = oauthAccount;
  else delete raw.oauthAccount;
  // primaryApiKey is a "/login managed key" API-billing source; it must not survive a subscription switch.
  delete raw.primaryApiKey;
  atomicWrite(claudeJsonPath(), `${JSON.stringify(raw, null, 2)}\n`);
}

export function getApiKeyHelper(): string | null {
  const p = claudeSettingsPath();
  if (!existsSync(p)) return null;
  const s = parseOrThrow(jsonObjectSchema, JSON.parse(readFileSync(p, "utf-8")), "settings.json");
  return typeof s.apiKeyHelper === "string" ? s.apiKeyHelper : null;
}

function setApiKeyHelper(scriptPath: string | null): void {
  const p = claudeSettingsPath();
  const current = existsSync(p) ? parseOrThrow(jsonObjectSchema, JSON.parse(readFileSync(p, "utf-8")), "settings.json") : {};
  if (scriptPath) current.apiKeyHelper = scriptPath;
  else delete current.apiKeyHelper;
  atomicWrite(p, `${JSON.stringify(current, null, 2)}\n`, 0o644);
}

const apiKeyFilePath = (): string => path.join(hopHome(), "claude-api-key.key");
const apiHelperScriptPath = (): string => path.join(hopHome(), "claude-api-key.sh");

/** The API-override layer: an apiKeyHelper that outranks subscription OAuth (machine-global, keychain-free). */
export function claudeApiOn(name: string): void {
  const profile = readClaudeProfile(name, "api");
  if (!profile.apiKey) throw new Error(`Claude API profile "${name}" has no stored key.`);
  atomicWrite(apiKeyFilePath(), profile.apiKey, 0o600);
  atomicWrite(apiHelperScriptPath(), `#!/bin/sh\ncat ${JSON.stringify(apiKeyFilePath())}\n`, 0o755);
  setApiKeyHelper(apiHelperScriptPath());
  const reg = loadRegistry();
  reg.previous.claude = reg.active.claude ?? null;
  reg.active.claude = profileKey(name, "api");
  saveRegistry(reg);
}

export function claudeApiOff(): void {
  setApiKeyHelper(null);
  for (const f of [apiKeyFilePath(), apiHelperScriptPath()]) {
    try {
      rmSync(f);
    } catch {
      /* already gone */
    }
  }
}

/* ── Capture + switch ────────────────────────────────────────────────────── */

export async function adoptClaude(name: string, opts: { api: boolean; apiKey?: string }): Promise<ClaudeProfile> {
  if (!NAME_RE.test(name)) throw new Error(`Invalid profile name "${name}" (use letters, digits, - and _).`);
  const savedAt = new Date().toISOString();
  if (opts.api) {
    const key = opts.apiKey ?? (await securityFind(claudeApiKeyService(), keychainAccount()));
    if (!key) throw new Error("No API key given and none in the keychain. Pass --key <sk-ant-…> or set HOP_API_KEY.");
    const profile: ClaudeProfile = { name, kind: "api", apiKey: key, oauthAccount: readClaudeOauthAccount(), savedAt };
    writeClaudeProfile(profile);
    return profile;
  }
  const kc = await readClaudeKeychain();
  if (!kc?.parsed.claudeAiOauth) {
    throw new Error("No Claude subscription login in the keychain. Run `/login` in claude, then `hop add <name> --tool claude`.");
  }
  const profile: ClaudeProfile = {
    name,
    kind: "sub",
    claudeAiOauth: kc.parsed.claudeAiOauth,
    oauthAccount: readClaudeOauthAccount(),
    savedAt,
  };
  writeClaudeProfile(profile);
  return profile;
}

export type ActiveClaude = { helperActive: boolean; hasOauth: boolean; oauthAccount: ClaudeOauthAccount | null };

export async function readActiveClaude(): Promise<ActiveClaude> {
  const helper = getApiKeyHelper();
  const kc = await readClaudeKeychain();
  return {
    helperActive: helper !== null && helper.startsWith(hopHome()),
    hasOauth: kc?.parsed.claudeAiOauth !== undefined && kc?.parsed.claudeAiOauth !== null,
    oauthAccount: readClaudeOauthAccount(),
  };
}

/** The journaled, backup-first, verify-then-commit swap between subscription accounts. */
export async function switchClaudeSub(name: string, opts: { safe: boolean }): Promise<{ warnings: string[]; notes: string[] }> {
  const warnings: string[] = [];
  const notes: string[] = [];
  const target = readClaudeProfile(name, "sub");
  if (!target.claudeAiOauth) {
    throw new Error(`Claude subscription profile "${name}" has no stored OAuth credential.`);
  }

  // 1. Process gate (warn-and-proceed by default; --safe blocks).
  const pids = await runningPids("claude");
  if (pids.length > 0) {
    const msg = `claude is running (pid ${pids.join(", ")}); a live token refresh mid-swap could invalidate a login.`;
    if (opts.safe) throw new Error(`${msg}\nQuit claude or drop --safe to proceed anyway.`);
    warnings.push(msg);
  }

  // 2. Back up every store we might touch.
  const liveKc = await readClaudeKeychain();
  const liveApiKey = await securityFind(claudeApiKeyService(), keychainAccount());
  const liveClaudeJson = existsSync(claudeJsonPath()) ? readFileSync(claudeJsonPath(), "utf-8") : null;
  const backupDir = backup(`claude-switch-to-${name}`, [
    { name: "credentials.json", content: liveKc?.raw ?? null },
    { name: "apikey.txt", content: liveApiKey },
    { name: "claude.json", content: liveClaudeJson },
  ]);

  // 3. Sync-back: claude only rotates tokens forward, so the LIVE keychain token supersedes any
  //    stored snapshot of the SAME account. Attribute it by accountUuid (~/.claude.json identity
  //    cache) and fold it into the profile that owns it — the target itself when toggling back
  //    from an api override, or the outgoing sub account on a sub→sub switch.
  const reg = loadRegistry();
  const outgoing = reg.active.claude ?? null;
  const outgoingParsed = outgoing ? parseProfileKey(outgoing) : null;
  const targetKey = profileKey(name, "sub");
  const liveOauth = liveKc?.parsed.claudeAiOauth ?? null;
  const liveUuid = readClaudeOauthAccount()?.accountUuid ?? null;
  let effectiveTarget = target.claudeAiOauth;
  if (liveOauth) {
    const ownedByTarget = liveUuid !== null && target.oauthAccount?.accountUuid === liveUuid;
    // On an identity-less toggle-back (same name, api → sub) the keychain base can only be the target's.
    const unattributableToggleBack =
      outgoingParsed?.kind === "api" && outgoingParsed.name === name && liveUuid === null && !target.oauthAccount?.accountUuid;
    if (ownedByTarget || unattributableToggleBack) {
      effectiveTarget = liveOauth;
      writeClaudeProfile({ ...target, claudeAiOauth: liveOauth });
    } else if (outgoingParsed?.kind === "sub" && outgoing !== targetKey) {
      try {
        const prev = readClaudeProfile(outgoingParsed.name, "sub");
        // Only fold the live token into the outgoing profile when ownership matches (or is unknowable).
        if (!liveUuid || !prev.oauthAccount?.accountUuid || prev.oauthAccount.accountUuid === liveUuid) {
          writeClaudeProfile({
            ...prev,
            claudeAiOauth: liveOauth,
            oauthAccount: readClaudeOauthAccount() ?? prev.oauthAccount,
          });
        }
      } catch (e) {
        warnings.push(`Could not sync-back outgoing account "${outgoing}": ${errMsg(e)}`);
      }
    }
  }

  writeJournal({ op: "claude-switch", to: targetKey, from: outgoing ?? "" });

  // 4. Swap in target: keychain oauth (preserve mcpOAuth), drop the API override, patch identity,
  //    and remove any leftover console API-key credential so it can't shadow the subscription
  //    (mirrors what Claude's own subscription /login does). patchClaudeJsonIdentity drops primaryApiKey.
  await writeClaudeOauth(effectiveTarget);
  claudeApiOff();
  patchClaudeJsonIdentity(target.oauthAccount ?? null);
  if (liveApiKey !== null) {
    await securityDelete(claudeApiKeyService(), keychainAccount());
    notes.push(`removed a leftover console API-key keychain item (backed up to ${backupDir})`);
  }

  // 5. Verify; roll back from the backup on mismatch.
  const after = await readClaudeKeychain();
  if (after?.parsed.claudeAiOauth?.accessToken !== effectiveTarget.accessToken) {
    if (liveKc) await securityAdd(claudeCredentialsService(), keychainAccount(), liveKc.raw);
    if (liveApiKey !== null) await securityAdd(claudeApiKeyService(), keychainAccount(), liveApiKey);
    if (liveClaudeJson !== null) atomicWrite(claudeJsonPath(), liveClaudeJson, 0o600);
    clearJournal();
    throw new Error(`Verification failed switching to "${name}"; rolled back to the previous account.`);
  }

  // 6. Commit.
  reg.previous.claude = outgoing;
  reg.active.claude = targetKey;
  saveRegistry(reg);
  clearJournal();
  return { warnings, notes };
}

export function claudeIdentityLabel(profile: ClaudeProfile): { email?: string; plan?: string } {
  return {
    email: profile.oauthAccount?.emailAddress ?? undefined,
    plan: profile.kind === "api" ? "api-key" : profile.claudeAiOauth?.subscriptionType ?? undefined,
  };
}
