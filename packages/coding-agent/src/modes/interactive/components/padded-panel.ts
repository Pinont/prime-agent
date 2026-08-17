import { type Component, visibleWidth } from "@earendil-works/pi-tui";

/**
 * PaddedPanel — insets a single child component with a uniform margin of
 * blank rows on the top/bottom and blank columns on the left/right. This
 * keeps the whole TUI panel from running flush against the terminal edges.
 */
export class PaddedPanel implements Component {
	constructor(
		private readonly child: Component,
		private readonly padX: number,
		private readonly padY: number,
	) {}

	invalidate(): void {
		this.child.invalidate();
	}

	render(width: number): string[] {
		const innerWidth = Math.max(1, width - this.padX * 2);
		const paddingRow = " ".repeat(Math.max(0, width));
		const lines: string[] = [];
		for (let i = 0; i < this.padY; i++) {
			lines.push(paddingRow);
		}
		for (const line of this.child.render(innerWidth)) {
			const inner = line + " ".repeat(Math.max(0, innerWidth - visibleWidth(line)));
			lines.push(" ".repeat(this.padX) + inner + " ".repeat(Math.max(0, width - this.padX - visibleWidth(inner))));
		}
		for (let i = 0; i < this.padY; i++) {
			lines.push(paddingRow);
		}
		return lines;
	}
}
