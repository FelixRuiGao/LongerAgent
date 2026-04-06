/**
 * Managed cloud provider credential slots.
 *
 * These providers always resolve credentials from Vigil-managed env vars.
 * External shell env vars are treated only as import candidates during setup.
 */

export interface ManagedProviderCredentialSpec {
  providerId: string;
  internalEnvVar: string;
  externalEnvVars: string[];
}

export const MANAGED_PROVIDER_CREDENTIAL_SPECS: ManagedProviderCredentialSpec[] = [
  { providerId: "glm", internalEnvVar: "VIGIL_GLM_API_KEY", externalEnvVars: ["GLM_API_KEY"] },
  { providerId: "glm-intl", internalEnvVar: "VIGIL_GLM_INTL_API_KEY", externalEnvVars: ["GLM_INTL_API_KEY"] },
  { providerId: "glm-code", internalEnvVar: "VIGIL_GLM_CODE_API_KEY", externalEnvVars: ["GLM_CODE_API_KEY"] },
  { providerId: "glm-intl-code", internalEnvVar: "VIGIL_GLM_INTL_CODE_API_KEY", externalEnvVars: ["GLM_INTL_CODE_API_KEY"] },
  { providerId: "kimi", internalEnvVar: "VIGIL_KIMI_API_KEY", externalEnvVars: ["MOONSHOT_API_KEY", "KIMI_API_KEY"] },
  { providerId: "kimi-cn", internalEnvVar: "VIGIL_KIMI_CN_API_KEY", externalEnvVars: ["MOONSHOT_API_KEY", "KIMI_CN_API_KEY"] },
  { providerId: "kimi-code", internalEnvVar: "VIGIL_KIMI_CODE_API_KEY", externalEnvVars: ["KIMI_CODE_API_KEY"] },
  { providerId: "minimax", internalEnvVar: "VIGIL_MINIMAX_API_KEY", externalEnvVars: ["MINIMAX_API_KEY"] },
  { providerId: "minimax-cn", internalEnvVar: "VIGIL_MINIMAX_CN_API_KEY", externalEnvVars: ["MINIMAX_CN_API_KEY"] },
];

const SPEC_BY_PROVIDER = new Map(
  MANAGED_PROVIDER_CREDENTIAL_SPECS.map((spec) => [spec.providerId, spec] as const),
);

export interface DetectedCredentialCandidate {
  envVar: string;
  value: string;
}

export function isManagedProvider(providerId: string): boolean {
  return SPEC_BY_PROVIDER.has(providerId);
}

export function getManagedCredentialSpec(
  providerId: string,
): ManagedProviderCredentialSpec | undefined {
  return SPEC_BY_PROVIDER.get(providerId);
}

export function getManagedCredentialEnvVar(
  providerId: string,
): string | undefined {
  return SPEC_BY_PROVIDER.get(providerId)?.internalEnvVar;
}

export function hasManagedCredential(
  providerId: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const envVar = getManagedCredentialEnvVar(providerId);
  const raw = envVar ? env[envVar] : undefined;
  return typeof raw === "string" && raw.trim() !== "";
}

export function detectManagedCredentialCandidates(
  providerId: string,
  env: NodeJS.ProcessEnv = process.env,
): DetectedCredentialCandidate[] {
  const spec = getManagedCredentialSpec(providerId);
  if (!spec) return [];

  const out: DetectedCredentialCandidate[] = [];
  const seen = new Set<string>();
  for (const envVar of spec.externalEnvVars) {
    if (seen.has(envVar)) continue;
    seen.add(envVar);
    const raw = env[envVar];
    if (typeof raw === "string" && raw.trim() !== "") {
      out.push({ envVar, value: raw });
    }
  }
  return out;
}

export function hasAnyManagedCredential(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return MANAGED_PROVIDER_CREDENTIAL_SPECS.some((spec) => {
    const raw = env[spec.internalEnvVar];
    return typeof raw === "string" && raw.trim() !== "";
  });
}
