import type { ManagedCreateSettings } from "nanocodex/managed";

type Model = ManagedCreateSettings["model"];
type Thinking = ManagedCreateSettings["thinking"];
export type AvailableModel = Readonly<{
  id: Model; name: string; provider: string; thinking: readonly Thinking[];
  fastMode: boolean; reasoningModes: readonly string[];
}>;
export type ModelCatalog = Readonly<{ models: readonly AvailableModel[]; defaultModel: Model | null }>;
const efforts = new Set(["none", "low", "medium", "high", "xhigh", "max"]);
export function decodeModelCatalog(value: unknown): ModelCatalog {
  if (!record(value) || value.object !== "list" || !Array.isArray(value.data)
    || value.data.length > 64 || !(value.default_model === null || typeof value.default_model === "string")) {
    throw new Error("Invalid available model response.");
  }
  const ids = new Set<string>();
  const models = value.data.map((model): AvailableModel => {
    if (!record(model) || typeof model.id !== "string" || !model.id || model.id.length > 128
      || ids.has(model.id) || typeof model.name !== "string" || !model.name || model.name.length > 128
      || typeof model.provider !== "string" || !model.provider || typeof model.fast_mode !== "boolean"
      || !Array.isArray(model.thinking) || !model.thinking.length || model.thinking.some(e => typeof e !== "string" || !efforts.has(e))
      || !Array.isArray(model.reasoning_modes) || !model.reasoning_modes.length
      || model.reasoning_modes.some(e => !["standard", "pro"].includes(e))) {
      throw new Error("Invalid available model response.");
    }
    ids.add(model.id);
    return { id: model.id as Model, name: model.name, provider: model.provider,
      thinking: model.thinking as Thinking[], fastMode: model.fast_mode, reasoningModes: model.reasoning_modes as string[] };
  });
  if (value.default_model !== null && !ids.has(value.default_model as string)) throw new Error("Invalid default model response.");
  return { models, defaultModel: value.default_model as Model | null };
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
