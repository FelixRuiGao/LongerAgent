import { describe, expect, it, vi } from "vitest";

import type { ModelConfig } from "../src/config.js";
import { OpenAIResponsesProvider } from "../src/providers/openai-responses.js";

function modelConfig(overrides?: Partial<ModelConfig>): ModelConfig {
  return {
    name: "openai-responses-test",
    provider: "openai",
    model: "gpt-5.2",
    apiKey: "test-key",
    baseUrl: "https://api.openai.com/v1",
    temperature: 0.7,
    maxTokens: 1024,
    contextLength: 400_000,
    supportsMultimodal: true,
    supportsThinking: true,
    thinkingBudget: 0,
    supportsWebSearch: true,
    extra: {},
    ...overrides,
  };
}

async function* streamOf(events: Array<Record<string, unknown>>): AsyncIterable<Record<string, unknown>> {
  for (const event of events) {
    yield event;
  }
}

async function captureCreateCall(
  overrides?: Partial<ModelConfig>,
  messages: Array<Record<string, unknown>> = [{ role: "user", content: "hi" }],
  options?: Record<string, unknown>,
): Promise<{
  body: Record<string, unknown>;
  requestOptions: Record<string, unknown> | undefined;
}> {
  const provider = new OpenAIResponsesProvider(modelConfig(overrides));
  const finalResponse = {
    output: [],
    usage: {
      input_tokens: 1,
      output_tokens: 1,
      input_tokens_details: { cached_tokens: 0 },
    },
  };
  const create = vi.fn(async () => ({
    output: [],
    usage: {
      input_tokens: 1,
      output_tokens: 1,
      input_tokens_details: { cached_tokens: 0 },
    },
  }));

  create.mockImplementation(async (params: Record<string, unknown>) => {
    if (params["stream"]) {
      return streamOf([
        { type: "response.completed", response: finalResponse },
      ]);
    }
    return finalResponse;
  });

  (provider as any)._client = {
    responses: {
      create,
    },
  };

  await provider.sendMessage(messages as any, undefined, options as any);
  return {
    body: (create.mock.calls[0]?.[0] as Record<string, unknown>) ?? {},
    requestOptions: create.mock.calls[0]?.[1] as Record<string, unknown> | undefined,
  };
}

async function captureRequestKwargs(model: string): Promise<Record<string, unknown>> {
  const { body } = await captureCreateCall({ model });
  return body;
}

describe("OpenAIResponsesProvider temperature support", () => {
  it.each([
    "gpt-5.2",
    "gpt-5.2-codex",
    "gpt-5.3-codex",
    "gpt-5.4",
    "gpt-5.4-mini",
    "gpt-5.4-nano",
    "openai/gpt-5.4",
    "openai/gpt-5.4-mini",
  ])("omits temperature for %s", async (model) => {
    const kwargs = await captureRequestKwargs(model);
    expect(kwargs["temperature"]).toBeUndefined();
  });

  it("keeps temperature for non-gpt5 models", async () => {
    const kwargs = await captureRequestKwargs("custom-non-gpt5-model");
    expect(kwargs["temperature"]).toBe(0.7);
  });
});

describe("OpenAIResponsesProvider openai-codex request shaping", () => {
  it("forwards prompt cache key through codex headers and include", async () => {
    const { body, requestOptions } = await captureCreateCall(
      {
        provider: "openai-codex",
        model: "gpt-5.4-mini",
        extra: { store: false, include: ["foo"] },
      },
      [{ role: "user", content: "hi" }],
      { promptCacheKey: "session-123" },
    );

    expect(body["prompt_cache_key"]).toBe("session-123");
    expect(body["include"]).toEqual(["foo", "reasoning.encrypted_content"]);
    expect(body["store"]).toBe(false);
    expect(requestOptions?.["headers"]).toEqual({
      conversation_id: "session-123",
      session_id: "session-123",
    });
  });

  it("does not add codex affinity headers for normal openai responses", async () => {
    const { body, requestOptions } = await captureCreateCall(
      {
        provider: "openai",
        model: "gpt-5.2",
      },
      [{ role: "user", content: "hi" }],
      { promptCacheKey: "session-123" },
    );

    expect(body["prompt_cache_key"]).toBe("session-123");
    expect(body["include"]).toBeUndefined();
    expect(requestOptions?.["headers"]).toBeUndefined();
  });

  it("sanitizes codex round-trip items before re-injecting them into input", async () => {
    const reasoningState = [
      {
        type: "reasoning",
        id: "rs_123",
        summary: [{ type: "summary_text", text: "thinking" }],
        encrypted_content: "enc-1",
      },
      {
        type: "function_call",
        id: "fc_123",
        call_id: "call_123",
        name: "grep",
        arguments: "{\"pattern\":\"abc\"}",
        status: "completed",
      },
    ];

    const { body } = await captureCreateCall(
      {
        provider: "openai-codex",
        model: "gpt-5.4-mini",
        extra: { store: false },
      },
      [
        { role: "assistant", content: "", _reasoning_state: reasoningState },
        { role: "user", content: "hi" },
      ],
      { promptCacheKey: "session-123" },
    );

    const input = body["input"] as Array<Record<string, unknown>>;
    const reasoningItem = input.find((item) => item["type"] === "reasoning");
    const functionCallItem = input.find((item) => item["type"] === "function_call");

    expect(reasoningItem).toEqual({
      type: "reasoning",
      summary: [{ type: "summary_text", text: "thinking" }],
      encrypted_content: "enc-1",
    });
    expect(functionCallItem).toEqual({
      type: "function_call",
      call_id: "call_123",
      name: "grep",
      arguments: "{\"pattern\":\"abc\"}",
    });
  });
});
