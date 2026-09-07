/**
 * Default loop detection thresholds for the CLI.
 * The agent core leaves loop detection off by default;
 * the CLI enables it with these settings.
 */
export const CLI_DEFAULT_LOOP_DETECTION = {
	softThreshold: 3,
	hardThreshold: 5,
} as const;

/**
 * Default checkpoint configuration for the CLI.
 * Core leaves checkpoints disabled by default (opt-in);
 * the CLI enables them so every run gets a restorable git snapshot.
 */
export const CLI_DEFAULT_CHECKPOINT_CONFIG = {
	enabled: true,
} as const;

// Provider/model por defecto del CLI. FreeLLMAPI (local) es el primario; si el
// localhost no responde, el SDK hace fallback automático a OpenRouter.
export { DEFAULT_API_PROVIDER as CLI_DEFAULT_API_PROVIDER } from "@cline/shared";
export { FREELLM_DEFAULT_MODEL_ID as CLI_DEFAULT_MODEL_ID } from "@cline/shared";
