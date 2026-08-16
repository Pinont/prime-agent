/** Built-in Plan/Build workflow extension. */
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "../types.js";

type Mode = "plan" | "build" | "orchestrate" | "goal";
interface GoalSnapshot {
	status: string;
	objective?: string;
	tokensUsed?: number;
	tokenBudget?: number;
	timeUsedSeconds?: number;
}
function latestGoal(ctx: ExtensionContext): GoalSnapshot | undefined {
	const entries = [...ctx.sessionManager.getEntries()].reverse();
	for (const entry of entries) {
		if (entry.type === "custom" && entry.customType === "thread_goal_state") {
			const data = (entry as { data?: Record<string, unknown> }).data;
			if (!data) return undefined;
			return {
				status: String(data.status ?? "idle"),
				objective: typeof data.objective === "string" ? data.objective : undefined,
				tokensUsed: typeof data.tokensUsed === "number" ? data.tokensUsed : undefined,
				tokenBudget: typeof data.tokenBudget === "number" ? data.tokenBudget : undefined,
				timeUsedSeconds: typeof data.timeUsedSeconds === "number" ? data.timeUsedSeconds : undefined,
			};
		}
	}
	return undefined;
}
interface SubmittedPlan {
	title: string;
	summary: string;
	steps: string[];
	affected: string[];
	tests: string[];
	risks: string[];
}
interface State {
	version: 1;
	mode: Mode;
	plan?: SubmittedPlan;
	planPath?: string;
	planRevision: number;
	approvedRevision?: number;
	previousTools: string[];
}
const ENTRY = "prime-agent.plan-mode";
const OWN_TOOLS = ["ask_user", "submit_plan"];
const READ_ONLY_TOOLS = ["bash", ...OWN_TOOLS];
const SAFE_BASH =
	/^(?:\s*)(?:cat|head|tail|less|more|grep|rg|find|ls|pwd|git\s+(?:status|log|diff|show|branch)|npm\s+(?:list|ls|view|info|search|outdated|audit)|wc|du|df|stat|file|sed\s+-n|awk|jq)\b/i;
const UNSAFE_BASH =
	/(?:^|[\s;&|])(?:rm|mv|cp|mkdir|touch|chmod|chown|ln|tee|dd|sudo|su|kill|git\s+(?:add|commit|push|pull|merge|rebase|reset|checkout|stash)|npm\s+(?:install|update|uninstall|ci))\b|(?:^|[^<])>{1,2}/i;

function cleanList(values: string[], field: string): string[] {
	const cleaned = values.map((value) => value.trim()).filter(Boolean);
	if (cleaned.length === 0) throw new Error(`${field} must contain at least one item`);
	return cleaned;
}
function slug(value: string): string {
	if (/[/\\\0-\x1f]/.test(value)) throw new Error("Plan title contains an unsafe path character");
	const result = value
		.toLowerCase()
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 60);
	if (!result) throw new Error("Plan title must contain letters or numbers");
	return result;
}
function formatPlan(plan: SubmittedPlan): string {
	const list = (items: string[]) => items.map((item) => `- ${item}`).join("\n");
	return `# ${plan.title}\n\n## Summary\n\n${plan.summary}\n\n## Implementation steps\n\n${plan.steps.map((step, i) => `${i + 1}. ${step}`).join("\n")}\n\n## Affected files/components\n\n${list(plan.affected)}\n\n## Tests and validation\n\n${list(plan.tests)}\n\n## Risks and alternatives\n\n${list(plan.risks)}\n`;
}
async function writeArtifact(cwd: string, revision: number, title: string, content: string): Promise<string> {
	const project = await realpath(cwd);
	const prime = join(project, ".prime");
	await mkdir(prime, { recursive: true });
	const primeStat = await lstat(prime);
	if (primeStat.isSymbolicLink() || !primeStat.isDirectory()) throw new Error(".prime must be a real directory");
	const safePrime = await realpath(prime);
	if (relative(project, safePrime).startsWith(`..${sep}`) || relative(project, safePrime) === "..")
		throw new Error(".prime escapes the project");
	for (let attempt = 0; attempt < 100; attempt++) {
		const suffix = attempt === 0 ? "" : `-${attempt + 1}`;
		const file = join(safePrime, `${String(revision).padStart(2, "0")}-submitted-${slug(title)}${suffix}.md`);
		if (relative(safePrime, file).startsWith(`..${sep}`)) throw new Error("Invalid submitted plan destination");
		try {
			const handle = await open(file, "wx", 0o600);
			try {
				await handle.writeFile(content, "utf8");
			} finally {
				await handle.close();
			}
			return relative(project, file);
		} catch (error: unknown) {
			if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
			throw error;
		}
	}
	throw new Error("Unable to allocate a submitted plan artifact");
}

export function planBuildOrchestrateExtension(pi: ExtensionAPI): void {
	// Fresh sessions start in the normal (build) state; PLAN is opt-in via /mode plan.
	let state: State = { version: 1, mode: "build", planRevision: 0, previousTools: [] };
	const persist = () => pi.appendEntry(ENTRY, state);
	const activeNames = () => new Set(pi.getAllTools().map((tool) => tool.name));
	const render = (ctx: ExtensionContext) => {
		if (state.mode === "goal") {
			const goal = latestGoal(ctx);
			const summary = goal?.objective ? goal.objective.slice(0, 80) : "no active goal";
			const statusLine = goal
				? `${goal.status}${goal.tokenBudget !== undefined ? ` (${goal.tokensUsed ?? 0}/${goal.tokenBudget} tokens)` : ""}`
				: "idle";
			ctx.ui.setStatus("plan-build-orchestrate", `mode: goal | ${statusLine}`);
			ctx.ui.setWidget("plan-build-orchestrate", [
				`GOAL MODE: ${summary}`,
				"Use /goal [objective] to set, /goal pause|resume|clear, /goal status.",
			]);
			return;
		}
		const approval = state.plan && state.approvedRevision === state.planRevision ? "approved" : "unapproved";
		ctx.ui.setStatus(
			"plan-build-orchestrate",
			`mode: ${state.mode} | plan r${state.planRevision || "-"} ${approval}`,
		);
		ctx.ui.setWidget(
			"plan-build-orchestrate",
			state.plan
				? [`PLAN READY r${state.planRevision}: ${state.plan.title}`, "Use /mode build or /mode orchestrate."]
				: undefined,
		);
	};
	const enterPlan = (ctx: ExtensionContext) => {
		if (state.mode !== "plan") state.previousTools = pi.getActiveTools();
		state.mode = "plan";
		state.approvedRevision = undefined;
		pi.setActiveTools(READ_ONLY_TOOLS.filter((name) => activeNames().has(name)));
		persist();
		render(ctx);
	};
	const enterGoal = (ctx: ExtensionContext, objective?: string) => {
		if (state.mode !== "goal") state.previousTools = pi.getActiveTools();
		state.mode = "goal";
		state.approvedRevision = undefined;
		pi.setActiveTools(state.previousTools.filter((name) => activeNames().has(name)));
		persist();
		render(ctx);
		if (objective) {
			ctx.ui.notify(
				"Goal mode entered. Set or update the objective with /goal <objective> [--budget <tokens>].",
				"info",
			);
		} else {
			ctx.ui.notify(
				"Goal mode entered. Set an objective with /goal <objective> [--budget <tokens>], then manage with /goal status|pause|resume|clear.",
				"info",
			);
		}
	};
	const enterBuild = (ctx: ExtensionContext) => {
		if (!state.plan || state.approvedRevision !== state.planRevision) {
			ctx.ui.notify("Submit a current plan before entering build mode.", "warning");
			return;
		}
		state.mode = "build";
		pi.setActiveTools(state.previousTools.filter((name) => activeNames().has(name)));
		persist();
		render(ctx);
	};
	pi.registerTool({
		name: "ask_user",
		label: "Ask user",
		description: "Ask the user a planning question. In headless mode returns unavailable.",
		parameters: Type.Object({
			mode: Type.Union([
				Type.Literal("text"),
				Type.Literal("choice"),
				Type.Literal("confirm"),
				Type.Literal("editor"),
				Type.Literal("multi-choice"),
			]),
			question: Type.String(),
			options: Type.Optional(Type.Array(Type.String())),
		}),
		async execute(_id, params, _signal, _update, ctx) {
			if (!ctx.hasUI)
				return {
					content: [{ type: "text", text: JSON.stringify({ status: "unavailable", cancelled: true }) }],
					details: { status: "unavailable", cancelled: true },
				};
			let answer: string | boolean | undefined;
			if (params.mode === "text") answer = await ctx.ui.input(params.question);
			else if (params.mode === "editor") answer = await ctx.ui.input(params.question, "Enter your response");
			else if (params.mode === "confirm") answer = await ctx.ui.confirm("Confirmation", params.question);
			else if (params.mode === "choice") answer = await ctx.ui.select(params.question, params.options ?? []);
			else
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({
								status: "unavailable",
								cancelled: true,
								reason: "multi-choice requires a custom UI component",
							}),
						},
					],
					details: { status: "unavailable", cancelled: true },
				};
			const cancelled = answer === undefined;
			return {
				content: [
					{
						type: "text",
						text: JSON.stringify({
							status: cancelled ? "cancelled" : "answered",
							cancelled,
							answer: cancelled ? undefined : answer,
						}),
					},
				],
				details: { cancelled, answer },
			};
		},
	});
	pi.registerTool({
		name: "submit_plan",
		label: "Submit plan",
		description: "Validate and save the completed implementation plan. Required before build mode.",
		parameters: Type.Object({
			title: Type.String(),
			summary: Type.String(),
			steps: Type.Array(Type.String()),
			affected: Type.Array(Type.String()),
			tests: Type.Array(Type.String()),
			risks: Type.Array(Type.String()),
		}),
		async execute(_id, params, _signal, _update, ctx) {
			try {
				if (state.mode !== "plan") throw new Error("submit_plan is only available in PLAN mode");
				const plan: SubmittedPlan = {
					title: params.title.trim(),
					summary: params.summary.trim(),
					steps: cleanList(params.steps, "steps"),
					affected: cleanList(params.affected, "affected files/components"),
					tests: cleanList(params.tests, "tests"),
					risks: cleanList(params.risks, "risks"),
				};
				if (!plan.title || !plan.summary) throw new Error("title and summary are required");
				const revision = state.planRevision + 1;
				const planPath = await writeArtifact(ctx.cwd, revision, plan.title, formatPlan(plan));
				state = { ...state, plan, planPath, planRevision: revision, approvedRevision: undefined };
				persist();
				render(ctx);
				ctx.ui.notify("PLAN READY", "info");
				return {
					content: [{ type: "text", text: `PLAN READY r${revision}: ${planPath}` }],
					details: { planPath, revision },
				};
			} catch (error) {
				return {
					content: [
						{
							type: "text",
							text: `Plan submission failed: ${error instanceof Error ? error.message : String(error)}`,
						},
					],
					details: {},
					isError: true,
				};
			}
		},
	});
	pi.registerCommand("mode", {
		description: "Show or change plan/build workflow mode",
		getArgumentCompletions: (prefix) =>
			["plan", "build", "orchestrate", "goal", "status", "cancel"]
				.filter((value) => value.startsWith(prefix))
				.map((value) => ({ value, label: value })),
		handler: async (args, ctx) => {
			const command = args.trim().toLowerCase();
			if (!command || command === "status") {
				render(ctx);
				ctx.ui.notify(
					`Mode: ${state.mode}; plan revision: ${state.planRevision || "none"}; ${state.approvedRevision === state.planRevision ? "approved" : "unapproved"}`,
					"info",
				);
				return;
			}
			if (command === "plan" || command === "cancel") {
				if (command === "cancel") state.plan = undefined;
				enterPlan(ctx);
				return;
			}
			if (command === "build") {
				if (!state.plan) {
					ctx.ui.notify("Submit a current plan before entering build mode.", "warning");
					return;
				}
				if (state.approvedRevision !== state.planRevision) {
					if (!ctx.hasUI) {
						ctx.ui.notify("Build mode requires interactive approval of the submitted plan.", "warning");
						return;
					}
					const approved = await ctx.ui.confirm(
						"Approve plan",
						`Proceed to BUILD mode with plan r${state.planRevision}: ${state.plan.title}?`,
					);
					if (!approved) {
						ctx.ui.notify("Plan not approved; remaining in PLAN mode.", "info");
						return;
					}
					state.approvedRevision = state.planRevision;
				}
				enterBuild(ctx);
				return;
			}
			if (command === "goal") {
				const objective = args.trim().length > 4 ? args.slice(4).trim() : undefined;
				enterGoal(ctx, objective);
				return;
			}
			if (command === "orchestrate") {
				ctx.ui.notify(
					"Orchestrate mode is unavailable: extensions cannot safely permit only rlm.run within unrestricted ipython. Core capability policy support is required.",
					"warning",
				);
				return;
			}
			ctx.ui.notify("Usage: /mode [plan|build|orchestrate|goal|status|cancel]", "warning");
		},
	});
	pi.on("input", (event) => {
		if (event.source !== "extension" && state.approvedRevision !== undefined) {
			state.approvedRevision = undefined;
			persist();
		}
	});
	pi.on("before_agent_start", (event, ctx) => {
		if (state.mode === "plan")
			return {
				systemPrompt: `${event.systemPrompt}\n\nPLAN MODE: Use only read-only exploration. Do not modify files or external state. Ask clarification with ask_user and finish by calling submit_plan with a structured plan.`,
			};
		if (state.mode === "goal") {
			const goal = latestGoal(ctx);
			const objective = goal?.objective ? goal.objective : "no objective set yet";
			return {
				systemPrompt: `${event.systemPrompt}\n\nGOAL MODE: You are pursuing the active thread goal. Objective: ${objective}\n\nWork toward completing the objective across turns. Use the goal skill from IPython (await goal.get(), await goal.complete()) and the /goal command (status, pause, resume, clear) to manage it. Do not mark the goal complete until it is genuinely achieved.`,
			};
		}
		return undefined;
	});
	pi.on("tool_call", (event) => {
		if (state.mode !== "plan") return;
		if (event.toolName === "ask_user" || event.toolName === "submit_plan") return;
		if (event.toolName === "bash") {
			const command = typeof event.input.command === "string" ? event.input.command : "";
			if (SAFE_BASH.test(command) && !UNSAFE_BASH.test(command)) return;
			return { block: true, reason: "PLAN mode permits only allowlisted read-only bash commands." };
		}
		return { block: true, reason: "PLAN mode blocks non-read-only tools." };
	});
	pi.on("session_start", (_event, ctx) => {
		const entry = [...ctx.sessionManager.getEntries()]
			.reverse()
			.find((candidate) => candidate.type === "custom" && candidate.customType === ENTRY) as
			| { type: "custom"; customType: string; data?: State }
			| undefined;
		if (entry?.data?.version === 1) state = entry.data;
		if (!entry && state.previousTools.length === 0) state.previousTools = pi.getActiveTools();
		if (state.mode === "plan") pi.setActiveTools(READ_ONLY_TOOLS.filter((name) => activeNames().has(name)));
		else pi.setActiveTools(state.previousTools.filter((name) => activeNames().has(name)));
		render(ctx);
	});
}
