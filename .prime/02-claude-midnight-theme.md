# Plan: Claude-Inspired Midnight Theme with Codex Header

## Goal

Create a selectable Prime Agent visual design that follows the visual hierarchy and interaction language of Claude Code, using the brainless project as a reference, while using midnight blue as the dominant palette. Replace only the startup header with a Codex-style header. Preserve existing agent behavior, commands, keybindings, accessibility behavior, theme discovery, and hot reload.

## Implementation ownership

This is a core repository change in `packages/coding-agent`; it is not an extension pack or project-local resource. The implementation may continue to expose existing extension hooks, including custom-header overrides, but the new built-in theme/header behavior belongs in the core TUI.

## Scope

### Included

- Add a complete built-in `claude-midnight` theme with all required Prime Agent color tokens.
- Use midnight-blue backgrounds and surfaces, blue-gray borders and muted text, and high-contrast off-white foreground text.
- Use restrained Claude-inspired terracotta for thinking/status emphasis, amber for warnings, green for success, and red for errors.
- Adapt the interactive TUI’s visual presentation where needed to express the Claude Code hierarchy:
  - user and assistant messages;
  - thinking/status lines;
  - tool execution panels;
  - diffs;
  - permission/approval prompts;
  - slash-command and selection menus;
  - prompt/editor state.
- Replace the built-in startup splash/header with a Codex-style header showing Prime Agent identity/version, active model, and current working directory.
- Keep the core header Codex-inspired and monochrome/structured in layout, but allow it to use the active theme’s colors. Do not add the Claude-style logo/header.
- Add or update focused tests and documentation/changelog entries as appropriate.

### Excluded

- Installing brainless’s React/Tailwind components into Prime Agent.
- Replacing the terminal TUI with a web UI.
- Changing model selection, agent behavior, commands, keybindings, tool semantics, or protocol behavior.
- Removing existing themes or changing the default theme.
- Adding a new non-configurable keybinding.

## Reference design

Use these as visual references, not as code dependencies:

- https://brainless.swerdlow.dev
- https://brainless.swerdlow.dev/r/registry.json
- https://github.com/theswerd/brainless

The target should preserve the recognizable Claude Code hierarchy—minimal dark terminal presentation, clear user prompt markers, plain assistant output, compact status/thinking lines, readable tool blocks, diffs, and approval states—without copying React-specific layout or Tailwind classes.

## Current repository mechanisms

- Theme documentation: `packages/coding-agent/docs/themes.md`
- Theme schema: `packages/coding-agent/src/modes/interactive/theme/theme-schema.json`
- Theme implementation/loading: `packages/coding-agent/src/modes/interactive/theme/theme.ts`
- Built-in theme examples: `packages/coding-agent/src/modes/interactive/theme/dark.json`, `light.json`, and `prime.json`
- Startup header implementation: `packages/coding-agent/src/modes/interactive/interactive-mode.ts`, `BrandSplashHeader`; extension `setHeader` remains an override and is not the implementation target
- Interactive components: `packages/coding-agent/src/modes/interactive/components/`
- Theme tests: `packages/coding-agent/test/theme-export.test.ts`, `theme-adaptive.test.ts`, and related TUI tests
- Theme documentation/settings: `packages/coding-agent/docs/themes.md`, `docs/settings.md`

Before editing, read the full relevant files and inspect existing tests and component render paths. Confirm whether the requested component adjustments can be expressed through existing theme tokens before changing layout code.

## Proposed palette

Treat these as starting values; tune them after inspecting the rendered output and contrast behavior:

| Role | Starting value |
|---|---|
| Main background | `#0b1220` |
| Secondary surface | `#111c2e` |
| Selected surface | `#1a2b45` |
| Border | `#29415f` |
| Muted text | `#71839d` |
| Default text | `#d7e2f0` |
| Accent | `#78a9d8` |
| Claude/ thinking accent | `#d98262` |
| Warning | `#d9b36c` |
| Success | `#7fbf9b` |
| Error | `#d87878` |

Use `vars` for reusable palette values. Validate foreground/background contrast for normal text, selected rows, tool states, diffs, and light/dark terminal adaptation behavior. Do not assume a hex value remains sufficiently distinct on 256-color terminals.

## Implementation steps

1. **Audit the existing UI and references**
   - Read the full theme loader/schema and all relevant interactive component implementations.
   - Identify which Claude-like visual behaviors already exist and only need recoloring.
   - Identify layout changes that are required for the Codex header or Claude-style hierarchy.
   - Check how built-in themes are discovered and how custom theme names are selected.

2. **Add the `claude-midnight` theme**
   - Create the theme JSON using the schema and all required color tokens.
   - Define reusable midnight-blue palette variables.
   - Include explicit colors for tool diff backgrounds/text, thinking levels, bash mode, markdown, and export colors where useful.
   - Ensure the theme is discoverable as a built-in/project-available theme according to the repository’s existing convention, without changing the default theme.
   - Add a short user-facing documentation entry explaining selection and palette intent.

3. **Implement the Codex-style startup header in core**
   - Refactor or extend `BrandSplashHeader` only as needed, keeping its existing metadata sources and responsive/truncation behavior.
   - Render a Codex-like structure: identity/version line followed by model and directory rows.
   - Use the active theme for colors; do not hardcode a separate palette.
   - Remove the Prime butterfly/logo from this startup header when the new header is active.
   - Preserve quiet startup, verbose instructions, start hints, narrow terminal behavior, extensions’ custom-header override, and invalidation behavior.
   - Make this a core built-in header behavior rather than an extension-provided replacement. Gate the Codex-style header to the `claude-midnight` theme; preserve existing `dark`, `light`, `prime`, custom-theme, quiet/verbose, and extension custom-header behavior. Preserve extension custom-header overrides.

4. **Tune Claude-style TUI presentation**
   - Reuse existing components and theme tokens first.
   - Adjust only the components whose structure cannot reproduce the requested hierarchy through colors.
   - Keep user/assistant distinction, thinking collapse/expand, tool expansion, diff semantics, permission actions, slash-menu navigation, and editor behavior unchanged.
   - Ensure all added styling remains valid at narrow widths and does not rely on color alone for status or permission meaning.

5. **Tests and documentation**
   - Add tests validating the new theme’s schema completeness, loading/discovery, variable resolution, and key color mappings.
   - Add focused header rendering tests for normal and narrow widths, model/cwd truncation, and absence of the old logo in the Codex-style header.
   - Extend existing theme/export/adaptive tests if the new theme exercises those paths.
   - Update `packages/coding-agent/docs/themes.md` and the affected package changelog under `## [Unreleased]`.

## Acceptance criteria

- `claude-midnight` loads successfully and is selectable through `/settings` and normal theme configuration.
- The theme defines every required color token and passes full validation.
- The default theme and existing `dark`, `light`, and `prime` behavior remain unchanged unless explicitly documented.
- The startup header uses the Codex structure, displays Prime Agent version/model/directory, and does not render the Claude-style or Prime butterfly header.
- Header output remains usable at narrow terminal widths and with long model/path values.
- Claude-inspired styling is visible across messages, thinking, tools, diffs, prompts, and menus without changing their semantics.
- Custom themes and hot reload continue to work.
- Existing extension custom headers still override the built-in header.
- Focused tests pass, followed by `npm run check` from the repository root.

## Core-change boundary

The theme and Codex header are implemented in the repository’s core interactive TUI. Do not package them under `.prime/agent/extensions/` or rely on an extension for startup registration. Existing extension APIs remain supported and custom headers continue to take precedence.

## Risks and decisions

- The brainless reference is a React component registry, so exact DOM/layout copying is not appropriate for the terminal TUI.
- Some requested visual differences may require component changes beyond a JSON theme; each such change should be minimal and covered by a focused test.
- The Codex-style header is explicitly gated to `claude-midnight`; existing built-in and custom themes retain their current headers. Test this scope and custom-header precedence.
- Midnight-blue backgrounds may have poor contrast on terminals with unusual default colors or 256-color quantization. Use the existing adaptive helpers and test both truecolor and 256-color modes.
- Do not change the protocol, startup requirements, or daemon wire shapes for this UI-only feature.

## Validation commands

Run from the repository root after implementation:

```bash
npm run check
```

If tests are added or modified, run only the specific affected test files from their package root using the repository’s documented Vitest command. Do not run `npm test`, `npm run build`, or `npm run dev`.
