import { once } from "node:events";
import { createServer, type Http2ServerRequest, type Http2ServerResponse } from "node:http2";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	AgentClientMessageSchema,
	type AgentServerMessage,
	AgentServerMessageSchema,
	GetBlobArgsSchema,
	InteractionUpdateSchema,
	KvServerMessageSchema,
	TextDeltaUpdateSchema,
	ThinkingDeltaUpdateSchema,
	TokenDeltaUpdateSchema,
	TurnEndedUpdateSchema,
} from "../src/providers/cursor/cursor-proto.js";
import { create, fromBinary, toBinary } from "../src/providers/cursor/protobuf.js";
import { frameConnectMessage } from "../src/providers/cursor/transport.js";
import { streamCursorAgent } from "../src/providers/cursor.js";
import type { Context, Model } from "../src/types.js";

const HEARTBEAT_MS = 120;

function testModel(baseUrl: string): Model<"cursor-agent"> {
	return {
		id: "claude-4.6-opus-high",
		name: "Claude 4.6 Opus High (Cursor)",
		api: "cursor-agent",
		provider: "cursor",
		baseUrl,
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 2, output: 10, cacheRead: 0.25, cacheWrite: 2.5 },
		contextWindow: 400000,
		maxTokens: 64000,
	} as Model<"cursor-agent">;
}

const baseContext: Context = {
	systemPrompt: "You are a helpful assistant.",
	messages: [{ role: "user", content: "Hi", timestamp: Date.now() }],
};

type ReceivedFrame = { case: string; value?: unknown };

interface MockServer {
	url: string;
	close(): Promise<void>;
	headers: () => Record<string, string> | undefined;
	received: () => ReceivedFrame[];
	/** Resolves as soon as `condition` holds for the frames received so far. */
	waitFor(condition: (received: ReceivedFrame[]) => boolean): Promise<void>;
	sendText(text: string): void;
	sendThinking(text: string): void;
	sendTokens(tokens: number): void;
	sendTurnEnded(): void;
	sendEndStreamError(code: string, message: string): void;
	endWithoutTurnEnded(): void;
	requestKvGet(blobId: Uint8Array): void;
}

async function startMockServer(): Promise<MockServer> {
	const received: ReceivedFrame[] = [];
	const waiters: { check: (received: ReceivedFrame[]) => boolean; resolve: () => void }[] = [];
	let headers: Record<string, string> | undefined;
	let response: Http2ServerResponse | undefined;

	const server = createServer((req: Http2ServerRequest, res: Http2ServerResponse) => {
		headers = req.headers as Record<string, string>;
		response = res;
		res.writeHead(200, { "content-type": "application/connect+proto" });
		let buffer = Buffer.alloc(0);
		req.on("data", (chunk: Buffer) => {
			buffer = Buffer.concat([buffer, chunk]);
			while (buffer.length >= 5) {
				const flags = buffer[0];
				const length = buffer.readUInt32BE(1);
				if (buffer.length < 5 + length) break;
				const payload = buffer.subarray(5, 5 + length);
				buffer = buffer.subarray(5 + length);
				if (flags & 0b00000010) continue;
				try {
					const message = fromBinary(AgentClientMessageSchema, new Uint8Array(payload));
					received.push({ case: message.message.case ?? "none", value: message.message.value });
				} catch {
					// ignore frames that fail to decode (e.g. heartbeats are decodable; nothing is expected here)
				}
				for (let waiter = waiters.length - 1; waiter >= 0; waiter -= 1) {
					if (waiters[waiter].check(received)) {
						waiters[waiter].resolve();
						waiters.splice(waiter, 1);
					}
				}
			}
		});
	});

	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address() as { port: number };
	const url = `http://127.0.0.1:${address.port}`;

	function writeFrame(data: Uint8Array, flags = 0): void {
		response?.write(frameConnectMessage(data, flags));
	}

	function sendServer(serverMessage: AgentServerMessage): void {
		writeFrame(toBinary(AgentServerMessageSchema, serverMessage));
	}

	return {
		url,
		async close() {
			response?.end();
			server.close();
			await once(server, "close");
		},
		headers: () => headers,
		received: () => received,
		async waitFor(condition) {
			if (condition(received)) return;
			await new Promise<void>((resolve) => {
				waiters.push({ check: condition, resolve });
			});
		},
		sendText(text) {
			sendServer(
				create(AgentServerMessageSchema, {
					message: {
						case: "interactionUpdate",
						value: create(InteractionUpdateSchema, {
							message: { case: "textDelta", value: create(TextDeltaUpdateSchema, { text }) },
						}),
					},
				}),
			);
		},
		sendThinking(text) {
			sendServer(
				create(AgentServerMessageSchema, {
					message: {
						case: "interactionUpdate",
						value: create(InteractionUpdateSchema, {
							message: { case: "thinkingDelta", value: create(ThinkingDeltaUpdateSchema, { text }) },
						}),
					},
				}),
			);
		},
		sendTokens(tokens) {
			sendServer(
				create(AgentServerMessageSchema, {
					message: {
						case: "interactionUpdate",
						value: create(InteractionUpdateSchema, {
							message: { case: "tokenDelta", value: create(TokenDeltaUpdateSchema, { tokens }) },
						}),
					},
				}),
			);
		},
		sendTurnEnded() {
			sendServer(
				create(AgentServerMessageSchema, {
					message: {
						case: "interactionUpdate",
						value: create(InteractionUpdateSchema, {
							message: { case: "turnEnded", value: create(TurnEndedUpdateSchema, {}) },
						}),
					},
				}),
			);
			response?.addTrailers({ "grpc-status": "0" });
			response?.end();
		},
		sendEndStreamError(code, message) {
			writeFrame(new TextEncoder().encode(JSON.stringify({ error: { code, message } })), 0b00000010);
			response?.end();
		},
		endWithoutTurnEnded() {
			response?.addTrailers({ "grpc-status": "0" });
			response?.end();
		},
		requestKvGet(blobId) {
			sendServer(
				create(AgentServerMessageSchema, {
					message: {
						case: "kvServerMessage",
						value: create(KvServerMessageSchema, {
							id: 42,
							message: { case: "getBlobArgs", value: create(GetBlobArgsSchema, { blobId }) },
						}),
					},
				}),
			);
		},
	};
}

async function collect(
	stream: AsyncIterable<{ type: string; [k: string]: unknown }>,
): Promise<{ type: string; [k: string]: unknown }[]> {
	const events: { type: string; [k: string]: unknown }[] = [];
	for await (const event of stream) events.push(event as { type: string; [k: string]: unknown });
	return events;
}

describe("Cursor agent provider (mock Connect server)", () => {
	let server: MockServer;

	beforeEach(() => {
		process.env.CURSOR_HEARTBEAT_INTERVAL_MS = String(HEARTBEAT_MS);
	});

	afterEach(async () => {
		delete process.env.CURSOR_HEARTBEAT_INTERVAL_MS;
		await server?.close();
	});

	it("sends the exact Run headers and frames, streams text/thinking, and completes on turnEnded", async () => {
		server = await startMockServer();
		const stream = streamCursorAgent(testModel(server.url), baseContext, { apiKey: "test-key" });

		await server.waitFor((received) => received.some((r) => r.case === "runRequest"));
		const headers = server.headers()!;

		expect(headers[":method"]).toBe("POST");
		expect(headers[":path"]).toBe("/agent.v1.AgentService/Run");
		expect(headers["content-type"]).toBe("application/connect+proto");
		expect(headers["connect-protocol-version"]).toBe("1");
		expect(headers.te).toBe("trailers");
		expect(headers.authorization).toBe("Bearer test-key");
		expect(headers["x-ghost-mode"]).toBe("true");
		expect(headers["x-cursor-client-version"]).toBe("cli-2026.07.23-e383d2b");
		expect(headers["x-cursor-client-type"]).toBe("cli");
		expect(headers["x-request-id"]).toBeTruthy();

		server.sendThinking("Let me think.");
		server.sendText("Hello there");
		server.sendTokens(12);
		server.sendTurnEnded();

		const events = await collect(stream);
		const done = events.find((e) => e.type === "done");
		expect(done).toBeTruthy();
		const message = done?.message as {
			content: { type: string; text?: string; thinking?: string }[];
			usage: { output: number };
		};
		const text = message.content
			.filter((b) => b.type === "text")
			.map((b) => b.text)
			.join("");
		const thinking = message.content
			.filter((b) => b.type === "thinking")
			.map((b) => b.thinking)
			.join("");
		expect(text).toBe("Hello there");
		expect(thinking).toBe("Let me think.");
		expect(message.usage.output).toBe(12);
	});

	it("answers KV get blob requests from the local store", async () => {
		server = await startMockServer();
		const stream = streamCursorAgent(testModel(server.url), baseContext, { apiKey: "test-key" });

		await server.waitFor((received) => received.some((r) => r.case === "runRequest"));
		const runRequest = server.received().find((r) => r.case === "runRequest")?.value as {
			conversationState: { rootPromptMessagesJson: Uint8Array[] };
		};
		const firstBlobId = runRequest.conversationState.rootPromptMessagesJson[0];

		server.requestKvGet(firstBlobId);
		await server.waitFor((received) => received.some((r) => r.case === "kvClientMessage"));

		const kvReply = server.received().find((r) => r.case === "kvClientMessage")?.value as {
			id: number;
			message: { case: string; value: { blobData?: Uint8Array } };
		};
		expect(kvReply.id).toBe(42);
		expect(kvReply.message.case).toBe("getBlobResult");
		const json = Buffer.from(kvReply.message.value.blobData ?? []).toString("utf8");
		expect(JSON.parse(json)).toEqual({ role: "system", content: "You are a helpful assistant." });

		server.sendTurnEnded();
		await collect(stream);
	});

	it("sends heartbeats at the heartbeat interval", async () => {
		server = await startMockServer();
		const stream = streamCursorAgent(testModel(server.url), baseContext, { apiKey: "test-key" });

		await server.waitFor((received) => received.some((r) => r.case === "runRequest"));
		// Heartbeats are a periodic wire signal; wait for the observed frame.
		await server.waitFor((received) => received.some((r) => r.case === "clientHeartbeat"));

		server.sendTurnEnded();
		await collect(stream);
	});

	it("maps a Connect end-stream error to an error event", async () => {
		server = await startMockServer();
		const stream = streamCursorAgent(testModel(server.url), baseContext, { apiKey: "test-key" });

		await server.waitFor((received) => received.some((r) => r.case === "runRequest"));
		server.sendEndStreamError("not_found", "model deleted");

		const events = await collect(stream);
		const error = events.find((e) => e.type === "error");
		expect(error).toBeTruthy();
		const message = error?.error as { errorMessage: string; stopReason: string };
		expect(message.stopReason).toBe("error");
		expect(message.errorMessage).toMatch(/Connect error not_found: model deleted/);
	});

	it("reports an incomplete stream when the server ends without turnEnded", async () => {
		server = await startMockServer();
		const stream = streamCursorAgent(testModel(server.url), baseContext, { apiKey: "test-key" });

		await server.waitFor((received) => received.some((r) => r.case === "runRequest"));
		server.endWithoutTurnEnded();

		const events = await collect(stream);
		const error = events.find((e) => e.type === "error");
		const message = error?.error as { errorMessage: string };
		expect(message.errorMessage).toMatch(/ended before turnEnded/);
	});

	it("emits an aborted error when the caller aborts mid-stream", async () => {
		server = await startMockServer();
		const controller = new AbortController();
		const stream = streamCursorAgent(testModel(server.url), baseContext, {
			apiKey: "test-key",
			signal: controller.signal,
		});

		await server.waitFor((received) => received.some((r) => r.case === "runRequest"));
		controller.abort();

		const events = await collect(stream);
		const error = events.find((e) => e.type === "error");
		const message = error?.error as { stopReason: string };
		expect(message.stopReason).toBe("aborted");
	});
});
