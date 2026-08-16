import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getAgentDir, getSessionsDir } from "../config.js";

export interface StatsDay {
	date: string;
	activity: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
}
export interface StatsResult {
	period: { from: string; to: string };
	days: StatsDay[];
	totals: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number };
	sessionsScanned: number;
	skipped: number;
	learning: Array<{ title: string; scope: string; createdAt?: string; updatedAt?: string; kind: string }>;
}
const MAX_FILES = 500;
const isoDay = (value: unknown): string | undefined => {
	const d = new Date(String(value));
	return Number.isNaN(d.getTime()) ? undefined : d.toISOString().slice(0, 10);
};
export function collectStats(sessionDir: string = getSessionsDir(), now = new Date()): StatsResult {
	const end = new Date(now);
	end.setHours(23, 59, 59, 999);
	const from = new Date(end);
	from.setDate(from.getDate() - 363);
	const fromDay = from.toISOString().slice(0, 10),
		toDay = end.toISOString().slice(0, 10);
	const map = new Map<string, StatsDay>();
	for (let i = 0; i < 364; i++) {
		const d = new Date(from);
		d.setDate(from.getDate() + i);
		const date = d.toISOString().slice(0, 10);
		map.set(date, { date, activity: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 });
	}
	let files: string[] = [];
	try {
		files = readdirSync(sessionDir)
			.filter((f) => f.endsWith(".jsonl"))
			.slice(0, MAX_FILES);
	} catch {
		// Session dir unreadable: treat as empty.
	}
	let skipped = 0;
	for (const f of files) {
		try {
			const lines = readFileSync(join(sessionDir, f), "utf8").split("\n");
			for (const line of lines) {
				if (!line.trim()) continue;
				const e = JSON.parse(line);
				const day = isoDay(e.timestamp);
				const bucket = day && map.get(day);
				if (!bucket) continue;
				if (e.type === "message") bucket.activity++;
				const u = e.type === "message" && e.message?.role === "assistant" ? e.message.usage : undefined;
				if (u) {
					bucket.input += u.input ?? 0;
					bucket.output += u.output ?? 0;
					bucket.cacheRead += u.cacheRead ?? 0;
					bucket.cacheWrite += u.cacheWrite ?? 0;
					bucket.cost += u.cost?.total ?? 0;
				}
			}
		} catch {
			skipped++;
		}
	}
	const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
	for (const d of map.values()) {
		totals.input += d.input;
		totals.output += d.output;
		totals.cacheRead += d.cacheRead;
		totals.cacheWrite += d.cacheWrite;
		totals.cost += d.cost;
	}
	return {
		period: { from: fromDay, to: toDay },
		days: [...map.values()],
		totals,
		sessionsScanned: files.length,
		skipped,
		learning: readLearning(),
	};
}
function readLearning(): StatsResult["learning"] {
	const candidates = [
		process.env.PRIME_AGENT_HARNESS_STATE_PATH,
		join(getAgentDir(), "harness_state.json"),
		join(homedir(), ".prime/agent/harness_state.json"),
	].filter((x): x is string => Boolean(x));
	for (const file of candidates)
		try {
			const state = JSON.parse(readFileSync(file, "utf8"));
			const entries = Object.values(state.entries ?? {})
				.flatMap((group) => Object.values(group as Record<string, unknown>))
				.map((raw: unknown) => ({
					title: String(
						(raw as Record<string, unknown>).title ??
							(raw as Record<string, unknown>).trigger ??
							(raw as Record<string, unknown>).id,
					),
					scope: String(
						(raw as Record<string, unknown>).scope ??
							((raw as Record<string, unknown>).metadata as Record<string, unknown> | undefined)?.scope ??
							"local",
					),
					createdAt: (raw as Record<string, unknown>).created_at as string | undefined,
					updatedAt: (raw as Record<string, unknown>).updated_at as string | undefined,
					kind: String((raw as Record<string, unknown>).kind ?? "memory"),
				}));
			const refs = (state.refinements ?? []).map((raw: unknown) => ({
				title: String((raw as Record<string, unknown>).trigger ?? (raw as Record<string, unknown>).id),
				scope: "local",
				createdAt: (raw as Record<string, unknown>).created_at as string | undefined,
				updatedAt: (raw as Record<string, unknown>).created_at as string | undefined,
				kind: "refinement",
			}));
			return [...entries, ...refs]
				.sort((a, b) => String(b.updatedAt ?? b.createdAt).localeCompare(String(a.updatedAt ?? a.createdAt)))
				.slice(0, 100);
		} catch {
			// Harness state unreadable/partial: return no learning entries rather than failing stats.
		}
	return [];
}
export function renderStatsHeatmap(
	result: StatsResult,
	color: (level: number, text: string) => string = (_l, t) => t,
): string {
	const max = Math.max(...result.days.map((d) => d.activity), 1);
	const rows: string[] = [];
	for (let weekday = 0; weekday < 7; weekday++) {
		let row = "";
		for (let week = 0; week < 52; week++) {
			const d = result.days[week * 7 + weekday];
			const level = d ? (d.activity === 0 ? 0 : d.activity <= 5 ? 1 : d.activity <= 10 ? 2 : 3) : 0;
			row += color(level, level === 0 ? "·" : "■");
		}
		rows.push(row);
	}
	return `${rows.join("\n")}\nLegend: · 0  ■ 1-5  ■ 6-10  ■ 11+ (max ${max})`;
}
