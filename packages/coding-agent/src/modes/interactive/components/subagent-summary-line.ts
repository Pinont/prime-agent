import { type Component, type Focusable, getKeybindings, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { AgentConnectionRlmChildAgentSnapshot } from "../../agent-connection/index.js";
import { theme } from "../theme/theme.js";
import { keyText } from "./keybinding-hints.js";

export interface SubagentSummaryCounts {
	total: number;
	running: number;
	idle: number;
	inactive: number;
}

export function countDirectSubagentStatuses(
	children: Iterable<AgentConnectionRlmChildAgentSnapshot>,
	parentId: string | undefined,
	activeHeartbeatSessionIds: ReadonlySet<string>,
): SubagentSummaryCounts {
	let total = 0;
	let running = 0;
	let idle = 0;
	for (const child of children) {
		if (child.parentId !== parentId || child.status === "cancelled") continue;
		total += 1;
		const isRunning =
			child.status === "running" ||
			child.status === "queued" ||
			child.activity !== undefined ||
			(child.activeSessionId !== undefined && activeHeartbeatSessionIds.has(child.activeSessionId));
		if (isRunning) {
			running += 1;
		} else if ((child.status === "done" || child.status === "error") && child.activeSessionId !== undefined) {
			idle += 1;
		}
	}
	return { total, running, idle, inactive: total - running - idle };
}

/** One-line entry into the current session's scoped agents view. */
export class SubagentSummaryLine implements Component, Focusable {
	focused = false;
	private counts: SubagentSummaryCounts = { total: 0, running: 0, idle: 0, inactive: 0 };
	private openable = false;

	onOpen?: () => void;
	onCancel?: () => void;
	onChatAction?: (data: string) => void;

	constructor(
		private readonly getLocationLabel: () => string | undefined = () => undefined,
		private readonly getContextLabel: () => string | undefined = () => undefined,
		private readonly getOverrideLabel: () => string | undefined = () => undefined,
	) {}

	setSubagentCounts(counts: SubagentSummaryCounts): void {
		this.counts = counts;
	}

	setOpenable(openable: boolean): void {
		this.openable = openable;
	}

	isSelectable(): boolean {
		return this.counts.total > 0 && this.openable;
	}

	handleInput(data: string): void {
		const keybindings = getKeybindings();
		if (keybindings.matches(data, "tui.select.confirm") || keybindings.matches(data, "app.agents.open")) {
			if (this.isSelectable()) this.onOpen?.();
			return;
		}
		if (
			keybindings.matches(data, "tui.select.up") ||
			keybindings.matches(data, "tui.select.cancel") ||
			keybindings.matches(data, "app.agents.back")
		) {
			this.onCancel?.();
			return;
		}
		this.onChatAction?.(data);
	}

	render(width: number): string[] {
		// The subagent summary is part of the tray line itself (replacing the
		// model slot): "agents/resume  N subagents: N running · N idle · N
		// inactive  ? for shortcuts  [mode]".
		return this.renderInfoLine(width);
	}

	private subagentSummaryText(): string {
		const summary = `${this.counts.total} subagent${this.counts.total === 1 ? "" : "s"}: ${this.counts.running} running · ${this.counts.idle} idle · ${this.counts.inactive} inactive`;
		const openHint = this.openable
			? `  ${keyText("tui.select.confirm")} or ${keyText("app.agents.open")} to open`
			: "";
		return `${this.focused ? "▸" : " "} ${summary}${openHint}`;
	}

	private renderInfoLine(width: number): string[] {
		const overrideLabel = this.getOverrideLabel()?.trim();
		const locationLabel = this.getLocationLabel()?.trim();
		const contextLabel = this.getContextLabel()?.trim();
		const baseLeft = overrideLabel || locationLabel || "";
		const subagentPart = this.subagentSummaryText();
		const left = [baseLeft, subagentPart].filter((part) => part.trim().length > 0).join("  ");
		if (!left && !contextLabel) return [];
		// Reserve two columns for the outer frame's side borders so the whole
		// line (including the right-aligned mode box) fits inside the frame.
		const safeWidth = Math.max(1, width - 2);
		const right = contextLabel ?? "";
		const gap = left && right ? 2 : 0;
		const rightWidth = Math.min(visibleWidth(right), Math.max(0, safeWidth - gap));
		const leftWidth = Math.max(0, safeWidth - rightWidth - gap);
		const renderedLeft = truncateToWidth(left, leftWidth, "…");
		const renderedRight = truncateToWidth(right, rightWidth, "…");
		const padding = Math.max(0, safeWidth - visibleWidth(renderedLeft) - visibleWidth(renderedRight));
		return [theme.fg("muted", `${renderedLeft}${" ".repeat(padding)}${renderedRight}`)];
	}

	invalidate(): void {
		// Render output is derived from counts and focus state.
	}
}
