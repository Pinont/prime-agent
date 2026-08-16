# Plan: Custom Models, Providers, and Task Model Profiles

## Goal

Add a secure model-management system reachable through `/model` that lets users configure their own API endpoint and credential, discover/import a selectable subset of models, and assign independent models to PLAN, BUILD, and delegated-agent work. Preserve the existing built-in model selector, provider adapters, authentication, session behavior, and mode/tool policy when profiles are unset.

## User-visible behavior

Keep `/model` as the canonical entry point:

- `/model` — select the current model using the existing selector.
- `/model add` — add or edit a named custom endpoint and credential reference.
- `/model discover <provider>` — fetch a bounded model catalog with cancellation.
- `/model import <provider>` — multi-select discovered/manual models and apply the import.
- `/model tasks` — assign Plan, Build, and Delegate profiles.
- `/model tasks reset` — clear role assignments so every role inherits the current model.

Interactive flows must have explicit Apply/Cancel. The catalog picker supports search/filter, toggle, select visible, select all with confirmation for large catalogs, clear, ordered selected models, and a visible count. `/model` selection, enabled-for-cycling, and task-role assignment are separate concepts; do not overload `enabledModels` with role state. Headless/RPC forms return structured results and never open a modal or hang.

A fresh installation behaves exactly as today when no profiles are configured: the current selected model is used for PLAN, BUILD, and delegated agents. A configured role is resolved at the start of that task, not by globally changing the current model. PLAN uses the Plan profile, BUILD and the root ORCHESTRATE reviewer use Build, and delegated children use Delegate, with inheritance to the current model when unset.

## Provider and model contract

Reuse the existing `ModelRegistry`, `Model` types, provider registration, API adapters, `AuthStorage`, settings manager, model resolver, and `/model` components. Do not create a second streaming/provider abstraction or edit generated model files directly.

Add a versioned provider definition and canonical model key containing:

- stable provider ID/display name;
- normalized base URL and API family (`openai-completions`, `openai-responses`, `anthropic-messages`, or another registered adapter);
- opaque credential reference and redacted custom headers;
- model ID/display name, provenance, context/output limits, input modalities, tools/parallel-tools/reasoning/streaming capability, and deprecation status;
- catalog source, endpoint identity, fetched timestamp, schema/config revision.

A resolved task model is immutable and records provider, model ID, role, source, and config revision. Model identity and config revision are recorded with plan approval and task/delegation records; a changed role/provider configuration invalidates approval for the affected execution. Never silently switch model/provider during an in-flight request or approved execution.

Validate API compatibility before use. A model that cannot support required tools, streaming, images, reasoning, or context limits fails with a structured actionable error; do not silently downgrade capabilities.

## Endpoint and credential security

Normalize endpoint URLs centrally: require a scheme, trim only safe trailing slashes, preserve explicit reverse-proxy/version paths, and append provider catalog/request paths exactly once. Reject URL credentials, secret query parameters, unsafe schemes, control characters, and disallowed redirects. Require HTTPS by default; permit loopback development HTTP only through explicit configuration. Apply the existing SSRF/host policy where applicable.

Store endpoint metadata and model records in the existing user settings/model catalog mechanism, preferably `~/.prime/agent/models.json`; store API keys only through existing `AuthStorage`/keychain/file-backed credential storage with current locking, atomic replacement, and restrictive permissions. Settings and session entries contain only opaque credential references. Never put secrets in `.prime`, project config, plan artifacts, logs, diagnostics, telemetry, RPC/daemon events, headers, model output, or child-agent context. Resolve credentials only immediately before the provider request and redact all error strings.

Support add, test, rotate, and remove credentials. A failed rotation preserves the prior working credential. Missing/removed credentials disable dependent models without deleting selections and offer repair. Environment-variable resolution remains compatible with existing precedence. Project settings may reference a user credential by opaque ID, but must not contain its value.

## Discovery and multi-select import

Discovery is explicit and cancellable; it never blocks startup or is triggered on every render. Use the configured adapter’s documented catalog endpoint, timeout, response-size/model-count/page limits, and redirect policy. Support providers that do not expose discovery by offering manual model entry/import. Cache normalized results with endpoint identity, protocol, schema/config revision, timestamp, and optional ETag; a stale known-compatible cache may remain selectable with a visible stale status. Discovery failures disable only refresh, not manually configured models.

The import picker validates each selected record against the existing model schema, normalizes IDs, shows capability/unknown-limit warnings, and persists only selected models. Partial success is reported per model. Duplicate provider/model IDs use deterministic conflict handling and require confirmation for overwriting built-in metadata; no silent replacement. Imported records are executable only when their API adapter can honor their declared capabilities.

## Task profiles and mode integration

Add optional settings such as:

```ts
type ModelRole = "plan" | "build" | "delegate";
interface ModelRoleAssignment {
  modelKey: string;
  source: "builtin" | "custom" | "imported";
}
interface ModelRoleSettings {
  plan?: ModelRoleAssignment;
  build?: ModelRoleAssignment;
  delegate?: ModelRoleAssignment;
}
```

Resolution order is explicit role assignment, then current session model. A configured but unavailable role fails before a request with `profile_unavailable` and a repair/select action; it does not silently fall back. A user may explicitly replace a role before a new request. Child launch receives only a canonical model reference and profile/config revision; credentials remain local to the executing registry. Role selection never bypasses PLAN capability restrictions or the ORCHESTRATE delegation gate.

Plan 01 must bind approval to both plan revision and resolved model/config revision. Mode transitions revalidate role capability and availability. A new request invalidates prior approval as already specified. Child records include effective model identity and must be authenticated to the current session/task; a child completion cannot authorize unrelated mutation.

## Persistence and compatibility

- User/project settings: provider definitions, selected imported models, role assignments, catalog metadata, and UI preferences.
- Auth storage: secrets only.
- Session tree: resolved model identity/profile/config revision for each request, approval, and delegated task.
- Daemon runtime: secrets and resolution stay server-side; clients receive redacted catalog/status snapshots only.

Use schema versions, migrations, atomic writes, file locks, bounded sizes, and per-record recovery. Unknown/future versions fail safe with a diagnostic; malformed records are skipped individually. Removing a provider leaves historical sessions readable as unavailable. Existing model selection, CLI flags, recent models, `/login`, enabled-model cycling, and handoff remain unchanged when no custom configuration is used.

Optional daemon catalog/role metadata and management operations require negotiated capabilities. Old clients/daemons retain existing model behavior; startup and attach must not require discovery or role metadata. Never transmit API keys or arbitrary endpoint headers over the wire.

## Implementation steps

1. Audit existing model registry, resolver, auth storage, settings, selector, agent task creation, RLM child launch, RPC, and daemon catalog APIs.
2. Define validated provider/model/profile schemas, canonical model keys, config revisions, migrations, and redaction helpers.
3. Implement secure credential CRUD and endpoint metadata persistence using existing storage primitives.
4. Implement adapter-specific discovery, bounded caching, manual import, validation, deterministic conflicts, and registry refresh.
5. Add role resolution and model/config pinning at plan/build/delegation task boundaries; bind approvals and child records.
6. Extend `/model` interactive UI with endpoint editor, test connection, discovery, multi-select import, and Plan/Build/Delegate assignment; preserve configurable keybindings and narrow/no-color accessibility.
7. Add structured CLI/RPC forms and errors; keep headless flows non-blocking.
8. Add capability-gated daemon catalog/role synchronization only if existing protocol APIs support it.
9. Add integration tests with Plans 01–03, update docs and affected package changelogs.

## Testing and acceptance

Test existing selection/auth behavior unchanged, endpoint URL/API compatibility, credential permissions/rotation/redaction, discovery timeout/cancel/limits/cache, import validation/partial success/duplicates, and model capability errors. Test role inheritance, explicit Plan/Build/Delegate resolution, unavailable-role failure, in-flight immutability, approval/config revision invalidation, resume/fork/compaction, child model isolation, and ORCHESTRATE gating.

Test multi-select search, filtering, ordering, select-all/toggle/clear, Apply/Cancel, keyboard focus, long Unicode/narrow widths, truecolor/256/no-color, custom/legacy themes, and structured headless responses. Test fresh/resumed/forked/RPC/noninteractive/daemon/reconnect/child sessions, old/new daemon capability negotiation, and no secret leakage in files or wire payloads.

End-to-end acceptance: configure an endpoint and credential through `/model`, discover/import multiple models, assign distinct Plan/Build/Delegate models, enter PLAN, submit and approve a plan, execute BUILD or gated ORCHESTRATE, and verify model identity plus mode/todo/tool statuses in `claude-midnight` and an existing/custom theme. Run focused tests from affected package roots, then `npm run check`; do not run prohibited broad test/build/dev commands.

## Decisions and deferred work

Before implementation, confirm the exact existing AuthStorage/model catalog schemas, supported runtime API adapters, project-vs-user provider precedence, endpoint SSRF policy, discovery limits, and daemon capability map. Fallback is opt-in and deterministic; no silent provider switch is included in this feature.
