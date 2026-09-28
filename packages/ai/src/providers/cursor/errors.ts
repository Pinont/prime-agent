export type ProviderResponseErrorKind =
	| "incomplete-stream"
	| "output"
	| "empty-body"
	| "empty-output"
	| "envelope"
	| "content-blocked"
	| "runtime";

/**
 * Minimal port of oh-my-pi's provider error classes (MIT, attributed).
 * Prime Agent normalizes provider failures through stream-failure.ts, so these
 * classes only need to carry stable messages and kind classifications used by
 * the cursor transport and retry logic.
 */
export class ProviderResponseError extends Error {
	readonly provider?: string;
	readonly kind: ProviderResponseErrorKind;
	readonly status?: number;
	readonly requestId?: string;

	constructor(
		message: string,
		options: {
			provider?: string;
			kind?: ProviderResponseErrorKind;
			status?: number;
			requestId?: string;
		} = {},
	) {
		super(message);
		this.name = "ProviderResponseError";
		this.provider = options.provider;
		this.kind = options.kind ?? "runtime";
		this.status = options.status;
		this.requestId = options.requestId;
	}
}

export class MissingApiKeyError extends Error {
	readonly provider: string | undefined;
	constructor(provider?: string, message?: string) {
		super(message ?? (provider ? `No API key for provider: ${provider}` : "No API key available"));
		this.name = "MissingApiKeyError";
		this.provider = provider;
	}
}

export class AbortError extends Error {
	constructor(message = "Request was aborted", options?: { cause?: unknown }) {
		super(message, options?.cause === undefined ? undefined : { cause: options.cause });
		this.name = "AbortError";
	}
}

export class ValidationError extends Error {
	constructor(message: string, options?: { cause?: unknown }) {
		super(message, options?.cause === undefined ? undefined : { cause: options.cause });
		this.name = "ValidationError";
	}
}
