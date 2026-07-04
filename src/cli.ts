#!/usr/bin/env bun
import {
  adoptClaude,
  claudeApiOn,
  claudeIdentityLabel,
  fetchClaudeUsage,
  getApiKeyHelper,
  listClaudeProfiles,
  readActiveClaude,
  readClaudeKeychain,
  readClaudeProfile,
  refreshClaudeToken,
  securityFind,
  switchClaudeSub,
  writeClaudeProfile,
} from "./claude.ts";
import {
  adoptCodex,
  assertFileStoreMode,
  codexIdentity,
  fetchCodexUsage,
  listCodexProfiles,
  readActiveCodex,
  readCodexProfile,
  refreshCodexProfile,
  switchCodex,
} from "./codex.ts";
import { codexJwtClaimsSchema, type Tool } from "./schemas.ts";
import {
  claudeApiKeyService,
  claudeCredentialsService,
  claudeJsonPath,
  clearJournal,
  codexHome,
  decodeJwt,
  errMsg,
  hopHome,
  keychainAccount,
  loadRegistry,
  readJournal,
  runningPids,
  saveRegistry,
  upsertProfile,
  withLock,
} from "./store.ts";

/* ── output helpers ──────────────────────────────────────────────────────── */

const color = (): boolean => Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const wrap = (code: string, s: string): string => (color() ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = (s: string): string => wrap("1", s);
const dim = (s: string): string => wrap("2", s);
const green = (s: string): string => wrap("32", s);
const yellow = (s: string): string => wrap("33", s);
const red = (s: string): string => wrap("31", s);

const pctColorize = (p: number, s: string): string => (p >= 80 ? red(s) : p >= 50 ? yellow(s) : green(s));

function fmtCountdown(msUntil: number): string {
  if (msUntil <= 0) return "now";
  const mins = Math.floor(msUntil / 60000);
  const d = Math.floor(mins / 1440);
  const h = Math.floor((mins % 1440) / 60);
  const m = mins % 60;
  if (d > 0) return `${d}d${h}h`;
  if (h > 0) return `${h}h${m}m`;
  return `${m}m`;
}

/* ── row model for the status table ──────────────────────────────────────── */

type UsageWindow = { pct: number; resetMs: number | null } | null;
type Row = {
  tool: Tool;
  name: string;
  active: boolean;
  label: string; // plan / email / kind
  fiveHour: UsageWindow;
  weekly: UsageWindow;
  note?: string;
};

const skipUsage = (): boolean => Boolean(process.env.HOP_SKIP_USAGE);

async function codexRows(): Promise<Row[]> {
  const active = readActiveCodex();
  const activeName = active.state === "managed" ? active.name : null;
  const names = listCodexProfiles();
  return Promise.all(
    names.map(async (name): Promise<Row> => {
      const isActive = name === activeName;
      let auth = readCodexProfile(name);
      const id = codexIdentity(auth);
      const label = id.kind === "api" ? "api-key" : [id.plan, id.email].filter(Boolean).join(" · ") || "subscription";
      const row: Row = { tool: "codex", name, active: isActive, label, fiveHour: null, weekly: null };
      if (id.kind === "api" || skipUsage() || !auth.tokens?.access_token) return row;
      try {
        const claims = decodeJwt(auth.tokens.access_token, codexJwtClaimsSchema);
        const exp = claims?.exp ?? null;
        if (!isActive && exp && exp * 1000 < Date.now() + 60_000 && auth.tokens.refresh_token) {
          auth = await refreshCodexProfile(name);
        }
        const token = auth.tokens?.access_token;
        if (!token) return row;
        const usage = await fetchCodexUsage(token, id.accountId);
        const prim = usage.rate_limit?.primary_window;
        const sec = usage.rate_limit?.secondary_window;
        if (prim) row.fiveHour = { pct: prim.used_percent, resetMs: prim.reset_at ? prim.reset_at * 1000 - Date.now() : null };
        if (sec) row.weekly = { pct: sec.used_percent, resetMs: sec.reset_at ? sec.reset_at * 1000 - Date.now() : null };
      } catch (e) {
        row.note = errMsg(e);
      }
      return row;
    }),
  );
}

async function claudeRows(): Promise<Row[]> {
  const reg = loadRegistry();
  const active = await readActiveClaude();
  const activeName = reg.active.claude ?? null;
  const names = listClaudeProfiles();
  return Promise.all(
    names.map(async (name): Promise<Row> => {
      const profile = readClaudeProfile(name);
      const isActive = name === activeName;
      const idl = claudeIdentityLabel(profile);
      const label = [idl.plan, idl.email].filter(Boolean).join(" · ") || profile.kind;
      const row: Row = { tool: "claude", name, active: isActive, label, fiveHour: null, weekly: null };
      if (profile.kind === "api") {
        row.note = active.helperActive && isActive ? "API billing (active override)" : "API billing";
        return row;
      }
      if (skipUsage() || !profile.claudeAiOauth) return row;
      try {
        let oauth = profile.claudeAiOauth;
        if (isActive) {
          const kc = await readClaudeKeychain();
          if (kc?.parsed.claudeAiOauth) oauth = kc.parsed.claudeAiOauth;
        } else if (oauth.expiresAt && oauth.expiresAt < Date.now() + 60_000) {
          oauth = await refreshClaudeToken(oauth);
          writeClaudeProfile({ ...profile, claudeAiOauth: oauth });
        }
        const usage = await fetchClaudeUsage(oauth.accessToken);
        const toWin = (u: { utilization?: number | null; resets_at?: string | null } | null | undefined): UsageWindow => {
          if (!u || u.utilization === null || u.utilization === undefined) return null;
          const reset = u.resets_at ? Date.parse(u.resets_at) - Date.now() : null;
          return { pct: u.utilization, resetMs: reset };
        };
        row.fiveHour = toWin(usage.five_hour);
        row.weekly = toWin(usage.seven_day);
      } catch (e) {
        row.note = errMsg(e);
      }
      return row;
    }),
  );
}

function cell(w: UsageWindow): { pct: string; reset: string } {
  if (!w) return { pct: dim("—"), reset: dim("—") };
  const p = `${Math.round(w.pct)}%`;
  return {
    pct: pctColorize(w.pct, p),
    reset: w.resetMs === null ? dim("—") : fmtCountdown(w.resetMs),
  };
}

function renderTable(rows: Row[]): string {
  if (rows.length === 0) {
    return dim("No profiles yet. Capture your current logins:\n  hop add <name> --tool codex\n  hop add <name> --tool claude");
  }
  const header = ["", "TOOL", "PROFILE", "PLAN", "5H", "WEEK", "RESET"];
  const body = rows.map((r) => {
    const c = cell(r.fiveHour);
    const w = cell(r.weekly);
    const resetText = r.fiveHour ? c.reset : w.reset;
    return {
      cells: [r.active ? green("●") : " ", r.tool, r.name, r.note ?? r.label, c.pct, w.pct, resetText],
      strong: r.active,
    };
  });
  const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");
  const widths = header.map((h, i) =>
    Math.max(stripAnsi(h).length, ...body.map((row) => stripAnsi(row.cells[i] ?? "").length)),
  );
  const line = (cells: string[], strong: boolean): string =>
    cells
      .map((cellText, i) => {
        const pad = " ".repeat(Math.max(0, (widths[i] ?? 0) - stripAnsi(cellText).length));
        const text = cellText + pad;
        return i === 2 && strong ? bold(text) : text;
      })
      .join("  ")
      .trimEnd();
  return [dim(line(header, false)), ...body.map((row) => line(row.cells, row.strong))].join("\n");
}

/* ── commands ────────────────────────────────────────────────────────────── */

async function cmdStatus(json: boolean): Promise<void> {
  const [codex, claude] = await Promise.all([codexRows(), claudeRows()]);
  const rows = [...claude, ...codex];
  if (json) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }
  const active = readActiveCodex();
  if (active.state === "unmanaged") {
    console.log(yellow("! Codex has an unmanaged login. Capture it with `hop add <name> --tool codex`.\n"));
  }
  console.log(renderTable(rows));
}

function codexActiveName(): string | null {
  const a = readActiveCodex();
  return a.state === "managed" ? a.name : null;
}

async function switchByTool(tool: Tool, name: string, safe: boolean): Promise<{ warnings: string[]; notes: string[] }> {
  if (tool === "codex") {
    switchCodex(name);
    const reg = loadRegistry();
    reg.previous.codex = reg.active.codex ?? null;
    reg.active.codex = name;
    saveRegistry(reg);
    return { warnings: [], notes: [] };
  }
  const profile = readClaudeProfile(name);
  if (profile.kind === "api") {
    claudeApiOn(name);
    return { warnings: [], notes: [] };
  }
  return switchClaudeSub(name, { safe });
}

function resolveName(name: string): { tool: Tool } {
  const inCodex = listCodexProfiles().includes(name);
  const inClaude = listClaudeProfiles().includes(name);
  if (inCodex && inClaude) {
    throw new Error(`"${name}" exists for both tools. Use \`hop codex ${name}\` or \`hop claude ${name}\`.`);
  }
  if (inCodex) return { tool: "codex" };
  if (inClaude) return { tool: "claude" };
  throw new Error(`No profile "${name}". Run \`hop status\` to list profiles.`);
}

function printSwitchResult(tool: Tool, name: string, result: { warnings: string[]; notes: string[] }): void {
  for (const warn of result.warnings) console.log(yellow(`! ${warn}`));
  console.log(green(`✓ ${tool} → ${bold(name)}`));
  for (const note of result.notes) console.log(dim(`  ${note}`));
  if (tool === "codex") console.log(dim("  Next `codex` run uses this account (refreshes flow into the profile automatically)."));
  else console.log(dim("  Restart claude to pick up the new account."));
}

async function cmdUse(positionals: string[], safe: boolean): Promise<void> {
  await withLock(async () => {
    // Forms: `hop <name>` | `hop <tool> <name>`
    let tool: Tool;
    let name: string;
    if (positionals.length === 1) {
      const first = positionals[0] ?? "";
      const resolved = resolveName(first);
      tool = resolved.tool;
      name = first;
    } else {
      const t = positionals[0];
      if (t !== "claude" && t !== "codex") throw new Error(`Unknown tool "${t}". Use "claude" or "codex".`);
      tool = t;
      name = positionals[1] ?? "";
    }
    const result = await switchByTool(tool, name, safe);
    printSwitchResult(tool, name, result);
  });
}

async function cmdPrevious(safe: boolean): Promise<void> {
  const reg = loadRegistry();
  const prevCodex = reg.previous.codex;
  const prevClaude = reg.previous.claude;
  const target = prevClaude ?? prevCodex;
  if (!target) throw new Error("No previous profile recorded yet.");
  // Prefer whichever tool has a recorded previous; if both, ask for explicit form.
  if (prevClaude && prevCodex) {
    throw new Error(`Previous exists for both tools. Use \`hop claude ${prevClaude}\` or \`hop codex ${prevCodex}\`.`);
  }
  const tool: Tool = prevClaude ? "claude" : "codex";
  await withLock(async () => {
    const result = await switchByTool(tool, target, safe);
    printSwitchResult(tool, target, result);
  });
}

async function cmdNext(tool: Tool, safe: boolean): Promise<void> {
  const names = tool === "codex" ? listCodexProfiles() : listClaudeProfiles();
  if (names.length === 0) throw new Error(`No ${tool} profiles.`);
  const reg = loadRegistry();
  const current = tool === "codex" ? codexActiveName() : reg.active.claude ?? null;
  const idx = current ? names.indexOf(current) : -1;
  const next = names[(idx + 1) % names.length] ?? names[0];
  if (!next) throw new Error(`No ${tool} profiles.`);
  await withLock(async () => {
    const result = await switchByTool(tool, next, safe);
    printSwitchResult(tool, next, result);
  });
}

async function cmdAdd(name: string, tool: Tool, api: boolean, key: string | undefined): Promise<void> {
  if (!name) throw new Error("Usage: hop add <name> --tool claude|codex [--api] [--key <sk-…>]");
  await withLock(async () => {
    const reg = loadRegistry();
    if (tool === "codex") {
      if (api) throw new Error("For a Codex API profile, run `codex login --api-key` then `hop add <name> --tool codex`.");
      const { forkedFrom, auth } = adoptCodex(name);
      const id = codexIdentity(auth);
      upsertProfile(reg, {
        name,
        tool: "codex",
        kind: id.kind,
        email: id.email,
        plan: id.plan,
        accountId: id.accountId,
        savedAt: new Date().toISOString(),
      });
      reg.active.codex = name;
      saveRegistry(reg);
      if (forkedFrom) console.log(yellow(`! auth.json was already linked to "${forkedFrom}"; forked its current content into "${name}".`));
      console.log(green(`✓ captured codex profile ${bold(name)}`) + (id.email ? dim(` (${id.email})`) : ""));
      return;
    }
    const profile = await adoptClaude(name, { api, apiKey: key ?? process.env.HOP_API_KEY });
    const idl = claudeIdentityLabel(profile);
    upsertProfile(reg, {
      name,
      tool: "claude",
      kind: profile.kind,
      email: idl.email,
      plan: idl.plan,
      accountId: profile.oauthAccount?.accountUuid,
      orgId: profile.oauthAccount?.organizationUuid,
      savedAt: profile.savedAt,
    });
    saveRegistry(reg);
    console.log(green(`✓ captured claude ${profile.kind} profile ${bold(name)}`) + (idl.email ? dim(` (${idl.email})`) : ""));
  });
}

async function cmdClaudeMode(mode: "api" | "sub", name: string | undefined, safe: boolean): Promise<void> {
  await withLock(async () => {
    if (mode === "api") {
      const target = name ?? listClaudeProfiles().find((n) => readClaudeProfile(n).kind === "api");
      if (!target) throw new Error("No Claude API profile. Create one: `hop add <name> --tool claude --api --key sk-ant-…`.");
      claudeApiOn(target);
      console.log(green(`✓ claude → ${bold(target)} (API billing)`));
      console.log(dim("  apiKeyHelper set in settings.json; outranks subscription OAuth. Restart claude to apply."));
      return;
    }
    if (!name) throw new Error("Usage: hop claude sub <profile>");
    const result = await switchClaudeSub(name, { safe });
    printSwitchResult("claude", name, result);
  });
}

function cmdWhich(json: boolean): void {
  const reg = loadRegistry();
  const codex = codexActiveName();
  const claude = reg.active.claude ?? null;
  const helper = getApiKeyHelper();
  if (json) {
    console.log(JSON.stringify({ codex, claude, claudeApiOverride: helper !== null && helper.startsWith(hopHome()) }, null, 2));
    return;
  }
  console.log(`codex:  ${codex ? bold(codex) : dim("(unmanaged/none)")}`);
  console.log(`claude: ${claude ? bold(claude) : dim("(none)")}`);
}

async function cmdRemove(name: string, yes: boolean): Promise<void> {
  if (!name) throw new Error("Usage: hop rm <name> [-y]");
  const reg = loadRegistry();
  const matches = reg.profiles.filter((p) => p.name === name);
  if (matches.length === 0) throw new Error(`No profile "${name}".`);
  if (!yes) {
    const answer = prompt(`Remove profile "${name}" (${matches.map((m) => m.tool).join(", ")})? This only deletes the stored snapshot. [y/N]`);
    if (answer?.toLowerCase() !== "y") {
      console.log("Aborted.");
      return;
    }
  }
  const fs = await import("node:fs");
  for (const m of matches) {
    const p =
      m.tool === "codex"
        ? `${codexHome()}/accounts/${name}.json`
        : `${hopHome()}/claude/${name}.json`;
    try {
      fs.rmSync(p);
    } catch {
      /* profile file already gone */
    }
  }
  reg.profiles = reg.profiles.filter((p) => p.name !== name);
  if (reg.active.claude === name) reg.active.claude = null;
  if (reg.active.codex === name) reg.active.codex = null;
  saveRegistry(reg);
  console.log(green(`✓ removed profile ${bold(name)}`));
}

async function cmdDoctor(): Promise<void> {
  const checks: { ok: boolean; label: string }[] = [];
  const push = (ok: boolean, label: string): void => {
    checks.push({ ok, label });
  };

  // Codex store mode + symlink integrity
  try {
    assertFileStoreMode();
    push(true, "Codex credential store is file mode");
  } catch (e) {
    push(false, errMsg(e));
  }
  const codexActive = readActiveCodex();
  if (codexActive.state === "managed-missing") push(false, `Codex auth.json → "${codexActive.name}" but that profile file is missing`);
  else if (codexActive.state === "unmanaged") push(false, "Codex auth.json is a regular file (unmanaged) — run `hop add`");
  else if (codexActive.state === "managed") push(true, `Codex active symlink → ${codexActive.name}`);
  else push(true, "Codex logged out");

  // Claude keychain reachability + mcpOAuth presence + subscription/API-key shadowing
  try {
    const kc = await readClaudeKeychain();
    const apiKeyItem = await securityFind(claudeApiKeyService(), keychainAccount());
    if (kc === null) push(true, "Claude keychain item not present (no subscription login captured)");
    else {
      push(true, `Claude keychain readable (service "${claudeCredentialsService()}")`);
      const raw = JSON.parse(kc.raw);
      if (raw && typeof raw === "object" && "mcpOAuth" in raw) push(true, "mcpOAuth present in keychain blob (preserved on swap)");
    }
    if (kc?.parsed.claudeAiOauth && apiKeyItem !== null) {
      push(false, "both a subscription login and a console API key are present — the API key may shadow the subscription; `hop <sub-profile>` clears it");
    }
  } catch (e) {
    push(false, `Claude keychain unreadable: ${errMsg(e)}`);
  }

  // claude.json parses
  try {
    const { existsSync, readFileSync } = await import("node:fs");
    if (existsSync(claudeJsonPath())) {
      JSON.parse(readFileSync(claudeJsonPath(), "utf-8"));
      push(true, "~/.claude.json parses");
    }
  } catch (e) {
    push(false, `~/.claude.json does not parse: ${errMsg(e)}`);
  }

  // journal empty
  const journal = readJournal();
  if (journal) push(false, `Unfinished switch journaled (${JSON.stringify(journal)}); state may be mid-swap`);
  else push(true, "No unfinished switch journaled");

  // running processes
  const [claudePids, codexPids] = await Promise.all([runningPids("claude"), runningPids("codex")]);
  if (claudePids.length) push(true, dim(`note: claude running (pid ${claudePids.join(", ")})`).replace(/\x1b\[[0-9;]*m/g, ""));
  if (codexPids.length) push(true, dim(`note: codex running (pid ${codexPids.join(", ")})`).replace(/\x1b\[[0-9;]*m/g, ""));

  for (const c of checks) console.log(`${c.ok ? green("✓") : red("✗")} ${c.label}`);
  if (checks.some((c) => !c.ok)) process.exitCode = 1;
}

function cmdCompletions(): void {
  console.log(`# hop fish completions — add to ~/.config/fish/completions/hop.fish
function __hop_names
    hop __names 2>/dev/null
end
complete -c hop -f
complete -c hop -n __fish_use_subcommand -a "status add rm which next doctor claude codex completions -" -d "hop command"
complete -c hop -n "__fish_seen_subcommand_from claude codex next" -a "(__hop_names)" -d profile
complete -c hop -n "__fish_use_subcommand" -a "(__hop_names)" -d profile
complete -c hop -l tool -a "claude codex" -d "target tool"
complete -c hop -l api -d "API-key profile"
complete -c hop -l json -d "JSON output"
complete -c hop -l safe -d "block if claude/codex running"`);
}

function usage(): void {
  console.log(`hop — switch Claude Code & Codex accounts and billing

USAGE
  hop                          status table (which account, usage headroom)
  hop status [--json]
  hop <name>                   switch to a profile (auto-detects tool)
  hop <tool> <name>            switch, tool = claude | codex
  hop -                        switch to the previous profile
  hop next <tool>              rotate to the next profile of a tool
  hop add <name> --tool <t>    capture the current live login as a profile
       [--api] [--key sk-…]    ...as an API-key profile
  hop claude api [name]        flip Claude to API billing (apiKeyHelper toggle)
  hop claude sub <name>        restore a Claude subscription account
  hop which [--json]           show the active profile per tool
  hop rm <name> [-y]           delete a stored profile snapshot
  hop doctor                   health checks
  hop completions fish

FLAGS
  --safe   refuse a keychain/symlink swap while claude/codex is running`);
}

/* ── arg parsing + dispatch ──────────────────────────────────────────────── */

function parseArgs(argv: string[]): { positionals: string[]; flags: Record<string, string | boolean> } {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? "";
    if (a === "--json") flags.json = true;
    else if (a === "--safe") flags.safe = true;
    else if (a === "--api") flags.api = true;
    else if (a === "-y" || a === "--yes") flags.yes = true;
    else if (a === "--key") flags.key = argv[++i] ?? "";
    else if (a === "--tool") flags.tool = argv[++i] ?? "";
    else positionals.push(a);
  }
  return { positionals, flags };
}

async function main(): Promise<void> {
  const { positionals, flags } = parseArgs(process.argv.slice(2));
  const json = flags.json === true;
  const safe = flags.safe === true;
  const cmd = positionals[0];

  // Recover from an interrupted switch on any invocation.
  if (readJournal() && cmd !== "doctor") {
    console.error(yellow("! A previous switch did not finish (see `hop doctor`). Clearing journal marker."));
    clearJournal();
  }

  if (cmd === undefined) return void (await cmdStatus(json));

  switch (cmd) {
    case "status":
      return void (await cmdStatus(json));
    case "-":
      return void (await cmdPrevious(safe));
    case "which":
      return void cmdWhich(json);
    case "doctor":
      return void (await cmdDoctor());
    case "next": {
      const t = positionals[1];
      if (t !== "claude" && t !== "codex") throw new Error("Usage: hop next <claude|codex>");
      return void (await cmdNext(t, safe));
    }
    case "add": {
      const t = flags.tool === "claude" || flags.tool === "codex" ? flags.tool : undefined;
      if (!t) throw new Error("Specify --tool claude|codex");
      return void (await cmdAdd(positionals[1] ?? "", t, flags.api === true, typeof flags.key === "string" ? flags.key : undefined));
    }
    case "rm":
    case "remove":
      return void (await cmdRemove(positionals[1] ?? "", flags.yes === true));
    case "completions":
      return void cmdCompletions();
    case "__names":
      return void console.log([...listClaudeProfiles(), ...listCodexProfiles()].join("\n"));
    case "help":
    case "--help":
    case "-h":
      return void usage();
    case "claude":
    case "codex": {
      // `hop claude api|sub …` special-cases; otherwise `hop <tool> <name>` switch.
      if (cmd === "claude" && (positionals[1] === "api" || positionals[1] === "sub")) {
        return void (await cmdClaudeMode(positionals[1], positionals[2], safe));
      }
      return void (await cmdUse(positionals, safe));
    }
    default:
      // Bare `hop <name>`.
      return void (await cmdUse(positionals, safe));
  }
}

main().catch((e: unknown) => {
  console.error(red(`✗ ${errMsg(e)}`));
  process.exit(1);
});
