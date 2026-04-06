import { setDotenvKey } from "./dotenv.js";
import {
  detectManagedCredentialCandidates,
  getManagedCredentialSpec,
  hasManagedCredential,
} from "./managed-provider-credentials.js";
import { findProviderPreset } from "./provider-presets.js";

export interface PromptChoice {
  label: string;
  value: string;
  description?: string;
}

export interface PromptSelectRequest {
  message: string;
  options: PromptChoice[];
}

export interface PromptSecretRequest {
  message: string;
  allowEmpty?: boolean;
}

export interface CredentialPromptAdapter {
  select(request: PromptSelectRequest): Promise<string | undefined>;
  secret(request: PromptSecretRequest): Promise<string | undefined>;
}

export interface EnsureManagedCredentialOptions {
  mode: "init" | "model";
  allowReplaceExisting?: boolean;
}

export interface EnsureManagedCredentialResult {
  status: "configured" | "skipped";
  source?: "existing" | "imported" | "pasted";
  envVar: string;
}

function providerLabel(providerId: string): string {
  return findProviderPreset(providerId)?.name ?? providerId;
}

export async function ensureManagedProviderCredential(
  providerId: string,
  adapter: CredentialPromptAdapter,
  options: EnsureManagedCredentialOptions,
): Promise<EnsureManagedCredentialResult> {
  const spec = getManagedCredentialSpec(providerId);
  if (!spec) {
    throw new Error(`Provider '${providerId}' does not use managed credentials.`);
  }

  const label = providerLabel(providerId);
  const cancelLabel = options.mode === "init" ? "Skip" : "Cancel";

  if (hasManagedCredential(providerId)) {
    if (!options.allowReplaceExisting) {
      return {
        status: "configured",
        source: "existing",
        envVar: spec.internalEnvVar,
      };
    }

    const existingChoice = await adapter.select({
      message: `${label}: A Vigil-managed key is already saved`,
      options: [
        {
          label: "Keep current key",
          value: "keep",
          description: `Continue using ${spec.internalEnvVar}`,
        },
        {
          label: "Replace key",
          value: "replace",
          description: "Import a detected key or paste a new one",
        },
        {
          label: cancelLabel,
          value: "cancel",
          description: "Leave this provider unchanged",
        },
      ],
    });

    if (existingChoice === "keep") {
      return {
        status: "configured",
        source: "existing",
        envVar: spec.internalEnvVar,
      };
    }
    if (!existingChoice || existingChoice === "cancel") {
      return { status: "skipped", envVar: spec.internalEnvVar };
    }
  }

  const candidates = detectManagedCredentialCandidates(providerId);
  const choice = await adapter.select({
    message: candidates.length > 0
      ? `${label}: Choose how to configure the API key`
      : `${label}: No saved Vigil key found`,
    options: [
      ...candidates.map((candidate) => ({
        label: `Import detected ${candidate.envVar}`,
        value: `import:${candidate.envVar}`,
        description: `Copy ${candidate.envVar} into ${spec.internalEnvVar}`,
      })),
      {
        label: "Paste a different key",
        value: "paste",
        description: `Save it as ${spec.internalEnvVar}`,
      },
      {
        label: cancelLabel,
        value: "cancel",
        description: options.mode === "init"
          ? "Leave this provider unconfigured for now"
          : "Abort model switching",
      },
    ],
  });

  if (!choice || choice === "cancel") {
    return { status: "skipped", envVar: spec.internalEnvVar };
  }

  if (choice.startsWith("import:")) {
    const envVar = choice.slice("import:".length);
    const candidate = candidates.find((item) => item.envVar === envVar);
    if (!candidate) {
      throw new Error(`Detected key '${envVar}' is no longer available.`);
    }
    setDotenvKey(spec.internalEnvVar, candidate.value.trim());
    return {
      status: "configured",
      source: "imported",
      envVar: spec.internalEnvVar,
    };
  }

  while (true) {
    const pasted = await adapter.secret({
      message: `${label}: Paste API key`,
      allowEmpty: false,
    });
    if (pasted === undefined) {
      return { status: "skipped", envVar: spec.internalEnvVar };
    }
    if (pasted.trim() === "") continue;
    setDotenvKey(spec.internalEnvVar, pasted.trim());
    return {
      status: "configured",
      source: "pasted",
      envVar: spec.internalEnvVar,
    };
  }
}
