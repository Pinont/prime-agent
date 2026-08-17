import { Container, setKeybindings } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import {
	BrandSplashHeader,
	getRandomStartHint,
	InteractiveMode,
	START_HINTS,
} from "../src/modes/interactive/interactive-mode.js";
import { getMarkdownTheme, initTheme } from "../src/modes/interactive/theme/theme.js";
import { PRIME_BUTTERFLY_LOGO } from "../src/themes/prime-logo.js";

describe("InteractiveMode startup hints", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
	});

	function createMode(sessionHasMessages = false, returnToAgentsView = false, getEditorText = () => "") {
		const mode = {
			sessionHasMessages,
			options: { returnToAgentsView },
			editor: { getText: getEditorText },
			connectionState: {
				model: { name: "test-model", reasoning: true },
				thinkingLevel: "high",
			},
		};
		Object.setPrototypeOf(mode, InteractiveMode.prototype);
		return mode;
	}

	it("keeps a blank row above the shared splash and limits its metadata", () => {
		const header = new BrandSplashHeader(
			"0.0.0",
			() => "test-model",
			() => "/tmp/project",
			undefined,
			{
				topPadding: true,
				getStartHint: () => 'Try "refactor @<filepath>"',
			},
		);

		const lines = header.render(120);
		const output = stripAnsi(lines.join("\n"));

		expect(lines[0]).toBe("");
		expect(output).toContain("version  v0.0.0");
		expect(output).toContain("model    test-model");
		expect(output).toContain("cwd      /tmp/project");
		expect(output).toContain('Try "refactor @<filepath>"');
		expect(output).not.toContain("input");
		expect(output).not.toContain("files");
		expect(output).not.toContain("help");

		const unpadded = new BrandSplashHeader(
			"0.0.0",
			() => "test-model",
			() => "/tmp/project",
		);
		expect(unpadded.render(120)[0]).not.toBe("");
	});

	it("marks the header version as source or release build", () => {
		const original = process.env.PRIME_AGENT_BUILD_ID;
		try {
			delete process.env.PRIME_AGENT_BUILD_ID;
			const release = new BrandSplashHeader(
				"0.7.2",
				() => "model",
				() => "/cwd",
				undefined,
				{ topPadding: true },
			);
			expect(stripAnsi(release.render(120).join("\n"))).toContain("v0.7.2 (release)");

			process.env.PRIME_AGENT_BUILD_ID = "abc1234";
			const source = new BrandSplashHeader(
				"0.7.2",
				() => "model",
				() => "/cwd",
				undefined,
				{ topPadding: true },
			);
			const output = stripAnsi(source.render(120).join("\n"));
			expect(output).toContain("v0.7.2 (src abc1234)");
			expect(output).not.toContain("(release)");
		} finally {
			if (original === undefined) {
				delete process.env.PRIME_AGENT_BUILD_ID;
			} else {
				process.env.PRIME_AGENT_BUILD_ID = original;
			}
		}
	});

	it("uses a Codex-style header only for the claude-midnight theme", () => {
		initTheme("claude-midnight");
		const header = new BrandSplashHeader(
			"0.0.0",
			() => "provider/very-long-model-name",
			() => "/very/long/project/path/with/a/final-directory",
		);

		const output = stripAnsi(header.render(60).join("\n"));
		// The claude-midnight header is the [ logo | header ] layout: the logo
		// renders on the left, a divider, and the title/model/cwd rows on the
		// right. The logo is present, so the box is taller than the text alone.
		expect(output).toContain("Prime Agent v0.0.0");
		expect(output).toContain("model");
		expect(output).toContain("cwd");
		expect(output).toContain(PRIME_BUTTERFLY_LOGO.split("\n")[0]!.trim());
		expect(output).toContain("│");
		const rendered = header.render(60);
		expect(rendered.length).toBeGreaterThanOrEqual(4);
		expect(rendered.every((line) => stripAnsi(line).length <= 60)).toBe(true);

		initTheme("dark");
	});

	it("randomly selects from five concise filepath prompts", () => {
		expect(START_HINTS).toHaveLength(5);
		expect(new Set(START_HINTS).size).toBe(5);

		for (const [index, hint] of START_HINTS.entries()) {
			expect(getRandomStartHint(() => index / START_HINTS.length)).toBe(hint);
			expect(hint).toMatch(/^Try ".*@<filepath>.*"$/);
		}
	});

	it("places the fresh-chat shortcut hint after the model and effort", () => {
		const mode = createMode();
		const label = Reflect.get(InteractiveMode.prototype, "getTrayLocationLabel").call(mode);

		expect(stripAnsi(label)).toBe("test-model • high  ? for shortcuts");
	});

	it("routes session-view requests through the existing agents-view return path", async () => {
		const returnToAgentsView = vi.fn(async () => {});
		const mode = Object.assign(createMode(false, true), { returnToAgentsView });

		await Reflect.get(InteractiveMode.prototype, "requestAgentsView").call(mode);

		expect(returnToAgentsView).toHaveBeenCalledOnce();
	});

	it("explains why a draft blocks the destructive agents-view handoff", async () => {
		const returnToAgentsView = vi.fn(async () => {});
		const showStatus = vi.fn();
		const mode = Object.assign(
			createMode(false, true, () => "draft prompt"),
			{ returnToAgentsView, showStatus },
		);

		await Reflect.get(InteractiveMode.prototype, "requestAgentsView").call(mode);

		expect(returnToAgentsView).not.toHaveBeenCalled();
		expect(showStatus).toHaveBeenCalledWith("Send, stash, or clear your draft before opening agents");
	});

	it("opens the shared session view on back navigation for process-local chats", async () => {
		const requestAgentsView = vi.fn(async () => {});
		const returnToAgentsView = vi.fn(async () => {});
		const mode = Object.assign(createMode(false, false), { requestAgentsView, returnToAgentsView });

		const handled = Reflect.get(InteractiveMode.prototype, "handleAgentsBack").call(mode) as boolean;

		expect(handled).toBe(true);
		expect(requestAgentsView).toHaveBeenCalledOnce();
		expect(returnToAgentsView).not.toHaveBeenCalled();
	});

	it("returns to the daemon agents view on back navigation for daemon chats", async () => {
		const requestAgentsView = vi.fn(async () => {});
		const returnToAgentsView = vi.fn(async () => {});
		const mode = Object.assign(createMode(false, true), { requestAgentsView, returnToAgentsView });

		const handled = Reflect.get(InteractiveMode.prototype, "handleAgentsBack").call(mode) as boolean;

		expect(handled).toBe(true);
		expect(returnToAgentsView).toHaveBeenCalledOnce();
		expect(requestAgentsView).not.toHaveBeenCalled();
	});

	it("leaves back navigation to the editor while a draft exists", async () => {
		const requestAgentsView = vi.fn(async () => {});
		const mode = Object.assign(
			createMode(false, false, () => "draft prompt"),
			{ requestAgentsView },
		);

		const handled = Reflect.get(InteractiveMode.prototype, "handleAgentsBack").call(mode) as boolean;

		expect(handled).toBe(false);
		expect(requestAgentsView).not.toHaveBeenCalled();
	});

	it("explains that the agents view needs the daemon for non-daemon chats", async () => {
		const showStatus = vi.fn();
		const shutdown = vi.fn(async () => {});
		const mode = Object.assign(createMode(false, false), {
			returnToAgentsView: vi.fn(async () => {}),
			showStatus,
			shutdown,
		});

		await Reflect.get(InteractiveMode.prototype, "requestAgentsView").call(mode);

		expect(showStatus).toHaveBeenCalledWith(expect.stringContaining("needs the daemon"));
		expect(shutdown).not.toHaveBeenCalled();
	});

	it("keeps the lowercase agents hint while typing", () => {
		let editorText = "";
		const mode = createMode(false, true, () => editorText);
		const getLabel = () => Reflect.get(InteractiveMode.prototype, "getTrayLocationLabel").call(mode);

		expect(stripAnsi(getLabel())).toBe("← agents/resume  test-model • high  ? for shortcuts");

		editorText = "draft prompt";
		expect(stripAnsi(getLabel())).toBe("← agents/resume  test-model • high");
	});

	it("hides the fresh-chat shortcut hint while the prompt has text", () => {
		let editorText = "";
		const mode = createMode(false, false, () => editorText);
		const getLabel = () => Reflect.get(InteractiveMode.prototype, "getTrayLocationLabel").call(mode);

		expect(stripAnsi(getLabel())).toBe("test-model • high  ? for shortcuts");

		editorText = "draft prompt";
		expect(stripAnsi(getLabel())).toBe("test-model • high");

		editorText = " ";
		expect(stripAnsi(getLabel())).toBe("test-model • high");

		editorText = "";
		expect(stripAnsi(getLabel())).toBe("test-model • high  ? for shortcuts");
	});

	it("hides the tray shortcut guidance for chats with history", () => {
		const mode = createMode(true);
		const label = Reflect.get(InteractiveMode.prototype, "getTrayLocationLabel").call(mode);

		expect(stripAnsi(label)).toBe("test-model • high");
	});

	it("keeps the question-mark shortcut guide compact", () => {
		const guide = Reflect.get(InteractiveMode.prototype, "getShortcutGuide").call(createMode());

		expect(guide).toContain("`!` shell mode · `/` commands · `@` file paths");
		expect(guide).toContain("stash prompt");
		expect(guide).toContain("`/hotkeys` full reference");
		expect(guide).not.toContain("Ctrl+Z");
		expect(guide).not.toContain("suspend");
		expect(guide).not.toContain("**Navigation**");
		expect(guide).not.toContain("**Extensions**");
	});

	it("renders question-mark shortcut help ephemerally without appending to chat history", () => {
		const shortcutGuideContainer = new Container();
		const chatContainer = new Container();
		const mode = Object.assign(createMode(), {
			shortcutGuideContainer,
			chatContainer,
			ui: { requestRender: vi.fn() },
			getMarkdownThemeWithSettings: () => getMarkdownTheme(),
		});

		Reflect.get(InteractiveMode.prototype, "showShortcutGuide").call(mode);
		Reflect.get(InteractiveMode.prototype, "showShortcutGuide").call(mode);

		expect(chatContainer.children).toHaveLength(0);
		expect(shortcutGuideContainer.children).toHaveLength(2);

		Reflect.get(InteractiveMode.prototype, "clearShortcutGuide").call(mode);

		expect(shortcutGuideContainer.children).toHaveLength(0);
	});

	it("keeps /hotkeys comprehensive without Ctrl+Z", () => {
		const guide = Reflect.get(InteractiveMode.prototype, "getHotkeysGuide").call(createMode());

		expect(guide).toContain("**Navigation**");
		expect(guide).toContain("**Editing**");
		expect(guide).toContain("**Fullscreen mode (`/fullscreen`)**");
		expect(guide).toContain("Queue follow-up message");
		expect(guide).not.toContain("Ctrl+Z");
		expect(guide).not.toContain("Suspend to background");
	});

	it("renders /hotkeys in chat history instead of the temporary guide", () => {
		const shortcutGuideContainer = new Container();
		const chatContainer = new Container();
		const mode = Object.assign(createMode(), {
			shortcutGuideContainer,
			chatContainer,
			ui: { requestRender: vi.fn() },
			getMarkdownThemeWithSettings: () => getMarkdownTheme(),
		});

		Reflect.get(InteractiveMode.prototype, "handleHotkeysCommand").call(mode);

		expect(chatContainer.children).toHaveLength(2);
		expect(shortcutGuideContainer.children).toHaveLength(0);
	});
});
