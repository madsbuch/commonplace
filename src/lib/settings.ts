/** Keys of the `settings` (synced) and `device_settings` (this device only) tables. */
export const SETTING_KEYS = {
  // Spec: AI-1, AI-5
  openrouterApiKey: "openrouter_api_key",
  /** The model the assistant uses; absent = `DEFAULT_ASSISTANT_MODEL`. */
  assistantModel: "assistant_model",
  /** OpenRouter's model list as last fetched, and when (this device only). */
  modelsCache: "models_cache",
  modelsCacheAt: "models_cache_at",
  /** The page last open, to reopen on start (this device only). */
  lastPage: "last_page",
} as const;

// Spec: SYN-15
/** Keys that belong to one device and never sync. */
export const DEVICE_SETTING_KEYS: ReadonlySet<string> = new Set<string>([
  SETTING_KEYS.modelsCache,
  SETTING_KEYS.modelsCacheAt,
  SETTING_KEYS.lastPage,
]);

export const DEFAULT_ASSISTANT_MODEL = "anthropic/claude-sonnet-4.5";
