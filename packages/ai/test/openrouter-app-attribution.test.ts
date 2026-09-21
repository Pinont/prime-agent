import { expect, it } from "vitest";
import { getOpenRouterHeaders } from "../src/utils/openrouter-headers.js";

it("identifies Prime Agent with the required attribution headers", () => {
	expect(getOpenRouterHeaders()).toEqual({
		"HTTP-Referer": "https://github.com/PrimeIntellect-ai/prime-agent",
		"X-OpenRouter-Title": "Prime Agent",
		"X-OpenRouter-Categories": "cli-agent",
	});
});
