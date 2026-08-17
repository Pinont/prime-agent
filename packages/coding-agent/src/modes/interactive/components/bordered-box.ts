import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.js";

/**
 * BorderedBox — wraps a child component in its own border box (border in
 * border): a top line, side borders, and a bottom line, all in the active
 * theme's border color. Used by claude-midnight to draw the header and prompt
 * as nested boxes inside the outer rounded frame.
 */
export class BorderedBox implements Component {
	private readonly color: (line: string) => string;

	constructor(
		private readonly child: Component,
		color?: (line: string) => string,
	) {
		this.color = color ?? ((line: string) => theme.fg("border", line));
	}

	invalidate(): void {
		this.child.invalidate();
	}

	render(width: number): string[] {
		const color = this.color;
		const innerWidth = Math.max(1, width - 2);
		const childLines = this.child.render(innerWidth);
		const lines: string[] = [];
		lines.push(color("┏" + "━".repeat(innerWidth) + "┓"));
		for (const line of childLines) {
			const inner = truncateToWidth(line, innerWidth, "");
			const pad = " ".repeat(Math.max(0, innerWidth - visibleWidth(inner)));
			lines.push(color("┃") + inner + pad + color("┃"));
		}
		lines.push(color("┗" + "━".repeat(innerWidth) + "┛"));
		return lines;
	}
}
