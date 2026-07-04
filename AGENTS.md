## Process

- **Always use `bun`/`bunx`, never `npm`/`pnpm`/`npx`/`yarn`.** Applies to installs, scripts, and one-off package execution alike.
- **Never use type casts (`as`) or `any`.** Derive or import the real type, or validate with a Zod schema (`z.infer` for the type) instead of forcing the compiler to accept it. Use Zod over hand-written type guards, even for simple checks.
- **Implement in a worktree.** Create a git worktree before starting feature implementation; never build on the main checkout (it often carries unrelated uncommitted work). Push worktree branches with an explicit refspec: `git push origin <name>:refs/heads/<name>` — `push.default=upstream` can silently push to `main` otherwise.
- **Conventional Commits** Use the `conventional-commit` skill to commit work. Auto-push if work was done on a branch or worktree. Do NOT push to `main` without explicit instruction to do so.
- **Verify the real cause before shipping a fix.** When something "is broken," reproduce or trace the actual failure (rendered DOM, CSS stacking/pointer-events, dev server, curl) before committing a plausible-sounding theory. If you can't reproduce, say so instead of pushing a guess. A wrong fix on main costs more than five minutes of investigation.
- **Consult tool/SDK docs before building custom instrumentation.** Mature tools (Sentry, OpenTelemetry, Claude Code, Vercel) usually have built-in env flags, auto-instrumentation, and native events. Read the vendor's telemetry/hooks/events docs _before_ drafting a plan that adds wrappers or hooks.
- **Verify SDK types before dismissing a claimed feature.** If the user says an SDK has an option you don't recall, grep the installed `.d.ts` (or `npm pack <pkg>@latest` into a scratch dir and grep the tarball). Doc indexes lag; type definitions are ground truth.
- **Breaking changes are allowed.** No transitional defaults on new `notNull` columns, no self-heal backfills, no backwards-compat gates or deprecated aliases. Delete "what if this predates the refactor" code paths. Assume a one-shot backfill script or fresh DB reset covers existing rows.

## Testing

- **Keep tests focused.** Each test exercises one behavior; don't bundle unrelated assertions into a single test.
- **Prefer live over mocked.** Mock only what's truly external or non-deterministic (third-party APIs, time, randomness); hit real databases/services in-process where feasible.
- **Prefer e2e over unit.** An e2e test that exercises the real flow beats a pile of unit tests around internals — reach for unit tests only when e2e coverage can't reach the case.
- **Always parallelize test runs.**

## Code style & structure

- **No wrapper helpers.** Inline logic at the call site (5–15 lines inline beats a named helper). Reach for a function only when the same logic appears in 3+ places, it's already extracted, or the framework requires a module boundary (workflow steps, route handlers). If you add a function or file, look for an old one to delete — keep net surface area flat or smaller. Never leave thin wrapper layers behind after a refactor.
- **No new workspace packages.** Move code into an existing package (same dependencies, related domain); use subpath exports to avoid naming collisions. Create a new package only when working on a major new unrelated component.
- **Prefer official SDKs for third-party services.** An official TypeScript SDK beats a hand-rolled raw-fetch client (e.g. `@linear/sdk` gave error classification, webhook HMAC verification, and transport for free). Hand-rolling only wins when the SDK is unmaintained, drags a heavy transitive tree, or you need a trivial slice.
- **Always use the latest dependency versions.** For `bun.lock` conflicts: `rm bun.lock && bun i`. If a newer version breaks consuming code, fix the consumer — never downgrade or pin to mask breakage. Deliberate catalog pins/`overrides` in the root `package.json` stay unless told otherwise.
- **shadcn/ui is the component base.** Install via `bunx shadcn@latest add <name>` instead of hand-rolling dialogs, tooltips, popovers, etc. If an app lacks `components.json`, run `bunx shadcn@latest init`. Keep the custom `brand-*` Tailwind tokens working alongside shadcn's CSS variables.

## API contracts (Hono)

- Every route file defines `const xxxSchema = z.object(...)` for both **input** and **output**. Validate inputs with `zValidator("json", schema, ...)`; annotate responses with `satisfies z.infer<typeof outputSchema>` on `c.json(...)` (a `satisfies`, not a cast, so drift fails to compile). Export types via `z.infer` for consumers to import by name.
- **Do not use `hc<App>()` RPC** in this repo — Hono's chained Schema type collapses to `unknown` across package boundaries.

## Database (Drizzle/Postgres)

- **Never hand-write migration SQL.** Edit only the TS schema (`packages/db/src/schema/*.ts`) and use `bun db:push` for local iteration. Don't run `db:generate` during dev — defer migration files until the schema is stable.
- **Native `pgEnum` for closed value sets**, not `varchar().$type<>()`. Declare the enum from the canonical `as const` tuple in `@manicule/types/overhaul` (same tuple the Zod schemas and apps import); one enum type can back many columns. Exceptions: Better Auth's `auth.ts` (adapter needs varchar) and legacy loose statuses in `audit.ts`.
- **Wrap multi-statement sequences in `db.transaction(async (tx) => ...)`** when they must commit together (canonical pattern: `resetPipelineRunForResume` in `apps/api/src/pipeline/store.ts`). Single statements are atomic on their own. When modifying a file with DB calls, audit its existing call sites for the same property. Don't span a transaction across workflow `"use step"` boundaries — each step's writes must commit independently for resume. Never swallow DB write errors with `.catch()` after a successful external side-effect (GitHub PR, sandbox snapshot) — that leaves DB state silently diverged; let step retry logic handle it.

## AI / LLM usage

- **No LLM step for already-structured data.** If the input is shaped rows (names, statuses, counts), render with a deterministic template/label map — a model adds cost, latency, nondeterminism, and an unmockable test boundary for zero information gain. LLM steps are for unstructured input only.
- **Lean on agent context over heuristics.** When an agent already reads rich source material, have it extract facts from that content (fix the prompt first). Keep URL/domain/string-parsing heuristics strictly as last-resort fallbacks; don't expand them to cover cases the agent could just read.
- **Claude Agent SDK (`query()`) gotchas:** `permissionMode: "bypassPermissions"` requires `allowDangerouslySkipPermissions: true` in the same options object; structured JSON via `outputFormat: { type: "json_schema", schema }` (result at `message.structured_output`) beats regex-parsing `message.result`; HTTP MCP servers use `mcpServers: { name: { type: "http", url, headers } }`; `includePartialMessages: true` only when streaming UIs need per-token deltas.
- **Anthropic thinking + structured output (AI SDK):** the HTTP 400 "Thinking may not be enabled when tool_choice forces tool use" comes from the AI SDK's default `Output.object` tool-call mode. Set `providerOptions.anthropic.structuredOutputMode: "outputFormat"` to use native JSON output alongside thinking — don't reflexively disable thinking.

## Observability (Sentry on Vercel)

- **`await Sentry.flush(2000)` before returning** from any Vercel Function handler or workflow step that calls `Sentry.captureException`/`captureMessage` — Vercel can freeze the instance before the async transport ships the event. The error middleware usually survives without it, but flush on any path that could be the function's last act.
