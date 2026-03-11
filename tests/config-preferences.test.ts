import { describe, expect, it } from "vitest";
import { Config } from "../src/config.js";

describe("Config preference-backed models", () => {
  it("preserves the OAuth sentinel for openai-codex presets", () => {
    const config = new Config({
      providerEnvVars: {
        "openai-codex": "_OPENAI_CODEX_OAUTH",
      },
    });

    expect(config.modelNames).toContain("openai-codex:gpt-5.2-codex");
    expect(config.listModelEntries()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "openai-codex:gpt-5.2-codex",
          provider: "openai-codex",
          model: "gpt-5.2-codex",
          apiKeyRaw: "oauth:openai-codex",
        }),
        expect.objectContaining({
          name: "openai-codex:gpt-5.3-codex",
          apiKeyRaw: "oauth:openai-codex",
        }),
        expect.objectContaining({
          name: "openai-codex:gpt-5.4",
          apiKeyRaw: "oauth:openai-codex",
        }),
      ]),
    );
  });
});
