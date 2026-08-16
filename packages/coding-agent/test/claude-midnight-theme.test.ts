import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	getAvailableThemes,
	getResolvedThemeColors,
	getThemeByName,
	preloadThemeValidator,
} from "../src/modes/interactive/theme/theme.js";

describe("claude-midnight theme", () => {
	it("is a complete built-in theme with the intended resolved palette", async () => {
		await preloadThemeValidator();
		const raw = JSON.parse(
			readFileSync(new URL("../src/modes/interactive/theme/claude-midnight.json", import.meta.url), "utf-8"),
		) as { colors: Record<string, string> };
		const schema = JSON.parse(
			readFileSync(new URL("../src/modes/interactive/theme/theme-schema.json", import.meta.url), "utf-8"),
		) as { properties: { colors: { required: string[] } } };

		expect(getAvailableThemes()).toContain("claude-midnight");
		expect(getThemeByName("claude-midnight")?.name).toBe("claude-midnight");
		expect(Object.keys(raw.colors).sort()).toEqual(schema.properties.colors.required.sort());
		expect(getResolvedThemeColors("claude-midnight")).toMatchObject({
			accent: "#78a9d8",
			text: "#d7e2f0",
			thinkingText: "#d98262",
			selectedBg: "#1a2b45",
			toolDiffAdded: "#7fbf9b",
			toolDiffRemoved: "#d87878",
		});
	});
});
