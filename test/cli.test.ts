import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

// e2e: spawn the real CLI with isolated env and assert the kind-resolution rules.

let tmp: string;
let env: Record<string, string>;

const authJson = (account: string): string =>
  JSON.stringify({
    auth_mode: "chatgpt",
    OPENAI_API_KEY: null,
    tokens: { id_token: "h.e.s", access_token: "h.e.s", refresh_token: `rt.1.${account}`, account_id: account },
    last_refresh: "2026-07-04T12:00:00Z",
  });

// Async spawn (not spawnSync): the mock usage server runs on this thread's event loop, and a
// synchronous wait would deadlock the child's fetch against it.
async function hop(args: string[], extraEnv: Record<string, string> = {}): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn(["bun", "run", path.join(import.meta.dir, "..", "src", "cli.ts"), ...args], {
    env: { ...process.env, ...env, ...extraEnv },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, out: out + err };
}

/** Codex backend fixture: /usage with the given percentages, /credits with reset-credit entries. */
function usageServer(
  fiveHourPct: number,
  weeklyPct: number,
  credits: { status: string; expires_at?: string | null }[] = [],
): ReturnType<typeof Bun.serve> {
  const now = Math.floor(Date.now() / 1000);
  return Bun.serve({
    port: 0,
    fetch: (req) => {
      if (new URL(req.url).pathname.endsWith("/credits")) {
        return Response.json({
          available_count: credits.length,
          credits: credits.map((c, i) => ({
            id: `credit-${i}`,
            reset_type: "five_hour",
            status: c.status,
            granted_at: "2026-07-01T00:00:00Z",
            expires_at: c.expires_at ?? null,
          })),
        });
      }
      return Response.json({
        plan_type: "team",
        rate_limit: {
          primary_window: { used_percent: fiveHourPct, reset_at: now + 3600, limit_window_seconds: 18000 },
          secondary_window: { used_percent: weeklyPct, reset_at: now + 86400, limit_window_seconds: 604800 },
        },
      });
    },
  });
}

const mockEnv = (server: ReturnType<typeof Bun.serve>): Record<string, string> => ({
  HOP_SKIP_USAGE: "",
  HOP_CODEX_USAGE_URL: `http://localhost:${server.port}/usage`,
  HOP_CODEX_RESET_CREDITS_URL: `http://localhost:${server.port}/credits`,
});

const activeCodexKey = (): string =>
  path.basename(readlinkSync(path.join(env.CODEX_HOME ?? "", "auth.json"))).replace(/\.json$/, "");

beforeEach(async () => {
  tmp = mkdtempSync(path.join(tmpdir(), "hop-cli-"));
  env = {
    CODEX_HOME: path.join(tmp, "codex"),
    HOP_HOME: path.join(tmp, "hop"),
    CLAUDE_CONFIG_DIR: path.join(tmp, "claude"),
    HOP_SKIP_USAGE: "1", // usage unknown → limit-aware fallback stays on sub (fail open)
    NO_COLOR: "1",
  };
  mkdirSync(env.CODEX_HOME ?? "", { recursive: true });
  // Active login "alice" (sub), plus both variations of "work" and both of "alice".
  writeFileSync(path.join(env.CODEX_HOME ?? "", "auth.json"), authJson("alice"));
  expect((await hop(["add", "alice", "--tool", "codex"])).code).toBe(0);
  expect((await hop(["add", "alice", "--tool", "codex", "--api", "--key", "sk-proj-alice"])).code).toBe(0);
  writeFileSync(path.join(env.CODEX_HOME ?? "", "accounts", "work.sub.json"), authJson("work"));
  writeFileSync(
    path.join(env.CODEX_HOME ?? "", "accounts", "work.api.json"),
    JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: "sk-proj-work" }),
  );
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

test("no flag, same profile: toggles sub↔api and back", async () => {
  // active is alice.sub
  const first = await hop(["codex", "alice"]);
  expect(first.code).toBe(0);
  expect(first.out).toContain("toggled sub → api");
  expect(activeCodexKey()).toBe("alice.api");

  const second = await hop(["codex", "alice"]);
  expect(second.code).toBe(0);
  expect(second.out).toContain("toggled api → sub");
  expect(activeCodexKey()).toBe("alice.sub");
});

test("no flag, different profile: defaults to sub", async () => {
  const res = await hop(["codex", "work"]);
  expect(res.code).toBe(0);
  expect(activeCodexKey()).toBe("work.sub");
});

test("explicit kind flag wins over the toggle", async () => {
  // active is alice.sub; --sub must NOT toggle to api
  const res = await hop(["codex", "alice", "--sub"]);
  expect(res.code).toBe(0);
  expect(activeCodexKey()).toBe("alice.sub");
});

test("single-variation names resolve without a flag", async () => {
  writeFileSync(path.join(env.CODEX_HOME ?? "", "accounts", "solo.sub.json"), authJson("solo"));
  const res = await hop(["codex", "solo"]);
  expect(res.code).toBe(0);
  expect(activeCodexKey()).toBe("solo.sub");
});

test("no flag, different profile with an exhausted sub: defaults to api", async () => {
  const server = usageServer(100, 12);
  try {
    const res = await hop(["codex", "work"], mockEnv(server));
    expect(res.code).toBe(0);
    expect(res.out).toContain("defaulting to api");
    expect(activeCodexKey()).toBe("work.api");
  } finally {
    server.stop();
  }
});

test("explicitly switching to an exhausted sub warns after switching", async () => {
  const server = usageServer(30, 100);
  try {
    const res = await hop(["codex", "work", "--sub"], mockEnv(server));
    expect(res.code).toBe(0);
    expect(activeCodexKey()).toBe("work.sub"); // the switch itself completes
    expect(res.out).toContain("subscription is exhausted");
    expect(res.out).toContain("weekly at 100%");
  } finally {
    server.stop();
  }
});

test("status counts usage-limit reset credits the way CodexBar does (available + unexpired only)", async () => {
  const server = usageServer(40, 10, [
    { status: "available" }, // counts (no expiry)
    { status: "available", expires_at: new Date(Date.now() + 86_400_000).toISOString() }, // counts
    { status: "available", expires_at: "2020-01-01T00:00:00Z" }, // expired → filtered
    { status: "redeemed" }, // consumed → filtered
  ]);
  try {
    const res = await hop(["status", "--json"], mockEnv(server));
    expect(res.code).toBe(0);
    const rows: { name: string; kind: string; resets: number | null }[] = JSON.parse(res.out);
    const subRow = rows.find((r) => r.name === "alice" && r.kind === "sub");
    expect(subRow?.resets).toBe(2);
  } finally {
    server.stop();
  }
});

test("exhausted-sub warning mentions available usage-limit resets", async () => {
  const server = usageServer(100, 10, [{ status: "available" }, { status: "available" }]);
  try {
    const res = await hop(["codex", "work", "--sub"], mockEnv(server));
    expect(res.code).toBe(0);
    expect(res.out).toContain("subscription is exhausted");
    expect(res.out).toContain("2 usage-limit resets available");
  } finally {
    server.stop();
  }
});
