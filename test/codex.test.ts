import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  adoptCodex,
  assertFileStoreMode,
  codexAuthPath,
  createCodexApiProfile,
  listCodexProfiles,
  readActiveCodex,
  readCodexProfile,
  switchCodex,
} from "../src/codex.ts";

let tmp: string;

const authJson = (account: string): string =>
  JSON.stringify({
    auth_mode: "chatgpt",
    OPENAI_API_KEY: null,
    tokens: { id_token: "h.e.s", access_token: "h.e.s", refresh_token: `rt.1.${account}`, account_id: account },
    last_refresh: "2026-07-04T12:00:00Z",
  });

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "hop-codex-"));
  process.env.CODEX_HOME = path.join(tmp, "codex");
  process.env.HOP_HOME = path.join(tmp, "hop");
  process.env.HOP_SKIP_USAGE = "1";
  mkdirSync(process.env.CODEX_HOME, { recursive: true });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

test("adopt turns auth.json into a 0600 symlink pointing at the kind-keyed profile", () => {
  writeFileSync(codexAuthPath(), authJson("alice"));
  const { kind } = adoptCodex("alice");
  expect(kind).toBe("sub");

  const st = lstatSync(codexAuthPath());
  expect(st.isSymbolicLink()).toBe(true);
  expect(readlinkSync(codexAuthPath())).toBe(path.join("accounts", "alice.sub.json"));

  const profile = path.join(process.env.CODEX_HOME ?? "", "accounts", "alice.sub.json");
  expect(existsSync(profile)).toBe(true);
  expect(statSync(profile).mode & 0o777).toBe(0o600);
  expect(readActiveCodex()).toEqual({ state: "managed", name: "alice", kind: "sub" });
});

test("codex's truncate-in-place write flows through the symlink into the profile", () => {
  // The load-bearing assumption: writing to auth.json (O_TRUNC, follows symlink) rewrites the target.
  writeFileSync(codexAuthPath(), authJson("alice"));
  adoptCodex("alice");

  const refreshed = authJson("alice-rotated");
  writeFileSync(codexAuthPath(), refreshed); // exactly what codex does on refresh

  const profile = path.join(process.env.CODEX_HOME ?? "", "accounts", "alice.sub.json");
  expect(readFileSync(profile, "utf-8")).toBe(refreshed);
  expect(lstatSync(codexAuthPath()).isSymbolicLink()).toBe(true); // link intact
});

test("switch retargets the symlink between kind-keyed profiles", () => {
  writeFileSync(codexAuthPath(), authJson("alice"));
  adoptCodex("alice");
  writeFileSync(path.join(process.env.CODEX_HOME ?? "", "accounts", "bob.sub.json"), authJson("bob"));

  switchCodex("bob", "sub");
  expect(readlinkSync(codexAuthPath())).toBe(path.join("accounts", "bob.sub.json"));
  expect(readActiveCodex()).toEqual({ state: "managed", name: "bob", kind: "sub" });

  switchCodex("alice", "sub");
  expect(readActiveCodex()).toEqual({ state: "managed", name: "alice", kind: "sub" });
});

test("same name coexists as sub and api; api profile activates via symlink", () => {
  writeFileSync(codexAuthPath(), authJson("work"));
  adoptCodex("work"); // work.sub
  createCodexApiProfile("work", "sk-proj-test-key"); // work.api

  expect(listCodexProfiles()).toEqual([
    { name: "work", kind: "api" },
    { name: "work", kind: "sub" },
  ]);

  switchCodex("work", "api");
  expect(readActiveCodex()).toEqual({ state: "managed", name: "work", kind: "api" });
  const live = JSON.parse(readFileSync(codexAuthPath(), "utf-8"));
  expect(live.auth_mode).toBe("apikey");
  expect(live.OPENAI_API_KEY).toBe("sk-proj-test-key");
  expect(readCodexProfile("work", "sub").tokens?.account_id).toBe("work"); // sub untouched

  switchCodex("work", "sub");
  expect(readActiveCodex()).toEqual({ state: "managed", name: "work", kind: "sub" });
});

test("switch refuses to clobber an unmanaged (regular-file) login", () => {
  writeFileSync(codexAuthPath(), authJson("alice"));
  adoptCodex("alice");
  // Simulate `codex logout && codex login`: auth.json becomes a fresh REGULAR file.
  rmSync(codexAuthPath());
  writeFileSync(codexAuthPath(), authJson("fresh-uncaptured"));

  expect(() => switchCodex("alice", "sub")).toThrow(/unmanaged/);
  // The uncaptured login survived.
  expect(JSON.parse(readFileSync(codexAuthPath(), "utf-8")).tokens.account_id).toBe("fresh-uncaptured");
});

test("switching to an unknown profile throws and lists options", () => {
  writeFileSync(codexAuthPath(), authJson("alice"));
  adoptCodex("alice");
  expect(() => switchCodex("nope", "sub")).toThrow(/No Codex profile "nope"/);
});

test("keyring store mode is refused", () => {
  writeFileSync(path.join(process.env.CODEX_HOME ?? "", "config.toml"), 'cli_auth_credentials_store = "keyring"\n');
  expect(() => assertFileStoreMode()).toThrow(/OS keyring/);
  writeFileSync(codexAuthPath(), authJson("alice"));
  expect(() => adoptCodex("alice")).toThrow(/OS keyring/);
});
