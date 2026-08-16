/**
 * Tests for the built-in todo extension: registration, actions, validation
 * errors, session resume persistence, and branch semantics.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.js";
import { createEventBus } from "../src/core/event-bus.js";
import { createTodoExtension, type TodoDetails } from "../src/core/extensions/builtin/todo.js";
import { createExtensionRuntime, loadExtensionFromFactory } from "../src/core/extensions/loader.js";
import { ExtensionRunner } from "../src/core/extensions/runner.js";
import type { AgentToolResult, ExtensionActions, ExtensionContextActions } from "../src/core/extensions/types.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import { SessionManager } from "../src/core/session-manager.js";

type TodoAction = "list" | "add" | "toggle" | "clear";

interface TodoParams {
	action: TodoAction;
	text?: string;
	id?: number;
}

const extensionActions: ExtensionActions = {
	sendMessage: () => {},
	sendUserMessage: () => {},
	appendEntry: () => {},
	setSessionName: () => {},
	getSessionName: () => undefined,
	setLabel: () => {},
	getActiveTools: () => [],
	getAllTools: () => [],
	setActiveTools: () => {},
	refreshTools: () => {},
	getCommands: () => [],
	setModel: async () => false,
	getThinkingLevel: () => "off",
	setThinkingLevel: () => {},
};

const extensionContextActions: ExtensionContextActions = {
	getModel: () => undefined,
	isIdle: () => true,
	getSignal: () => undefined,
	abort: () => {},
	hasPendingMessages: () => false,
	shutdown: () => {},
	getContextUsage: () => undefined,
	compact: () => {},
	getSystemPrompt: () => "",
};

describe("built-in todo extension", () => {
	let dir: string;
	let sessionManager: SessionManager;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pi-todo-test-"));
		sessionManager = SessionManager.inMemory();
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	async function createRunner(sm: SessionManager = sessionManager): Promise<ExtensionRunner> {
		const runtime = createExtensionRuntime();
		const extension = await loadExtensionFromFactory(createTodoExtension(), dir, createEventBus(), runtime);
		const authStorage = AuthStorage.create(join(dir, "auth.json"));
		const modelRegistry = ModelRegistry.create(authStorage);
		const runner = new ExtensionRunner([extension], runtime, dir, sm, modelRegistry);
		runner.bindCore(extensionActions, extensionContextActions);
		await runner.emit({ type: "session_start", reason: "startup" });
		return runner;
	}

	function todoTool(runner: ExtensionRunner) {
		const registered = runner.getAllRegisteredTools().find((t) => t.definition.name === "todo");
		if (!registered) throw new Error("todo tool not registered");
		return registered.definition;
	}

	async function runTodo(
		runner: ExtensionRunner,
		toolCallId: string,
		params: TodoParams,
	): Promise<AgentToolResult<TodoDetails>> {
		const ctx = runner.createContext();
		const result = await todoTool(runner).execute(toolCallId, params, undefined, undefined, ctx);
		return result as AgentToolResult<TodoDetails>;
	}

	/** Simulate the agent runtime persisting a tool result into the session. */
	function appendTodoResult(sm: SessionManager, toolCallId: string, text: string, details: TodoDetails): string {
		return sm.appendMessage({
			role: "toolResult",
			toolCallId,
			toolName: "todo",
			content: [{ type: "text", text }],
			details,
			isError: false,
			timestamp: Date.now(),
		});
	}

	async function addTodo(runner: ExtensionRunner, text: string, sm: SessionManager = sessionManager): Promise<string> {
		const result = await runTodo(runner, `call-${text}`, { action: "add", text });
		return appendTodoResult(
			sm,
			`call-${text}`,
			result.content[0]?.type === "text" ? result.content[0].text : "",
			result.details!,
		);
	}

	it("registers the todo tool and /todos command", async () => {
		const runner = await createRunner();
		expect(todoTool(runner).name).toBe("todo");
		expect(runner.getRegisteredCommands().some((c) => c.name === "todos")).toBe(true);
	});

	it("adds and lists todos", async () => {
		const runner = await createRunner();
		await runTodo(runner, "c1", { action: "add", text: "review the API" });
		await runTodo(runner, "c2", { action: "add", text: "write tests" });

		const result = await runTodo(runner, "c3", { action: "list" });
		expect(result.details?.todos.map((t) => ({ id: t.id, text: t.text, done: t.done }))).toEqual([
			{ id: 1, text: "review the API", done: false },
			{ id: 2, text: "write tests", done: false },
		]);
	});

	it("toggles todos between done and not done", async () => {
		const runner = await createRunner();
		await runTodo(runner, "c1", { action: "add", text: "review the API" });

		const toggled = await runTodo(runner, "c2", { action: "toggle", id: 1 });
		expect(toggled.details?.todos.find((t) => t.id === 1)?.done).toBe(true);

		const untoggled = await runTodo(runner, "c3", { action: "toggle", id: 1 });
		expect(untoggled.details?.todos.find((t) => t.id === 1)?.done).toBe(false);
	});

	it("clears all todos", async () => {
		const runner = await createRunner();
		await runTodo(runner, "c1", { action: "add", text: "review the API" });
		await runTodo(runner, "c2", { action: "add", text: "write tests" });

		const cleared = await runTodo(runner, "c3", { action: "clear" });
		expect(cleared.details?.todos).toEqual([]);
		expect(cleared.details?.nextId).toBe(1);

		const listed = await runTodo(runner, "c4", { action: "list" });
		expect(listed.details?.todos).toEqual([]);
	});

	it("rejects add without text", async () => {
		const runner = await createRunner();
		const result = await runTodo(runner, "c1", { action: "add" });
		expect(result.details?.error).toBe("text required");
		expect(result.content[0]?.type === "text" && result.content[0].text).toContain("text required");
	});

	it("rejects toggle without an id", async () => {
		const runner = await createRunner();
		const result = await runTodo(runner, "c1", { action: "toggle" });
		expect(result.details?.error).toBe("id required");
	});

	it("rejects toggle with an unknown id", async () => {
		const runner = await createRunner();
		await runTodo(runner, "c1", { action: "add", text: "review the API" });
		const result = await runTodo(runner, "c2", { action: "toggle", id: 99 });
		expect(result.details?.error).toBe("#99 not found");
	});

	it("restores todo state when a session is resumed", async () => {
		const runner1 = await createRunner();
		await addTodo(runner1, "review the API");
		await addTodo(runner1, "write tests");

		// A fresh runner over the same session simulates resume: state must be
		// reconstructed from the persisted tool result entries.
		const runner2 = await createRunner(sessionManager);
		const result = await runTodo(runner2, "c1", { action: "list" });
		expect(result.details?.todos.map((t) => t.text)).toEqual(["review the API", "write tests"]);
	});

	it("inherits todos up to the branch point and isolates later changes", async () => {
		const runner1 = await createRunner();
		const alphaId = await addTodo(runner1, "alpha");
		const betaId = await addTodo(runner1, "beta");

		// Branch back to before "beta": a runner on this branch must only see "alpha".
		sessionManager.branch(alphaId);
		const branchRunner = await createRunner(sessionManager);
		const branchList = await runTodo(branchRunner, "c1", { action: "list" });
		expect(branchList.details?.todos.map((t) => t.text)).toEqual(["alpha"]);

		// Adding on the branch must not leak into the abandoned branch.
		await addTodo(branchRunner, "gamma", sessionManager);
		sessionManager.branch(betaId);
		const originalRunner = await createRunner(sessionManager);
		const originalList = await runTodo(originalRunner, "c2", { action: "list" });
		expect(originalList.details?.todos.map((t) => t.text)).toEqual(["alpha", "beta"]);
	});
});
