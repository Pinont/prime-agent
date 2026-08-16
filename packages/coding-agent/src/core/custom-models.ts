/** Utilities shared by custom model configuration and discovery. */

import type { Api } from "@earendil-works/pi-ai";

export const CUSTOM_MODEL_APIS = [
	"openai-completions",
	"openai-responses",
	"anthropic-messages",
] as const satisfies readonly Api[];

export type CustomModelApi = (typeof CUSTOM_MODEL_APIS)[number];

const SECRET_QUERY_PARAMETER = /(?:api[_-]?key|token|secret|password|credential)/i;

/**
 * Normalize an endpoint without changing an intentional reverse-proxy path.
 * Credentials and secret query strings are forbidden because endpoints are persisted.
 */
export function normalizeCustomModelEndpoint(value: string, options: { allowHttpLoopback?: boolean } = {}): string {
	const endpoint = value.trim();
	if (!endpoint || /[\u0000-\u001f\u007f]/.test(endpoint)) {
		throw new Error("Endpoint must be a non-empty URL without control characters.");
	}

	let url: URL;
	try {
		url = new URL(endpoint);
	} catch {
		throw new Error("Endpoint must be an absolute HTTP(S) URL.");
	}
	if (url.protocol !== "https:" && url.protocol !== "http:") {
		throw new Error("Endpoint must use HTTPS.");
	}
	const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
	if (url.protocol === "http:" && !(options.allowHttpLoopback && loopback)) {
		throw new Error("HTTP endpoints are allowed only for loopback development endpoints.");
	}
	if (url.username || url.password) {
		throw new Error("Endpoint URLs must not contain credentials.");
	}
	for (const key of url.searchParams.keys()) {
		if (SECRET_QUERY_PARAMETER.test(key)) throw new Error("Endpoint URLs must not contain secret query parameters.");
	}
	url.hash = "";
	url.pathname = url.pathname.replace(/\/+$/, "") || "/";
	return url.toString().replace(/\/$/, "");
}

export function isCustomModelApi(value: string): value is CustomModelApi {
	return (CUSTOM_MODEL_APIS as readonly string[]).includes(value);
}

export function customModelKey(provider: string, modelId: string): string {
	if (!provider.trim() || !modelId.trim() || /[\u0000-\u001f\u007f]/.test(provider + modelId)) {
		throw new Error("Provider and model ID must be non-empty and contain no control characters.");
	}
	return `${provider}/${modelId}`;
}
