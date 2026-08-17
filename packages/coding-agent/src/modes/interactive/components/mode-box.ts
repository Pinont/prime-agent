import { type Component, truncateToWidth } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.js";

export type AgentMode = "plan" | "build" | "orchestrate" | "goal";

/** Per-mode chat border color: map modes to the claude-midnight semantic palette. */
export const MODE_BORDER_COLOR: Record<AgentMode, (line: string) => string> = {
	plan: (line) => theme.fg("accent", line),
	build: (line) => theme.fg("success", line),
	orchestrate: (line) => theme.fg("warning", line),
	goal: (line) => theme.fg("customMessageLabel", line),
};

/** Label shown inside the { mode } box. */
export const MODE_LABEL: Record<AgentMode, string> = {
	plan: "plan",
	build: "build",
	orchestrate: "orchestrate",
	goal: "goal",
};

// orchestrate is intentionally excluded from cycling while the extension
// cannot enforce the delegation gate; /mode orchestrate remains available as a
// command that reports unavailability.
const MODE_ORDER: AgentMode[] = ["plan", "build", "goal"];

export function nextMode(mode: AgentMode): AgentMode {
	const index = MODE_ORDER.indexOf(mode);
	return MODE_ORDER[(index + 1) % MODE_ORDER.length]!;
}

export function previousMode(mode: AgentMode): AgentMode {
	const index = MODE_ORDER.indexOf(mode);
	return MODE_ORDER[(index - 1 + MODE_ORDER.length) % MODE_ORDER.length]!;
}

/**
 * ModeBox — renders the current mode as a centered { mode } rectangle using
 * the per-mode border color. Placed under the chat box, above the prompt.
 */
export class ModeBox implements Component {
	private mode: AgentMode;
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(mode: AgentMode) {
		this.mode = mode;
	}

	setMode(mode: AgentMode): void {
		if (this.mode === mode) return;
		this.mode = mode;
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	render(width: number): string[] {
		if (this.cachedWidth === width && this.cachedLines) {
			return this.cachedLines;
		}
		const color = MODE_BORDER_COLOR[this.mode];
		const label = MODE_LABEL[this.mode];
		const inner = ` ${label} `;
		const boxWidth = inner.length + 2;
		const left = Math.max(0, Math.floor((width - boxWidth) / 2));
		const line = " ".repeat(left) + color("{" + inner + "}");
		const padded = line + " ".repeat(Math.max(0, width - truncateToWidth(line, width).length));
		this.cachedWidth = width;
		this.cachedLines = [padded];
		return this.cachedLines;
	}
}
