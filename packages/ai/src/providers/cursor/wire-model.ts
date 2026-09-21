// Ported from oh-my-pi (MIT License, https://github.com/can1357/oh-my-pi, (c) 2025 Mario Zechner, 2025-2026 Can Bölük, 2026 Stencil Labs, Inc.).
/**
 * Cursor wire-model resolution helpers — a pure TypeScript port (no protobuf
 * or catalog imports) of the oh-my-pi logic in
 * `catalog/src/compat/collapse.ts` (`isCursorMaxModeWireId`), the cursor
 * collapse vocabulary of `catalog/src/compat/taxonomy.ts`
 * (`collapseVariantId`) and `catalog/src/discovery/cursor.ts`
 * (normalization helpers), plus the Run-request model resolution of
 * `ai/src/providers/cursor.ts` (`resolveCursorWireModel`).
 *
 * The omp originals classify ids with the compiled KDL taxonomy; this module
 * re-encodes only the matchers that can fire for Cursor ids (claude/anthropic,
 * gemini, gpt/chatgpt/codex/o-series, kimi, grok/x-ai, glm) as small local
 * predicates so the helpers stay dependency-free.
 */

/**
 * User-facing thinking efforts, least to most intensive
 * (omp `catalog/src/effort.ts` `Effort`).
 */
export enum Effort {
	minimal = "minimal",
	low = "low",
	medium = "medium",
	high = "high",
	xhigh = "xhigh",
	max = "max",
}

/** Ordered effort ladder, least to most intensive (omp `THINKING_EFFORTS`). */
export const THINKING_EFFORTS: readonly Effort[] = [
	Effort.minimal,
	Effort.low,
	Effort.medium,
	Effort.high,
	Effort.xhigh,
	Effort.max,
];

/** Default context window for discovered Cursor models without a signal. */
export const CURSOR_DEFAULT_CONTEXT_WINDOW = 200_000;
/** Default output-token cap for discovered Cursor models. */
export const CURSOR_DEFAULT_MAX_TOKENS = 64_000;
/** Context window for Cursor SKUs that advertise the 1M ceiling. */
export const CURSOR_1M_CONTEXT_WINDOW = 1_000_000;
/** Id/display-name signal for 1M-context Cursor SKUs ("Opus 5 1M", "GPT-5.5 1M High"). */
export const CURSOR_1M_NAME_PATTERN = /\b1m\b/i;

/** `major.minor.patch` triple; omitted components are zero (4.6 ≡ 4.6.0). */
type CursorRevision = readonly [number, number, number];

/** One `rules.json` collapse-suffix rule, scoped to the cursor provider. */
interface CollapseSuffixRule {
	suffix: string;
	/** Effort tier the suffix encodes; absent for bare thinking suffixes. */
	effort?: Effort | "off";
	/** Suffix marks a thinking variant ("-thinking") rather than an effort tier. */
	thinking?: boolean;
	/** Bare ids starting with this prefix never collapse the suffix (qwen `-max`). */
	exceptBarePrefix?: string;
}

/**
 * The cursor provider's collapse vocabulary from the omp taxonomy.
 * Longest matching suffix wins regardless of list order.
 */
const CURSOR_COLLAPSE_SUFFIXES: readonly CollapseSuffixRule[] = [
	{ suffix: "-thinking", thinking: true },
	{ suffix: "-extra-high", effort: Effort.xhigh },
	{ suffix: "-none", effort: "off" },
	{ suffix: "-minimal", effort: Effort.minimal },
	{ suffix: "-medium", effort: Effort.medium },
	{ suffix: "-xhigh", effort: Effort.xhigh },
	{ suffix: "-high", effort: Effort.high },
	{ suffix: "-low", effort: Effort.low },
	{ suffix: "-max", effort: Effort.max, exceptBarePrefix: "qwen" },
];

/** The cursor service-lane suffix; effort tiers may ride inside the lane. */
const CURSOR_COLLAPSE_LANE_SUFFIX = "-fast";

/** What a Cursor wire id collapses to through the suffix vocabulary. */
interface CollapsedCursorVariant {
	/** Logical id after suffix collapse (original bytes preserved where possible). */
	logicalId: string;
	/** Effort tier collapsed out of the id, when it was an effort variant. */
	effort?: Effort | "off";
	/** Whether the id carried a thinking-variant suffix. */
	thinkingVariant: boolean;
}

/**
 * Collapses a Cursor effort/thinking suffix from a wire id. Faithful port of
 * `collapseVariantId("cursor", model)` from the omp taxonomy: longest suffix
 * wins, `-max` skips qwen parameter tokens, and the `-fast` service lane is
 * preserved on the logical id while its effort tier is decoded.
 */
function collapseCursorVariantId(model: string): CollapsedCursorVariant {
	const lower = model.toLowerCase();
	const bare = bareOf(lower);
	let winner: CollapseSuffixRule | undefined;
	for (const rule of CURSOR_COLLAPSE_SUFFIXES) {
		if (!lower.endsWith(rule.suffix)) continue;
		if (rule.exceptBarePrefix !== undefined && bare.startsWith(rule.exceptBarePrefix)) continue;
		if (winner === undefined || rule.suffix.length > winner.suffix.length) winner = rule;
	}
	if (winner !== undefined) {
		return {
			logicalId: model.slice(0, model.length - winner.suffix.length),
			effort: winner.effort,
			thinkingVariant: winner.thinking === true,
		};
	}
	// The `-fast` lane wraps effort tiers only (`gpt-5.2-codex-high-fast` →
	// base `gpt-5.2-codex-fast`, effort high); thinking variants never lane.
	if (lower.endsWith(CURSOR_COLLAPSE_LANE_SUFFIX)) {
		const trimmed = lower.slice(0, lower.length - CURSOR_COLLAPSE_LANE_SUFFIX.length);
		const trimmedBare = bareOf(trimmed);
		let effortRule: CollapseSuffixRule | undefined;
		for (const rule of CURSOR_COLLAPSE_SUFFIXES) {
			if (rule.effort === undefined || !trimmed.endsWith(rule.suffix)) continue;
			if (rule.exceptBarePrefix !== undefined && trimmedBare.startsWith(rule.exceptBarePrefix)) continue;
			if (effortRule === undefined || rule.suffix.length > effortRule.suffix.length) effortRule = rule;
		}
		if (effortRule !== undefined) {
			const base = model.slice(0, trimmed.length - effortRule.suffix.length);
			if (base && !base.endsWith("/")) {
				return {
					logicalId: `${base}${model.slice(trimmed.length)}`,
					effort: effortRule.effort,
					thinkingVariant: false,
				};
			}
		}
	}
	return { logicalId: model, thinkingVariant: false };
}

/**
 * Whether a Cursor wire id names an extended tier upstream serves only in max
 * mode. The omp taxonomy identifies the `xhigh`/`extra-high`/`max` efforts
 * (and their optional `-fast` lanes); this is an inference, not an upstream
 * marker, exactly like `isCursorMaxModeWireId` in omp's collapse module.
 */
export function isCursorMaxModeWireId(wireModelId: string): boolean {
	const effort = collapseCursorVariantId(wireModelId).effort;
	return effort === Effort.xhigh || effort === Effort.max;
}

/** Result of resolving a Cursor Run wire model id and its parameters. */
export interface CursorWireModelResolution {
	id: string;
	params: Array<{ id: string; value: string }>;
}

/**
 * Resolves the Cursor Run wire model id and parameter list for a selected
 * model id. Port of `resolveCursorWireModel` from omp's
 * `ai/src/providers/cursor.ts`:
 * - OpenAI-family effort siblings (`gpt-5.4-high`, `gpt-5.6-sol-none-fast`)
 *   split into the collapsed base id plus a `reasoning` effort parameter; the
 *   `off` tier (`-none`) normalizes to the bare base with no parameter.
 * - A bare `composer-2.5` id resolves to the Fast variant server-side, so the
 *   Standard tier is pinned with `{ id: "fast", value: "false" }`.
 * - Everything else (Claude/Gemini/Kimi/Grok/GLM siblings, `-fast` lanes,
 *   Cursor-native ids) passes through unchanged.
 */
export function collapseCursorWireModel(wireModelId: string): CursorWireModelResolution {
	const collapsed = collapseCursorVariantId(wireModelId);
	const effort = collapsed.effort;
	const base = effort !== undefined ? collapsed.logicalId : undefined;
	if (effort !== undefined && base !== undefined && isCursorOpenaiFamilyId(base)) {
		if (effort === "off") {
			return { id: base, params: [] };
		}
		if (THINKING_EFFORTS.includes(effort)) {
			return { id: base, params: [{ id: "reasoning", value: effort }] };
		}
	}
	if (wireModelId === "composer-2.5") {
		return { id: wireModelId, params: [{ id: "fast", value: "false" }] };
	}
	return { id: wireModelId, params: [] };
}

/** The id without any provider namespace ("anthropic/claude-x" → "claude-x"). */
function bareOf(id: string): string {
	const slash = id.lastIndexOf("/");
	return slash === -1 ? id : id.slice(slash + 1);
}

/** omp taxonomy `bounded` matcher: equality or a token boundary (`- _ . : 0-9`). */
function boundedMatch(value: string, token: string): boolean {
	if (value === token) return true;
	if (!value.startsWith(token)) return false;
	const next = value.charCodeAt(token.length);
	return next === 45 || next === 95 || next === 46 || next === 58 || (next >= 48 && next <= 57);
}

/** The omp taxonomy classes that can fire for Cursor ids. */
type CursorFamilyClass = "anthropic" | "gemini" | "openai" | "kimi" | "xai" | "glm" | "unknown";

/**
 * Local re-encoding of the omp taxonomy class matchers (`classifyModel`)
 * scoped to the Cursor id space: claude/anthropic, gemini, gpt/chatgpt/
 * codex/o-series (+ `openai` namespace), kimi (+ `moonshotai` namespace),
 * grok/cursor-grok (+ `x-ai`/`xai` namespaces), glm/zai-glm.
 */
function classifyCursorFamilyClass(model: string): CursorFamilyClass {
	const lower = model.trim().toLowerCase();
	const bare = bareOf(lower);
	if (
		bare === "o1" ||
		bare === "o3" ||
		bare === "o4" ||
		bare.startsWith("gpt-") ||
		bare.startsWith("chatgpt-") ||
		bare.startsWith("codex-") ||
		bare.startsWith("o1-") ||
		bare.startsWith("o1.") ||
		bare.startsWith("o3-") ||
		bare.startsWith("o3.") ||
		bare.startsWith("o4-") ||
		bare.startsWith("o4.") ||
		lower.split(/[/.:]/).some((part) => part === "openai")
	) {
		return "openai";
	}
	if (boundedMatch(bare, "claude") || boundedMatch(bare, "anthropic")) return "anthropic";
	if (boundedMatch(bare, "gemini")) return "gemini";
	if (boundedMatch(bare, "kimi") || lower.split("/").some((part) => part === "moonshotai")) return "kimi";
	if (boundedMatch(bare, "glm") || boundedMatch(bare, "zai-glm")) return "glm";
	if (
		bare.startsWith("cursor-grok-") ||
		boundedMatch(bare, "grok") ||
		lower.split(/[/.:]/).some((part) => part === "x-ai" || part === "xai")
	) {
		return "xai";
	}
	return "unknown";
}

/** Whether an id belongs to the OpenAI family (the only class that splits effort siblings). */
function isCursorOpenaiFamilyId(id: string): boolean {
	return classifyCursorFamilyClass(id) === "openai";
}

function parseComponent(value: string): number | undefined {
	if (!value) return undefined;
	let out = 0;
	for (let i = 0; i < value.length; i++) {
		const code = value.charCodeAt(i);
		if (code < 48 || code > 57) return undefined;
		out = out * 10 + (code - 48);
		if (out > 255) return undefined;
	}
	return out;
}

/**
 * Extracts a leading revision from an identifier tail that begins with a
 * digit (omp `parseRevisionPrefix`): up to three components separated by `.`
 * or by `-` followed by a digit (`"4-6-turbo"` → [4, 6, 0]). A component
 * whose digits run directly into a letter is a size token (`llama-3.3-70b`),
 * never a revision component.
 */
function parseCursorRevisionPrefix(value: string): CursorRevision | undefined {
	const out: [number, number, number] = [0, 0, 0];
	let count = 0;
	let index = 0;
	while (count < 3) {
		const start = index;
		while (index < value.length && value.charCodeAt(index) >= 48 && value.charCodeAt(index) <= 57) {
			index++;
		}
		const trailing = index < value.length ? value.charCodeAt(index) : 0;
		const isSizeToken = (trailing >= 97 && trailing <= 122) || (trailing >= 65 && trailing <= 90);
		const component = isSizeToken ? undefined : parseComponent(value.slice(start, index));
		if (component === undefined) return count > 0 ? out : undefined;
		out[count] = component;
		count++;
		const separator = value[index];
		if (separator === undefined) break;
		const next = value.charCodeAt(index + 1);
		if ((separator !== "." && separator !== "-") || !(next >= 48 && next <= 57)) break;
		index++;
	}
	return out;
}

/** Lexicographic triple comparison: negative, zero, or positive. */
function compareCursorRevisions(a: CursorRevision, b: CursorRevision): number {
	return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

/**
 * Revision extracted from a bare id via the omp per-class revision prefixes
 * that can fire for Cursor ids: `cursor-grok-`/`grok-` (xai, prefix-bound)
 * and `glm-` (glm, anywhere).
 */
function extractCursorRevision(bare: string): CursorRevision | undefined {
	for (const prefix of ["cursor-grok-", "grok-"]) {
		if (!bare.startsWith(prefix)) continue;
		const tail = bare.slice(prefix.length);
		const digit = tail.search(/[0-9]/);
		return digit === -1 ? undefined : parseCursorRevisionPrefix(tail.slice(digit));
	}
	const glmStart = bare.indexOf("glm-");
	if (glmStart !== -1) {
		const tail = bare.slice(glmStart + "glm-".length);
		const digit = tail.search(/[0-9]/);
		if (digit !== -1) {
			const revision = parseCursorRevisionPrefix(tail.slice(digit));
			if (revision !== undefined) return revision;
		}
	}
	return undefined;
}

/**
 * Whether a Cursor id names Kimi K3 (class kimi, family k3). K3 is a
 * reasoning model whose effort rides the sibling id, with no `thinkingDetails`
 * on the wire.
 */
export function isCursorKimiK3(id: string): boolean {
	if (classifyCursorFamilyClass(id) !== "kimi") return false;
	return bareOf(id.trim().toLowerCase()).includes("kimi-k3");
}

/**
 * Whether a Cursor id is a versioned Grok model at revision >= 4
 * (`cursor-grok-4.5`, `cursor-grok-4.6-high`, ...). The `grok-code-fast-*`
 * family classifies below the 4.x floor and stays out, exactly like omp.
 */
export function isCursorVersionedGrok(id: string): boolean {
	if (classifyCursorFamilyClass(id) !== "xai") return false;
	const revision = extractCursorRevision(bareOf(id.trim().toLowerCase()));
	if (revision === undefined) return false;
	return compareCursorRevisions(revision, [4, 0, 0]) >= 0;
}

/**
 * Natively 1M-context families Cursor serves without a "1M" label: GLM 5.2+
 * base/air/turbo coding SKUs. Structured family and revision gates exclude
 * vision/flash variants and sub-1M generations (omp `isCursorNative1MModelId`).
 */
export function isCursorNative1MModelId(id: string): boolean {
	if (classifyCursorFamilyClass(id) !== "glm") return false;
	const bare = bareOf(id.trim().toLowerCase());
	// omp glm family globs, priority order (vision wins, then flash/air/turbo).
	const family = bare.includes("glm-5v")
		? "vision"
		: bare.includes("flash")
			? "flash"
			: bare.includes("air")
				? "air"
				: bare.includes("turbo")
					? "turbo"
					: undefined;
	if (family !== undefined && family !== "air" && family !== "turbo") return false;
	const revision = extractCursorRevision(bare);
	if (revision === undefined) return false;
	return compareCursorRevisions(revision, [5, 2, 0]) >= 0;
}

/**
 * Context window for a discovered Cursor model: the 1M ceiling when any 1M
 * signal fires (never below the reference), else the reference. Signals:
 * a `1m` label on the id or any name field, a natively 1M family, or the
 * max-mode flag on Claude/Gemini ids (omp `resolveCursorContextWindow`).
 */
export function resolveCursorContextWindow(
	id: string,
	nameFields: string[],
	maxMode: boolean,
	referenceContext?: number,
): number {
	const labeled1M =
		CURSOR_1M_NAME_PATTERN.test(id) || nameFields.some((candidate) => CURSOR_1M_NAME_PATTERN.test(candidate));
	const familyClass = classifyCursorFamilyClass(id);
	const maxMode1M = maxMode && (familyClass === "anthropic" || familyClass === "gemini");
	if (labeled1M || isCursorNative1MModelId(id) || maxMode1M) {
		return Math.max(referenceContext ?? 0, CURSOR_1M_CONTEXT_WINDOW);
	}
	return referenceContext ?? 0;
}

/**
 * Resolves input modalities from a bundled reference when available. Without
 * a reference, families whose native catalogs are multimodal (anthropic,
 * gemini, openai) fall back to id classification (omp `resolveCursorInput`).
 */
export function resolveCursorInput(id: string, referenceInput?: ("text" | "image")[]): ("text" | "image")[] {
	if (referenceInput !== undefined) return referenceInput;
	const familyClass = classifyCursorFamilyClass(id);
	if (familyClass === "anthropic" || familyClass === "gemini" || familyClass === "openai") {
		return ["text", "image"];
	}
	return ["text"];
}

/**
 * Whether a discovered Cursor model reasons. The wire ships no
 * `thinkingDetails` for K3 or versioned Grok ids, so they are recovered from
 * the id; the bundled reference is the final fallback (omp `normalizeCursorModel`).
 */
export function resolveCursorReasoning(
	id: string,
	thinkingDetailsPresent: boolean,
	referenceReasoning?: boolean,
): boolean {
	return isCursorKimiK3(id) || isCursorVersionedGrok(id) || thinkingDetailsPresent || referenceReasoning === true;
}
