import { describe, expect, it } from "vitest";

import { formatStatusBarModelName } from "../src/tui/status-bar-model-name.js";

describe("status bar model name formatting", () => {
  it("uses compact provider and model labels for built-in providers", () => {
    expect(formatStatusBarModelName("anthropic", "claude-sonnet-4-6")).toBe(
      "Anthropic/Sonnet 4.6",
    );
    expect(formatStatusBarModelName("openai", "gpt-5.4")).toBe(
      "OpenAI/GPT-5.4",
    );
    expect(formatStatusBarModelName("openai", "gpt-5.4-mini")).toBe(
      "OpenAI/GPT-5.4 Mini",
    );
    expect(formatStatusBarModelName("openai", "gpt-5.4-nano")).toBe(
      "OpenAI/GPT-5.4 Nano",
    );
    expect(formatStatusBarModelName("openai-codex", "gpt-5.3-codex")).toBe(
      "OpenAI Codex/GPT-5.3 Codex",
    );
    expect(formatStatusBarModelName("openai-codex", "gpt-5.4-mini")).toBe(
      "OpenAI Codex/GPT-5.4 Mini",
    );
  });

  it("keeps multi-site provider labels readable", () => {
    expect(formatStatusBarModelName("kimi-cn", "kimi-k2.5")).toBe(
      "Kimi China/Kimi K2.5",
    );
    expect(formatStatusBarModelName("minimax-cn", "MiniMax-M2.5")).toBe(
      "MiniMax China/MiniMax M2.5",
    );
    expect(formatStatusBarModelName("glm-intl-code", "glm-5")).toBe(
      "GLM Global Code/GLM 5",
    );
  });

  it("drops OpenRouter vendor prefixes and falls back to raw names for unknown models", () => {
    expect(formatStatusBarModelName("openrouter", "anthropic/claude-sonnet-4.6")).toBe(
      "OpenRouter/Sonnet 4.6",
    );
    expect(formatStatusBarModelName("openrouter", "moonshotai/kimi-k2.5")).toBe(
      "OpenRouter/Kimi K2.5",
    );
    expect(formatStatusBarModelName("foo-bar", "custom-model-x")).toBe(
      "Foo Bar/Custom Model X",
    );
  });
});
