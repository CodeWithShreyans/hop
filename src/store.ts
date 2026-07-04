import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { homedir, userInfo } from "node:os";
import { createHash } from "node:crypto";
import * as path from "node:path";
import { z } from "zod";
import { parseOrThrow, registrySchema, type Kind, type Registry } from "./schemas.ts";

/* ── Profile identity: (tool, name, kind) — "work" can exist as sub AND api per tool ── */

export const NAME_RE = /^[A-Za-z0-9_-]+$/;
export const profileKey = (name: string, kind: Kind): string => `${name}.${kind}`;
export function parseProfileKey(key: string): { name: string; kind: Kind } | null {
  const m = key.match(/^([A-Za-z0-9_-]+)\.(sub|api)$/);
  if (!m || !m[1]) return null;
  return { name: m[1], kind: m[2] === "sub" ? "sub" : "api" };
}

/* ── Locations (all env-overridable so e2e tests never touch real state) ──── */

export const hopHome = (): string => process.env.HOP_HOME ?? path.join(homedir(), ".config", "hop");
export const codexHome = (): string => process.env.CODEX_HOME ?? path.join(homedir(), ".codex");
export const claudeConfigDir = (): string =>
  (process.env.CLAUDE_CONFIG_DIR ?? path.join(homedir(), ".claude")).normalize("NFC");

/** Mirror of Claude's own `.claude.json` resolver (binary fn `IT`). */
export function claudeJsonPath(): string {
  const dotConfig = path.join(claudeConfigDir(), ".config.json");
  if (existsSync(dotConfig)) return dotConfig;
  const suffix = process.env.CLAUDE_CODE_CUSTOM_OAUTH_URL ? "-custom-oauth" : "";
  return path.join(process.env.CLAUDE_CONFIG_DIR ?? homedir(), `.claude${suffix}.json`);
}

export const claudeSettingsPath = (): string => path.join(claudeConfigDir(), "settings.json");

/** Mirror of Claude's keychain service builder (binary fn `oF`). */
export function keychainService(suffix: string): string {
  const secure = process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR;
  const noHash = secure !== undefined ? secure === "" : !process.env.CLAUDE_CONFIG_DIR;
  const hashSource = secure !== undefined ? secure.normalize("NFC") : claudeConfigDir();
  const oauthSuffix = process.env.CLAUDE_CODE_CUSTOM_OAUTH_URL ? "-custom-oauth" : "";
  const hash = noHash ? "" : `-${createHash("sha256").update(hashSource).digest("hex").substring(0, 8)}`;
  return `Claude Code${oauthSuffix}${suffix}${hash}`;
}
export const claudeCredentialsService = (): string => keychainService("-credentials");
export const claudeApiKeyService = (): string => keychainService("");

/** Mirror of Claude's keychain account builder (binary fn `RM`). */
export function keychainAccount(): string {
  let name: string;
  try {
    name = process.env.USER || userInfo().username;
  } catch {
    return "claude-code-user";
  }
  return /^[A-Za-z0-9._-]+$/.test(name) ? name : "claude-code-user";
}

/* ── Atomic + validated file IO ──────────────────────────────────────────── */

let atomicCounter = 0;

/** Write via temp file + fsync + rename so a reader never sees a torn file. */
export function atomicWrite(filePath: string, data: string, mode = 0o600): void {
  const dir = path.dirname(filePath);
  mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(filePath)}.tmp-${process.pid}-${atomicCounter++}`);
  const fd = openSync(tmp, "wx", mode);
  try {
    writeSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  chmodSync(tmp, mode);
  renameSync(tmp, filePath);
}

export function readJsonFile<T>(filePath: string, schema: z.ZodType<T>, context: string): T {
  return parseOrThrow(schema, JSON.parse(readFileSync(filePath, "utf-8")), context);
}

/* ── Profile registry ────────────────────────────────────────────────────── */

const registryPath = (): string => path.join(hopHome(), "registry.json");

export function loadRegistry(): Registry {
  const p = registryPath();
  if (!existsSync(p)) return { version: 1, profiles: [], active: {}, previous: {} };
  return readJsonFile(p, registrySchema, "hop registry");
}

export function saveRegistry(reg: Registry): void {
  atomicWrite(registryPath(), `${JSON.stringify(reg, null, 2)}\n`);
}

/** Insert or replace a profile's metadata in the registry (does not persist). */
export function upsertProfile(reg: Registry, meta: Registry["profiles"][number]): void {
  const idx = reg.profiles.findIndex((p) => p.tool === meta.tool && p.name === meta.name && p.kind === meta.kind);
  if (idx >= 0) reg.profiles[idx] = meta;
  else reg.profiles.push(meta);
}

/* ── Exclusive lock so two hop invocations never race a swap ──────────────── */

export async function withLock<T>(fn: () => Promise<T>): Promise<T> {
  mkdirSync(hopHome(), { recursive: true });
  const lockPath = path.join(hopHome(), "lock");
  let fd: number;
  try {
    fd = openSync(lockPath, "wx");
  } catch {
    throw new Error(`Another hop operation is in progress (lock: ${lockPath}). Remove it if stale.`);
  }
  try {
    writeSync(fd, `${process.pid}`);
    return await fn();
  } finally {
    closeSync(fd);
    try {
      unlinkSync(lockPath);
    } catch {
      /* already gone */
    }
  }
}

/* ── Timestamped rolling backups (recover from a botched swap) ────────────── */

export function backup(label: string, files: { name: string; content: string | null }[]): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = path.join(hopHome(), "backups", `${stamp}-${label}`);
  mkdirSync(dir, { recursive: true });
  for (const f of files) {
    if (f.content !== null) atomicWrite(path.join(dir, f.name), f.content);
  }
  // Keep the 20 most recent backup dirs.
  const root = path.join(hopHome(), "backups");
  const dirs = readdirSync(root).sort();
  for (const old of dirs.slice(0, Math.max(0, dirs.length - 20))) {
    rmSync(path.join(root, old), { recursive: true, force: true });
  }
  return dir;
}

/* ── Crash journal: record intent before destructive writes ──────────────── */

const journalPath = (): string => path.join(hopHome(), "journal.json");

export function writeJournal(intent: Record<string, string>): void {
  atomicWrite(journalPath(), `${JSON.stringify({ ...intent, at: new Date().toISOString() }, null, 2)}\n`);
}
export function readJournal(): Record<string, string> | null {
  const p = journalPath();
  if (!existsSync(p)) return null;
  const parsed: unknown = JSON.parse(readFileSync(p, "utf-8"));
  return parsed !== null && typeof parsed === "object" ? { ...parsed } : null;
}
export function clearJournal(): void {
  try {
    unlinkSync(journalPath());
  } catch {
    /* nothing to clear */
  }
}

/* ── Misc ────────────────────────────────────────────────────────────────── */

export const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export function copyFile0600(src: string, dst: string): void {
  mkdirSync(path.dirname(dst), { recursive: true });
  copyFileSync(src, dst);
  chmodSync(dst, 0o600);
}

/** PIDs of a running `claude`/`codex` process (excluding ourselves). */
export async function runningPids(name: "claude" | "codex"): Promise<number[]> {
  const proc = Bun.spawn(["pgrep", "-x", name], { stdout: "pipe", stderr: "ignore" });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return out
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((s) => Number.parseInt(s, 10))
    .filter((n) => Number.isFinite(n) && n !== process.pid);
}

/** Decode a JWT payload (no signature check) and validate it. Returns null on any failure. */
export function decodeJwt<T>(token: string, schema: z.ZodType<T>): T | null {
  const parts = token.split(".");
  if (parts.length < 2 || !parts[1]) return null;
  try {
    const json = Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf-8");
    const result = schema.safeParse(JSON.parse(json));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}
