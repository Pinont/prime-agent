import { describe, expect, it, vi } from "vitest";
import { planBuildOrchestrateExtension } from "../src/core/extensions/builtin/plan-build-orchestrate.js";

type Handler = (...args: any[]) => unknown;
function harness(entries: unknown[] = []) {
	const handlers = new Map<string, Handler>();
	const commands = new Map<string, { handler: Handler }>();
	const ui = {
		setStatus: vi.fn(),
		setWidget: vi.fn(),
		notify: vi.fn(),
		confirm: vi.fn(async () => true),
		input: vi.fn(),
		select: vi.fn(),
	};
	const pi = {
		on: vi.fn((event: string, handler: Handler) => handlers.set(event, handler)),
		registerCommand: vi.fn((name: string, opts: { handler: Handler }) => commands.set(name, opts)),
		registerTool: vi.fn(),
		getAllTools: vi.fn(() => [{ name: "bash" }, { name: "ask_user" }, { name: "submit_plan" }, { name: "ipython" }]),
		getActiveTools: vi.fn(() => ["bash", "ipython"]),
		setActiveTools: vi.fn(),
		appendEntry: vi.fn(),
	};
	const ctx = {
		ui,
		hasUI: true,
		cwd: "/tmp",
		sessionManager: { getEntries: () => entries },
		isIdle: () => true,
	} as any;
	planBuildOrchestrateExtension(pi as any);
	return { handlers, commands, ui, pi, ctx };
}

describe("plan/build/orchestrate goal mode", () => {
	it("enters goal mode with /mode goal", async () => {
		const h = harness();
		await h.commands.get("mode")!.handler("goal", h.ctx);
		expect(h.pi.setActiveTools).toHaveBeenLastCalledWith(["bash", "ipython"]);
		expect(h.ui.setStatus).toHaveBeenLastCalledWith("plan-build-orchestrate", "mode: goal | idle");
	});

	it("renders the latest thread goal state in the status widget", async () => {
		const h = harness([
			{
				type: "custom",
				customType: "thread_goal_state",
				data: { status: "active", objective: "Ship the feature", tokensUsed: 12, tokenBudget: 100 },
			},
		]);
		await h.commands.get("mode")!.handler("goal", h.ctx);
		expect(h.ui.setStatus).toHaveBeenLastCalledWith("plan-build-orchestrate", "mode: goal | active (12/100 tokens)");
		expect(h.ui.setWidget).toHaveBeenLastCalledWith("plan-build-orchestrate", [
			"GOAL MODE: Ship the feature",
			expect.any(String),
		]);
	});

	it("injects the goal mode prompt before the agent starts", async () => {
		const h = harness([
			{ type: "custom", customType: "thread_goal_state", data: { status: "active", objective: "Ship the feature" } },
		]);
		await h.commands.get("mode")!.handler("goal", h.ctx);
		const result = (await h.handlers.get("before_agent_start")!({ systemPrompt: "base" }, h.ctx)) as {
			systemPrompt: string;
		};
		expect(result.systemPrompt).toContain("GOAL MODE");
		expect(result.systemPrompt).toContain("Objective: Ship the feature");
	});

	it("keeps plan mode behavior and prompt unchanged", async () => {
		const h = harness();
		await h.commands.get("mode")!.handler("plan", h.ctx);
		const result = (await h.handlers.get("before_agent_start")!({ systemPrompt: "base" }, h.ctx)) as {
			systemPrompt: string;
		};
		expect(result.systemPrompt).toContain("PLAN MODE");
		expect(result.systemPrompt).not.toContain("GOAL MODE");
	});
});
