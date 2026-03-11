# Supported Providers

LongerAgent supports 10 providers across cloud APIs and local inference servers. Use `longeragent init` to configure any combination of them.

## Provider Table

| Provider | Models | Auth |
|----------|--------|-------------|
| **Anthropic** | Claude Haiku 4.5, Opus 4.6, Sonnet 4.6 (+ 1M context variants) | `ANTHROPIC_API_KEY` |
| **OpenAI** | GPT-5.2, GPT-5.2 Codex, GPT-5.3 Codex, GPT-5.4 | `OPENAI_API_KEY` or OAuth |
| **Kimi / Moonshot** | Kimi K2.5, K2 Instruct (Global, China, Coding Plan) | Managed slots (`LONGERAGENT_KIMI_*`); imports `MOONSHOT_API_KEY` / `KIMI_*` during setup |
| **MiniMax** | M2.1, M2.5 (Global, China) | Managed slots (`LONGERAGENT_MINIMAX_*`); imports `MINIMAX_*` during setup |
| **GLM / Zhipu** | GLM-5, GLM-4.7 (Global, China, Coding Plan) | Managed slots (`LONGERAGENT_GLM_*`); imports `GLM_*` during setup |
| **Ollama** | Any local Ollama model (dynamic discovery) | -- |
| **oMLX** | Any local MLX model (dynamic discovery) | -- |
| **LM Studio** | Any local GGUF model (dynamic discovery) | -- |
| **OpenRouter** | Curated presets for Claude, GPT, Kimi, MiniMax, GLM, plus any custom model | `OPENROUTER_API_KEY` |

## Cloud vs. Local

**Cloud providers** (Anthropic, OpenAI, Kimi, MiniMax, GLM, OpenRouter) require an API key. The init wizard prompts you for the key and stores it in `~/.longeragent/.env`. GLM, Kimi, and MiniMax use LongerAgent-managed internal slots there instead of relying on runtime provider-to-env mappings.

**Local providers** (Ollama, oMLX, LM Studio) connect to a server running on your machine. No API key is needed. During `longeragent init`, the wizard queries the server's `/v1/models` endpoint to discover available models.

## Switching at Runtime

Use the `/model` command during a session to switch between any configured model. For GLM, Kimi, and MiniMax, selecting a model with a missing key can prompt you to import or paste the key on the spot. Inline `/model ... key=...` syntax is not supported. You can also adjust reasoning depth with `/thinking`.

See [Model Switching](/guide/model-switching) for details.

## Setup Guides

- [Cloud Providers](/providers/cloud) -- Anthropic, OpenAI, Kimi, GLM, MiniMax, OpenRouter
- [Local Providers](/providers/local) -- Ollama, oMLX, LM Studio
- [ChatGPT OAuth Login](/providers/openai-oauth) -- Use your ChatGPT account instead of an API key
