@AGENTS.md

## Picking the right models for workflows and subagents (MOST IMPORTANT)

Before every Agent call and every `agent()` call in a Workflow script, pick the model with this procedure and set it explicitly — never leave the parameter unset to inherit the session default:

1. **Bulk/mechanical work** (clear-spec implementation, data analysis, migrations) → **gpt-5.5** via the codex wrapper (Mechanics below). It's effectively free.
2. **Anything user-facing** (UI, copy, API design) → needs taste ≥ 7: **fable-5** or **opus-4.8**; sonnet-5 is the floor.
3. **Reviews of plans/implementations** → **fable-5** or **opus-4.8**, optionally gpt-5.5 as an extra independent perspective.
4. **Thin wrapper/glue agents** (like the codex wrapper) → **sonnet-5**, effort low.
5. **Never use Haiku.**

If a task matches both branches 1 and 2, branch 2 wins: user-facing work needs taste ≥ 7 even when the spec is mechanical. When spawning, state the choice in one clause ("gpt-5.5 because mechanical spec-following"). These are defaults, not limits: you have standing permission to escalate — if a cheaper model's output doesn't meet the bar, rerun or redo the work with a smarter model without asking. Judge the output, not the price tag; escalating costs less than shipping mediocre work. When axes conflict for anything that ships, intelligence > taste > cost — cost is a tie-breaker only.

Backing data (higher = better). Cost reflects what I actually pay, not list price. Intelligence is how hard a problem you can hand the model unsupervised. Taste covers UI/UX, code quality, API design, and copy.

| model    | cost | intelligence | taste |
| -------- | ---- | ------------ | ----- |
| gpt-5.5  | 9    | 8            | 5     |
| sonnet-5 | 5    | 5            | 7     |
| opus-4.8 | 4    | 7            | 8     |
| fable-5  | 2    | 9            | 9     |

Mechanics:

- gpt-5.5 is only reachable through the Codex CLI - `cx exec` / `cx review` (my `~/.codex/config.toml` defaults to gpt-5.5). Run `cx exec -s read-only` directly with a self-contained prompt.
- Claude models (sonnet-5, opus-4.8, fable-5) run via the Agent/Workflow model parameter. The model parameter only takes Claude models, so to use gpt-5.5 inside workflows and subagents, spawn a thin Claude wrapper agent with `model: 'sonnet'`, `effort: 'low'` whose prompt instructs it to write a self-contained codex prompt, run `cx exec` via Bash, and return the result.
