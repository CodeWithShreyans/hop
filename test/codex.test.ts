import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { adoptCodex, assertFileStoreMode, codexAuthPath, readActiveCodex, switchCodex } from "../src/codex.ts";

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

test("adopt turns auth.json into a 0600 symlink pointing at the profile", () => {
  writeFileSync(codexAuthPath(), authJson("alice"));
  adoptCodex("alice");

  const st = lstatSync(codexAuthPath());
  expect(st.isSymbolicLink()).toBe(true);
  expect(readlinkSync(codexAuthPath())).toBe(path.join("accounts", "alice.json"));

  const profile = path.join(process.env.CODEX_HOME ?? "", "accounts", "alice.json");
  expect(existsSync(profile)).toBe(true);
  expect(statSync(profile).mode & 0o777).toBe(0o600);
  expect(readActiveCodex()).toEqual({ state: "managed", name: "alice" });
});

test("codex's truncate-in-place write flows through the symlink into the profile", () => {
  // The load-bearing assumption: writing to auth.json (O_TRUNC, follows symlink) rewrites the target.
  writeFileSync(codexAuthPath(), authJson("alice"));
  adoptCodex("alice");

  const refreshed = authJson("alice-rotated");
  writeFileSync(codexAuthPath(), refreshed); // exactly what codex does on refresh

  const profile = path.join(process.env.CODEX_HOME ?? "", "accounts", "alice.json");
  expect(readFileSync(profile, "utf-8")).toBe(refreshed);
  expect(lstatSync(codexAuthPath()).isSymbolicLink()).toBe(true); // link intact
});

test("switch retargets the symlink to another profile", () => {
  writeFileSync(codexAuthPath(), authJson("alice"));
  adoptCodex("alice");
  // Create a second profile by adopting a fresh regular auth.json.
  writeFileSync(codexAuthPath(), authJson("bob")); // note: flows into alice.json via the link...
  // ...so instead craft bob's profile directly to test switching between existing profiles.
  writeFileSync(path.join(process.env.CODEX_HOME ?? "", "accounts", "bob.json"), authJson("bob"));

  switchCodex("bob");
  expect(readlinkSync(codexAuthPath())).toBe(path.join("accounts", "bob.json"));
  expect(readActiveCodex()).toEqual({ state: "managed", name: "bob" });

  switchCodex("alice");
  expect(readActiveCodex()).toEqual({ state: "managed", name: "alice" });
});

test("switching to an unknown profile throws and lists options", () => {
  writeFileSync(codexAuthPath(), authJson("alice"));
  adoptCodex("alice");
  expect(() => switchCodex("nope")).toThrow(/No Codex profile "nope"/);
});

test("keyring store mode is refused", () => {
  writeFileSync(path.join(process.env.CODEX_HOME ?? "", "config.toml"), 'cli_auth_credentials_store = "keyring"\n');
  expect(() => assertFileStoreMode()).toThrow(/OS keyring/);
  writeFileSync(codexAuthPath(), authJson("alice"));
  expect(() => adoptCodex("alice")).toThrow(/OS keyring/);
});
