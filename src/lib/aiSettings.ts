/**
 * The AI settings: the author's OpenRouter key and chosen model (in the
 * synced `settings`, so every device of the book uses them), and this
 * device's cache of OpenRouter's model list.
 */
import { deleteSetting, getSetting, setSetting } from "./db";
import { fetchModels } from "./openrouter";
import { DEFAULT_ASSISTANT_MODEL, SETTING_KEYS } from "./settings";
import { parseJson, parseModelList, type ORModel } from "./schemas";

// Spec: AI-1, AI-5
export async function getApiKey(): Promise<string | null> {
  const key = await getSetting(SETTING_KEYS.openrouterApiKey);
  return key?.trim() ? key.trim() : null;
}

export async function saveApiKey(key: string): Promise<void> {
  await setSetting(SETTING_KEYS.openrouterApiKey, key.trim());
}

export async function removeApiKey(): Promise<void> {
  await deleteSetting(SETTING_KEYS.openrouterApiKey);
}

// Spec: AI-5
/** The assistant's model: the author's choice, else the default. */
export async function getAssistantModel(): Promise<string> {
  const model = await getSetting(SETTING_KEYS.assistantModel);
  return model?.trim() ? model.trim() : DEFAULT_ASSISTANT_MODEL;
}

export async function saveAssistantModel(id: string): Promise<void> {
  await setSetting(SETTING_KEYS.assistantModel, id);
}

export interface CachedModels {
  models: ORModel[];
  /** When the list was fetched (ISO), or null. */
  at: string | null;
}

// Spec: AI-2
/** The model list as last fetched on this device; empty when never fetched. */
export async function loadCachedModels(): Promise<CachedModels> {
  const [raw, at] = await Promise.all([
    getSetting(SETTING_KEYS.modelsCache),
    getSetting(SETTING_KEYS.modelsCacheAt),
  ]);
  let models: ORModel[] = [];
  if (raw) {
    try {
      models = parseModelList(parseJson(raw)) ?? [];
    } catch {
      models = [];
    }
  }
  return { models, at };
}

// Spec: AI-2
/** Fetches the live list from OpenRouter and keeps it as this device's cache. */
export async function refreshModels(): Promise<CachedModels> {
  const models = await fetchModels();
  const at = new Date().toISOString();
  await setSetting(SETTING_KEYS.modelsCache, JSON.stringify(models));
  await setSetting(SETTING_KEYS.modelsCacheAt, at);
  return { models, at };
}
