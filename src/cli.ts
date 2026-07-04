#!/usr/bin/env bun
import {
  adoptClaude,
  claudeApiOff,
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
  createCodexApiProfile,
  fetchCodexResetCredits,
  fetchCodexUsage,
  listCodexProfiles,
  readActiveCodex,
  readCodexProfile,
  refreshCodexProfile,
  switchCodex,
} from "./codex.ts";
import { codexJwtClaimsSchema, type Kind, type Tool } from "./schemas.ts";
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
  parseProfileKey,
  profileKey,
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
  kind: Kind;
  active: boolean;
  label: string; // plan / email
  fiveHour: UsageWindow;
  weekly: UsageWindow;
  resets: number | null; // codex on-demand usage-limit reset credits
  note?: string;
};

const skipUsage = (): boolean => Boolean(process.env.HOP_SKIP_USAGE);

type SubWindows = { fiveHour: UsageWindow; weekly: UsageWindow };

/** Live 5h/weekly windows for a codex sub profile (refreshes an inactive profile's expired token). */
async function codexSubWindows(name: string, isActive: boolean): Promise<SubWindows> {
  let auth = readCodexProfile(name, "sub");
  if (!auth.tokens?.access_token) return { fiveHour: null, weekly: null };
  const exp = decodeJwt(auth.tokens.access_token, codexJwtClaimsSchema)?.exp ?? null;
  if (!isActive && exp && exp * 1000 < Date.now() + 60_000 && auth.tokens.refresh_token) {
    auth = await refreshCodexProfile(name, "sub");
  }
  const token = auth.tokens?.access_token;
  if (!token) return { fiveHour: null, weekly: null };
  const usage = await fetchCodexUsage(token, codexIdentity(auth).accountId);
  const prim = usage.rate_limit?.primary_window;
  const sec = usage.rate_limit?.secondary_window;
  return {
    fiveHour: prim ? { pct: prim.used_percent, resetMs: prim.reset_at ? prim.reset_at * 1000 - Date.now() : null } : null,
    weekly: sec ? { pct: sec.used_percent, resetMs: sec.reset_at ? sec.reset_at * 1000 - Date.now() : null } : null,
  };
}

/** Live 5h/weekly windows for a claude sub profile (live keychain token when active). */
async function claudeSubWindows(name: string, isActive: boolean): Promise<SubWindows> {
  const profile = readClaudeProfile(name, "sub");
  if (!profile.claudeAiOauth) return { fiveHour: null, weekly: null };
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
    return { pct: u.utilization, resetMs: u.resets_at ? Date.parse(u.resets_at) - Date.now() : null };
  };
  return { fiveHour: toWin(usage.five_hour), weekly: toWin(usage.seven_day) };
}

/** Windows or null when unknowable (usage disabled, network/auth failure) — callers fail open. */
async function subWindowsSafe(tool: Tool, name: string, isActive: boolean): Promise<SubWindows | null> {
  if (skipUsage()) return null;
  try {
    return tool === "codex" ? await codexSubWindows(name, isActive) : await claudeSubWindows(name, isActive);
  } catch {
    return null;
  }
}

/** "5h at 100% (resets in 2h47m); weekly at 100%" when any window is exhausted, else null. */
function exhaustedLabel(w: SubWindows | null): string | null {
  if (!w) return null;
  const part = (label: string, win: UsageWindow): string | null =>
    win && win.pct >= 100
      ? `${label} at ${Math.round(win.pct)}%${win.resetMs !== null && win.resetMs > 0 ? ` (resets in ${fmtCountdown(win.resetMs)})` : ""}`
      : null;
  const parts = [part("5h", w.fiveHour), part("weekly", w.weekly)].filter((p) => p !== null);
  return parts.length ? parts.join("; ") : null;
}

async function codexRows(): Promise<Row[]> {
  const active = readActiveCodex();
  const activeKey = active.state === "managed" ? profileKey(active.name, active.kind) : null;
  return Promise.all(
    listCodexProfiles().map(async ({ name, kind }): Promise<Row> => {
      const isActive = profileKey(name, kind) === activeKey;
      const auth = readCodexProfile(name, kind);
      const id = codexIdentity(auth);
      const label = kind === "api" ? "API billing" : [id.plan, id.email].filter(Boolean).join(" · ") || "subscription";
      const row: Row = { tool: "codex", name, kind, active: isActive, label, fiveHour: null, weekly: null, resets: null };
      if (kind === "api" || skipUsage()) return row;
      try {
        const w = await codexSubWindows(name, isActive);
        row.fiveHour = w.fiveHour;
        row.weekly = w.weekly;
      } catch (e) {
        row.note = errMsg(e);
      }
      try {
        // Re-read: codexSubWindows may have refreshed (rotated) the profile's tokens.
        const token = readCodexProfile(name, kind).tokens?.access_token;
        if (token) row.resets = (await fetchCodexResetCredits(token, id.accountId)).available;
      } catch {
        /* informational column only */
      }
      return row;
    }),
  );
}

async function claudeRows(): Promise<Row[]> {
  const reg = loadRegistry();
  const active = await readActiveClaude();
  const activeKey = reg.active.claude ?? null;
  return Promise.all(
    listClaudeProfiles().map(async ({ name, kind }): Promise<Row> => {
      const profile = readClaudeProfile(name, kind);
      const isActive = profileKey(name, kind) === activeKey;
      const idl = claudeIdentityLabel(profile);
      const row: Row = {
        tool: "claude",
        name,
        kind,
        active: isActive,
        label: [kind === "api" ? "API billing" : idl.plan, idl.email].filter(Boolean).join(" · ") || kind,
        fiveHour: null,
        weekly: null,
        resets: null,
      };
      if (kind === "api") {
        if (active.helperActive && isActive) row.note = "active override";
        return row;
      }
      if (skipUsage()) return row;
      try {
        const w = await claudeSubWindows(name, isActive);
        row.fiveHour = w.fiveHour;
        row.weekly = w.weekly;
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
  const header = ["", "TOOL", "PROFILE", "KIND", "PLAN", "5H", "WEEK", "RESET IN", "RESETS"];
  const body = rows.map((r) => {
    const c = cell(r.fiveHour);
    const w = cell(r.weekly);
    const resetText = r.fiveHour ? c.reset : w.reset;
    const plan = r.note ? `${r.label} ${dim(`(${r.note})`)}` : r.label;
    const resets = r.resets === null ? dim("—") : r.resets > 0 ? green(String(r.resets)) : String(r.resets);
    return {
      cells: [r.active ? green("●") : " ", r.tool, r.name, r.kind, plan, c.pct, w.pct, resetText, resets],
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

function codexActiveKey(): string | null {
  const a = readActiveCodex();
  return a.state === "managed" ? profileKey(a.name, a.kind) : null;
}

/** Strict resolution (used by rm): explicit flag wins; else the only existing variation; ambiguity errors. */
function resolveKind(tool: Tool, name: string, kindFlag: Kind | null): Kind {
  const variations = (tool === "codex" ? listCodexProfiles() : listClaudeProfiles())
    .filter((p) => p.name === name)
    .map((p) => p.kind);
  if (kindFlag) {
    if (!variations.includes(kindFlag)) {
      throw new Error(`No ${tool} profile "${name}" (${kindFlag}). Run \`hop status\` to list profiles.`);
    }
    return kindFlag;
  }
  const first = variations[0];
  if (first === undefined) throw new Error(`No ${tool} profile "${name}". Run \`hop status\` to list profiles.`);
  if (variations.length > 1) {
    throw new Error(`"${name}" exists as both sub and api for ${tool}. Add --sub or --api.`);
  }
  return first;
}

/** Switch resolution when no kind flag is given: same profile → toggle sub↔api;
 *  different profile → sub, unless that sub's 5h/weekly limit is exhausted → api.
 *  Returns the windows when they were fetched so the caller can warn without refetching. */
async function resolveSwitchKind(
  tool: Tool,
  name: string,
  kindFlag: Kind | null,
): Promise<{ kind: Kind; notes: string[]; windows: SubWindows | null }> {
  const variations = (tool === "codex" ? listCodexProfiles() : listClaudeProfiles())
    .filter((p) => p.name === name)
    .map((p) => p.kind);
  if (kindFlag) {
    if (!variations.includes(kindFlag)) {
      throw new Error(`No ${tool} profile "${name}" (${kindFlag}). Run \`hop status\` to list profiles.`);
    }
    return { kind: kindFlag, notes: [], windows: null };
  }
  const first = variations[0];
  if (first === undefined) throw new Error(`No ${tool} profile "${name}". Run \`hop status\` to list profiles.`);
  if (variations.length === 1) return { kind: first, notes: [], windows: null };

  const activeKey = tool === "codex" ? codexActiveKey() : loadRegistry().active[tool] ?? null;
  const active = activeKey ? parseProfileKey(activeKey) : null;
  if (active?.name === name) {
    const kind: Kind = active.kind === "sub" ? "api" : "sub";
    return { kind, notes: [`same profile — toggled ${active.kind} → ${kind}`], windows: null };
  }
  const windows = await subWindowsSafe(tool, name, false);
  const ex = exhaustedLabel(windows);
  if (ex) {
    return { kind: "api", notes: [`"${name}" subscription is exhausted (${ex}) — defaulting to api; use --sub to override`], windows };
  }
  return { kind: "sub", notes: [], windows };
}

/** Switching to an api profile toggles billing automatically; a sub profile swaps the login. */
async function switchByTool(tool: Tool, name: string, kind: Kind, safe: boolean): Promise<{ warnings: string[]; notes: string[] }> {
  if (tool === "codex") {
    switchCodex(name, kind);
    const reg = loadRegistry();
    reg.previous.codex = reg.active.codex ?? null;
    reg.active.codex = profileKey(name, kind);
    saveRegistry(reg);
    return { warnings: [], notes: [] };
  }
  if (kind === "api") {
    claudeApiOn(name);
    return { warnings: [], notes: ["apiKeyHelper set (outranks subscription OAuth); the base login is untouched."] };
  }
  return switchClaudeSub(name, { safe });
}

function printSwitchResult(tool: Tool, name: string, kind: Kind, result: { warnings: string[]; notes: string[] }): void {
  for (const warn of result.warnings) console.log(yellow(`! ${warn}`));
  console.log(green(`✓ ${tool} → ${bold(name)} ${dim(`(${kind})`)}`));
  for (const note of result.notes) console.log(dim(`  ${note}`));
  if (tool === "codex") console.log(dim("  Next `codex` run uses this account (refreshes flow into the profile automatically)."));
  else console.log(dim("  Restart claude to pick it up."));
}

async function cmdUse(tool: Tool, name: string, kindFlag: Kind | null, safe: boolean): Promise<void> {
  if (!name) throw new Error(`Usage: hop ${tool} <name> [--sub|--api]`);
  await withLock(async () => {
    const { kind, notes, windows } = await resolveSwitchKind(tool, name, kindFlag);
    const result = await switchByTool(tool, name, kind, safe);
    result.notes.push(...notes);
    printSwitchResult(tool, name, kind, result);
    // Landing on a sub with a consumed 5h/weekly window deserves a heads-up — after the switch.
    if (kind === "sub") {
      const ex = exhaustedLabel(windows ?? (await subWindowsSafe(tool, name, true)));
      if (ex) {
        console.log(yellow(`! this subscription is exhausted — ${ex}. Flip to API billing: hop ${tool} ${name} --api`));
        if (tool === "codex") {
          try {
            const profile = readCodexProfile(name, "sub");
            const token = profile.tokens?.access_token;
            if (token) {
              const rc = await fetchCodexResetCredits(token, codexIdentity(profile).accountId);
              if (rc.available > 0) {
                const expiry = rc.nextExpiryMs !== null ? ` (next expires in ${fmtCountdown(rc.nextExpiryMs)})` : "";
                console.log(
                  yellow(`! ${rc.available} usage-limit reset${rc.available === 1 ? "" : "s"} available${expiry} — redeem in codex to clear the limit now`),
                );
              }
            }
          } catch {
            /* informational only */
          }
        }
      }
    }
  });
}

async function cmdPrevious(safe: boolean): Promise<void> {
  const reg = loadRegistry();
  const prevCodex = reg.previous.codex;
  const prevClaude = reg.previous.claude;
  if (!prevClaude && !prevCodex) throw new Error("No previous profile recorded yet.");
  if (prevClaude && prevCodex) {
    throw new Error(`Previous exists for both tools. Use \`hop claude …\` or \`hop codex …\` explicitly.`);
  }
  const tool: Tool = prevClaude ? "claude" : "codex";
  const parsed = parseProfileKey(prevClaude ?? prevCodex ?? "");
  if (!parsed) throw new Error("Previous profile record is unreadable; switch explicitly once to repair it.");
  await withLock(async () => {
    const result = await switchByTool(tool, parsed.name, parsed.kind, safe);
    printSwitchResult(tool, parsed.name, parsed.kind, result);
  });
}

async function cmdNext(tool: Tool, safe: boolean): Promise<void> {
  const profiles = tool === "codex" ? listCodexProfiles() : listClaudeProfiles();
  if (profiles.length === 0) throw new Error(`No ${tool} profiles.`);
  const reg = loadRegistry();
  const currentKey = tool === "codex" ? codexActiveKey() : reg.active.claude ?? null;
  const idx = profiles.findIndex((p) => profileKey(p.name, p.kind) === currentKey);
  const next = profiles[(idx + 1) % profiles.length] ?? profiles[0];
  if (!next) throw new Error(`No ${tool} profiles.`);
  await withLock(async () => {
    const result = await switchByTool(tool, next.name, next.kind, safe);
    printSwitchResult(tool, next.name, next.kind, result);
  });
}

async function cmdAdd(name: string, tool: Tool, api: boolean, key: string | undefined): Promise<void> {
  if (!name) throw new Error("Usage: hop add <name> --tool claude|codex [--api] [--key <sk-…>]");
  await withLock(async () => {
    const reg = loadRegistry();
    if (tool === "codex") {
      if (api) {
        const { source } = createCodexApiProfile(name, key ?? process.env.HOP_API_KEY);
        upsertProfile(reg, { name, tool: "codex", kind: "api", savedAt: new Date().toISOString() });
        saveRegistry(reg);
        const from = source === "live login" ? " (key pulled from the live codex login)" : "";
        console.log(green(`✓ created codex api profile ${bold(name)}`) + dim(`${from} — activate with \`hop codex ${name} --api\``));
        return;
      }
      const { forkedFrom, kind, auth } = adoptCodex(name);
      const id = codexIdentity(auth);
      upsertProfile(reg, {
        name,
        tool: "codex",
        kind,
        email: id.email,
        plan: id.plan,
        accountId: id.accountId,
        savedAt: new Date().toISOString(),
      });
      reg.active.codex = profileKey(name, kind);
      saveRegistry(reg);
      if (forkedFrom) console.log(yellow(`! auth.json was already linked to "${forkedFrom}"; forked its current content into "${name}".`));
      console.log(green(`✓ captured codex ${kind} profile ${bold(name)}`) + (id.email ? dim(` (${id.email})`) : ""));
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

function cmdWhich(json: boolean): void {
  const reg = loadRegistry();
  const codex = codexActiveKey();
  const claude = reg.active.claude ?? null;
  const helper = getApiKeyHelper();
  if (json) {
    console.log(JSON.stringify({ codex, claude, claudeApiOverride: helper !== null && helper.startsWith(hopHome()) }, null, 2));
    return;
  }
  const fmt = (key: string | null): string => {
    const p = key ? parseProfileKey(key) : null;
    return p ? `${bold(p.name)} ${dim(`(${p.kind})`)}` : dim("(unmanaged/none)");
  };
  console.log(`codex:  ${fmt(codex)}`);
  console.log(`claude: ${fmt(claude)}`);
}

async function cmdRemove(tool: Tool | undefined, name: string, kindFlag: Kind | null, yes: boolean): Promise<void> {
  if (!tool || !name) throw new Error("Usage: hop rm <claude|codex> <name> [--sub|--api] [-y]");
  const kind = resolveKind(tool, name, kindFlag);
  const key = profileKey(name, kind);
  // Removing the active codex profile would leave auth.json a dangling symlink (codex loses its login).
  if (tool === "codex" && codexActiveKey() === key) {
    throw new Error(`"${name}" (${kind}) is the active codex profile — switch to another profile first.`);
  }
  if (!yes) {
    const answer = prompt(`Remove ${tool} profile "${name}" (${kind})? This only deletes the stored snapshot. [y/N]`);
    if (answer?.toLowerCase() !== "y") {
      console.log("Aborted.");
      return;
    }
  }
  const fs = await import("node:fs");
  const p = tool === "codex" ? `${codexHome()}/accounts/${key}.json` : `${hopHome()}/claude/${key}.json`;
  try {
    fs.rmSync(p);
  } catch {
    /* profile file already gone */
  }
  const reg = loadRegistry();
  reg.profiles = reg.profiles.filter((pr) => !(pr.tool === tool && pr.name === name && pr.kind === kind));
  if (reg.active[tool] === key) {
    // Removing the active claude api profile must also retire its live apiKeyHelper override.
    if (tool === "claude" && kind === "api") claudeApiOff();
    reg.active[tool] = null;
  }
  if (reg.previous[tool] === key) reg.previous[tool] = null;
  saveRegistry(reg);
  console.log(green(`✓ removed ${tool} profile ${bold(name)} ${dim(`(${kind})`)}`));
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
  if (codexActive.state === "managed-missing")
    push(false, `Codex auth.json → "${profileKey(codexActive.name, codexActive.kind)}" but that profile file is missing`);
  else if (codexActive.state === "unmanaged") push(false, "Codex auth.json is a regular file (unmanaged) — run `hop add`");
  else if (codexActive.state === "managed") push(true, `Codex active symlink → ${profileKey(codexActive.name, codexActive.kind)}`);
  else push(true, "Codex logged out");

  // A `codex login` run while a profile symlink is active writes THROUGH the link and replaces that
  // profile's content — detect any profile whose content no longer matches its filename kind.
  for (const { name, kind } of listCodexProfiles()) {
    try {
      const derived = codexIdentity(readCodexProfile(name, kind)).kind;
      if (derived !== kind) {
        push(
          false,
          `codex profile "${name}" (${kind}) actually contains ${derived} credentials — a \`codex login\` through the active symlink likely overwrote it; recapture with \`hop add\``,
        );
      }
    } catch (e) {
      push(false, `codex profile "${name}" (${kind}) unreadable: ${errMsg(e)}`);
    }
  }

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
      push(false, "both a subscription login and a console API key are present — the API key may shadow the subscription; switching to a claude sub profile clears it");
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
  if (claudePids.length) push(true, `note: claude running (pid ${claudePids.join(", ")})`);
  if (codexPids.length) push(true, `note: codex running (pid ${codexPids.join(", ")})`);

  for (const c of checks) console.log(`${c.ok ? green("✓") : red("✗")} ${c.label}`);
  if (checks.some((c) => !c.ok)) process.exitCode = 1;
}

function cmdNames(tool: string | undefined): void {
  const profiles =
    tool === "claude" ? listClaudeProfiles() : tool === "codex" ? listCodexProfiles() : [...listClaudeProfiles(), ...listCodexProfiles()];
  console.log([...new Set(profiles.map((p) => p.name))].join("\n"));
}

function cmdCompletions(): void {
  console.log(`# hop fish completions — add to ~/.config/fish/completions/hop.fish
complete -c hop -f
complete -c hop -n __fish_use_subcommand -a "status add rm which next doctor claude codex completions -" -d "hop command"
complete -c hop -n "__fish_seen_subcommand_from claude" -a "(hop __names claude)" -d profile
complete -c hop -n "__fish_seen_subcommand_from codex" -a "(hop __names codex)" -d profile
complete -c hop -n "__fish_seen_subcommand_from next rm" -a "claude codex" -d tool
complete -c hop -l tool -a "claude codex" -d "target tool"
complete -c hop -l sub -d "subscription variation"
complete -c hop -l api -d "API-key variation"
complete -c hop -l json -d "JSON output"
complete -c hop -l safe -d "block if claude/codex running"`);
}

function usage(): void {
  console.log(`hop — switch Claude Code & Codex accounts and billing

A profile is (tool, name, kind): "work" can exist as sub AND api for each tool.
Switching to an api profile flips billing automatically; a sub profile swaps the login.

USAGE
  hop                             status table (which account, usage headroom)
  hop status [--json]
  hop <tool> <name> [--sub|--api] switch; tool = claude | codex
                                  no flag: same profile → toggles sub↔api;
                                  different profile → sub (or api when that
                                  sub's 5h/weekly limit is exhausted)
  hop -                           switch to the previous profile
  hop next <tool>                 rotate to the next profile of a tool
  hop add <name> --tool <t>       capture the current live login as a profile
       [--api] [--key sk-…]       ...as an API-key profile
  hop which [--json]              show the active profile per tool
  hop rm <tool> <name> [--sub|--api] [-y]
  hop doctor                      health checks
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
    else if (a === "--sub") flags.sub = true;
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
  if (flags.api === true && flags.sub === true) throw new Error("--sub and --api are mutually exclusive.");
  const kindFlag: Kind | null = flags.api === true ? "api" : flags.sub === true ? "sub" : null;
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
    case "remove": {
      const t = positionals[1] === "claude" || positionals[1] === "codex" ? positionals[1] : undefined;
      return void (await cmdRemove(t, positionals[2] ?? "", kindFlag, flags.yes === true));
    }
    case "completions":
      return void cmdCompletions();
    case "__names":
      return void cmdNames(positionals[1]);
    case "help":
    case "--help":
    case "-h":
      return void usage();
    case "claude":
    case "codex":
      return void (await cmdUse(cmd, positionals[1] ?? "", kindFlag, safe));
    default:
      throw new Error(`Unknown command "${cmd}". Switching is \`hop <claude|codex> <name>\` — see \`hop help\`.`);
  }
}

main().catch((e: unknown) => {
  console.error(red(`✗ ${errMsg(e)}`));
  process.exit(1);
});
