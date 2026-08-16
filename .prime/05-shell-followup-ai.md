# Plan: Shell Follow-up AI (Active Talk After User Bash)

## Goal

After the user runs a shell command themselves in the interactive TUI (`!` or `!!` prefix), an LLM reads the command, its output, and the current conversation context, then proactively replies with a short follow-up related to the current situation. The feature is off by default, toggleable in settings, and uses a configurable model.

## User-visible behavior

- `!command` / `!!command` executes and streams output as today.
- When the run completes (bash_end) and the setting is enabled, a follow-up panel appears near the bash output: a brief LLM comment grounded in the command, its output, and the session context (e.g. "you found the matching line in src/x.ts — that confirms the refactor target").
- The follow-up is non-blocking, cancellable, and never added to the main session context.
- A settings toggle `Shell follow-up` (default off) and a `Shell follow-up model` (default: current session model) are available in `/settings`.

## Implementation

### Settings (packages/coding-agent/src/core/settings-manager.ts)

Add a `ShellFollowupSettings` section (or extend TerminalSettings) with:

- `enabled?: boolean` default false
- `model?: string` optional provider/model key; empty = current session model

Add getters/setters (`getShellFollowupEnabled/setShellFollowupEnabled`, `getShellFollowupModel/setShellFollowupModel`) following existing settings-manager patterns (globalSettings + save + markModified). Persist under a namespaced settings key.

### Settings UI (packages/coding-agent/src/modes/interactive/components/settings-selector.ts)

- Extend `SettingsConfig` with `shellFollowupEnabled: boolean` and `shellFollowupModel: string`.
- Add toggle item "Shell follow-up" (values true/false).
- Add model item "Shell follow-up model" listing `current` plus available model keys from the connection catalog; on change call `onShellFollowupModelChange`.
- Add callbacks `onShellFollowupEnabledChange`, `onShellFollowupModelChange` and wire them in `interactive-mode.ts showSettingsSelector()` to the settings manager setters.

### Follow-up trigger (packages/coding-agent/src/modes/interactive/interactive-mode.ts)

In the `bash_end` session-event case, after the run is marked complete (not cancelled, no error, user-initiated `!`/`!!`, not a side-question pane run), if `getShellFollowupEnabled()` and no active side question:

1. Collect the command (from the matching BashExecutionComponent or the bash_start event) and its output (component.getOutput(), truncated via existing truncateTail helper).
2. Build a question string: "The user ran the command: <command>\n\nOutput:\n<output>\n\nProvide a very brief follow-up (1-3 sentences) grounded in the current conversation and this output. Do not use tools."
3. Start a side-question run (reuse `agentConnection.startSideQuestion` + existing side-question pane plumbing) with a distinct pane title "Shell follow-up" so it renders as a follow-up, not a `/btw` question.
4. If a follow-up model is configured, resolve it and pass it to the side-question request; otherwise use the session model.

### Model override plumbing

- `packages/coding-agent/src/modes/agent-connection/types.ts`: extend `startSideQuestion(id, question, previousTurns?, model?)` with optional model.
- `packages/coding-agent/src/modes/agent-connection/daemon-agent-connection.ts`: send optional `model` field; guard with a new negotiated server capability (e.g. `side_question_model`).
- `packages/coding-agent/src/modes/daemon/daemon-protocol.ts`: add optional `model?: { provider: string; id: string }` to `start_side_question`; add capability to `DaemonServerCapability` and default capability list; bump DAEMON_SCHEMA_REVISION and update schema id.
- `packages/coding-agent/src/modes/daemon/daemon-mode.ts`: on `start_side_question`, if model provided, resolve via `session.modelRegistry` and pass to `startSideQuestion`; otherwise current model.
- `packages/coding-agent/src/core/side-question.ts`: accept optional model override in `startSideQuestion`; use `model ?? parent.state.model`; validate the model is usable.

### Rendering

Reuse the side-question pane, or add a lightweight "Shell follow-up" panel component next to the bash output that shows `Thinking…` then the markdown answer. Prefer reusing the existing side-question event stream so streaming/cancel/error states work unchanged; only the title/label differs.

## Tests

- Settings getters/setters persistence round-trip.
- Side-question model override: model passed through when configured, session model when not.
- Daemon protocol: new capability negotiated; old-client/new-daemon and new-client/old-daemon behavior (capability check before sending model; old daemon ignores/refuses gracefully).
- Interactive-mode: follow-up triggered after user bash completion when enabled, not triggered when disabled or for cancelled/failed runs; not triggered for side-question pane runs; no follow-up while another side question is active.

## Validation

Run focused tests from packages/coding-agent, then `npm run check` from the repo root. Do not run prohibited broad test/build/dev commands.

## Risks

- Overlapping with `/btw` side questions: reuse the same slot guard (one active side question).
- Model override is a protocol change: keep it capability-gated and backward compatible.
- Privacy: follow-up output stays out of the main session context, same as side questions.
