import { describeModel } from "../model-presentation.js";

export function formatStatusBarModelName(
  provider: string | undefined,
  model: string | undefined,
): string {
  const safeProvider = String(provider ?? "").trim();
  const safeModel = String(model ?? "").trim();

  if (!safeProvider && !safeModel) return "";
  if (!safeProvider) {
    return safeModel
      ? describeModel({
        providerId: "unknown",
        selectionKey: safeModel,
        modelId: safeModel,
      }).modelLabel
      : "";
  }

  return describeModel({
    providerId: safeProvider,
    selectionKey: safeModel || safeProvider,
    modelId: safeModel || safeProvider,
  }).compactScopedLabel;
}
