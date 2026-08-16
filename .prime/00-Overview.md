# Overview: Coordinated Prime Agent Plan Set

## Purpose

This document links the three implementation plans in `.prime/` into one executable roadmap. The plans are related but belong to different layers:

- [01 — Plan, Build, and Orchestrate Modes](./01-plan-build-orchestrate-mode.md) defines workflow state, approval, tool policy, and delegation gates.
- [02 — Claude-Inspired Midnight Theme with Codex Header](./02-claude-midnight-theme.md) defines the core TUI visual system and startup header.
- [03 — Auto-Enable the Todo Tool](./03-auto-enable-todo-tool.md) makes todo a built-in capability and preserves its session state.

The reader and QA reports (`plan-reader-1.md`, `plan-reader-2.md`, `plan-reader-3.md`, and `plan-qa.md`) were used to resolve cross-plan gaps before implementation. They are review artifacts, not submitted plan artifacts.

## Product outcome

A fresh Prime Agent session automatically provides todo tracking, supports an explicit PLAN → BUILD or PLAN → ORCHESTRATE workflow, and presents all states through one consistent midnight TUI language. The selected model never changes. Existing commands, keybindings, extension hooks, protocol behavior, themes, and session semantics remain compatible unless a plan explicitly states otherwise.

The user flow is:

1. Start a session; built-in `todo` and `/todos` are available without an extension path.
2. Select `claude-midnight` when the new visual design is desired. The Codex-style startup header shows Prime Agent identity/version, model, and working directory.
3. Run `/mode plan`; only the centrally classified read-only capabilities are visible and executable.
4. The agent researches, asks questions through `ask_user`, and submits a revisioned plan. A unique controlled `.prime/<number>-<slug>.md` artifact is written and `PLAN READY` is shown.
5. Explicitly approve BUILD for direct work or ORCHESTRATE for delegated work.
6. BUILD permits normal implementation. ORCHESTRATE blocks root mutation until a relevant subagent task is running or complete, then permits review, integration, and validation.
7. `/todos` remains session-scoped and follows existing resume/branch semantics; todo mutations never bypass mode policy.

## Dependency and ownership model

```text
ResourceLoader / extension lifecycle
  ├── built-in todo factory (03)
  └── mode policy and orchestration extension (01)
        ├── active-tool filtering
        ├── execution-time tool gate
        ├── ask_user / submit_plan
        └── subagent lifecycle integration

Theme schema / loader / interactive components (02)
  └── shared semantic presentation for todo, tools, modes, plans, and approvals
```

Implementation order:

1. **Foundation and contracts:** inspect actual extension, resource-loader, session, tool-call, subagent, and TUI APIs. Establish capability metadata, state/event ordering, duplicate registration behavior, and persistence rules.
2. **Todo (03):** extract one authoritative built-in factory, register it before mode tool snapshots, settle `--no-extensions`, duplicate handling, exact tool/command schemas, and branch/persistence behavior.
3. **Modes (01):** implement `/mode`, revision-bound approval, read-only and orchestration enforcement, `ask_user`, controlled artifact creation, and real subagent lifecycle gating.
4. **Theme/header (02):** add `claude-midnight`, decide and document header scope before implementation, then style mode/todo/tool states with existing semantic theme APIs. This may proceed in parallel after the component contracts are known.
5. **Integration and validation:** run the compatibility matrix and focused tests, then repository checks and documentation/changelog updates.

Plan 02 is core TUI work, not an extension. Plan 03 is a built-in extension factory, not a separately loaded example. Plan 01 must consume the actual registered tool and subagent lifecycle APIs rather than guessing names.

## Shared contracts

### Capability policy

Every tool is classified by capability, not by name: `read`, `write`, `execute`, `network`, and `external-state`. Unknown custom/MCP tools default to denied in PLAN and before the ORCHESTRATE delegation gate. `ipython` is denied until a real read-only runtime policy exists. Todo `add`, `toggle`, and `clear` are session-state mutations and are governed as write-capable; `list` and `/todos` display are read-only. `ask_user` is an allowed interaction capability; `submit_plan` is the sole controlled PLAN artifact write. The active-tool list is UX only; `tool_call` is the hard enforcement point and returns a stable, model-readable blocked result before side effects.

Built-ins register before mode snapshots. On transitions/reload, restore capabilities against currently registered tools, apply policy to newly registered tools, and remove stale listeners idempotently. Explicitly loading the old todo example must not create a second callable tool or command; conflict behavior and user override precedence must be deterministic.

### State and event ordering

Mode/plan state, delegation records, and todo state remain namespaced session data, not global storage. Project plan Markdown is a controlled project artifact, not session state. Use versioned entries/events and define recovery for malformed entries, stale paths, failed metadata persistence, failed artifact writes, compaction, fork, reload, and concurrent sessions.

The relevant lifecycle sequence is: user request boundary → mode/approval invalidation → tool registration/policy refresh → tool call or blocked call → delegation start/end → todo mutation or plan submission → UI status event → session append/restore. A new agent request invalidates plan approval but does not clear todo state. Branches inherit a point-in-time state and isolate subsequent mutations according to the repository’s session model.

### Visual/status vocabulary

All new UI uses existing theme semantic roles and shared panel/list helpers; no local ANSI literals or second palette. State is always conveyed by text, icon, or shape in addition to color:

| State/surface | Presentation contract |
|---|---|
| User / assistant | Existing markers and message hierarchy; midnight surfaces reinforce, not replace, semantic distinction. |
| Thinking / status | Terracotta emphasis plus visible status/collapse text. |
| Tool pending/running | Labeled tool panel, secondary surface, border, and running indicator. |
| Tool success | Explicit completion label/icon plus success color. |
| Tool failed | Error label/details plus error color. |
| Tool blocked by mode | `BLOCKED`/policy reason and recovery guidance plus warning/error treatment; never a generic failure. |
| Delegation waiting/running/completed/failed | Textual lifecycle label and task identity, using muted/accent/success/error roles. |
| Todo incomplete/complete/error | Stable ID, checkbox/check marker, text state, and appropriate success/muted/error role. |
| Plan ready/approved | `PLAN READY` and approval action labels; selected action uses the same selection surface as menus. |
| Permission pending/allowed/denied | Explicit action/status text and existing permission semantics. |
| Diffs | +/- markers and readable additions/deletions; color is supplementary. |
| Menus/editor | Existing focus, selection, autocomplete, and keyboard behavior; shared selected/border tokens. |

The Codex-style header uses active theme colors and preserves custom extension header precedence, quiet/verbose startup, invalidation, truncation, and narrow-width behavior. Header scope must be resolved before coding; the least surprising default is to gate the new header to `claude-midnight` so existing themes remain unchanged, unless product owners explicitly choose a documented global header improvement. No Claude logo/header is added.

## Resolved coordination decisions

These decisions are the integration authority for Plans 01–03. They remove the ambiguities identified by the reader and QA reports.

### Versioned state and event contract

Use separate versioned session namespaces: `prime-agent.mode`, `prime-agent.plan`, `prime-agent.delegation`, and `prime-agent.todo`. Mode state is one of `plan`, `build`, or `orchestrate`; plan status is `none`, `drafting`, `ready`, `approved`, `executing`, `cancelled`, `superseded`, or `failed`. A BUILD or ORCHESTRATE approval stores the exact plan revision and fails closed if the revision changes. Todo state is session-tree state and is never reconstructed from a Markdown artifact.

The ordered lifecycle is: `user-request-start` → invalidate approval for that request → refresh registered capabilities → mode transition → tool call or blocked call → delegation start/end → plan submission/edit/approval or todo mutation → UI status event → append session entry. Fork, reload, compaction, and daemon reconnect restore each namespace independently and idempotently. Entries have a schema version; malformed or unknown versions are ignored with a visible diagnostic and a safe default, not guessed into active execution.

A new agent/user request, including a queued follow-up that begins execution, invalidates approval. Tool results, `/todos` inspection, rendering, compaction, and session reload do not. `/mode build` and `/mode orchestrate` are approval actions only when a submitted plan revision is present; stale or missing approval is rejected.

### Capability and delegation policy

The registry classifies tools by capability (`read`, `write`, `execute`, `network`, `external-state`). Filesystem writes, mutating shell/process commands, unrestricted IPython, MCP/RPC tools with unknown effects, RLM/subagent mutation, todo `add`/`toggle`/`clear`, and unknown custom tools are denied in PLAN. Read-only inspection, `/todos` listing, `ask_user`, and `submit_plan` are allowed; read-only network or shell access is allowed only when the implementation can prove the capability, otherwise it is denied. `submit_plan` is the controlled artifact-writing exception. Active-tool filtering is presentation only; every direct, parallel, streaming, newly registered, and child call passes the execution-time gate before side effects and receives a stable structured `blocked_by_mode` result.

ORCHESTRATE requires a delegation matching the repository, approved plan revision, and task scope. A relevant child in `running` or `completed` state unlocks integration mutations; pending, failed, cancelled, timed-out, unavailable, or irrelevant tasks do not. Research-only children unlock review but not implementation mutation unless the task explicitly covers implementation. The implementation must identify the actual RLM/subagent lifecycle API before wiring this gate. Duplicate delegations are tracked by task ID; a failed child can be retried, but never silently satisfies the gate.

### Registration and artifact ownership

Built-in factories load before snapshots or policy restoration. Todo is registered exactly once; loading the legacy example is an idempotent no-op or emits a clear duplicate diagnostic, never a second callable tool/command. Built-in todo remains available under `--no-extensions`; that flag disables external/user extensions. The same rule applies in interactive, RPC, daemon, resumed, non-interactive, and child sessions, with deterministic conflict handling for intentional user overrides.

Numeric plan allocation scans only the reserved submitted-plan filename pattern, ignores reader/QA reports and existing source/design plans as appropriate, and uses atomic exclusive creation with retry. It rejects traversal, absolute paths, control characters, and symlink/realpath escapes. An absent/unwritable `.prime` directory returns a structured submission failure without changing approval. If the file succeeds but metadata persistence fails, the artifact is marked recoverable and approval remains unset; if metadata succeeds but the file fails, metadata is rolled back or marked failed and never treated as an approved artifact. A session may adopt only its own recorded artifact identity, not a path found by name.

### Headless interaction and visual scope

Interactive modal precedence is: active ask-user/approval or permission modal, then slash-command/menu interaction, then editor/autocomplete; startup header is non-interactive and extension custom headers take precedence over the built-in header. Headless/RPC paths never open a modal or hang: `ask_user` returns `{status: "unavailable"|"cancelled"}`, mode and todo commands return structured status/results, and blocked calls return structured policy errors.

The Codex-style header is gated to `claude-midnight`; existing `dark`, `light`, `prime`, custom themes, quiet startup, verbose instructions, and extension custom-header overrides retain their behavior. Its rows are: `Prime Agent v<version>`, `Model: <model-or-unknown>`, and `Directory: <cwd-or-unknown>`, with theme-colored separators and width-safe truncation. Mode/plan status is a text-labelled status widget below the header and above the prompt; it is not encoded in the header.

The shared visual state matrix is: running/pending uses a textual lifecycle label plus accent/border; success uses a completion label/icon plus success; failure uses error text plus error; blocked uses `BLOCKED` and its policy reason plus warning/error; delegation shows task ID and lifecycle; todo shows stable ID and checkbox/check marker; plan shows `PLAN READY` and action labels; diffs retain `+/-`; permissions retain explicit action labels. These mappings use existing semantic theme roles and degrade to text/icons in custom, legacy, 256-color, and no-color themes. Validate ANSI fixtures at widths 40, 80, and 120, including wide Unicode and long paths.

## Remaining implementation contracts

The following details remain implementation-level contracts, not product decisions: the repository's exact RLM/subagent lifecycle symbol; the concrete todo input/output schema, IDs, ordering, limits, concurrency and branch mechanics; approval widget key handling; and package-specific fallback APIs. Each owner must document these against the real code before editing and add the focused tests listed below.


## Compatibility and integration matrix

At minimum, test the combined behavior in: fresh interactive, resumed, forked/tree-navigation, compacted, daemon attach/reconnect, RPC/headless, non-interactive, extension reload, `--no-extensions`, explicit old todo example, and child-agent sessions. For each surface verify:

- todo registration exactly once and `/todos` response shape;
- mode state and approval restoration without stale tools/listeners;
- PLAN direct-call denial for every write/execute/unknown category;
- ORCHESTRATE denial until relevant delegation and correct behavior for pending, running, completed, failed, cancelled, irrelevant, or unavailable children;
- plan artifact uniqueness/path safety and recovery;
- non-hanging `ask_user` cancellation/unavailability;
- theme/header discovery, hot reload, custom themes, truecolor/256/no-color, contrast, ANSI output, widths 40/80/120, long and wide-Unicode values;
- non-color labels, focus order, keyboard behavior, and narrow overflow handling.

Use focused tests from the affected package roots as required by repository instructions, then run `npm run check` from the repository root. Do not run broad test/build/dev commands prohibited by repository policy.

## Risks and mitigations

- **Tool-policy bypass:** classify capabilities and enforce at execution time before side effects; deny unknowns.
- **Duplicate todo registration:** one factory, deterministic conflict detection, registration matrix tests.
- **State divergence:** versioned namespaced entries, ordered events, idempotent restore, corruption/failure recovery tests.
- **Artifact collision/path escape:** atomic exclusive creation, realpath/symlink checks, retry on collision, controlled directory only.
- **Visual ambiguity:** shared semantic tokens, text/icon indicators, ANSI snapshots and contrast/adaptive tests.
- **Header regression:** explicit scope decision, golden rendering fixtures, custom-header and old-theme regression tests.
- **Protocol/startup regression:** keep theme/header UI-only and avoid new daemon startup requirements or wire shapes.

## Plan 04 integration: custom models and task profiles

[04 — Custom Models, Providers, and Task Model Profiles](./04-custom-model-system.md) adds model configuration without changing the existing default model behavior. It owns provider endpoint metadata, credential references, discovery/import, multi-select catalog management, and Plan/Build/Delegate profile resolution. The model registry/auth/settings layer owns configuration; Plan 01 owns mode policy and approval; the TUI theme in Plan 02 owns presentation; Plan 03’s todo remains independent session state.

The integration contract is: built-in and custom models resolve through the existing provider/model adapters; role resolution happens only at a task boundary; a resolved model is pinned to the task and recorded with its config revision; credentials never enter session state, `.prime`, child context, or daemon payloads. When profiles are unset, every role inherits the current model exactly as before. Explicitly unavailable profiles fail closed with a repair action rather than silently switching providers. Plan approval is bound to both plan revision and resolved model/config revision.

The shared visual matrix applies to provider/model states: configured, credential-required, discovery-failed, stale, selected, unavailable, and imported. Each has text/status markers in addition to semantic theme colors. `/model` endpoint forms, model multi-select, and task-role assignment reuse existing menu, focus, keybinding, and theme APIs; headless/RPC responses are structured and never open modals.

The compatibility matrix expands to custom endpoint validation, auth redaction, discovery/import cancellation and limits, role resolution in PLAN/BUILD/ORCHESTRATE, child model isolation, resume/fork/daemon/RPC behavior, and old-client/new-daemon capability negotiation. Plan 04 must be implemented after the existing registry/auth/settings APIs are audited, and before final Plan 01 model-bound approval integration.

## Cross-plan QA closure and implementation gate

The cross-check reports (`crosscheck-architecture.md`, `crosscheck-model-modes.md`, `crosscheck-visual-runtime.md`, and `crosscheck-qa.md`) found no ownership conflict, but identified closure work required before implementation is marked ready. The following contracts are authoritative additions to the earlier sections:

- **One runtime authorization boundary:** tool capability metadata is immutable after registration unless an authorized registry revision changes; every direct, nested, parallel, streaming, retry, newly registered, MCP, IPython, RLM, and child invocation passes the same pre-side-effect gate. Missing or malformed metadata fails closed with stable `blocked_by_mode`. Permission prompts occur only after mode authorization, never as a bypass.
- **Atomic request/model approval:** a monotonic request epoch plus plan revision and model-config revision is compared-and-swapped at approval, delegation, tool execution, and immediately before provider execution. Stale calls fail closed. A resolved model identity contains only provider/model/endpoint fingerprint/API/capabilities/source/role/config revision; no secrets. No task silently re-resolves or falls back after pinning.
- **Authenticated delegation:** delegated records include session/request IDs, canonical repository identity, task scope, plan revision, child identity, provenance, attempt/event IDs, and terminal status. Only an authenticated relevant task unlocks the documented mutation class; completion never authorizes unrelated writes. Replays, forged records, stale revisions, timeout, cancellation, and compromised/child-side mutation are denied and tested.
- **Model trust boundary:** endpoint allowlist/HTTPS-loopback policy, redirect host/scheme validation, header/query redaction, credential-reference ACL/scope, adapter registration, response bounds, and SDK-exception redaction are centralized and tested. Secrets remain in AuthStorage only and never cross session, child, RPC, daemon, `.prime`, logs, or UI boundaries.
- **Versioned headless protocol:** define exact versioned JSON schemas/status codes for `/mode`, `/todos`, plan submit/approval, `ask_user`, blocked calls, `/model add/discover/import/tasks`, cancellation, and unavailable UI. New daemon metadata/commands are capability-gated with compatibility maps and old-client/new-daemon plus new-client/old-daemon tests; startup/attach never waits for discovery or UI.
- **Artifact transaction:** submitted artifacts use a reserved generated namespace distinct from checked-in source plans and reports. Allocation uses ownership token, realpath/symlink checks, atomic exclusive create, fsync/rename/retry, and recovery for either file/metadata write succeeding first. Cross-session adoption, crash, stale/deleted, collision, traversal, and unwritable cases are denied or explicitly recoverable.

P1 release gates are schema migrations/limits and session-tree event idempotency; deterministic built-in/example registration; the concrete todo contract; semantic theme/header snapshots and terminal escaping; model catalog collision/cache/partial-import behavior; and protocol startup compatibility. The required end-to-end test is: built-in todo registration → PLAN blocked mutation → research/ask-user → artifact submission/approval → BUILD or authenticated ORCHESTRATE gate → distinct Plan/Build/Delegate model resolution → resume/fork/daemon reconnect → midnight and existing/custom theme rendering.

## Plans 05–06: shell follow-up AI and /stats

[05 — Shell Follow-up AI](./05-shell-followup-ai.md) makes the assistant proactively comment after the user runs a `!`/`!!` shell command: an LLM reads the command, its output, and the current conversation context, and replies briefly in a non-blocking follow-up pane. It is off by default, toggleable in `/settings`, and uses a configurable model (default: the current session model). The follow-up reuses the side-question event stream and slot guard; the model override is an optional, capability-gated `start_side_question` field so old daemons degrade gracefully. Follow-up output never enters the main session context.

[06 — /stats Command](./06-stats-command.md) adds a GitHub-style local dashboard: a per-day activity heatmap (last 52 weeks, light to dark), the learning path (harness memories/refinements), token in/out usage, and total cost in $, aggregated across the user's session directory. It uses the session manager's entry format and harness state, renders with active-theme semantic tokens plus a text legend, and supports structured `--json` output headlessly. All data stays local.

Ownership: Plan 05 touches settings-manager, settings-selector, agent-connection/daemon side-question protocol (capability-gated), core side-question, and interactive-mode bash_end handling. Plan 06 touches slash-commands, interactive-mode rendering, session scanning, and harness-state reading. Both reuse existing theme/session infrastructure and must not regress `/context`, `/btw`, or the capability-gated daemon contract.

## Definition of done

- Each source plan’s acceptance criteria is met and its docs/changelog are updated.
- All reader/QA TODOs are either resolved in implementation or explicitly recorded as deferred work with an owner and test.
- Cross-plan integration tests pass for the matrix above.
- `claude-midnight` is selectable and all new surfaces render through theme APIs.
- Built-in todo is available exactly once, persists correctly, and obeys mode policy.
- Mode transitions, approvals, artifact writes, and delegation gates are revision-safe and recoverable.
- Focused tests pass, followed by `npm run check`; no forbidden commands are used.

## Final QA TODOs

The overview resolves the major policy, persistence, artifact, header-scope, and visual-state P0 decisions. The following P0 implementation contracts remain open and must be closed before implementation is considered ready:

- **Owner: Plan 01/runtime owner — delegation lifecycle.** Identify the repository’s actual RLM/subagent lifecycle symbols and event payloads, then implement relevance (repository, task scope, plan revision, child identity), status/timeout handling, and duplicate-task behavior. **Acceptance:** tests show pending, running, completed, failed, cancelled, timed-out, unavailable, and irrelevant children produce the documented ORCHESTRATE allow/deny result without a mutation bypass.
- **Owner: Plan 01 + RPC/CLI owners — headless contract.** Specify exact structured response schemas for `/mode`, `/todos`, `submit_plan`, approval actions, and `ask_user` cancellation/unavailability, including interruption and queued-request behavior. **Acceptance:** interactive, RPC, and non-interactive tests assert stable statuses/errors and prove no path opens a modal or hangs.
- **Owner: Plan 01/03 — concrete todo contract.** Document the production tool’s action/input/output schema, stable ID and ordering rules, concurrent mutation behavior, and malformed/stale-state recovery against the already-decided mode policy. **Acceptance:** focused tests cover list versus add/toggle/clear in PLAN, pre-delegation ORCHESTRATE, BUILD, resume, fork, and child sessions.

These are implementation-level closure items; source plans remain unchanged.
