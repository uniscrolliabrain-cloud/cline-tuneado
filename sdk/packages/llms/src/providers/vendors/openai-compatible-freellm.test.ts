import {
	OPENROUTER_BASE_URL,
	OPENROUTER_FALLBACK_MODEL_ID,
} from "@cline/shared";
import { describe, expect, it, vi } from "vitest";
import { BUILTIN_SPECS } from "../builtins";
import { getModelsForProvider } from "../model-registry";
import {
	createFreeLlmFallbackFetch,
	rewriteUrlToOpenRouter,
} from "./openai-compatible";

const FREELLM_BASE_URL = "http://127.0.0.1:31415";

describe("freellmapi builtin registration", () => {
	it("registers the provider with the local base URL, 'auto' model and model source", () => {
		const spec = BUILTIN_SPECS.find((entry) => entry.id === "freellmapi");
		expect(spec).toBeDefined();
		expect(spec?.family).toBe("openai-compatible");
		expect(spec?.defaults?.baseUrl).toBe(FREELLM_BASE_URL);
		expect(spec?.defaultModelId).toBe("auto");
		expect(spec?.apiKeyEnv).toContain("FREELLM_API_KEY");
		expect(spec?.modelsSourceUrl).toBe(`${FREELLM_BASE_URL}/v1/models`);
	});

	it("exposes 'auto' as a known model", async () => {
		const models = await getModelsForProvider("freellmapi");
		expect(models["auto"]).toBeDefined();
	});
});

describe("rewriteUrlToOpenRouter", () => {
	it("routes chat completions onto OpenRouter's /api/v1 base", () => {
		const url = rewriteUrlToOpenRouter(
			`${FREELLM_BASE_URL}/v1/chat/completions`,
		);
		expect(url.href).toBe(`${OPENROUTER_BASE_URL}/chat/completions`);
	});

	it("routes /v1/models onto OpenRouter's /api/v1/models", () => {
		const url = rewriteUrlToOpenRouter(`${FREELLM_BASE_URL}/v1/models`);
		expect(url.href).toBe(`${OPENROUTER_BASE_URL}/models`);
	});

	it("preserves query strings", () => {
		const url = rewriteUrlToOpenRouter(
			`${FREELLM_BASE_URL}/v1/chat/completions?foo=1&bar=baz`,
		);
		expect(url.search).toBe("?foo=1&bar=baz");
	});
});

describe("createFreeLlmFallbackFetch", () => {
	it("returns the same fetch when no OpenRouter key is set", () => {
		const primary = vi.fn(async () => new Response("ok"));
		const wrapped = createFreeLlmFallbackFetch({
			fetch: primary,
			openRouterApiKey: undefined,
			fallbackModelId: OPENROUTER_FALLBACK_MODEL_ID,
		});
		expect(wrapped).toBe(primary);
	});

	it("passes the primary response through when the local server responds", async () => {
		const primary = vi.fn(async () => new Response("local"));
		const wrapped = createFreeLlmFallbackFetch({
			fetch: primary,
			openRouterApiKey: "sk-or-test",
			fallbackModelId: OPENROUTER_FALLBACK_MODEL_ID,
		});
		const response = await wrapped(`${FREELLM_BASE_URL}/v1/chat/completions`, {
			method: "POST",
			headers: {
				authorization: "Bearer local-key",
				"content-type": "application/json",
			},
			body: JSON.stringify({ model: "auto", messages: [] }),
		});
		expect(await response.text()).toBe("local");
		expect(primary).toHaveBeenCalledTimes(1);
	});

	it("falls back to OpenRouter when the local server is unreachable", async () => {
		const calls: Array<{ url: string; init?: RequestInit }> = [];
		const primary = vi.fn(
			async (input: Request | string, init?: RequestInit) => {
				calls.push({
					url: typeof input === "string" ? input : input.url,
					init,
				});
				if (calls.length === 1) {
					throw new TypeError("fetch failed", {
						cause: new Error("connect ECONNREFUSED 127.0.0.1:31415"),
					});
				}
				return new Response("openrouter");
			},
		);
		const wrapped = createFreeLlmFallbackFetch({
			fetch: primary,
			openRouterApiKey: "sk-or-test",
			fallbackModelId: OPENROUTER_FALLBACK_MODEL_ID,
		});
		const response = await wrapped(
			`${FREELLM_BASE_URL}/v1/chat/completions`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					model: "auto",
					messages: [{ role: "user", content: "hi" }],
				}),
			},
		);
		expect(await response.text()).toBe("openrouter");
		expect(primary).toHaveBeenCalledTimes(2);

		const fallbackCall = calls[1];
		expect(fallbackCall.url).toBe(`${OPENROUTER_BASE_URL}/chat/completions`);
		const headers = new Headers(fallbackCall.init?.headers);
		expect(headers.get("authorization")).toBe("Bearer sk-or-test");
		const body = JSON.parse(String(fallbackCall.init?.body ?? "")) as {
			model?: string;
		};
		expect(body.model).toBe(OPENROUTER_FALLBACK_MODEL_ID);
	});

	it("does not fall back when the failure is not a network error", async () => {
		const primary = vi.fn(async () => {
			throw new Error("502 Bad Gateway");
		});
		const wrapped = createFreeLlmFallbackFetch({
			fetch: primary,
			openRouterApiKey: "sk-or-test",
			fallbackModelId: OPENROUTER_FALLBACK_MODEL_ID,
		});
		await expect(
			wrapped(`${FREELLM_BASE_URL}/v1/chat/completions`, {
				method: "POST",
			}),
		).rejects.toThrow("502 Bad Gateway");
		expect(primary).toHaveBeenCalledTimes(1);
	});
});