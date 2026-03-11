# Cloud Providers

This page covers setup for all cloud-based providers: Anthropic, OpenAI, Kimi, GLM, MiniMax, and OpenRouter.

## Anthropic

**Models:** Claude Haiku 4.5, Claude Sonnet 4.6, Claude Sonnet 4.6 (1M context), Claude Opus 4.6, Claude Opus 4.6 (1M context)

1. Get an API key from [console.anthropic.com](https://console.anthropic.com/).
2. Run `longeragent init` and select **Anthropic (Claude)**.
3. Paste your API key when prompted.

The key is stored as `ANTHROPIC_API_KEY` in `~/.longeragent/.env`.

### 1M Context Beta

The 1M context variants of Sonnet 4.6 and Opus 4.6 appear as separate model options during init. These use Anthropic's extended context beta and allow up to 1,000,000 tokens of context.

**Thinking levels:** off, low, medium, high, max (Claude 4.6); off, low, medium, high (Claude 4.5 and earlier).

## OpenAI

**Models:** GPT-5.2, GPT-5.2 Codex, GPT-5.3 Codex, GPT-5.4

1. Get an API key from [platform.openai.com](https://platform.openai.com/).
2. Run `longeragent init` and select **OpenAI**.
3. Paste your API key when prompted.

The key is stored as `OPENAI_API_KEY` in `~/.longeragent/.env`.

Alternatively, you can use your ChatGPT account via OAuth instead of an API key. See [ChatGPT OAuth Login](/providers/openai-oauth).

**Thinking levels:** none, low, medium, high, xhigh.

## Kimi / Moonshot

**Models:** Kimi K2.5, Kimi K2 Instruct

Kimi is available through three endpoints. LongerAgent stores Kimi credentials in its own managed slots inside `~/.longeragent/.env` and can import external env vars during `init` or `/model`.

| Variant | Endpoint | LongerAgent Slot | Detected External Env |
|---------|----------|------------------|-----------------------|
| **Kimi-Global** | `api.moonshot.ai` | `LONGERAGENT_KIMI_API_KEY` | `MOONSHOT_API_KEY`, `KIMI_API_KEY` |
| **Kimi-China** | `api.moonshot.cn` | `LONGERAGENT_KIMI_CN_API_KEY` | `MOONSHOT_API_KEY`, `KIMI_CN_API_KEY` |
| **Kimi-Code** | `api.kimi.com/coding/v1` | `LONGERAGENT_KIMI_CODE_API_KEY` | `KIMI_CODE_API_KEY` |

::: warning
The Kimi-Code endpoint (`api.kimi.com/coding/v1`) is currently restricted by Moonshot to whitelisted agents. You may receive a `403 Kimi For Coding is currently only available for Coding Agents` error. Use `kimi` or `kimi-cn` (standard API) instead.
:::

1. Get an API key from Moonshot's developer portal.
2. Run `longeragent init` and select **Moonshot (Kimi)**, then pick your preferred variant.
3. Import a detected env var or paste your API key. LongerAgent saves it into the matching managed slot.

**Thinking levels:** off, on.

## GLM / Zhipu

**Models:** GLM-5, GLM-4.7

GLM is available through four endpoints. LongerAgent stores GLM credentials in managed endpoint-specific slots and only uses external env vars as import candidates.

| Variant | Endpoint | LongerAgent Slot | Detected External Env |
|---------|----------|------------------|-----------------------|
| **GLM-China** | `open.bigmodel.cn` | `LONGERAGENT_GLM_API_KEY` | `GLM_API_KEY` |
| **GLM-Global** | `api.z.ai` | `LONGERAGENT_GLM_INTL_API_KEY` | `GLM_INTL_API_KEY` |
| **GLM-China-Code** | `open.bigmodel.cn/api/coding` | `LONGERAGENT_GLM_CODE_API_KEY` | `GLM_CODE_API_KEY` |
| **GLM-Global-Code** | `api.z.ai/api/coding` | `LONGERAGENT_GLM_INTL_CODE_API_KEY` | `GLM_INTL_CODE_API_KEY` |

1. Get an API key from Zhipu's developer portal.
2. Run `longeragent init` and select **z.ai (GLM/Zhipu)**, then pick your preferred variant.
3. Import a detected env var or paste your API key. LongerAgent saves it into the matching managed slot.

**Thinking levels:** off, on.

## MiniMax

**Models:** MiniMax M2.1, MiniMax M2.5

MiniMax is available through two endpoints. LongerAgent stores MiniMax credentials in managed endpoint-specific slots and can import detected external env vars during setup.

| Variant | Endpoint | LongerAgent Slot | Detected External Env |
|---------|----------|------------------|-----------------------|
| **MiniMax-Global** | `api.minimax.io` | `LONGERAGENT_MINIMAX_API_KEY` | `MINIMAX_API_KEY` |
| **MiniMax-China** | `api.minimaxi.com` | `LONGERAGENT_MINIMAX_CN_API_KEY` | `MINIMAX_CN_API_KEY` |

1. Get an API key from MiniMax's developer portal.
2. Run `longeragent init` and select **MiniMax**, then pick your preferred variant.
3. Import a detected env var or paste your API key. LongerAgent saves it into the matching managed slot.

**Thinking levels:** always on (not configurable).

## OpenRouter

**Models:** Curated presets for Claude (Haiku 4.5, Sonnet 4.6, Opus 4.6), GPT (5.2, 5.2 Codex, 5.3 Codex, 5.4), Kimi K2.5, MiniMax M2.1/M2.5, GLM-5/GLM-4.7, plus any custom model.

OpenRouter acts as a unified API gateway to multiple model providers.

1. Get an API key from [openrouter.ai](https://openrouter.ai/).
2. Run `longeragent init` and select **OpenRouter**.
3. Paste your API key.
4. Pick from the curated model presets.

The key is stored as `OPENROUTER_API_KEY` in `~/.longeragent/.env`.

::: info
Web search is disabled by default on OpenRouter (it is a paid add-on). You can explicitly enable it per model if your OpenRouter plan supports it.
:::
