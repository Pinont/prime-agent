import type { Component } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { PaddedPanel } from "../src/modes/interactive/components/padded-panel.js";

const stub: Component = { render: () => ["hi"], invalidate: () => {} };

describe("PaddedPanel", () => {
	it("insets the child on all sides", () => {
		const panel = new PaddedPanel(stub, 2, 1);
		const lines = panel.render(10);
		expect(lines).toEqual(["          ", "  hi      ", "          "]);
	});
});
