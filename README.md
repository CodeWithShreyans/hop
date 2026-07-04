# hop

Switch **Claude Code** and **Codex** accounts and billing without re-running login flows.

Ride a subscription until it hits its session/weekly limit, then flip to API-key billing — or bounce between multiple subscription accounts — and every new `claude`/`codex` run picks up the change. macOS only, Bun + TypeScript.

```
   TOOL    PROFILE   PLAN            5H   WEEK  RESET
●  claude  work      max · me@co.com 12%  40%   3h10m
   claude  personal  pro · me@gmail  —    —     —
   claude  api       API billing     —    —     —
●  codex   work      team · me@co.com 88% 61%   42m
```

## How it works

The two tools store credentials differently, so `hop` uses a different mechanism for each — behind one uniform CLI.

- **Codex** keeps its login in `~/.codex/auth.json` and rewrites it in place (truncate, no rename). `hop` turns `auth.json` into a symlink to `~/.codex/accounts/<name>.json`; switching just retargets the link. Because Codex writes *through* the link, background token refreshes (which rotate the refresh token) land in the active profile automatically — nothing to sync back.
- **Claude Code** keeps its login in the macOS Keychain (`Claude Code-credentials`), with account identity cached in `~/.claude.json`. Switching subscription accounts is a journaled, backup-first swap: it syncs the live (possibly rotated) token back into the outgoing profile, replaces only `claudeAiOauth` in the keychain blob (preserving `mcpOAuth`), patches the identity in `~/.claude.json`, then verifies and commits — rolling back on any mismatch.
- **Claude API billing** is a separate layer: `hop claude api` writes an `apiKeyHelper` into `~/.claude/settings.json` that outranks the subscription OAuth. It never touches the Keychain, so flipping to API billing (and back) is instant and safe even mid-session.

`hop` never calls `claude /logout` or `codex logout` (those revoke server-side). The worst case for any single fault is re-logging-in exactly one account.

## Install

```bash
bun install
bun link            # or: alias hop="bun run /path/to/src/cli.ts"
hop completions fish > ~/.config/fish/completions/hop.fish
```

## Usage

```bash
hop                         # status table: which account is active, how much headroom
hop <name>                  # switch to a profile (auto-detects the tool)
hop codex work              # explicit tool form
hop -                       # switch to the previous profile
hop next codex              # rotate to the next codex profile

hop add work --tool codex           # capture the current codex login as "work"
hop add work --tool claude          # capture the current claude subscription login
hop add api --tool claude --api --key sk-ant-…   # store an API-key profile

hop claude api [name]       # flip Claude to API billing
hop claude sub work         # restore a Claude subscription account
hop which                   # active profile per tool
hop rm <name>               # delete a stored profile snapshot
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
- Codex's OS-keyring credential store (`cli_auth_credentials_store = keyring|auto`) is unsupported; `hop` refuses rather than silently no-op. Set it to `file` and re-login.

## Development

```bash
bun test            # e2e tests — isolated via CODEX_HOME + a hashed CLAUDE_CONFIG_DIR keychain service; never touches real logins
bun run typecheck
```
