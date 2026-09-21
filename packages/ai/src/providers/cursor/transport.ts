// Ported from oh-my-pi (MIT License, https://github.com/can1357/oh-my-pi,
// (c) 2025 Mario Zechner, 2025-2026 Can Bölük, 2026 Stencil Labs, Inc.).
// HTTP/2 Connect transport for Cursor's AgentService (agent.v1).

import { randomUUID } from "node:crypto";
import http2 from "node:http2";
import { ProviderResponseError } from "./errors.js";

/** Run RPC base URL (also used by discovery and usage). */
export const CURSOR_API_URL = "https://api2.cursor.sh";
/** x-cursor-client-version stamp Cursor enforces/evolves. */
export const CURSOR_CLIENT_VERSION = "cli-2026.07.23-e383d2b";
export const CURSOR_RUN_PATH = "/agent.v1.AgentService/Run";

/** Connect protocol: 1 flag byte + 4 byte big-endian length + payload. */
export const CONNECT_END_STREAM_FLAG = 0b00000010;
export const CURSOR_HEARTBEAT_INTERVAL_MS = 5_000;

export const RESOURCE_EXHAUSTED_PATTERN = /resource.?exhausted/i;
export const CURSOR_MODEL_NOT_FOUND_PATTERN = /^(?:Connect error not_found:|gRPC error 5:)/i;

/** Frame a Connect message: [flags][uint32BE length][payload]. */
export function frameConnectMessage(data: Uint8Array, flags = 0): Buffer {
	const frame = Buffer.alloc(5 + data.length);
	frame[0] = flags;
	frame.writeUInt32BE(data.length, 1);
	frame.set(data, 5);
	return frame;
}

/** Parse an end-stream (flag bit 1) payload: Connect JSON error envelope. */
export function parseConnectEndStream(data: Uint8Array): { code: string; message: string } | null {
	try {
		const envelope = JSON.parse(Buffer.from(data).toString("utf8")) as {
			error?: { code?: string; message?: string };
		};
		const error = envelope.error;
		if (error && typeof error.code === "string") {
			return { code: error.code, message: typeof error.message === "string" ? error.message : "" };
		}
	} catch {
		// not a JSON envelope; treat as end-of-stream without error details
	}
	return null;
}

const HTTP2_FORBIDDEN_HEADERS = new Set([
	"connection",
	"keep-alive",
	"proxy-connection",
	"transfer-encoding",
	"upgrade",
	"http2-settings",
]);

const CURSOR_RESERVED_HEADERS = new Set([
	"content-type",
	"connect-protocol-version",
	"te",
	"authorization",
	"x-ghost-mode",
	"x-cursor-client-version",
	"x-cursor-client-type",
	"x-request-id",
	"host",
	"content-length",
]);

/** Drop pseudo-headers and HTTP/2-forbidden/reserved headers from caller input. */
export function sanitizeCursorCallerHeaders(headers: Record<string, string> | undefined): Record<string, string> {
	if (!headers) return {};
	const clean: Record<string, string> = {};
	for (const [key, value] of Object.entries(headers)) {
		if (key.startsWith(":")) continue;
		const lower = key.toLowerCase();
		if (HTTP2_FORBIDDEN_HEADERS.has(lower) || CURSOR_RESERVED_HEADERS.has(lower)) continue;
		clean[key] = value;
	}
	return clean;
}

export interface CursorConnectOptions {
	baseUrl: string;
	apiKey: string;
	clientVersion?: string;
	callerHeaders?: Record<string, string>;
}

/** Established HTTP/2 session, open request stream, and frame writer. */
export interface CursorConnection {
	session: http2.ClientHttp2Session;
	stream: http2.ClientHttp2Stream;
	/** Write a Connect-framed protobuf payload (flags 0 by default). */
	send(data: Uint8Array, flags?: number): void;
}

/** Open the bi-directional Run stream over HTTP/2 (the service rejects HTTP/1). */
export function connectCursorStream(options: CursorConnectOptions): CursorConnection {
	const session = http2.connect(options.baseUrl);
	const headers: Record<string, string> = {
		":method": "POST",
		":path": CURSOR_RUN_PATH,
		"content-type": "application/connect+proto",
		"connect-protocol-version": "1",
		te: "trailers",
		authorization: `Bearer ${options.apiKey}`,
		"x-ghost-mode": "true",
		"x-cursor-client-version": options.clientVersion ?? CURSOR_CLIENT_VERSION,
		"x-cursor-client-type": "cli",
		"x-request-id": randomUUID(),
		...sanitizeCursorCallerHeaders(options.callerHeaders),
	};
	const stream = session.request(headers);
	stream.setTimeout(0);
	return {
		session,
		stream,
		send(data: Uint8Array, flags = 0) {
			stream.write(frameConnectMessage(data, flags));
		},
	};
}

/**
 * Map Bun/Node HTTP/2 failure modes to actionable errors (ALPN-stripping
 * proxies advertise h2c but reject h2, etc.).
 */
export function mapH2TransportError(error: unknown, baseUrl: string): unknown {
	if (error instanceof Error && /h2 is not supported|ERR_HTTP2_ERROR|UNSUPPORTED_PROTOCOL/i.test(error.message)) {
		return new ProviderResponseError(
			`Cursor requires HTTP/2, but the connection to ${baseUrl} could not negotiate h2. ` +
				`Disable any HTTP/2-stripping proxy for this host or set CURSOR_API_URL to a direct endpoint.`,
			{ kind: "runtime", provider: "cursor" },
		);
	}
	return error;
}

/** Incremental Connect frame reader over an HTTP/2 stream data callback. */
export class ConnectFrameReader {
	private buffer = Buffer.alloc(0);
	private readonly frames: { data: Buffer; flags: number }[] = [];
	private waited: (() => void)[] = [];
	private closed = false;

	push(chunk: Buffer): void {
		this.buffer = Buffer.concat([this.buffer, chunk]);
		this.drain();
	}

	/** Pop the next complete frame; resolves when one arrives or the reader closes. */
	next(): Promise<{ data: Buffer; flags: number } | null> {
		if (this.frames.length === 0 && !this.closed) {
			return new Promise((resolve) => this.waited.push(() => resolve(this.frames.shift() ?? null)));
		}
		return Promise.resolve(this.frames.shift() ?? null);
	}

	private drain(): void {
		while (this.buffer.length >= 5) {
			const flags = this.buffer[0];
			const length = this.buffer.readUInt32BE(1);
			if (this.buffer.length < 5 + length) return;
			const payload = this.buffer.subarray(5, 5 + length);
			this.buffer = this.buffer.subarray(5 + length);
			this.frames.push({ data: Buffer.from(payload), flags });
			const waiter = this.waited.shift();
			if (waiter) waiter();
		}
	}

	end(): void {
		this.closed = true;
		for (const waiter of this.waited.splice(0)) waiter();
	}
}
