import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildDefaultRegistry, type CommandContext } from "../src/commands.js";

const MODEL_TEST_ENV_VARS = [
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "OPENROUTER_API_KEY",
  "MOONSHOT_API_KEY",
  "KIMI_API_KEY",
  "KIMI_CN_API_KEY",
  "KIMI_CODE_API_KEY",
  "GLM_API_KEY",
  "GLM_CODE_API_KEY",
  "GLM_INTL_API_KEY",
  "GLM_INTL_CODE_API_KEY",
  "MINIMAX_API_KEY",
  "MINIMAX_CN_API_KEY",
  "LONGERAGENT_KIMI_API_KEY",
  "LONGERAGENT_KIMI_CN_API_KEY",
  "LONGERAGENT_KIMI_CODE_API_KEY",
  "LONGERAGENT_GLM_API_KEY",
  "LONGERAGENT_GLM_INTL_API_KEY",
  "LONGERAGENT_GLM_CODE_API_KEY",
  "LONGERAGENT_GLM_INTL_CODE_API_KEY",
  "LONGERAGENT_MINIMAX_API_KEY",
  "LONGERAGENT_MINIMAX_CN_API_KEY",
];

const savedModelTestEnv = new Map<string, string | undefined>();

function makeContext(
  registry: ReturnType<typeof buildDefaultRegistry>,
  session: Record<string, unknown>,
): CommandContext {
  return {
    session,
    showMessage: vi.fn(),
    autoSave: vi.fn(),
    resetUiState: vi.fn(),
    commandRegistry: registry,
  };
}

describe("/model command", () => {
  beforeEach(() => {
    savedModelTestEnv.clear();
    for (const envVar of MODEL_TEST_ENV_VARS) {
      savedModelTestEnv.set(envVar, process.env[envVar]);
      delete process.env[envVar];
    }
  });

  afterEach(() => {
    for (const [envVar, value] of savedModelTestEnv.entries()) {
      if (value === undefined) {
        delete process.env[envVar];
      } else {
        process.env[envVar] = value;
      }
    }
    savedModelTestEnv.clear();
  });

  it("shows all preset models and marks models that require API key", () => {
    const registry = buildDefaultRegistry();
    const cmd = registry.lookup("/model");
    expect(cmd?.options).toBeTruthy();

    const session = {
      config: {
        modelNames: ["my-claude"],
        listModelEntries: () => ([
          {
            name: "my-claude",
            provider: "anthropic",
            model: "claude-sonnet-4-6",
            apiKeyRaw: "sk-anthropic",
            hasResolvedApiKey: true,
          },
        ]),
      },
      primaryAgent: {
        modelConfig: {
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          apiKey: "sk-anthropic",
        },
      },
    };

    const opts = cmd!.options!({ session });
    const anthropic = opts.find((o) => o.value === "anthropic");
    const kimiGlobal = opts.find((o) => o.value === "kimi");
    const openai = opts.find((o) => o.value === "openai");

    expect(anthropic).toBeTruthy();
    expect(kimiGlobal).toBeTruthy();
    expect(openai).toBeTruthy();
    expect(anthropic!.children?.some((c) => c.label.includes("claude-haiku-4-5"))).toBe(true);
    expect(anthropic!.children?.some((c) => c.label.includes("claude-sonnet-4-6  (current)"))).toBe(true);
    expect(anthropic!.children?.some((c) => c.label.includes("claude-sonnet-4-6  (1M context beta)"))).toBe(true);
    expect(
      openai!.children?.some((c) => c.label.includes("gpt-5.2  (key missing: run longeragent init)")),
    ).toBe(true);
    expect(openai!.children?.some((c) => c.label.includes("gpt-5.1"))).toBe(false);
    expect(openai!.children?.some((c) => c.label.includes("gpt-4o"))).toBe(false);
    expect(openai!.children?.some((c) => c.label.includes("gpt-5.4"))).toBe(true);
    expect(openai!.children?.some((c) => c.label.includes("gpt-5.2-codex"))).toBe(true);
    expect(openai!.children?.some((c) => c.label.includes("gpt-5.3-codex"))).toBe(true);
  });

  it("tracks managed provider keys per exact endpoint instead of sharing them across a group", () => {
    process.env["LONGERAGENT_GLM_API_KEY"] = "glm-cn";

    const registry = buildDefaultRegistry();
    const cmd = registry.lookup("/model");
    expect(cmd?.options).toBeTruthy();

    const session = {
      config: {
        modelNames: [],
        listModelEntries: () => [],
      },
      primaryAgent: {
        modelConfig: {
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          apiKey: "sk-anthropic",
        },
      },
    };

    const opts = cmd!.options!({ session });
    const glmGroup = opts.find((o) => o.value === "glm");
    const glmChina = glmGroup?.children?.find((o) => o.value === "glm");
    const glmChinaCode = glmGroup?.children?.find((o) => o.value === "glm-code");

    expect(glmChina).toBeTruthy();
    expect(glmChinaCode).toBeTruthy();
    expect(glmChina!.children?.some((c) => c.label.includes("key missing"))).toBe(false);
    expect(glmChinaCode!.children?.every((c) => c.label.includes("key missing"))).toBe(true);
  });

  it("groups OpenRouter models by vendor prefix into three-level hierarchy", () => {
    const registry = buildDefaultRegistry();
    const cmd = registry.lookup("/model");
    expect(cmd?.options).toBeTruthy();

    const session = {
      config: {
        modelNames: [],
        listModelEntries: () => [],
      },
      primaryAgent: {
        modelConfig: {
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          apiKey: "sk-anthropic",
        },
      },
    };

    const opts = cmd!.options!({ session });
    const openrouter = opts.find((o) => o.value === "openrouter");
    expect(openrouter).toBeTruthy();

    // OpenRouter children are now vendor sub-groups.
    const vendorAnthro = openrouter!.children?.find((c) => c.value === "openrouter-anthropic");
    const vendorOpenAI = openrouter!.children?.find((c) => c.value === "openrouter-openai");
    const vendorKimi = openrouter!.children?.find((c) => c.value === "openrouter-moonshotai");
    const vendorMiniMax = openrouter!.children?.find((c) => c.value === "openrouter-minimax");
    const vendorGLM = openrouter!.children?.find((c) => c.value === "openrouter-z-ai");

    expect(vendorAnthro).toBeTruthy();
    expect(vendorAnthro!.label).toBe("Anthropic");
    expect(vendorAnthro!.children?.some((c) => c.label.startsWith("openrouter/claude-haiku-4.5"))).toBe(true);
    expect(vendorAnthro!.children?.some((c) => c.label.includes("openrouter/claude-sonnet-4.6  (1M context)"))).toBe(true);

    expect(vendorOpenAI).toBeTruthy();
    expect(vendorOpenAI!.label).toBe("OpenAI");
    expect(vendorOpenAI!.children?.some((c) => c.label.startsWith("openrouter/gpt-5.4"))).toBe(true);
    expect(vendorOpenAI!.children?.some((c) => c.label.startsWith("openrouter/gpt-5.3-codex"))).toBe(true);

    expect(vendorKimi).toBeTruthy();
    expect(vendorKimi!.label).toBe("Kimi");
    expect(vendorKimi!.children?.some((c) => c.label.startsWith("openrouter/kimi-k2.5"))).toBe(true);

    expect(vendorMiniMax).toBeTruthy();
    expect(vendorMiniMax!.label).toBe("MiniMax");
    expect(vendorMiniMax!.children?.some((c) => c.label.startsWith("openrouter/minimax-m2.1"))).toBe(true);

    expect(vendorGLM).toBeTruthy();
    expect(vendorGLM!.label).toBe("GLM / Zhipu");
  });

  it("blocks switching to provider:model when provider API key is missing", async () => {
    const registry = buildDefaultRegistry();
    const cmd = registry.lookup("/model");
    expect(cmd).toBeTruthy();

    const switchModel = vi.fn();
    const session = {
      config: {
        modelNames: ["my-claude"],
        listModelEntries: () => ([
          {
            name: "my-claude",
            provider: "anthropic",
            model: "claude-sonnet-4-6",
            apiKeyRaw: "sk-anthropic",
            hasResolvedApiKey: true,
          },
        ]),
      },
      switchModel,
      resetForNewSession: vi.fn(),
      primaryAgent: {
        modelConfig: {
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          apiKey: "sk-anthropic",
        },
      },
    };

    const ctx = makeContext(registry, session);
    await cmd!.handler(ctx, "openai:gpt-5.4");

    const rendered = (ctx.showMessage as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string;
    expect(rendered).toContain("Missing API key for provider 'openai'");
    expect(switchModel).not.toHaveBeenCalled();
  });

  it("prompts for a managed provider key during /model and switches after importing a detected key", async () => {
    process.env["GLM_CODE_API_KEY"] = "glm-code-detected";
    const previousHome = process.env["HOME"];
    const tempHome = mkdtempSync(join(tmpdir(), "longeragent-model-home-"));
    mkdirSync(join(tempHome, ".longeragent"), { recursive: true });
    process.env["HOME"] = tempHome;

    try {
      const registry = buildDefaultRegistry();
      const cmd = registry.lookup("/model");
      expect(cmd).toBeTruthy();

      const upsertModelRaw = vi.fn();
      const switchModel = vi.fn();
      const resetForNewSession = vi.fn();
      const promptSelect = vi.fn(async () => "import:GLM_CODE_API_KEY");
      const promptSecret = vi.fn();
      const session = {
        config: {
          modelNames: [],
          listModelEntries: () => [],
          upsertModelRaw,
        },
        switchModel: (name: string) => {
          switchModel(name);
          (session.primaryAgent as any).modelConfig = {
            name,
            provider: "glm-code",
            model: "glm-5",
            contextLength: 200000,
            apiKey: "glm-code-detected",
          };
        },
        resetForNewSession,
        primaryAgent: {
          modelConfig: {
            name: "my-claude",
            provider: "anthropic",
            model: "claude-sonnet-4-6",
            contextLength: 200000,
            apiKey: "sk-anthropic",
          },
        },
      };

      const ctx = {
        ...makeContext(registry, session),
        promptSelect,
        promptSecret,
      };

      await cmd!.handler(ctx, "glm-code:glm-5");

      expect(promptSelect).toHaveBeenCalledTimes(1);
      expect(promptSecret).not.toHaveBeenCalled();
      expect(process.env["LONGERAGENT_GLM_CODE_API_KEY"]).toBe("glm-code-detected");
      expect(upsertModelRaw).toHaveBeenCalledWith(
        "runtime-glm-code-glm-5",
        expect.objectContaining({
          provider: "glm-code",
          model: "glm-5",
          api_key: "${LONGERAGENT_GLM_CODE_API_KEY}",
        }),
      );
      expect(switchModel).toHaveBeenCalledWith("runtime-glm-code-glm-5");
      expect(resetForNewSession).toHaveBeenCalledTimes(1);
    } finally {
      if (previousHome === undefined) {
        delete process.env["HOME"];
      } else {
        process.env["HOME"] = previousHome;
      }
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it("rejects inline API key syntax and asks the user to use init or the picker", async () => {
    const registry = buildDefaultRegistry();
    const cmd = registry.lookup("/model");
    expect(cmd).toBeTruthy();

    const upsertModelRaw = vi.fn();
    const switchModel = vi.fn();
    const resetForNewSession = vi.fn();
    const session = {
      config: {
        modelNames: [],
        listModelEntries: () => [],
        upsertModelRaw,
      },
      switchModel: (name: string) => {
        switchModel(name);
        (session.primaryAgent as any).modelConfig = {
          name,
          provider: "openai",
          model: "gpt-5.2-codex",
          contextLength: 400000,
          apiKey: "sk-inline",
        };
      },
      resetForNewSession,
      primaryAgent: {
        modelConfig: {
          name: "my-claude",
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          contextLength: 200000,
          apiKey: "sk-anthropic",
        },
      },
    };

    const ctx = makeContext(registry, session);
    await cmd!.handler(ctx, "openai:gpt-5.2-codex key=sk-inline");

    const rendered = (ctx.showMessage as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string;
    expect(rendered).toContain("Inline API keys in `/model` are no longer supported.");
    expect(upsertModelRaw).not.toHaveBeenCalled();
    expect(switchModel).not.toHaveBeenCalled();
    expect(resetForNewSession).not.toHaveBeenCalled();
  });

  it("preserves configured providers when persisting preferences after model switch", async () => {
    const registry = buildDefaultRegistry();
    const cmd = registry.lookup("/model");
    expect(cmd).toBeTruthy();

    process.env["LONGERAGENT_GLM_CODE_API_KEY"] = "glm-test-key";

    const switchModel = vi.fn();
    const resetForNewSession = vi.fn();
    const saveGlobalPreferences = vi.fn();
    const loadGlobalPreferences = vi.fn(() => ({
      version: 1,
      modelConfigName: "lmstudio:qwen/qwen3.5-9b",
      modelProvider: "lmstudio",
      modelSelectionKey: "qwen/qwen3.5-9b",
      modelId: "qwen/qwen3.5-9b",
      thinkingLevel: "default",
      cacheHitEnabled: true,
      providerEnvVars: { glm: "GLM_API_KEY" },
      localProviders: {
        lmstudio: {
          baseUrl: "http://localhost:1234/v1",
          model: "qwen/qwen3.5-9b",
          contextLength: 260000,
        },
      },
      contextRatio: 0.75,
    }));

    const session = {
      config: {
        modelNames: [],
        listModelEntries: () => [],
        upsertModelRaw: vi.fn(),
      },
      switchModel: (name: string) => {
        switchModel(name);
        (session.primaryAgent as any).modelConfig = {
          name,
          provider: "glm-code",
          model: "glm-5",
          contextLength: 200000,
          apiKey: "glm-test-key",
        };
      },
      setPersistedModelSelection: vi.fn(),
      getGlobalPreferences: () => ({
        version: 1,
        modelConfigName: "runtime-glm-code-glm-5",
        modelProvider: "glm-code",
        modelSelectionKey: "glm-5",
        modelId: "glm-5",
        thinkingLevel: "default",
        cacheHitEnabled: true,
      }),
      resetForNewSession,
      primaryAgent: {
        modelConfig: {
          name: "my-lmstudio",
          provider: "lmstudio",
          model: "qwen/qwen3.5-9b",
          contextLength: 260000,
          apiKey: "local",
        },
      },
    };

    const ctx = {
      ...makeContext(registry, session),
      store: {
        loadGlobalPreferences,
        saveGlobalPreferences,
        clearSession: vi.fn(),
      },
    };

    await cmd!.handler(ctx, "glm-code:glm-5");

    expect(saveGlobalPreferences).toHaveBeenCalledWith(expect.objectContaining({
      modelConfigName: "runtime-glm-code-glm-5",
      modelProvider: "glm-code",
      modelSelectionKey: "glm-5",
      modelId: "glm-5",
      providerEnvVars: { glm: "GLM_API_KEY" },
      localProviders: {
        lmstudio: {
          baseUrl: "http://localhost:1234/v1",
          model: "qwen/qwen3.5-9b",
          contextLength: 260000,
        },
      },
      contextRatio: 0.75,
    }));
  });

  it("preserves preset-specific overrides for Anthropic 1M variants", async () => {
    process.env["ANTHROPIC_API_KEY"] = "sk-anthropic";
    const registry = buildDefaultRegistry();
    const cmd = registry.lookup("/model");
    expect(cmd).toBeTruthy();

    const upsertModelRaw = vi.fn();
    const switchModel = vi.fn();
    const resetForNewSession = vi.fn();
    const session = {
      config: {
        modelNames: [],
        listModelEntries: () => [],
        upsertModelRaw,
      },
      switchModel: (name: string) => {
        switchModel(name);
        (session.primaryAgent as any).modelConfig = {
          name,
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          contextLength: 1_000_000,
          apiKey: "sk-inline",
        };
      },
      resetForNewSession,
      primaryAgent: {
        modelConfig: {
          name: "my-openai",
          provider: "openai",
          model: "gpt-5.2",
          contextLength: 400000,
          apiKey: "sk-openai",
        },
      },
    };

      const ctx = makeContext(registry, session);
    await cmd!.handler(ctx, "anthropic:claude-sonnet-4-6-1m");

    expect(upsertModelRaw).toHaveBeenCalledWith(
      "runtime-anthropic-claude-sonnet-4-6-1m",
      expect.objectContaining({
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        api_key: "${ANTHROPIC_API_KEY}",
        context_length: 1_000_000,
        betas: ["context-1m-2025-08-07"],
      }),
    );
    expect(switchModel).toHaveBeenCalledWith("runtime-anthropic-claude-sonnet-4-6-1m");
    expect(resetForNewSession).toHaveBeenCalledTimes(1);
  });

  it("reuses provider key from existing model when switching to another model in same provider", async () => {
    const registry = buildDefaultRegistry();
    const cmd = registry.lookup("/model");
    expect(cmd).toBeTruthy();

    const upsertModelRaw = vi.fn();
    const switchModel = vi.fn();
    const resetForNewSession = vi.fn();
    const session = {
      config: {
        modelNames: ["my-openai"],
        listModelEntries: () => ([
          {
            name: "my-openai",
            provider: "openai",
            model: "gpt-5.2",
            apiKeyRaw: "${OPENAI_API_KEY}",
            hasResolvedApiKey: true,
          },
        ]),
        upsertModelRaw,
      },
      switchModel: (name: string) => {
        switchModel(name);
        (session.primaryAgent as any).modelConfig = {
          name,
          provider: "openai",
          model: "gpt-5.2-codex",
          contextLength: 400000,
          apiKey: "sk-openai",
        };
      },
      resetForNewSession,
      primaryAgent: {
        modelConfig: {
          name: "my-openai",
          provider: "openai",
          model: "gpt-5.2",
          contextLength: 400000,
          apiKey: "sk-openai",
        },
      },
    };

    const ctx = makeContext(registry, session);
    await cmd!.handler(ctx, "openai:gpt-5.2-codex");

    expect(upsertModelRaw).toHaveBeenCalledWith(
      "runtime-openai-gpt-5-2-codex",
      expect.objectContaining({
        provider: "openai",
        model: "gpt-5.2-codex",
        api_key: "${OPENAI_API_KEY}",
      }),
    );
    expect(switchModel).toHaveBeenCalledWith("runtime-openai-gpt-5-2-codex");
    expect(resetForNewSession).toHaveBeenCalledTimes(1);
  });

  it("maps OpenRouter Anthropic aliases to the official 1M preset config", async () => {
    process.env["OPENROUTER_API_KEY"] = "sk-openrouter";
    const registry = buildDefaultRegistry();
    const cmd = registry.lookup("/model");
    expect(cmd).toBeTruthy();

    const upsertModelRaw = vi.fn();
    const switchModel = vi.fn();
    const resetForNewSession = vi.fn();
    const session = {
      config: {
        modelNames: [],
        listModelEntries: () => [],
        upsertModelRaw,
      },
      switchModel: (name: string) => {
        switchModel(name);
        (session.primaryAgent as any).modelConfig = {
          name,
          provider: "openrouter",
          model: "anthropic/claude-sonnet-4.6",
          contextLength: 1_000_000,
          apiKey: "sk-inline",
        };
      },
      resetForNewSession,
      primaryAgent: {
        modelConfig: {
          name: "my-openai",
          provider: "openai",
          model: "gpt-5.2",
          contextLength: 400000,
          apiKey: "sk-openai",
        },
      },
    };

    const ctx = makeContext(registry, session);
    await cmd!.handler(ctx, "openrouter:anthropic/claude-sonnet-4-6");

    expect(upsertModelRaw).toHaveBeenCalledWith(
      "runtime-openrouter-anthropic-claude-sonnet-4-6",
      expect.objectContaining({
        provider: "openrouter",
        model: "anthropic/claude-sonnet-4.6",
        api_key: "${OPENROUTER_API_KEY}",
        context_length: 1_000_000,
      }),
    );
    expect(switchModel).toHaveBeenCalledWith("runtime-openrouter-anthropic-claude-sonnet-4-6");
    expect(resetForNewSession).toHaveBeenCalledTimes(1);
  });
});
