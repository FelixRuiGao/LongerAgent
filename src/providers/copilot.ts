/**
 * GitHub Copilot provider — dispatcher + inner implementations.
 *
 * Architecture:
 *   CopilotProvider (dispatcher; the only thing registry.ts knows about)
 *     ├─ CopilotAnthropicImpl (extends AnthropicProvider)
 *     │    routes Claude models through Copilot's /v1/messages endpoint
 *     └─ CopilotResponsesImpl (extends OpenAIResponsesProvider)
 *          routes GPT / Codex models through Copilot's /responses endpoint
 *
 * The short-lived Copilot API token is managed by copilotTokenManager
 * (in-memory cache, auto-refresh every ~25 minutes). On every sendMessage
 * call, the inner provider rebuilds its underlying SDK client with the
 * fresh token and the Copilot gateway base URL from the token response.
 */

import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";

import type { ModelConfig } from "../config.js";
import { copilotTokenManager } from "../auth/github-copilot-token-manager.js";
import {
  BaseProvider,
  type Message,
  type ProviderResponse,
  type SendMessageOptions,
  type ToolDef,
} from "./base.js";
import { AnthropicProvider } from "./anthropic.js";
import { OpenAIResponsesProvider } from "./openai-responses.js";
import {
  buildCopilotRequestHeaders,
  detectAgentInMessages,
  detectVisionInMessages,
} from "./copilot-headers.js";

// =============================================================================
// Model routing table
// =============================================================================

/** Models served via Copilot's Anthropic-shaped /v1/messages endpoint. */
const ANTHROPIC_MODELS: ReadonlySet<string> = new Set([
  "claude-opus-4.6",
  "claude-opus-4.6-fast",
  "claude-sonnet-4.6",
]);

/** Models served via Copilot's OpenAI-shaped /responses endpoint. */
const RESPONSES_MODELS: ReadonlySet<string> = new Set([
  "gpt-5.2",
  "gpt-5.2-codex",
  "gpt-5.3-codex",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5-mini",
]);

// =============================================================================
// Helpers
// =============================================================================

/** Detect 401 Unauthorized errors from either SDK. */
function is401Error(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as Record<string, unknown>;
  if (e["status"] === 401 || e["statusCode"] === 401) return true;
  if (typeof e["message"] === "string" && /\b401\b/.test(e["message"] as string)) {
    return true;
  }
  return false;
}

// =============================================================================
// Inner: Anthropic-shaped (Claude models via Copilot /v1/messages)
// =============================================================================

class CopilotAnthropicImpl extends AnthropicProvider {
  private async _refreshClient(vision: boolean, isAgent: boolean): Promise<void> {
    const apiToken = await copilotTokenManager.getToken();
    const copilotHeaders = buildCopilotRequestHeaders({ vision, isAgent });

    this._client = new Anthropic({
      // Placeholder — real auth is injected in the fetch hook below to avoid
      // the SDK's default x-api-key header, which Copilot's proxy rejects.
      apiKey: "unused-copilot-token-manager-owned",
      baseURL: apiToken.endpointApi,
      // Disable the SDK's built-in retry loop. Our outer tool-loop has its own
      // network-retry layer (`src/network-retry.ts`) which is correctly scoped
      // (excludes 400s, exponential backoff, logged). A second hidden retry
      // layer inside the SDK silently multiplies Copilot billing on any
      // transient 429/5xx/`x-should-retry: true`.
      maxRetries: 0,
      fetch: async (input, init) => {
        const freshToken = await copilotTokenManager.getToken();
        const headers = new Headers(init?.headers);
        headers.delete("x-api-key");
        headers.set("authorization", `Bearer ${freshToken.token}`);
        for (const [k, v] of Object.entries(copilotHeaders)) {
          headers.set(k, v);
        }
        return fetch(input, { ...init, headers });
      },
    });
  }

  override async sendMessage(
    messages: Message[],
    tools?: ToolDef[],
    options?: SendMessageOptions,
  ): Promise<ProviderResponse> {
    const vision = detectVisionInMessages(messages);
    const isAgent = detectAgentInMessages(messages);
    await this._refreshClient(vision, isAgent);
    try {
      return await super.sendMessage(messages, tools, options);
    } catch (err) {
      if (is401Error(err)) {
        copilotTokenManager.invalidate();
        await this._refreshClient(vision, isAgent);
        return await super.sendMessage(messages, tools, options);
      }
      throw err;
    }
  }
}

// =============================================================================
// Inner: OpenAI Responses-shaped (GPT/Codex models via Copilot /responses)
// =============================================================================

class CopilotResponsesImpl extends OpenAIResponsesProvider {
  private async _refreshClient(vision: boolean, isAgent: boolean): Promise<void> {
    const apiToken = await copilotTokenManager.getToken();
    const copilotHeaders = buildCopilotRequestHeaders({ vision, isAgent });

    this._client = new OpenAI({
      // OpenAI SDK turns apiKey into `Authorization: Bearer ${apiKey}`.
      apiKey: apiToken.token,
      baseURL: apiToken.endpointApi,
      defaultHeaders: copilotHeaders,
      // Disable the SDK's built-in retry loop (default is 2 retries). See the
      // comment in CopilotAnthropicImpl above — a second retry layer inside
      // the SDK silently multiplies Copilot billing on transient errors.
      maxRetries: 0,
    });
  }

  override async sendMessage(
    messages: Message[],
    tools?: ToolDef[],
    options?: SendMessageOptions,
  ): Promise<ProviderResponse> {
    const vision = detectVisionInMessages(messages);
    const isAgent = detectAgentInMessages(messages);
    await this._refreshClient(vision, isAgent);
    try {
      return await super.sendMessage(messages, tools, options);
    } catch (err) {
      if (is401Error(err)) {
        copilotTokenManager.invalidate();
        await this._refreshClient(vision, isAgent);
        return await super.sendMessage(messages, tools, options);
      }
      throw err;
    }
  }
}

// =============================================================================
// Dispatcher: the only class exposed to registry.ts
// =============================================================================

/**
 * GitHub Copilot provider dispatcher.
 *
 * Routes by `config.model`:
 *   - Claude models → CopilotAnthropicImpl (/v1/messages)
 *   - GPT / Codex models → CopilotResponsesImpl (/responses)
 *
 * Exposes a single "copilot" provider ID; the Claude vs GPT split is invisible
 * to the rest of the system.
 */
export class CopilotProvider extends BaseProvider {
  override readonly requiresAlternatingRoles: boolean;
  override readonly budgetCalcMode: "subtract_output" | "full_context";

  private _inner: BaseProvider;

  constructor(config: ModelConfig) {
    super();
    const modelId = config.model;

    if (ANTHROPIC_MODELS.has(modelId)) {
      this._inner = new CopilotAnthropicImpl(config);
    } else if (RESPONSES_MODELS.has(modelId)) {
      this._inner = new CopilotResponsesImpl(config);
    } else {
      throw new Error(
        `Unknown Copilot model '${modelId}'. Supported models: ` +
          [...ANTHROPIC_MODELS, ...RESPONSES_MODELS].join(", "),
      );
    }

    this.requiresAlternatingRoles = this._inner.requiresAlternatingRoles;
    this.budgetCalcMode = this._inner.budgetCalcMode;
  }

  async sendMessage(
    messages: Message[],
    tools?: ToolDef[],
    options?: SendMessageOptions,
  ): Promise<ProviderResponse> {
    return this._inner.sendMessage(messages, tools, options);
  }
}
