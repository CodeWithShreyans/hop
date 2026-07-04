import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  adoptClaude,
  claudeApiOff,
  claudeApiOn,
  getApiKeyHelper,
  readClaudeProfile,
  securityAdd,
  securityDelete,
  securityFind,
  switchClaudeSub,
  writeClaudeProfile,
} from "../src/claude.ts";
import {
  atomicWrite,
  claudeApiKeyService,
  claudeCredentialsService,
  claudeJsonPath,
  keychainAccount,
  loadRegistry,
  saveRegistry,
} from "../src/store.ts";
import type { ClaudeProfile } from "../src/schemas.ts";

let tmp: string;

const oauth = (accessToken: string, refresh: string) => ({
  accessToken,
  refreshToken: refresh,
  expiresAt: Date.now() + 3_600_000,
  scopes: ["user:inference", "user:profile"],
  subscriptionType: "max",
});

const subProfile = (name: string, accessToken: string, uuid: string, email: string): ClaudeProfile => ({
  name,
  kind: "sub",
  claudeAiOauth: oauth(accessToken, `rt-${name}`),
  oauthAccount: { accountUuid: uuid, emailAddress: email, organizationUuid: `org-${uuid}` },
  savedAt: "2026-07-04T00:00:00Z",
});

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "hop-claude-"));
  // A non-default CLAUDE_CONFIG_DIR gives a distinct, throwaway keychain service — never the user's real item.
  process.env.CLAUDE_CONFIG_DIR = path.join(tmp, "claude");
  process.env.HOP_HOME = path.join(tmp, "hop");
  process.env.HOP_SKIP_USAGE = "1";
  mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true });
});

afterEach(async () => {
  // Remove the throwaway keychain items regardless of test outcome.
  await securityDelete(claudeCredentialsService(), keychainAccount());
  await securityDelete(claudeApiKeyService(), keychainAccount());
  rmSync(tmp, { recursive: true, force: true });
});

test("uses a hashed, non-default keychain service (never the real one)", () => {
  expect(claudeCredentialsService()).toMatch(/^Claude Code-credentials-[0-9a-f]{8}$/);
  expect(claudeCredentialsService()).not.toBe("Claude Code-credentials");
});

test("adopt captures claudeAiOauth + identity from the live keychain", async () => {
  await securityAdd(
    claudeCredentialsService(),
    keychainAccount(),
    JSON.stringify({ claudeAiOauth: oauth("A-access", "rt-a"), mcpOAuth: { notion: "n-tok" } }),
  );
  atomicWrite(claudeJsonPath(), JSON.stringify({ oauthAccount: { accountUuid: "uuid-a", emailAddress: "a@x.com" } }));

  const profile = await adoptClaude("acct-a", { api: false });
  expect(profile.claudeAiOauth?.accessToken).toBe("A-access");
  expect(profile.oauthAccount?.emailAddress).toBe("a@x.com");
  expect(readClaudeProfile("acct-a").claudeAiOauth?.accessToken).toBe("A-access");
});

test("switch swaps claudeAiOauth, preserves mcpOAuth, patches claude.json, syncs back the outgoing account", async () => {
  // Live keychain holds account A with a ROTATED token (newer than what acct-a captured) + MCP tokens.
  await securityAdd(
    claudeCredentialsService(),
    keychainAccount(),
    JSON.stringify({ claudeAiOauth: oauth("A-new", "rt-a-new"), mcpOAuth: { notion: "n-tok" } }),
  );
  atomicWrite(claudeJsonPath(), JSON.stringify({ oauthAccount: { accountUuid: "uuid-a", emailAddress: "a@x.com" } }));

  writeClaudeProfile(subProfile("acct-a", "A-old", "uuid-a", "a@x.com")); // stale snapshot
  writeClaudeProfile(subProfile("acct-b", "B-access", "uuid-b", "b@x.com"));
  saveRegistry({
    version: 1,
    profiles: [
      { name: "acct-a", tool: "claude", kind: "sub", savedAt: "t" },
      { name: "acct-b", tool: "claude", kind: "sub", savedAt: "t" },
    ],
    active: { claude: "acct-a" },
    previous: {},
  });

  const { warnings } = await switchClaudeSub("acct-b", { safe: false });
  expect(Array.isArray(warnings)).toBe(true);

  // Keychain now serves B, but MCP tokens survived untouched.
  const raw = await securityFind(claudeCredentialsService(), keychainAccount());
  const blob = JSON.parse(raw ?? "{}");
  expect(blob.claudeAiOauth.accessToken).toBe("B-access");
  expect(blob.mcpOAuth).toEqual({ notion: "n-tok" });

  // claude.json identity followed the swap.
  const cj = JSON.parse(await Bun.file(claudeJsonPath()).text());
  expect(cj.oauthAccount.accountUuid).toBe("uuid-b");

  // Outgoing account synced back to the LIVE (rotated) token, not the stale snapshot.
  expect(readClaudeProfile("acct-a").claudeAiOauth?.accessToken).toBe("A-new");

  const reg = loadRegistry();
  expect(reg.active.claude).toBe("acct-b");
  expect(reg.previous.claude).toBe("acct-a");

  // A backup was taken before the destructive writes.
  expect(readdirSync(path.join(process.env.HOP_HOME ?? "", "backups")).length).toBeGreaterThan(0);
});

test("API override toggles apiKeyHelper on and off", async () => {
  writeClaudeProfile({ name: "api1", kind: "api", apiKey: "sk-ant-test-key", savedAt: "t" });
  saveRegistry({ version: 1, profiles: [{ name: "api1", tool: "claude", kind: "api", savedAt: "t" }], active: {}, previous: {} });

  claudeApiOn("api1");
  const helper = getApiKeyHelper();
  expect(helper).not.toBeNull();
  expect(existsSync(helper ?? "")).toBe(true);
  // The helper script must print the stored key on stdout (that's the apiKeyHelper contract).
  const out = Bun.spawnSync(["sh", helper ?? ""]).stdout.toString().trim();
  expect(out).toBe("sk-ant-test-key");
  expect(loadRegistry().active.claude).toBe("api1");

  claudeApiOff();
  expect(getApiKeyHelper()).toBeNull();
});
