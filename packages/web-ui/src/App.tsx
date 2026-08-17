import { useState } from "react";
import { CodexHeader } from "./components/brainless/codex/codex-header";
import { ClaudeMessage } from "./components/brainless/claude/claude-message";
import { ClaudeThinking } from "./components/brainless/claude/claude-thinking";
import { ClaudeToolCall } from "./components/brainless/claude/claude-tool-call";
import { ClaudeTodoList, type Todo } from "./components/brainless/claude/claude-todo-list";
import { ClaudeDiff, type DiffLine } from "./components/brainless/claude/claude-diff";
import { ClaudePermission } from "./components/brainless/claude/claude-permission";
import { ClaudeSlashMenu } from "./components/brainless/claude/claude-slash-menu";
import { ClaudePrompt } from "./components/brainless/claude/claude-prompt";
import { cn } from "./lib/utils";

const TODOS: Todo[] = [
	{ label: "Review the API surface", status: "done" },
	{ label: "Add the brainless web UI", status: "active" },
	{ label: "Ship the release", status: "todo" },
];

const DIFF: DiffLine[] = [
	{ type: "ctx", text: "export function App() {" },
	{ type: "add", text: '  return <CodexHeader version="v0.7.2" model="deepseek-v4-pro" />;' },
	{ type: "del", text: '  return <header>old</header>;' },
	{ type: "ctx", text: "}" },
];

export function App() {
	const [permissionResult, setPermissionResult] = useState<string>("");
	const [prompt, setPrompt] = useState("");

	return (
		<div className="mx-auto flex min-h-screen max-w-3xl flex-col gap-3 px-4 py-6">
			<CodexHeader version="v0.7.2 (src)" model="deepseek-v4-pro" directory="~/Work/Dev/prime-agent" />

			<ClaudeMessage role="user">Can you add the brainless web UI for the agent?</ClaudeMessage>

			<ClaudeThinking verbs={["Reading the plan", "Checking the registry", "Composing components"]} showTokens />

			<ClaudeToolCall tool="read" arg=".prime/00-Overview.md" result="134 lines" status="success" defaultOpen={false} />

			<ClaudeTodoList todos={TODOS} />

			<ClaudeDiff file="packages/web-ui/src/App.tsx" summary="Wire the brainless session view" lines={DIFF} />

			<ClaudePermission
				title="Allow terminal to make changes?"
				command="mkdir -p packages/web-ui && npm install"
				question="Allow the terminal to make changes to this folder?"
				options={["Yes, and don’t ask again", "Yes", "No"]}
				defaultSelected={1}
				onChoose={(index) => setPermissionResult(index === 2 ? "denied" : "granted")}
			/>
			{permissionResult && (
				<ClaudeMessage role="assistant">Permission {permissionResult}. Proceeding with the build.</ClaudeMessage>
			)}

			<ClaudeSlashMenu />

			<div className="mt-auto">
				<ClaudePrompt
					value={prompt}
					onChange={(e) => setPrompt(e.target.value)}
					placeholder="Ask anything (Ctrl+Enter to submit)"
					className={cn("w-full")}
				/>
			</div>
		</div>
	);
}
