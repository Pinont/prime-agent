# Plan: Plan, Build, and Orchestrate Modes

## Goal

Add an extension-driven workflow with three modes that use the currently selected model without changing model configuration:

- **PLAN**: research and planning only.
- **BUILD**: direct implementation with normal tools.
- **ORCHESTRATE**: implementation is delegated to a subagent first, then the root agent coordinates, reviews, and validates.

The primary command is `/mode`. A configurable keyboard shortcut may cycle modes, but the command remains the canonical interface.

## User workflow

```text
/mode plan
  -> research repository and requirements
  -> ask clarifying questions when needed
  -> submit and display a structured plan

/mode build
  -> explicitly approve the plan
  -> restore normal tools
  -> execute directly

/mode orchestrate
  -> explicitly approve the plan
  -> require a relevant subagent delegation before root mutations
  -> review and validate delegated work
```

Supported commands:

- `/mode` — show the current mode and plan status.
- `/mode plan` — enter read-only planning mode.
- `/mode build` — approve the current plan and enter direct execution mode.
- `/mode orchestrate` — approve the current plan and enter delegated execution mode.
- `/mode status` — show mode, plan revision, and orchestration state.
- `/mode cancel` — cancel the current plan and return to PLAN mode.

The same selected model remains active in all modes. No `planModel`, `buildModel`, or model switching is required.

## Mode semantics

### PLAN

- Enable only read-only tools.
- Block `bash`, `edit`, write-capable `ipython`, and mutating custom/MCP tools.
- Inject planning instructions through `before_agent_start`.
- Allow the model to ask questions using an `ask_user` tool.
- Require the model to call `submit_plan` when the plan is complete.
- Display `PLAN READY` after successful plan submission.
- Do not modify project files except for the controlled plan artifact described below.

### BUILD

- Restore the tools that were active before PLAN mode.
- Permit direct implementation and validation.
- Do not require subagent delegation.
- Keep the approved plan and revision available as context/state.

### ORCHESTRATE

- Restore execution tools, but require subagent delegation before root-agent mutation.
- Block root `bash`, `edit`, write-capable `ipython`, and other mutating tools until a relevant subagent task has started.
- Allow the root agent to inspect, delegate, review, integrate, and validate.
- Propagate the orchestration/read-only policy to child agents where the runtime supports it.

## Mode transitions

```text
PLAN -> BUILD          explicit plan approval required
PLAN -> ORCHESTRATE    explicit plan approval required
BUILD -> PLAN          immediate
ORCHESTRATE -> PLAN    immediate
ORCHESTRATE -> BUILD   explicit confirmation recommended
```

A shortcut may cycle:

```text
PLAN -> ORCHESTRATE -> BUILD -> PLAN
```

The shortcut must use Prime Agent's configurable keybinding system. Do not hardcode a non-configurable `Tab` binding; `Tab` currently belongs to editor autocomplete. Use a configurable action, with `Shift+Tab` as a possible default if supported by the extension keybinding API.

## Plan artifact

When the model calls `submit_plan`, save a reviewable generated artifact in the project root under a reserved namespace distinct from checked-in source plans and QA reports:

```text
.prime/<number>-submitted-<feature>.md
```

The extension must scan only this submitted-artifact namespace, ignore source plans and all `plan-reader-*`, `*-qa*`, and other review reports, and allocate with atomic exclusive creation plus retry on collision. The feature slug must be lowercase kebab-case with control characters and path separators rejected. Bind the artifact path and an ownership token to the submitting session; another session must not adopt it by path alone. Validate realpaths and symlinks for `.prime` and the destination, and recover explicitly if file writing or session metadata persistence fails. Never overwrite an existing source or submitted artifact.

The artifact should contain:

1. Goal and non-goals.
2. User-visible workflow and commands.
3. Current repository mechanisms and relevant files.
4. Mode state machine and transition rules.
5. Tool policy and enforcement points.
6. Ask-user interaction requirements.
7. Plan/build/orchestrate implementation steps.
8. Testing and validation.
9. Risks, limitations, and deferred work.

The extension must write only to the controlled `.prime/` plan path. Reject path traversal, absolute paths outside the project, and symlink escapes. Plan artifacts are project documentation and should not be treated as session state.

## Ask-user interaction

Register an LLM-callable `ask_user` tool with these input modes:

- `text` — single-line input via `ctx.ui.input()`.
- `choice` — one option via `ctx.ui.select()`.
- `multi-choice` — multiple options via `ctx.ui.custom()`.
- `confirm` — yes/no via `ctx.ui.confirm()`.
- `editor` — multiline response via `ctx.ui.editor()`.

Return cancellation separately from an empty answer. In headless modes where `ctx.hasUI` is false, return a structured unavailable/cancelled result rather than hanging.

## Plan completion and approval

Register `submit_plan` as an LLM-callable tool. It accepts:

- title or feature name;
- summary;
- ordered implementation steps;
- affected files/components;
- tests and validation;
- risks and alternatives.

On successful submission:

1. Validate the plan structure.
2. Increment the plan revision.
3. Write `.prime/<number>-<feature>.md`.
4. Persist plan metadata in a namespaced session entry.
5. Show `PLAN READY` in the status bar.
6. Show a widget with available actions: Build, Orchestrate, Review, Edit, Cancel.

Approval must be tied to the exact plan revision. Editing or replacing the plan invalidates earlier approval. Approval must reset for every new user request; it must never carry over to a later request.

## Session persistence

Use an append-only, namespaced custom entry such as:

```ts
pi.appendEntry("prime-agent.plan-mode", {
  version: 1,
  mode: "plan",
  planPath: ".prime/01-feature.md",
  planRevision: 1,
  approvedRevision: undefined,
  previousTools: [],
  orchestration: {
    required: false,
    delegatedTaskIds: [],
  },
});
```

Restore the latest entry on session start/reload. Intersect saved tools with currently registered tools before restoring them. Handle session replacement, fork, tree navigation, compaction, daemon reconnect, and extension reload without leaving stale mode handlers or tool snapshots.

## Tool enforcement

Use both active-tool filtering and execution-time blocking:

1. `pi.setActiveTools()` controls what the model normally sees.
2. `pi.on("tool_call")` is the hard enforcement hook.

Do not treat tool names alone as a complete security model. Unknown custom and MCP tools should be denied by default in PLAN mode. `ipython` is currently unrestricted and must either be blocked in PLAN/ORCHESTRATE-before-delegation or gain an explicit read-only runtime policy. A prompt instruction is not sufficient protection.

Future core improvement: add capability metadata to tool definitions (`read`, `write`, `execute`, `network`, `external-state`) and enforce a mode policy centrally, including MCP and RLM child agents.

## Orchestration enforcement

The extension must identify the repository's actual subagent/RLM tool or lifecycle event rather than guessing a tool name. Track delegated tasks, not only a boolean:

```ts
interface DelegatedTask {
  id: string;
  description: string;
  status: "pending" | "running" | "completed" | "failed";
  subagentId?: string;
}
```

In ORCHESTRATE mode, root mutations remain blocked until a relevant delegated task is running or has completed. After delegation, the root agent may perform integration fixes and validation.

## Implementation steps

1. Confirm extension command, shortcut, UI, and lifecycle APIs in `core/extensions`.
2. Implement mode state and `/mode` command parsing.
3. Implement configurable mode shortcut without taking over editor autocomplete.
4. Snapshot and restore active tools safely.
5. Add PLAN system-prompt instructions and tool-call enforcement.
6. Add `ask_user` with text, choice, confirm, editor, and multi-choice UI.
7. Add `submit_plan`, plan validation, numeric `.prime/0N-<feature>.md` artifact creation, and `PLAN READY` UI.
8. Add explicit PLAN -> BUILD and PLAN -> ORCHESTRATE approval flows.
9. Integrate actual subagent lifecycle/tool detection and enforce ORCHESTRATE delegation.
10. Persist and restore state across reload, restart, fork, tree navigation, compaction, daemon reconnect, and headless/RPC modes.
11. Add tests for every mode, transition, blocked tool category, plan revision, ask cancellation, and orchestration gate.
12. Update extension documentation and changelog.

## Validation criteria

- The selected model never changes during mode transitions.
- `/mode` reports accurate mode and plan status.
- PLAN cannot edit files or execute unrestricted commands.
- BUILD can execute normally after explicit approval.
- ORCHESTRATE cannot mutate before a relevant subagent delegation.
- A completed plan writes a unique `.prime/0N-<feature>.md` file and shows `PLAN READY`.
- New user requests invalidate previous approval.
- Ask dialogs work interactively and through RPC; headless mode fails safely.
- Session reload restores state without restoring deleted/unavailable tools.
- Existing editor keybindings and extension behavior remain functional.
