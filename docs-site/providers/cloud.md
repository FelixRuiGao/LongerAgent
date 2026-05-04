# Cloud Providers

This page covers setup for cloud-based API providers. For GitHub Copilot, see [GitHub Copilot](/providers/copilot). For ChatGPT OAuth, see [ChatGPT OAuth Login](/providers/openai-oauth).

## Anthropic

**Models:** Claude Haiku 4.5, Sonnet 4.6, Sonnet 4.6 (1M context), Opus 4.6, Opus 4.6 (1M context), Opus 4.7

1. Get an API key from [console.anthropic.com](https://console.anthropic.com/).
2. Run `fermi init` and select **Anthropic (Claude)**.
3. Paste your API key when prompted.

The key is stored as `ANTHROPIC_API_KEY` in `~/.fermi/.env`.

### 1M Context Beta

The 1M context variants of Sonnet 4.6 and Opus 4.6 appear as separate model options. These use Anthropic's extended context beta and allow up to 1,000,000 tokens of context.

**Thinking levels:** Opus 4.7: off, low, medium, high, xhigh, max. Opus 4.6: off, low, medium, high, max. Sonnet/Haiku: off, low, medium, high.

## OpenAI

**Models:** GPT-5.2, GPT-5.2 Codex, GPT-5.3 Codex, GPT-5.4, GPT-5.4 Mini, GPT-5.4 Nano, GPT-5.5

1. Get an API key from [platform.openai.com](https://platform.openai.com/).
2. Run `fermi init` and select **OpenAI**.
3. Paste your API key when prompted.

The key is stored as `OPENAI_API_KEY` in `~/.fermi/.env`.

Alternatively, use your ChatGPT account via OAuth. See [ChatGPT OAuth Login](/providers/openai-oauth).

**Thinking levels:** none, low, medium, high, xhigh.

## DeepSeek

**Models:** DeepSeek V4 Flash, DeepSeek V4 Pro

1. Get an API key from DeepSeek's developer portal.
2. Run `fermi init` and select **DeepSeek**.
3. Paste your API key when prompted.

The key is stored as a managed slot in `~/.fermi/.env`.

## Kimi / Moonshot

**Models:** Kimi K2.6, K2.5, K2 Instruct

Available through three endpoint variants:

| Variant | Endpoint | Fermi Slot | Detected External Env |
|---------|----------|------------------|-----------------------|
| **Kimi-Global** | `api.moonshot.ai` | `FERMI_KIMI_API_KEY` | `MOONSHOT_API_KEY`, `KIMI_API_KEY` |
| **Kimi-China** | `api.moonshot.cn` | `FERMI_KIMI_CN_API_KEY` | `MOONSHOT_API_KEY`, `KIMI_CN_API_KEY` |
| **Kimi-Code** | `api.kimi.com/coding/v1` | `FERMI_KIMI_CODE_API_KEY` | `KIMI_CODE_API_KEY` |

::: warning
The Kimi-Code endpoint is restricted to whitelisted agents. You may receive a 403 error. Use `kimi` or `kimi-cn` (standard API) instead.
:::

1. Get an API key from Moonshot's developer portal.
2. Run `fermi init` and select **Moonshot (Kimi)**, then pick your variant.
3. Import a detected env var or paste your API key.

## GLM / Zhipu

**Models:** GLM-5.1, GLM-5, GLM-5 Turbo, GLM-5V Turbo, GLM-4.7

Available through four endpoint variants:

| Variant | Endpoint | Fermi Slot | Detected External Env |
|---------|----------|------------------|-----------------------|
| **GLM-China** | `open.bigmodel.cn` | `FERMI_GLM_API_KEY` | `GLM_API_KEY` |
| **GLM-Global** | `api.z.ai` | `FERMI_GLM_INTL_API_KEY` | `GLM_INTL_API_KEY` |
| **GLM-China-Code** | `open.bigmodel.cn/api/coding` | `FERMI_GLM_CODE_API_KEY` | `GLM_CODE_API_KEY` |
| **GLM-Global-Code** | `api.z.ai/api/coding` | `FERMI_GLM_INTL_CODE_API_KEY` | `GLM_INTL_CODE_API_KEY` |

::: warning
The GLM coding endpoints are restricted to whitelisted agents. Use `glm` or `glm-intl` (standard API) instead.
:::

1. Get an API key from Zhipu's developer portal.
2. Run `fermi init` and select **z.ai (GLM/Zhipu)**, then pick your variant.
3. Import a detected env var or paste your API key.

## MiniMax

**Models:** MiniMax M2.5, M2.5 Highspeed, M2.7, M2.7 Highspeed

Available through two endpoint variants:

| Variant | Endpoint | Fermi Slot | Detected External Env |
|---------|----------|------------------|-----------------------|
| **MiniMax-Global** | `api.minimax.io` | `FERMI_MINIMAX_API_KEY` | `MINIMAX_API_KEY` |
| **MiniMax-China** | `api.minimaxi.com` | `FERMI_MINIMAX_CN_API_KEY` | `MINIMAX_CN_API_KEY` |

1. Get an API key from MiniMax's developer portal.
2. Run `fermi init` and select **MiniMax**, then pick your variant.
3. Import a detected env var or paste your API key.

## Xiaomi (MiMo)

**Models:** MiMo V2.5, MiMo V2.5 Pro

1. Get an API key from Xiaomi's developer portal.
2. Run `fermi init` and select **Xiaomi (MiMo)**.
3. Paste your API key when prompted.

The key is stored as a managed slot in `~/.fermi/.env`.

## OpenRouter

**Models:** Multi-vendor curated presets (Claude, GPT, Kimi, MiniMax, GLM, DeepSeek) plus any custom model.

OpenRouter acts as a unified API gateway to multiple model providers.

1. Get an API key from [openrouter.ai](https://openrouter.ai/).
2. Run `fermi init` and select **OpenRouter**.
3. Paste your API key.
4. Pick from the curated model presets.

The key is stored as `OPENROUTER_API_KEY` in `~/.fermi/.env`.
