/** Canonical default model for the Cline provider. */
export const CLINE_DEFAULT_MODEL_ID = "anthropic/claude-sonnet-5";

// ─── Provider por defecto: FreeLLMAPI (local) con fallback a OpenRouter ─────
//
// Cline arranca con el provider `freellmapi` (OpenAI-compatible, local).
// Si el servidor local no responde, el SDK hace fallback automático a
// OpenRouter leyendo la key de `process.env.OPENROUTER_API_KEY`.
//
// 👉 Para cambiar de servidor/key: edita las dos constantes siguientes.
export const FREELLM_BASE_URL = "http://127.0.0.1:31415";
export const FREELLM_API_KEY =
	"freellmapi-5a1153771ec1cd10eb5e1a176c0aca756df9e1a533ef1f17";
/**
 * Modelo por defecto de FreeLLMAPI. `"auto"` = el router local elige el mejor
 * modelo disponible de los que tengas configurados en tu dashboard.
 */
export const FREELLM_DEFAULT_MODEL_ID = "auto";

/** URL de la API oficial de OpenRouter (fallback). */
export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
/** Variable de entorno de la que OpenRouter lee su API key. */
export const OPENROUTER_API_KEY_ENV = "OPENROUTER_API_KEY";
/** Modelo de OpenRouter usado cuando el fallback se dispara. */
export const OPENROUTER_FALLBACK_MODEL_ID = "anthropic/claude-sonnet-5";

/** Provider por defecto de Cline cuando no hay configuración del usuario. */
export const DEFAULT_API_PROVIDER = "freellmapi";
