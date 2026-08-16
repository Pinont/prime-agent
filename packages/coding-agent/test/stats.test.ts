import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { parseSlashCommand, resolveSlashCommand } from "../src/core/slash-commands.js";
import { collectStats, renderStatsHeatmap } from "../src/core/stats.js";

const NOW = new Date("2025-06-15T12:00:00.000Z");
const tempDirs: string[] = [];

afterEach(() => {
	delete process.env.PRIME_AGENT_HARNESS_STATE_PATH;
});

async function fixtureDir() {
	const dir = await mkdtemp(join(tmpdir(), "prime-agent-stats-"));
	tempDirs.push(dir);
	return dir;
}

function message(timestamp: string, role: string, usage?: Record<string, unknown>) {
	return JSON.stringify({ type: "message", timestamp, message: { role, ...(usage ? { usage } : {}) } });
}

describe("stats collection", () => {
	test("aggregates day buckets and token/cost totals while skipping corrupt sessions", async () => {
		const dir = await fixtureDir();
		await writeFile(
			join(dir, "first.jsonl"),
			[
				message("2025-06-14T10:00:00Z", "user"),
				message("2025-06-14T10:01:00Z", "assistant", {
					input: 10,
					output: 20,
					cacheRead: 3,
					cacheWrite: 4,
					cost: { total: 0.125 },
				}),
				message("2025-06-15T10:00:00Z", "assistant", {
					input: 5,
					output: 6,
					cacheRead: 7,
					cacheWrite: 8,
					cost: { total: 0.25 },
				}),
			].join("\n"),
		);
		await writeFile(join(dir, "corrupt.jsonl"), "{not json}\n");

		const result = collectStats(dir, NOW);
		const yesterday = result.days.find((day) => day.date === "2025-06-14");
		const today = result.days.find((day) => day.date === "2025-06-15");
		expect(yesterday).toMatchObject({ activity: 2, input: 10, output: 20, cacheRead: 3, cacheWrite: 4, cost: 0.125 });
		expect(today).toMatchObject({ activity: 1, input: 5, output: 6, cacheRead: 7, cacheWrite: 8, cost: 0.25 });
		expect(result.totals).toEqual({ input: 15, output: 26, cacheRead: 10, cacheWrite: 12, cost: 0.375 });
		expect(result.sessionsScanned).toBe(2);
		expect(result.skipped).toBe(1);
		expect(result.days).toHaveLength(364);
		expect(result.period).toEqual({ from: "2024-06-17", to: "2025-06-15" });
	});

	test("extracts memories and refinements newest first", async () => {
		const dir = await fixtureDir();
		const harness = join(dir, "harness.json");
		process.env.PRIME_AGENT_HARNESS_STATE_PATH = harness;
		await writeFile(
			harness,
			JSON.stringify({
				entries: {
					memories: {
						old: { id: "old", title: "Older memory", scope: "global", updated_at: "2025-01-01T00:00:00Z" },
						newest: { id: "newest", title: "Newest memory", scope: "local", updated_at: "2025-06-14T00:00:00Z" },
					},
				},
				refinements: [{ id: "ref", trigger: "Recent refinement", created_at: "2025-06-15T00:00:00Z" }],
			}),
		);
		expect(collectStats(dir, NOW).learning.map((entry) => entry.title)).toEqual([
			"Recent refinement",
			"Newest memory",
			"Older memory",
		]);
	});
});

describe("stats heatmap and command output", () => {
	test("renders a 52-week grid and legend with no-color fallback", () => {
		const result = collectStats("/directory-that-does-not-exist", NOW);
		const rendered = renderStatsHeatmap(result);
		const lines = rendered.split("\n");
		expect(lines).toHaveLength(8);
		expect(lines.slice(0, 7).every((line) => line.length === 52)).toBe(true);
		expect(rendered).toContain("Legend: · 0  ■ 1-5  ■ 6-10  ■ 11+");
	});

	test("parses /stats --json and produces structured JSON", () => {
		const parsed = parseSlashCommand("/stats --json");
		expect(parsed).toEqual({ name: "stats", args: "--json" });
		expect(resolveSlashCommand(parsed!)).toMatchObject({ name: "stats", args: "--json" });
		const payload = collectStats("/directory-that-does-not-exist", NOW);
		const decoded = JSON.parse(JSON.stringify(payload));
		expect(decoded).toMatchObject({ period: payload.period, totals: payload.totals, sessionsScanned: 0, skipped: 0 });
		expect(decoded.days).toHaveLength(364);
		expect(decoded.learning).toEqual([]);
	});
});
