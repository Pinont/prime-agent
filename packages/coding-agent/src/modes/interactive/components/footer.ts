import { type Component, truncateToWidth } from "@earendil-works/pi-tui";
import type { ReadonlyFooterDataProvider } from "../../../core/footer-data-provider.js";
import { theme } from "../theme/theme.js";

/** Format token counts compactly (12.3k, 1.2M). */
function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

export interface FooterData {
	/** Active model name, or undefined before a model is resolved. */
	model?: string;
	/** Current working directory. */
	cwd?: string;
	/** Context usage: tokens used and percent of window. */
	context?: { tokens: number | null; percent: number | null; contextWindow: number };
	/** Session totals: input/output tokens and cost. */
	session?: { input: number; output: number; cacheRead: number; cost: number };
}

/**
 * Footer for the prime brand TUI.
 *
 * Renders a single status line (model · cwd (branch) · tokens · context% · cost)
 * when a data getter is provided, in the active theme's muted/border colors.
 * With no data getter it renders nothing, preserving older call sites.
 */
export class FooterComponent implements Component {
	private autoCompactEnabled = true;
	private dataGetter: (() => FooterData) | undefined;

	constructor(
		private footerData: ReadonlyFooterDataProvider,
		dataGetter?: () => FooterData,
	) {
		this.dataGetter = dataGetter;
	}

	setAutoCompactEnabled(enabled: boolean): void {
		this.autoCompactEnabled = enabled;
	}

	invalidate(): void {
		// No-op: git branch is cached/invalidated by provider
	}

	dispose(): void {
		// Git watcher cleanup handled by provider
	}

	render(width: number): string[] {
		if (!this.dataGetter || theme.name !== "claude-midnight") {
			return [];
		}
		const data = this.dataGetter();
		const parts: string[] = [];
		if (data.model) {
			parts.push(theme.fg("accent", data.model));
		}
		if (data.cwd) {
			let cwdText = data.cwd;
			const branch = this.footerData.getGitBranch();
			if (branch) {
				cwdText = `${cwdText} (${branch})`;
			}
			parts.push(theme.fg("muted", cwdText));
		}
		if (data.session) {
			const s = data.session;
			if (s.input) parts.push(theme.fg("dim", `↑${formatTokens(s.input)}`));
			if (s.output) parts.push(theme.fg("dim", `↓${formatTokens(s.output)}`));
			if (s.cacheRead) parts.push(theme.fg("dim", `R${formatTokens(s.cacheRead)}`));
			if (s.cost) parts.push(theme.fg("dim", `$${s.cost.toFixed(3)}`));
		}
		if (data.context && data.context.contextWindow > 0) {
			const c = data.context;
			const percent = c.percent === null ? "?" : `${c.percent.toFixed(1)}%`;
			const auto = this.autoCompactEnabled ? " (auto)" : "";
			const display = `${percent}/${formatTokens(c.contextWindow)}${auto}`;
			const colored =
				c.percent !== null && c.percent > 90
					? theme.fg("error", display)
					: c.percent !== null && c.percent > 70
						? theme.fg("warning", display)
						: theme.fg("dim", display);
			parts.push(colored);
		}
		if (parts.length === 0) {
			return [];
		}
		const line = ` ${parts.join("  ")} `;
		const padded = truncateToWidth(line, Math.max(1, width));
		return [theme.fg("borderMuted", "─".repeat(width)), padded];
	}
}
