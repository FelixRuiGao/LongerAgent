/**
 * DeepSeek provider adapter.
 *
 * Extends OpenAIChatProvider with DeepSeek's thinking control:
 * - thinking.type: "enabled" / "disabled" toggles reasoning mode
 * - reasoning_effort: "high" / "max" picks effort within thinking mode
 *   (DeepSeek auto-maps low/medium → high and xhigh → max, so we surface
 *   only the three documented behaviors as levels: off / high / max)
 */

import type { ModelConfig } from "../config.js";
import type { SendMessageOptions } from "./base.js";
import { OpenAIChatProvider } from "./openai-chat.js";

export class DeepSeekProvider extends OpenAIChatProvider {
  constructor(config: ModelConfig) {
    if (!config.baseUrl) {
      throw new Error(
        "DeepSeek provider requires a base_url. " +
          "Use provider 'deepseek' (auto-configured) or set base_url explicitly.",
      );
    }
    super(config);
  }

  protected override _applyThinkingParams(
    kwargs: Record<string, unknown>,
    options?: SendMessageOptions,
  ): void {
    if (!this._config.supportsThinking) return;
    const level = options?.thinkingLevel;

    if (level === "off" || level === "none") {
      kwargs["extra_body"] = {
        ...((kwargs["extra_body"] as Record<string, unknown>) || {}),
        thinking: { type: "disabled" },
      };
      return;
    }

    kwargs["extra_body"] = {
      ...((kwargs["extra_body"] as Record<string, unknown>) || {}),
      thinking: { type: "enabled" },
    };
    kwargs["reasoning_effort"] = level === "max" ? "max" : "high";
  }
}
