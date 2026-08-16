# Plan: Auto-Enable the Todo Tool

## Goal

Make the todo list available automatically in every Prime Agent session as a core built-in capability, without requiring:

```bash
--extension packages/coding-agent/examples/extensions/todo.ts
```

The feature will provide the model with a `todo` tool and users with the `/todos` command, while preserving session-scoped persistence across resume and branching.

## Recommended architecture

Implement todo as a built-in extension factory rather than loading the example file as an extension path. This keeps the implementation in the normal build and bundle graph, avoids duplicate registration, and prevents installed-package path issues.

Expected structure:

```text
packages/coding-agent/src/core/extensions/builtin/todo.ts
        ↓
packages/coding-agent/src/core/extensions/index.ts
        ↓
ResourceLoader built-in extension factories
        ↓
`todo` tool + `/todos` command
```

## Implementation steps

### 1. Extract the production implementation

Move or extract the implementation from:

```text
packages/coding-agent/examples/extensions/todo.ts
```

to:

```text
packages/coding-agent/src/core/extensions/builtin/todo.ts
```

Export a factory compatible with the existing built-in extension pattern, such as `createTodoExtension()`.

Keep the example useful by either turning it into a thin wrapper around the production implementation or updating it to document that todo is now built in. Avoid maintaining two independent implementations.

### 2. Register the built-in factory

Use the existing inline extension factory mechanism in `ResourceLoader`:

```text
packages/coding-agent/src/core/resource-loader.ts
```

Register the todo factory with the built-in factories and ensure it is loaded for normal CLI, interactive, RPC, daemon, resumed, and non-interactive sessions where extensions are supported.

Use deterministic ordering and run the existing extension conflict detection after built-in factories are added.

### 3. Define extension and duplicate behavior

The default behavior should be:

- The built-in `todo` tool is registered automatically.
- The built-in `/todos` command is registered automatically.
- Loading the old example explicitly does not create duplicate tools or commands.
- The built-in implementation remains the authoritative implementation unless the extension system already provides an explicit override mechanism.

Document that the example is illustrative and normally should not be loaded separately.

### 4. Define `--no-extensions` behavior

Recommended policy: `--no-extensions` disables external/user extensions but does not disable built-in todo. Todo becomes a core Prime Agent capability, while the flag continues to prevent user extension code from loading.

If the existing semantics require `--no-extensions` to disable every extension, make that an explicit decision instead and test it. Do not leave the behavior implicit.

### 5. Preserve session persistence

Retain the current session-entry/event-based state model. Verify that todo state is:

- Restored when resuming a session.
- Inherited correctly when branching.
- Isolated correctly between branches.
- Maintained through compaction.
- Available through daemon attach/detach and RPC sessions where applicable.

Do not introduce a global todo store.

## Tests

Add focused tests under `packages/coding-agent/test/` covering:

- Automatic registration of the `todo` tool.
- Automatic registration of `/todos`.
- `list`, `add`, `toggle`, and `clear` actions.
- Validation errors for missing text, missing IDs, and unknown IDs.
- Session reload/resume persistence.
- Branch inheritance and branch isolation.
- Explicit loading of the example without duplicate registration.
- The selected `--no-extensions` policy.
- Bundled/runtime startup if the existing test structure supports it.

Use the existing extension/resource-loader test patterns rather than real provider calls.

## Documentation and changelog

Update the relevant documentation:

```text
packages/coding-agent/examples/extensions/README.md
packages/coding-agent/docs/extensions.md
packages/coding-agent/README.md
packages/coding-agent/CHANGELOG.md
```

Add an entry under `## [Unreleased]`, for example:

```markdown
- Added a built-in todo tool with `/todos` support and session-persistent task tracking.
```

Explain that the model can use `todo` automatically and that `/todos` displays the current list.

## Validation

From the repository root, run:

```bash
npm run check
```

From `packages/coding-agent`, run the focused tests that were added or modified, for example:

```bash
npx tsx ../../node_modules/vitest/dist/cli.js --run test/resource-loader.test.ts
```

Manually verify:

```text
Add “review the API” to my todo list, then show the list.
/todos
```

## Acceptance criteria

- A fresh Prime Agent session exposes the `todo` tool without `--extension`.
- `/todos` works without manually loading an extension.
- Todo state persists according to session semantics.
- No duplicate tools or commands occur when the old example is explicitly loaded.
- The chosen `--no-extensions` behavior is documented and tested.
- Existing extension behavior and startup modes remain functional.
