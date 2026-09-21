// Cursor (cursor-agent) provider entry: stream functions over Cursor's
// AgentService Connect RPC transport (HTTP/2, length-prefixed protobuf).
// Ported from oh-my-pi (MIT): ai/src/providers/cursor.ts semantics adapted to
// Prime Agent's AssistantMessageEventStream protocol and Model/Context types.

import { createHash } from "node:crypto";
import type http2 from "node:http2";
import { calculateCost } from "../models.js";
import type {
	Api,
	AssistantMessage,
	Context,
	Model,
	SimpleStreamOptions,
	StreamOptions,
	TextContent,
	ThinkingContent,
	ToolCall,
} from "../types.js";
import { AssistantMessageEventStream } from "../utils/event-stream.js";
import { parseStreamingJson } from "../utils/json-parse.js";
import { formatStreamFailureMessage, recordStreamFailure } from "../utils/stream-failure.js";
import {
	AgentClientMessageSchema,
	AgentRunRequestSchema,
	type AgentServerMessage,
	AgentServerMessageSchema,
	ClientHeartbeatSchema,
	ConversationActionSchema,
	ConversationStateStructureSchema,
	type ToolCall as CursorToolCall,
	ExecClientControlMessageSchema,
	ExecClientStreamCloseSchema,
	ExecClientThrowSchema,
	type ExecServerMessage,
	GetBlobResultSchema,
	type InteractionUpdate,
	type KvClientMessage,
	KvClientMessageSchema,
	type KvServerMessage,
	type McpToolCall,
	ModelDetailsSchema,
	RequestedModelSchema,
	ResumeActionSchema,
	SetBlobResultSchema,
	UserMessageActionSchema,
	UserMessageSchema,
} from "./cursor/cursor-proto.js";
import { deterministicUuid } from "./cursor/deterministic-id.js";
import { ProviderResponseError } from "./cursor/errors.js";
import { handleInteractionQuery } from "./cursor/interaction-query.js";
import { create, fromBinary, toBinary } from "./cursor/protobuf.js";
import {
	CONNECT_END_STREAM_FLAG,
	CURSOR_HEARTBEAT_INTERVAL_MS,
	connectCursorStream,
	frameConnectMessage,
	mapH2TransportError,
	parseConnectEndStream,
} from "./cursor/transport.js";
import { collapseCursorWireModel, isCursorMaxModeWireId } from "./cursor/wire-model.js";
import { buildBaseOptions } from "./simple-options.js";

export const CURSOR_ACCESS_TOKEN_ENV = "CURSOR_ACCESS_TOKEN";
export const CURSOR_API_BASE_URL = "https://api2.cursor.sh";

/** Options accepted by the Cursor agent provider. */
export interface CursorAgentOptions extends StreamOptions {
	/** Exact replacement for the system prompt (sent as-is on the wire). */
	customSystemPrompt?: string;
	/** Reuse a Cursor conversation id across turns. */
	conversationId?: string;
	/** Raw wire model id to request (defaults to model.id). */
	wireModelId?: string;
}

type Block = (TextContent | ThinkingContent | ToolCall) & { index?: number };

interface CursorStreamState {
	output: AssistantMessage;
	stream: AssistantMessageEventStream;
	blocks: Block[];
	blobStore: Map<string, Uint8Array>;
	sawTurnEnded: boolean;
	sawTokenDelta: boolean;
	sawProgress: boolean;
	heartbeatTimer?: NodeJS.Timeout;
}

interface ToolCallStreamState {
	name: string;
	argsText: string;
}

function hexOf(bytes: Uint8Array): string {
	return Buffer.from(bytes).toString("hex");
}

function storeCursorBlob(state: CursorStreamState, data: Uint8Array): Uint8Array {
	const digest = createHash("sha256").update(data).digest();
	const id = new Uint8Array(digest);
	state.blobStore.set(hexOf(id), data);
	return id;
}

/** System prompt entries as independent JSON blobs (server-side prefix caching). */
function buildCursorSystemPromptJsons(systemPrompt: string | undefined): string[] {
	const content = systemPrompt || "You are a helpful assistant.";
	return [JSON.stringify({ role: "system", content })];
}

function promptMessageJson(role: string, content: unknown): Uint8Array {
	return new TextEncoder().encode(JSON.stringify({ role, content }));
}

function messageText(message: { content: string | readonly unknown[] }): string {
	if (typeof message.content === "string") return message.content;
	return message.content
		.filter(
			(item): item is { type: string; text?: string } => typeof item === "object" && item !== null && "type" in item,
		)
		.filter((item): item is { type: "text"; text: string } => item.type === "text" && typeof item.text === "string")
		.map((item) => item.text)
		.join("\n");
}

/** Build the conversation prompt blobs from prior context (excluding the active user message). */
function buildPromptBlobs(
	state: CursorStreamState,
	context: Context,
	systemPromptBlobIds: Uint8Array[],
	excludeIndex: number,
): Uint8Array[] {
	const ids = [...systemPromptBlobIds];
	context.messages.forEach((message, index) => {
		if (index === excludeIndex) return;
		if (message.role === "user") {
			ids.push(storeCursorBlob(state, promptMessageJson("user", messageText(message))));
			return;
		}
		if (message.role === "toolResult") {
			ids.push(storeCursorBlob(state, promptMessageJson("tool", messageText(message))));
			return;
		}
		if (message.role === "assistant") {
			const serialized: unknown[] = [{ type: "text", text: messageText(message) }];
			for (const item of message.content) {
				if (item.type === "toolCall") {
					serialized.push({ type: "toolCall", id: item.id, name: item.name, arguments: item.arguments });
				} else if (item.type === "thinking") {
					serialized.push({ type: "thinking", thinking: item.thinking });
				}
			}
			ids.push(storeCursorBlob(state, promptMessageJson("assistant", serialized)));
		}
	});
	return ids;
}

/** Stable wire tool name for a Cursor tool-call frame. */
function cursorToolName(toolCall: CursorToolCall | undefined): string {
	if (!toolCall) return "tool";
	const tool = toolCall.tool;
	if (!tool || tool.case === undefined) return "tool";
	switch (tool.case) {
		case "shellToolCall":
			return "bash";
		case "readToolCall":
			return "read";
		case "deleteToolCall":
			return "delete";
		case "globToolCall":
			return "glob";
		case "grepToolCall":
			return "grep";
		case "editToolCall":
			return "edit";
		case "updateTodosToolCall":
		case "readTodosToolCall":
			return "todo";
		case "fetchToolCall":
			return "fetch";
		case "mcpToolCall":
			return (tool.value as McpToolCall).args?.toolName || "mcp";
		default:
			return tool.case.replace(/ToolCall$/, "");
	}
}

function emptyAssistantMessage(model: Model<"cursor-agent">): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "cursor-agent" as Api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

/** Reply to a KV blob request/set frame from the local blob store. */
function handleKvServerMessage(
	state: CursorStreamState,
	h2Stream: http2.ClientHttp2Stream,
	message: KvServerMessage,
): void {
	const kv = message.message;
	if (!kv || kv.case === undefined) return;
	let result: KvClientMessage;
	if (kv.case === "getBlobArgs") {
		const blob = state.blobStore.get(hexOf(kv.value.blobId));
		result = create(KvClientMessageSchema, {
			id: message.id,
			message: { case: "getBlobResult", value: create(GetBlobResultSchema, { blobData: blob ?? undefined }) },
		});
	} else {
		state.blobStore.set(hexOf(kv.value.blobId), kv.value.blobData);
		result = create(KvClientMessageSchema, {
			id: message.id,
			message: { case: "setBlobResult", value: create(SetBlobResultSchema, {}) },
		});
	}
	const envelope = create(AgentClientMessageSchema, {
		message: { case: "kvClientMessage", value: result },
	});
	h2Stream.write(frameConnectMessage(toBinary(AgentClientMessageSchema, envelope)));
}

/** Exec frames are answered with a typed throw until the coding-agent exec bridge lands. */
function replyExecNotImplemented(h2Stream: http2.ClientHttp2Stream, message: ExecServerMessage): void {
	const requestName = message.message.case ?? "exec";
	const throwEnvelope = create(AgentClientMessageSchema, {
		message: {
			case: "execClientControlMessage",
			value: create(ExecClientControlMessageSchema, {
				message: {
					case: "throw",
					value: create(ExecClientThrowSchema, {
						id: message.id,
						error: `${requestName} is not implemented by this client`,
						errorCode: "NOT_IMPLEMENTED",
					}),
				},
			}),
		},
	});
	h2Stream.write(frameConnectMessage(toBinary(AgentClientMessageSchema, throwEnvelope)));
	const closeEnvelope = create(AgentClientMessageSchema, {
		message: {
			case: "execClientControlMessage",
			value: create(ExecClientControlMessageSchema, {
				message: { case: "streamClose", value: create(ExecClientStreamCloseSchema, { id: message.id }) },
			}),
		},
	});
	h2Stream.write(frameConnectMessage(toBinary(AgentClientMessageSchema, closeEnvelope)));
}

/** Map a Cursor interaction update onto Prime Agent stream events. */
function processInteractionUpdate(
	state: CursorStreamState,
	update: InteractionUpdate,
	toolCallStates: Map<string, ToolCallStreamState>,
): void {
	const message = update.message;
	if (!message || message.case === undefined) return;
	const output = state.output;
	switch (message.case) {
		case "textDelta": {
			state.sawProgress = true;
			const last = state.blocks[state.blocks.length - 1];
			const index = last?.type === "text" ? state.blocks.length - 1 : state.blocks.length;
			const block: Block =
				last?.type === "text"
					? (last as Block)
					: (() => {
							const newBlock: Block = { type: "text", text: "", index };
							state.blocks.push(newBlock);
							output.content.push(newBlock);
							state.stream.push({ type: "text_start", contentIndex: index, partial: output });
							return newBlock;
						})();
			(block as Block & { text: string }).text += message.value.text;
			state.stream.push({ type: "text_delta", contentIndex: index, delta: message.value.text, partial: output });
			break;
		}
		case "thinkingDelta": {
			state.sawProgress = true;
			const last = state.blocks[state.blocks.length - 1];
			const index = last?.type === "thinking" ? state.blocks.length - 1 : state.blocks.length;
			const block: Block =
				last?.type === "thinking"
					? (last as Block)
					: (() => {
							const newBlock: Block = { type: "thinking", thinking: "", index };
							state.blocks.push(newBlock);
							output.content.push(newBlock);
							state.stream.push({ type: "thinking_start", contentIndex: index, partial: output });
							return newBlock;
						})();
			(block as Block & { thinking: string }).thinking += message.value.text;
			state.stream.push({ type: "thinking_delta", contentIndex: index, delta: message.value.text, partial: output });
			break;
		}
		case "tokenDelta": {
			if (message.value.tokens > 0) {
				state.sawTokenDelta = true;
				state.sawProgress = true;
				output.usage.output += message.value.tokens;
				output.usage.totalTokens =
					output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
			}
			break;
		}
		case "heartbeat":
			break;
		case "turnEnded":
			state.sawTurnEnded = true;
			break;
		case "toolCallStarted": {
			state.sawProgress = true;
			const callId = message.value.callId || `${toolCallStates.size}`;
			toolCallStates.set(callId, { name: cursorToolName(message.value.toolCall), argsText: "" });
			break;
		}
		case "partialToolCall": {
			state.sawProgress = true;
			const call = toolCallStates.get(message.value.callId);
			if (call) call.argsText += message.value.argsTextDelta;
			break;
		}
		case "toolCallDelta": {
			const call = toolCallStates.get(message.value.callId);
			const delta = message.value.toolCallDelta?.delta;
			if (call && delta && delta.case === "shellToolCallDelta") {
				const shellDelta = delta.value as { streamContents?: string };
				if (shellDelta.streamContents) call.argsText += shellDelta.streamContents;
			}
			break;
		}
		case "toolCallCompleted": {
			const callId = message.value.callId;
			const call = toolCallStates.get(callId);
			if (call) {
				toolCallStates.delete(callId);
				const args = parseStreamingJson<Record<string, unknown>>(call.argsText) ?? {};
				const index = state.blocks.length;
				const block: Block = { type: "toolCall", id: callId, name: call.name, arguments: args, index };
				state.blocks.push(block);
				output.content.push(block);
				state.stream.push({ type: "toolcall_start", contentIndex: index, partial: output });
				state.stream.push({
					type: "toolcall_end",
					contentIndex: index,
					toolCall: block as unknown as ToolCall,
					partial: output,
				});
			}
			break;
		}
		default:
			break;
	}
}

function sendHeartbeat(h2Stream: http2.ClientHttp2Stream): void {
	const envelope = create(AgentClientMessageSchema, {
		message: { case: "clientHeartbeat", value: create(ClientHeartbeatSchema, {}) },
	});
	h2Stream.write(frameConnectMessage(toBinary(AgentClientMessageSchema, envelope)));
}

/** Build the normalized Run request (client frame payload) for a turn. */
function buildRunRequest(
	model: Model<"cursor-agent">,
	context: Context,
	options: CursorAgentOptions | undefined,
): {
	requestBytes: Uint8Array;
	blobStore: Map<string, Uint8Array>;
	userText: string;
} {
	const state: CursorStreamState = {
		output: emptyAssistantMessage(model),
		stream: new AssistantMessageEventStream(),
		blocks: [],
		blobStore: new Map(),
		sawTurnEnded: false,
		sawTokenDelta: false,
		sawProgress: false,
	};

	const systemPromptIds = buildCursorSystemPromptJsons(context.systemPrompt).map((json) =>
		storeCursorBlob(state, new TextEncoder().encode(json)),
	);

	const lastIndex = context.messages.length - 1;
	const lastMessage = context.messages[lastIndex];
	const activeUser = lastMessage?.role === "user" ? lastMessage : undefined;

	const userText = activeUser ? messageText(activeUser) : "";
	const hasUserContent = userText.trim().length > 0;

	const action = create(ConversationActionSchema, {
		action:
			hasUserContent && activeUser
				? {
						case: "userMessageAction",
						value: create(UserMessageActionSchema, {
							userMessage: create(UserMessageSchema, {
								text: userText,
								messageId: deterministicUuid(
									`u:${lastIndex}:${createHash("sha256").update(userText).digest("hex")}`,
								),
								mode: 4,
							}),
						}),
					}
				: { case: "resumeAction", value: create(ResumeActionSchema, {}) },
	});

	const rootPromptMessagesJson = buildPromptBlobs(state, context, systemPromptIds, activeUser ? lastIndex : -1);

	const conversationState = create(ConversationStateStructureSchema, {
		rootPromptMessagesJson,
		turns: [],
		todos: [],
		pendingToolCalls: [],
		previousWorkspaceUris: [],
		fileStates: {},
		fileStatesV2: {},
		summaryArchives: [],
		turnTimings: [],
		subagentStates: {},
		selfSummaryCount: 0,
		readPaths: [],
	});

	const wireModelId = options?.wireModelId ?? model.id;
	const { id: collapsedId, params } = collapseCursorWireModel(wireModelId);
	const maxMode = isCursorMaxModeWireId(model.id);

	const modelDetails = create(ModelDetailsSchema, {
		modelId: collapsedId,
		displayModelId: model.id,
		displayName: model.name,
		...(maxMode ? { maxMode: true } : undefined),
	});
	const requestedModel = create(RequestedModelSchema, {
		modelId: collapsedId,
		maxMode,
		parameters: params,
	});

	let runRequest = create(AgentRunRequestSchema, {
		conversationState,
		action,
		modelDetails,
		requestedModel,
		conversationId: options?.conversationId,
	});
	if (options?.customSystemPrompt !== undefined) {
		runRequest.customSystemPrompt = options.customSystemPrompt;
	}
	const replacement = options?.onPayload
		? (options.onPayload as (req: unknown) => unknown | Promise<unknown>)(runRequest)
		: undefined;
	if (replacement !== undefined) {
		runRequest = replacement as typeof runRequest;
	}

	const requestBytes = toBinary(
		AgentClientMessageSchema,
		create(AgentClientMessageSchema, {
			message: { case: "runRequest", value: runRequest },
		}),
	);

	return { requestBytes, blobStore: state.blobStore, userText };
}

/** Stream one Cursor agent turn; the terminal `done` carries the final message. */
export function streamCursorAgent(
	model: Model<"cursor-agent">,
	context: Context,
	options?: CursorAgentOptions,
): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	const output = emptyAssistantMessage(model);

	(async () => {
		let h2Request: http2.ClientHttp2Stream | null = null;
		let h2Session: http2.ClientHttp2Session | null = null;
		let heartbeatTimer: NodeJS.Timeout | undefined;
		let aborted = false;
		let endStreamError: Error | null = null;
		const sawTurnEnded = false;

		const abortListener = () => {
			aborted = true;
			if (h2Request) {
				try {
					h2Request.close();
				} catch {
					// already closed
				}
			}
		};

		try {
			const apiKey = options?.apiKey ?? process.env[CURSOR_ACCESS_TOKEN_ENV];
			if (!apiKey) {
				throw new ProviderResponseError(
					`No API key for provider: cursor. Set ${CURSOR_ACCESS_TOKEN_ENV} or log in with /login.`,
					{ provider: "cursor", kind: "runtime" },
				);
			}

			const { requestBytes, blobStore, userText } = buildRunRequest(model, context, options);
			const state: CursorStreamState = {
				output,
				stream,
				blocks: [],
				blobStore,
				sawTurnEnded: false,
				sawTokenDelta: false,
				sawProgress: false,
			};
			const toolCallStates = new Map<string, ToolCallStreamState>();

			const baseUrl = (model.baseUrl || CURSOR_API_BASE_URL).replace(/\/$/, "");
			const connection = connectCursorStream({
				baseUrl,
				apiKey,
				callerHeaders: options?.headers,
			});
			h2Session = connection.session;
			h2Request = connection.stream;
			options?.signal?.addEventListener("abort", abortListener, { once: true });

			// First frame: runRequest.
			h2Request.write(frameConnectMessage(requestBytes));

			// Heartbeat every 5s (env override for tests).
			const heartbeatMs = Number(process.env.CURSOR_HEARTBEAT_INTERVAL_MS) || CURSOR_HEARTBEAT_INTERVAL_MS;
			heartbeatTimer = setInterval(() => {
				if (!aborted && h2Request) sendHeartbeat(h2Request);
			}, heartbeatMs);

			output.usage.input = estimateInputTokens(context, userText, requestBytes.length);

			let endStreamErrorFromWire: { code: string; message: string } | undefined;

			h2Request.on("trailers", (trailers: Record<string, string>) => {
				const status = trailers["grpc-status"];
				const grpcMessage = trailers["grpc-message"];
				if (status && status !== "0") {
					try {
						endStreamError = new ProviderResponseError(
							`gRPC error ${status}: ${grpcMessage ? decodeURIComponent(grpcMessage) : ""}`,
							{ kind: "envelope", provider: "cursor" },
						);
					} catch {
						endStreamError = new ProviderResponseError(`gRPC error ${status}`, {
							kind: "envelope",
							provider: "cursor",
						});
					}
				}
			});

			h2Request.on("data", (chunk: Buffer) => {
				let offset = 0;
				while (offset + 5 <= chunk.length && !aborted) {
					const flags = chunk[offset];
					const length = chunk.readUInt32BE(offset + 1);
					if (offset + 5 + length > chunk.length) break;
					const payload = chunk.subarray(offset + 5, offset + 5 + length);
					offset += 5 + length;
					if (flags & CONNECT_END_STREAM_FLAG) {
						const parsed = parseConnectEndStream(new Uint8Array(payload));
						if (parsed) endStreamErrorFromWire = parsed;
						continue;
					}
					let serverMessage: AgentServerMessage;
					try {
						serverMessage = fromBinary(AgentServerMessageSchema, new Uint8Array(payload));
					} catch {
						continue;
					}
					handleServerMessageFrame(state, serverMessage, toolCallStates, h2Request!, h2Session!);
				}
			});

			const endPromise = new Promise<void>((resolve) => {
				h2Request!.on("end", () => resolve());
				h2Request!.on("error", (error) => {
					endStreamError = mapH2TransportError(error, baseUrl) as Error;
					resolve();
				});
			});
			await endPromise;

			if (aborted) {
				output.stopReason = "aborted";
				throw new ProviderResponseError("Request was aborted", { kind: "runtime", provider: "cursor" });
			}
			if (endStreamErrorFromWire) {
				throw new ProviderResponseError(
					`Connect error ${endStreamErrorFromWire.code}: ${endStreamErrorFromWire.message}`,
					{
						kind: "runtime",
						provider: "cursor",
					},
				);
			}
			if (endStreamError) throw endStreamError;
			if (!state.sawTurnEnded && !sawTurnEnded) {
				throw new ProviderResponseError("Cursor stream ended before turnEnded", {
					kind: "incomplete-stream",
					provider: "cursor",
				});
			}

			// Finalize: close any open text/thinking blocks, strip scratch fields, cost.
			for (const block of state.blocks) {
				if (block.index !== undefined) delete block.index;
			}
			output.usage.totalTokens =
				output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
			calculateCost(model, output.usage);

			stream.push({ type: "done", reason: output.stopReason as "stop" | "length" | "toolUse", message: output });
			stream.end();
		} catch (error) {
			for (const block of output.content) {
				delete (block as { index?: number }).index;
			}
			output.stopReason = aborted ? "aborted" : "error";
			output.errorMessage = formatStreamFailureMessage(error);
			recordStreamFailure(model, output, error);
			stream.push({ type: "error", reason: output.stopReason as "aborted" | "error", error: output });
			stream.end();
		} finally {
			if (heartbeatTimer) clearInterval(heartbeatTimer);
			options?.signal?.removeEventListener("abort", abortListener);
			if (h2Request) {
				try {
					h2Request.close();
				} catch {
					// already closed
				}
			}
			if (h2Session) {
				try {
					h2Session.close();
				} catch {
					// already closed
				}
			}
		}
	})();

	return stream;
}

/** Dispatch one server frame (mirrors omp handleServerMessage dispatch table). */
function handleServerMessageFrame(
	state: CursorStreamState,
	message: AgentServerMessage,
	toolCallStates: Map<string, ToolCallStreamState>,
	h2Request: http2.ClientHttp2Stream,
	h2Session: http2.ClientHttp2Session,
): void {
	const msg = message.message;
	if (!msg || msg.case === undefined) return;
	switch (msg.case) {
		case "interactionUpdate":
			processInteractionUpdate(state, msg.value, toolCallStates);
			break;
		case "kvServerMessage":
			handleKvServerMessage(state, h2Request, msg.value);
			break;
		case "interactionQuery":
			handleInteractionQuery(msg.value, h2Request);
			break;
		case "execServerMessage":
			replyExecNotImplemented(h2Request, msg.value);
			break;
		case "execServerControlMessage":
			break;
		case "conversationCheckpointUpdate":
			// Cache the server-echoed state for future resume; usage backfill for
			// context tokens is skipped (Prime Agent usage has no contextTokens).
			break;
		default:
			break;
	}
	void h2Session;
}

/** Cheap deterministic input token estimate (chars/4) so usage is non-zero pre-turn. */
function estimateInputTokens(context: Context, userText: string, requestBytes: number): number {
	const systemChars = (context.systemPrompt ?? "").length;
	const historyChars = context.messages.reduce(
		(sum, message) =>
			sum + (typeof message.content === "string" ? message.content.length : JSON.stringify(message.content).length),
		0,
	);
	return Math.ceil((systemChars + historyChars + userText.length + requestBytes) / 4);
}

/** Simple-options variant (used by extensions that do not need rich options). */
export function streamSimpleCursorAgent(
	model: Model<"cursor-agent">,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	return streamCursorAgent(model, context, buildBaseOptions(model, options));
}
