# hop

Switch **Claude Code** and **Codex** accounts and billing without re-running login flows.

Ride a subscription until it hits its session/weekly limit, then flip to API-key billing — or bounce between multiple subscription accounts — and every new `claude`/`codex` run picks up the change. macOS only, Bun + TypeScript.

```
   TOOL    PROFILE   KIND  PLAN             5H   WEEK  FABLE  RESET IN  RESETS
●  claude  work      sub   max · me@co.com  12%  40%   88%    3h10m     —
   claude  work      api   API billing      —    —     —      —         —
   claude  personal  sub   pro · me@gmail   —    —     —      —         —
●  codex   work      sub   team · me@co.com 88%  61%   —      42m       2
   codex   work      api   API billing      —    —     —      —         —
```

## How it works

The two tools store credentials differently, so `hop` uses a different mechanism for each — behind one uniform CLI.

- **Codex** keeps its login in `~/.codex/auth.json` and rewrites it in place (truncate, no rename). `hop` turns `auth.json` into a symlink to `~/.codex/accounts/<name>.json`; switching just retargets the link. Because Codex writes *through* the link, background token refreshes (which rotate the refresh token) land in the active profile automatically — nothing to sync back.
- **Claude Code** keeps its login in the macOS Keychain (`Claude Code-credentials`), with account identity cached in `~/.claude.json`. Switching subscription accounts is a journaled, backup-first swap: it syncs the live (possibly rotated) token back into the outgoing profile, replaces only `claudeAiOauth` in the keychain blob (preserving `mcpOAuth`), patches the identity in `~/.claude.json`, then verifies and commits — rolling back on any mismatch.
- **Claude API billing** is a separate layer: switching to a claude `api` profile writes an `apiKeyHelper` into `~/.claude/settings.json` that outranks the subscription OAuth. It never touches the Keychain, so flipping to API billing (and back) is instant and safe even mid-session.

`hop` never calls `claude /logout` or `codex logout` (those revoke server-side). The worst case for any single fault is re-logging-in exactly one account.

## Install

```bash
bun install
bun link            # or: alias hop="bun run /path/to/src/cli.ts"
hop completions fish > ~/.config/fish/completions/hop.fish
```

## Usage

A profile is **(tool, name, kind)** — the same name can exist as `sub` and `api` for each tool, so "work" can have up to 4 variations. Switching to an `api` profile flips billing automatically (Claude: `apiKeyHelper` toggle; Codex: symlink to an API-key auth.json); switching to a `sub` profile swaps the login and clears any API override.

Without a `--sub`/`--api` flag, hop picks the kind for you: switching **within the active profile** toggles sub↔api (`hop claude work` while on `work (sub)` flips to API billing — the "I just hit my limit" motion); switching to a **different profile** defaults to sub, unless that sub's 5h/weekly/Fable window is already exhausted, in which case it goes to api. Landing on an exhausted sub always warns after the switch.

Claude subscriptions carry a separate model-scoped weekly limit for the **Fable 5** family, reported in the usage endpoint's newer `limits` array rather than the legacy top-level windows (which now return `null` on some plans). The `FABLE` column shows it; the `5H`/`WEEK` columns fall back to the array's unscoped session/weekly entries when the legacy fields are empty.

```bash
hop                         # status table: active account, usage headroom, and (codex) on-demand
                            # usage-limit RESET credits — available & unexpired, as CodexBar counts them
hop claude work             # on work (sub) and hit the limit? this toggles to work (api)
hop claude work             # ...and again to toggle back to the subscription
hop codex other             # different profile: defaults to sub (api if that sub is tapped out)
hop claude work --sub       # explicit kind always wins
hop -                       # switch to the previous profile
hop next codex              # rotate to the next codex profile

hop add work --tool codex                          # capture work (sub) from the current codex login
hop add work --tool claude                         # capture work (sub) from the current claude subscription login
hop add work --tool claude --api                   # store work (api) alongside work (sub) (key from the keychain, or --key sk-ant-…)
hop add work --tool codex  --api                   # store work (api) alongside work (sub) (key from the live `codex login --api-key`, or --key sk-proj-…)

hop which                   # active profile per tool
hop rm codex work --api     # delete a stored profile snapshot
hop doctor                  # health checks
```

Adding a **new** account is a one-time capture (hop can't fabricate a login):

```bash
# Codex
codex logout && codex login          # log into the new account
hop add personal --tool codex        # capture it

# Claude
# run /login inside claude for the new account, then:
hop add personal --tool claude
```

### Flags

- `--safe` — refuse a Keychain/symlink swap while `claude`/`codex` is running (default is warn-and-proceed).
- `--json` — machine-readable output for `status` / `which`.
- `NO_COLOR` — disable colored output.

## Safety notes

- Switching between subscription accounts (or capturing/restoring one) rewrites the Keychain / retargets the symlink. By default `hop` warns if `claude`/`codex` is running but proceeds; it always backs up first and verifies, so a botched swap is recoverable from `~/.config/hop/backups/`.
- Switching to a Claude **subscription** profile removes a leftover console/API-key credential (the `Claude Code` keychain item and `primaryApiKey` in `~/.claude.json`) so it can't shadow the subscription — mirroring what Claude's own `/login` does. The removed key is backed up to `~/.config/hop/backups/` and can be re-minted from the Console. `hop doctor` flags the shadow state if both are ever present at once.
- Codex's OS-keyring credential store (`cli_auth_credentials_store = keyring|auto`) is unsupported; `hop` refuses rather than silently no-op. Set it to `file` and re-login.

## Development

```bash
bun test            # e2e tests — isolated via CODEX_HOME + a hashed CLAUDE_CONFIG_DIR keychain service; never touches real logins
bun run typecheck
```
