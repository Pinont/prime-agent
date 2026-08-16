# Plan: /stats Command (Activity, Learning, Token & Cost Dashboard)

## Goal

Add a `/stats` slash command that shows a GitHub-style contribution report for the user's Prime Agent usage: a per-day activity heatmap (light to dark), the learning path (harness memories / refinements), token in/out usage, and total cost. Aggregate across sessions in the user's session directory, not just the current session.

## User-visible behavior

`/stats` opens a TUI panel (or prints a structured table) with:

1. **Activity heatmap** — a GitHub-contribution-style grid: one column per week, one row per weekday, each day colored from light to dark by the number of active sessions/messages that day (last 52 weeks). Include a text legend (0, 1-5, 6-10, 11+) since color is never the only signal.
2. **Learning path** — a list of the harness memories/refinements created or updated over time (title, created/updated date, scope), i.e. "what we went through". Sourced from the continual harness state (`~/.prime/agent/.../harness_state.json` or the same store the refine skill uses), newest first.
3. **Token usage** — total input, output, cache-read, cache-write tokens across all scanned sessions, plus per-day totals for the heatmap period.
4. **Cost** — total cost in $ (sum of usage.cost.total across assistant messages), with a daily breakdown for the heatmap period.

Headless/RPC: `/stats --json` (or `-m json`) returns the same data as structured JSON.

## Implementation

### Data sources

- **Sessions**: scan the session directory for `.jsonl` session files (same layout SessionManager uses). For each entry:
  - `message.role === "assistant"` → usage from `message.usage` (input/output/cacheRead/cacheWrite/totalTokens/cost.total) keyed by `message.timestamp` (day bucket) and model/provider.
  - `type === "message"` entries → activity day bucket by timestamp.
  - Respect the existing entry/session file format; do not parse arbitrary files. Skip sessions that fail to parse, with a count of skipped.
- **Learning path**: read the harness state (same file/API the continual harness uses — check `getHarnessState`/refine skill storage) and list memories/refinements with timestamps.
- Scope: the user's session directory (default `~/.prime/agent/sessions/` or whatever the session manager uses; override with the same env vars the config uses).

### Command wiring

- Register `stats` in `packages/coding-agent/src/core/slash-commands.ts` (description "Show activity, learning, token and cost stats").
- Handle it in interactive-mode (like `/context`): compute stats (async, bounded), render a panel with the heatmap using theme semantic tokens (no ANSI literals), the learning path list, token totals, and cost.
- Add `usage`/`stats` alias handling where appropriate; do not collide with existing `/context`.
- Add a `--json` argument (or reuse `-m json` headless path) for structured output.
- Keep the computation bounded: cap scanned sessions/files and parse only needed entry types; show a progress/loading state for large directories.

### Theme integration

- Use existing semantic tokens (accent, muted, success, warning, error, selected surface) for the heatmap scale and labels; heatmap colors are an intensity ramp derived from the active theme, never a second palette. Text legend always present.

## Tests

- Stats aggregation over a small fixture directory: correct day buckets, token totals, cost sum, skipped-corrupt handling.
- Heatmap rendering: correct week/day grid for a known date range, legend present, no-color fallback.
- Learning path extraction: memories/refinements listed with timestamps, newest first.
- `/stats` command registered and headless `--json` returns valid structured data.
- Large/corrupt directory: bounded, no crash, skipped count reported.

## Validation

Run focused tests from packages/coding-agent, then `npm run check` from the repo root. Do not run prohibited broad test/build/dev commands.

## Risks

- Session directory size: bound scanning and cache aggregated results per invocation; no global store.
- Privacy: stats are local-only; never sent to providers or uploaded (unless an explicit `/share`-style action is added later).
- Parsing drift: use the session manager's own entry types/parsers where exported, not ad-hoc regex.
