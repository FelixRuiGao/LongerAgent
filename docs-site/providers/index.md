# Supported Providers

Fermi supports cloud APIs and local inference servers. Use `fermi init` to configure any combination.

## Provider Table

| Provider | Models | Auth |
|----------|--------|------|
| **Anthropic** | Claude Haiku 4.5, Sonnet 4.6, Opus 4.6 (+ 1M context variants), Opus 4.7 | `ANTHROPIC_API_KEY` |
| **OpenAI** | GPT-5.2, 5.2 Codex, 5.3 Codex, 5.4, 5.4 Mini, 5.4 Nano, 5.5 | `OPENAI_API_KEY` or OAuth |
| **GitHub Copilot** | Claude Opus 4.6/4.7, Sonnet 4.6, GPT-5.x models | `/copilot` device-flow login |
| **DeepSeek** | V4 Flash, V4 Pro | Managed slot (`FERMI_DEEPSEEK_*`) |
| **Kimi / Moonshot** | K2.6, K2.5, K2 Instruct (Global, China, Code variants) | Managed slots (`FERMI_KIMI_*`) |
| **MiniMax** | M2.5, M2.5 Highspeed, M2.7, M2.7 Highspeed (Global, China) | Managed slots (`FERMI_MINIMAX_*`) |
| **GLM / Zhipu** | GLM-5.1, 5, 5 Turbo, 5V Turbo, 4.7 (Global, China, Code variants) | Managed slots (`FERMI_GLM_*`) |
| **Xiaomi (MiMo)** | V2.5, V2.5 Pro | Managed slot (`FERMI_XIAOMI_*`) |
| **OpenRouter** | Multi-vendor curated presets (Claude, GPT, etc.) + any custom model | `OPENROUTER_API_KEY` |
| **Ollama** | Any local model (dynamic discovery) | — |
| **oMLX** | Any local MLX model (dynamic discovery) | — |
| **LM Studio** | Any local GGUF model (dynamic discovery) | — |

## Cloud vs. Local

**Cloud providers** require either an API key or an OAuth login. The init wizard prompts for keys and stores them in `~/.fermi/.env`. Kimi, MiniMax, GLM, DeepSeek, and Xiaomi use Fermi-managed internal slots. GitHub Copilot uses its own device-flow OAuth via `/copilot`. OpenAI (ChatGPT Login) stores OAuth tokens in `~/.fermi/auth.json`.

**Local providers** (Ollama, oMLX, LM Studio) connect to a server on your machine. No API key needed. During `fermi init`, the wizard queries the server's model endpoint to discover available models.

## Switching at Runtime

Use `/model` during a session to switch between any configured model. For providers with missing keys, selecting a model can prompt you to import or paste the key on the spot.

Use `/tier` to assign models to high/medium/low tiers for sub-agents.

See [Model Switching](/guide/model-switching) for details.

## Known Limitations

Third-party coding plans (Kimi-Code, GLM-Code) use whitelist-based access control. Unless your account has explicit access, these endpoints will reject requests. Standard API endpoints work normally.

## Setup Guides

- [Cloud Providers](/providers/cloud) — Anthropic, OpenAI, DeepSeek, Kimi, GLM, MiniMax, Xiaomi, OpenRouter
- [GitHub Copilot](/providers/copilot) — Use your GitHub Copilot subscription
- [Local Providers](/providers/local) — Ollama, oMLX, LM Studio
- [ChatGPT OAuth Login](/providers/openai-oauth) — Use your ChatGPT account instead of an API key
