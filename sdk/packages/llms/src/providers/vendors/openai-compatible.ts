import { createGateway } from "@ai-sdk/gateway";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModelV4 } from "@ai-sdk/provider";
import type {
	GatewayProviderContext,
	GatewayResolvedProviderConfig,
} from "@cline/shared";
import { modelProducesImages } from "@cline/shared";
import {
	FREELLM_API_KEY,
	FREELLM_BASE_URL,
	OPENROUTER_API_KEY_ENV,
	OPENROUTER_BASE_URL,
	OPENROUTER_FALLBACK_MODEL_ID,
} from "@cline/shared";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { wrapLanguageModel } from "ai";
import { ensureFetch, resolveApiKey } from "../http";
import { splitToolImagesMiddleware } from "../middleware/split-tool-images";
import { isOpenAIReasoningEraModelId } from "../model-facts";
import type { ProviderFactoryResult } from "./types";

type FetchInput = Parameters<typeof fetch>[0];
type FetchWithOptionalPreconnect = typeof fetch & {
	preconnect?: (...args: unknown[]) => unknown;
};

function trimTrailingSlashes(value: string): string {
	let end = value.length;
	while (end > 0 && value.charCodeAt(end - 1) === 47) {
		end -= 1;
	}
	return value.slice(0, end);
}

function readAzureApiVersion(
	config: GatewayResolvedProviderConfig,
): string | undefined {
	const apiVersion = config.options?.apiVersion;
	if (typeof apiVersion !== "string") {
		return undefined;
	}
	const trimmed = apiVersion.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function shouldAddAzureApiVersion(url: URL): boolean {
	return (
		url.pathname.startsWith("/openai/deployments/") &&
		!url.searchParams.has("api-version")
	);
}

function withAzureApiVersion(
	input: FetchInput,
	apiVersion: string,
): FetchInput {
	let url: URL;
	try {
		url = new URL(input instanceof Request ? input.url : input.toString());
	} catch {
		return input;
	}
	if (!shouldAddAzureApiVersion(url)) {
		return input;
	}
	url.searchParams.set("api-version", apiVersion);
	if (input instanceof Request) {
		return new Request(url.toString(), input);
	}
	return (typeof input === "string" ? url.toString() : url) as FetchInput;
}

function createAzureApiVersionFetch(
	config: GatewayResolvedProviderConfig,
): typeof fetch | undefined {
	const apiVersion = readAzureApiVersion(config);
	if (!apiVersion) {
		return config.fetch;
	}
	const baseFetch = config.fetch ?? globalThis.fetch;
	if (!baseFetch) {
		return config.fetch;
	}
	const azureFetch = ((input, init) =>
		baseFetch(withAzureApiVersion(input, apiVersion), init)) as typeof fetch;
	const baseFetchWithPreconnect = baseFetch as FetchWithOptionalPreconnect;
	(azureFetch as FetchWithOptionalPreconnect).preconnect =
		typeof baseFetchWithPreconnect.preconnect === "function"
			? baseFetchWithPreconnect.preconnect.bind(baseFetch)
			: () => undefined;
	return azureFetch;
}

type ResponseErrorHandler = (response: Response) => Promise<void> | void;

function resolveVercelGatewayImageBaseUrl(
	baseUrl: string | undefined,
): string | undefined {
	if (!baseUrl) return undefined;
	try {
		const url = new URL(baseUrl);
		if (
			url.hostname === "ai-gateway.vercel.sh" &&
			trimTrailingSlashes(url.pathname) === "/v1"
		) {
			// The provider's generic OpenAI-compatible endpoint is not the AI SDK
			// Gateway endpoint. Let @ai-sdk/gateway select its current versioned
			// `/ai` base instead of producing `/v1/image-model`.
			return undefined;
		}
		return trimTrailingSlashes(url.toString());
	} catch {
		return baseUrl;
	}
}

function readResponseErrorHandler(
	config: GatewayResolvedProviderConfig,
): ResponseErrorHandler | undefined {
	const handler = config.options?.onResponseError;
	return typeof handler === "function"
		? (handler as ResponseErrorHandler)
		: undefined;
}

function createResponseErrorFetch(input: {
	fetch: typeof fetch;
	onResponseError: ResponseErrorHandler;
}): typeof fetch {
	const responseErrorFetch = (async (requestInput, init) => {
		const response = await input.fetch(requestInput, init);

		await input.onResponseError(response);

		return response;
	}) as typeof fetch;

	const baseFetchWithPreconnect = input.fetch as FetchWithOptionalPreconnect;
	(responseErrorFetch as FetchWithOptionalPreconnect).preconnect =
		typeof baseFetchWithPreconnect.preconnect === "function"
			? baseFetchWithPreconnect.preconnect.bind(input.fetch)
			: () => undefined;
	return responseErrorFetch;
}

/**
 * OpenAI's chat-completions API rejects `max_tokens` for reasoning-era
 * models ("Unsupported parameter: 'max_tokens' is not supported with this
 * model. Use 'max_completion_tokens' instead."). Rename the parameter only
 * for model ids that require it: OpenAI, Azure OpenAI, and the major
 * OpenAI-compatible gateways (OpenRouter, LiteLLM) all accept
 * `max_completion_tokens`, while older third-party servers that only know
 * `max_tokens` do not serve o-series/gpt-5 model ids — so every other
 * request keeps its exact current wire format.
 */
export function withMaxCompletionTokensForReasoningModels(
	body: Record<string, unknown>,
): Record<string, unknown> {
	const { max_tokens: maxTokens, ...rest } = body;
	if (
		maxTokens == null ||
		typeof body.model !== "string" ||
		!isOpenAIReasoningEraModelId(body.model)
	) {
		return body;
	}
	return {
		...rest,
		// Keep an explicit `max_completion_tokens` passed via provider
		// options passthrough if one is already present.
		max_completion_tokens: rest.max_completion_tokens ?? maxTokens,
	};
}

function isOpenRouterImageGenerationRequest(input: FetchInput): boolean {
	try {
		const url = new URL(
			input instanceof Request ? input.url : input.toString(),
		);
		return trimTrailingSlashes(url.pathname).endsWith("/images");
	} catch {
		return false;
	}
}

export function createSuccessDataResponseFetch(
	baseFetch: typeof fetch,
): typeof fetch {
	const responseEnvelopeFetch = (async (requestInput, init) => {
		const response = await baseFetch(requestInput, init);
		if (!response.ok || !isOpenRouterImageGenerationRequest(requestInput)) {
			return response;
		}

		const text = await response.text();
		let unwrapped = text;
		try {
			const payload = JSON.parse(text) as unknown;
			if (
				payload &&
				typeof payload === "object" &&
				!Array.isArray(payload) &&
				"success" in payload &&
				payload.success === true &&
				"data" in payload
			) {
				unwrapped = JSON.stringify(payload.data);
			}
		} catch {
			// Recreate the original response below so consuming it for envelope
			// detection never changes provider behavior.
		}

		const headers = new Headers(response.headers);
		headers.delete("content-encoding");
		headers.delete("content-length");
		return new Response(unwrapped, {
			status: response.status,
			statusText: response.statusText,
			headers,
		});
	}) as typeof fetch;

	const baseFetchWithPreconnect = baseFetch as FetchWithOptionalPreconnect;
	(responseEnvelopeFetch as FetchWithOptionalPreconnect).preconnect =
		typeof baseFetchWithPreconnect.preconnect === "function"
			? baseFetchWithPreconnect.preconnect.bind(baseFetch)
			: () => undefined;
	return responseEnvelopeFetch;
}

/**
 * Best-effort env read (Node). Returns `undefined` in browsers/workers.
 */
function readProcessEnv(name: string): string | undefined {
	const value = globalThis.process?.env?.[name];
	if (typeof value !== "string") {
		return undefined;
	}
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * True only for transport-level failures (server unreachable, socket errors,
 * timeouts). A reachable server that answers 401/429/503 is NOT retryable
 * here — those errors surface to the user as-is instead of silently
 * switching to OpenRouter.
 */
function isRetryableNetworkError(error: unknown): boolean {
	if (!(error instanceof Error)) {
		return false;
	}
	const causeMessage =
		error.cause instanceof Error ? ` ${error.cause.message}` : "";
	const message = `${error.name}: ${error.message}${causeMessage}`.toLowerCase();
	return /fetch failed|networkerror|network error|econnrefused|econnreset|etimedout|socket hang up|tunnel connection failed|connection refused|connect econnrefused|undici|i\/o error|getaddrinfo|timeout/i.test(
		message,
	);
}

/**
 * Re-route a request from the local FreeLLMAPI base URL to OpenRouter's base
 * URL, splicing the path prefixes so `/chat/completions` and `/responses`
 * land on `https://openrouter.ai/api/v1/…`.
 */
export function rewriteUrlToOpenRouter(input: FetchInput): URL {
	const original = new URL(
		input instanceof Request ? input.url : input.toString(),
	);
	const secondary = new URL(OPENROUTER_BASE_URL);
	const secondaryPath = trimTrailingSlashes(secondary.pathname);
	// Strip the FreeLLM /v1/ prefix so that, e.g.,
	// /v1/chat/completions becomes /chat/completions before being joined
	// with OpenRouter's /api/v1 base.
	const rest = original.pathname.replace(/^\/?v1(?=\/|$)/, "");
	// Rebuild from a string instead of mutating the URL instance: mutating
	// `host`/`hostname` can leave the original port behind in some runtimes.
	return new URL(
		`${secondary.origin}${secondaryPath}${rest.startsWith("/") ? rest : `/${rest}`}${original.search}`,
	);
}

/**
 * Fetch wrapper for the `freellmapi` provider: tries the local server first
 * and, when it is unreachable (network-level error), retries the request
 * against OpenRouter with the OpenRouter API key and fallback model id.
 * Model-agnostic — it rewrites the URL, the Authorization header, and the
 * `model` field of JSON bodies, so streaming, tool calls, `/responses`, and
 * `/models` all keep working.
 */
export function createFreeLlmFallbackFetch(input: {
	fetch: typeof fetch;
	openRouterApiKey: string | undefined;
	fallbackModelId: string | undefined;
}): typeof fetch {
	const { fetch: primaryFetch, openRouterApiKey, fallbackModelId } = input;
	// Sin key de OpenRouter no hay fallback posible: usa el fetch original.
	if (!openRouterApiKey) {
		return primaryFetch;
	}

	const fallbackAwareFetch = (async (requestInput, init) => {
		try {
			return await primaryFetch(requestInput, init);
		} catch (primaryError) {
			if (!isRetryableNetworkError(primaryError)) {
				throw primaryError;
			}

			const url = rewriteUrlToOpenRouter(requestInput);
			const headers = new Headers(
				(init?.headers as Record<string, string> | undefined) ??
					(requestInput instanceof Request
						? requestInput.headers
						: undefined),
			);
			headers.set("authorization", `Bearer ${openRouterApiKey}`);
			let body = init?.body;
			if (requestInput instanceof Request && body === undefined) {
				body = await requestInput.clone().text();
			}
			if (typeof body === "string" && fallbackModelId) {
				try {
					const parsed = JSON.parse(body) as { model?: unknown };
					if (
						parsed &&
						typeof parsed === "object" &&
						typeof parsed.model === "string"
					) {
						parsed.model = fallbackModelId;
						body = JSON.stringify(parsed);
					}
				} catch {
					// Payload no JSON — se reenvía tal cual.
				}
			}
			return primaryFetch(url.toString(), {
				...init,
				method:
					init?.method ??
					(requestInput instanceof Request
						? requestInput.method
						: "GET"),
				headers,
				body,
				signal:
					init?.signal ??
					(requestInput instanceof Request
						? requestInput.signal
						: undefined),
			});
		}
	}) as typeof fetch;

	const primaryFetchWithPreconnect = primaryFetch as FetchWithOptionalPreconnect;
	(fallbackAwareFetch as FetchWithOptionalPreconnect).preconnect =
		typeof primaryFetchWithPreconnect.preconnect === "function"
			? primaryFetchWithPreconnect.preconnect.bind(primaryFetch)
			: () => undefined;
	return fallbackAwareFetch;
}

export async function createOpenAICompatibleProviderModule(
	config: GatewayResolvedProviderConfig,
	context: GatewayProviderContext,
): Promise<ProviderFactoryResult> {
	// Don't preflight-check for a missing API key. If credentials are
	// missing or wrong, the provider's own response (e.g. 401) is the
	// authoritative error and is surfaced to the user as-is. This keeps
	// `llms` unopinionated about which providers do or don't need a key.
	const isFreeLlmApi = context.provider.id === "freellmapi";
	const resolvedApiKey = await resolveApiKey(config);
	const apiKey = resolvedApiKey ?? (isFreeLlmApi ? FREELLM_API_KEY : undefined);
	const baseUrl =
		config.baseUrl ?? (isFreeLlmApi ? FREELLM_BASE_URL : undefined);
	const fetch = createAzureApiVersionFetch(config);
	const onResponseError = readResponseErrorHandler(config);
	const providerFetch = onResponseError
		? createResponseErrorFetch({
				fetch: ensureFetch(fetch),
				onResponseError,
			})
		: fetch;
	// FreeLLMAPI: si el localhost no responde (error de red/transporte), el
	// fallback re-envía la misma petición a la API de OpenRouter usando la key
	// de `process.env.OPENROUTER_API_KEY` y el modelo de fallback configurado.
	const effectiveFetch = isFreeLlmApi
		? createFreeLlmFallbackFetch({
				fetch: ensureFetch(providerFetch),
				openRouterApiKey: readProcessEnv(OPENROUTER_API_KEY_ENV),
				fallbackModelId: OPENROUTER_FALLBACK_MODEL_ID,
			})
		: providerFetch;
	const provider = createOpenAICompatible({
		name: context.provider.id,
		apiKey,
		...(baseUrl ? { baseURL: baseUrl } : {}),
		...(config.headers ? { headers: config.headers } : {}),
		...(effectiveFetch ? { fetch: effectiveFetch } : {}),
		includeUsage: true,
		transformRequestBody: withMaxCompletionTokensForReasoningModels,
	} as never);
	const useOpenRouterImageTransport =
		context.provider.metadata?.imageTransport === "openrouter" &&
		modelProducesImages(context.model);
	const openRouterFetch =
		context.provider.metadata?.responseEnvelope === "success-data"
			? createSuccessDataResponseFetch(ensureFetch(providerFetch))
			: providerFetch;
	const openRouterImageProvider = useOpenRouterImageTransport
		? createOpenRouter({
				apiKey,
				baseURL: config.baseUrl,
				headers: config.headers,
				fetch: openRouterFetch,
				compatibility:
					context.provider.id === "openrouter" ? "strict" : "compatible",
			})
		: undefined;
	const vercelGateway =
		context.provider.id === "vercel-ai-gateway"
			? createGateway({
					apiKey,
					baseURL: resolveVercelGatewayImageBaseUrl(config.baseUrl),
					headers: config.headers,
					fetch: providerFetch,
				})
			: undefined;
	return {
		// Wrap each constructed model with `splitToolImagesMiddleware` so
		// `role:"tool"` messages whose `output.type === 'content'` carries
		// image-data parts get split into a placeholder text + a synthetic
		// `role:"user"` message carrying the images. The OpenAI Chat
		// Completions wire format does NOT support multimodal tool messages
		// (the `@ai-sdk/openai-compatible` chat-messages converter
		// `JSON.stringify`s the parts array, losing image bytes). The
		// middleware operates on the typed `LanguageModelV4Prompt` BEFORE
		// the converter runs, so the converter sees only text-only tool
		// messages with adjacent multimodal user messages — the wire
		// pattern that classic Cline used in production for years (see
		// `convertToOpenAiMessages` in `src/core/api/transform/openai-format.ts`
		// on origin/main).
		operations: {
			language: (modelId) =>
				wrapLanguageModel({
					model: (openRouterImageProvider?.chat(modelId) ??
						provider(modelId)) as LanguageModelV4,
					middleware: splitToolImagesMiddleware,
				}),
			imageGeneration: (modelId) =>
				vercelGateway
					? vercelGateway.imageModel(modelId)
					: openRouterImageProvider
						? openRouterImageProvider.imageModel(modelId)
						: provider.imageModel(modelId),
		},
	};
}
