import { describe, expect, test } from "vitest";
import { customModelKey, normalizeCustomModelEndpoint } from "../src/core/custom-models.js";

describe("custom model endpoint validation", () => {
	test("preserves proxy paths while normalizing trailing slashes", () => {
		expect(normalizeCustomModelEndpoint("https://example.test/openai/v1///")).toBe("https://example.test/openai/v1");
	});
	test("rejects insecure and secret-bearing endpoints", () => {
		expect(() => normalizeCustomModelEndpoint("http://example.test/v1")).toThrow(
			/HTTP endpoints are allowed only for loopback/,
		);
		expect(() => normalizeCustomModelEndpoint("https://key@example.test/v1")).toThrow("credentials");
		expect(() => normalizeCustomModelEndpoint("https://example.test/v1?api_key=nope")).toThrow("secret");
	});
	test("permits explicit loopback development HTTP", () => {
		expect(normalizeCustomModelEndpoint("http://localhost:11434/v1/", { allowHttpLoopback: true })).toBe(
			"http://localhost:11434/v1",
		);
	});
	test("uses canonical provider/model keys", () => {
		expect(customModelKey("local", "my/model")).toBe("local/my/model");
	});
});
