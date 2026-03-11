# FAQ

## General

### What platforms does LongerAgent support?

macOS only at this time.

### What Node.js version is required?

Node.js 18 or later.

### Is LongerAgent free?

LongerAgent itself is free and open source under the MIT license. You pay for the API usage of whichever model provider you use. Local providers (Ollama, oMLX, LM Studio) have no API costs.

## Setup

### How do I add a new provider after initial setup?

Re-run the setup wizard:

```bash
longeragent init
```

It will detect your existing configuration and let you add new providers without losing the ones you already set up.

### My API key is not working

Check that the key is correctly stored in `~/.longeragent/.env`:

```bash
cat ~/.longeragent/.env
```

Make sure the environment variable name matches what the provider expects. For GLM, Kimi, and MiniMax, LongerAgent stores the runtime key in its own internal slots (for example `LONGERAGENT_GLM_CODE_API_KEY` or `LONGERAGENT_KIMI_API_KEY`) inside `~/.longeragent/.env`. External env vars such as `MOONSHOT_API_KEY`, `GLM_CODE_API_KEY`, or `MINIMAX_API_KEY` are only imported during `longeragent init` or when `/model` prompts for a missing key.

### The init wizard cannot find models for my local server

Make sure the local server is running before you start `longeragent init`. The wizard queries the server's `/v1/models` endpoint:

- **Ollama:** `http://localhost:11434/v1/models` -- run `ollama serve` first
- **oMLX:** `http://localhost:8000/v1/models`
- **LM Studio:** `http://localhost:1234/v1/models` -- start the local server from LM Studio's UI

### How do I use my ChatGPT subscription instead of an API key?

Use the OAuth login flow:

```bash
longeragent oauth
```

This authenticates with your ChatGPT account. Then select **OpenAI (ChatGPT Login)** during `longeragent init`.

See [ChatGPT OAuth Login](/providers/openai-oauth) for details.

## Usage

### The agent is running slowly

Context size affects performance. Try:

1. **Summarize:** `/summarize` to compress older context segments.
2. **Compact:** `/compact` for a full context reset.
3. **Switch models:** `/model` to switch to a faster or cheaper model.
4. **Lower thinking:** `/thinking` to reduce reasoning depth.

### How do I stop the agent mid-task?

You can send a new message at any time -- it will be delivered at the next activation boundary. If you need to stop completely, press `Ctrl+C` to exit LongerAgent.

### Can I resume a previous session?

Yes. Use `/resume` to pick from previous session logs and continue where you left off.

### How does context management work?

LongerAgent uses three layers:

1. **Hint compression** -- automatic prompting for the agent to summarize older content
2. **Agent-initiated summarization** -- the agent inspects and compresses its own context
3. **Auto-compact** -- safety net that triggers a full context reset near the limit

See [Context Management](/guide/context) for the full explanation.

### What is the Important Log?

A persistent record of key discoveries, failed approaches, and architectural decisions maintained by the agent throughout a session. It survives every summarization and compaction. You do not manage it directly -- the agent writes to it automatically.

### What are AGENTS.md files?

Persistent memory files that the agent reads on every turn:

- `~/AGENTS.md` -- global preferences
- `<project>/AGENTS.md` -- project-specific notes

The agent can also write to them to save long-term knowledge. They persist across sessions.

## Sub-Agents

### How many sub-agents can run at once?

There is no hard limit. The practical limit depends on your model provider's rate limits and the complexity of each sub-agent's task.

### Do sub-agents share context with the main agent?

No. Each sub-agent has its own context window. They share the same filesystem and model, but maintain separate conversations. Results are delivered back to the main agent when a sub-agent finishes.

## Skills

### Where do skills live?

In `~/.longeragent/skills/`. Each skill is a directory containing a `SKILL.md` file.

### How do I create a custom skill?

Create a directory in `~/.longeragent/skills/` with a `SKILL.md` file:

```yaml
---
name: my-skill
description: What this skill does
---

Instructions for the agent when this skill is active.
```

See [Skills](/guide/skills) for the full guide.

## MCP

### How do I add MCP tools?

Create `~/.longeragent/mcp.json` with your server configurations. See [MCP Integration](/guide/mcp) for examples.

### Do I need the MCP SDK installed?

The `@modelcontextprotocol/sdk` package is an optional dependency of LongerAgent. It will be installed automatically if available. If it is not installed, MCP features are simply unavailable.

## Troubleshooting

### "Environment variable 'X' is not set"

LongerAgent could not find the API key for a configured provider. Either:

1. Run `longeragent init` to reconfigure the provider and set the key.
2. Export the variable in your shell: `export ANTHROPIC_API_KEY=sk-ant-...`
3. Add it to `~/.longeragent/.env`.

For GLM, Kimi, and MiniMax, the easiest fix is usually to rerun `longeragent init` or select the model in `/model` and let LongerAgent import or save the key into its managed internal slot.

### "Unknown provider 'X'"

The provider name in your configuration does not match any supported provider. Supported providers are: `anthropic`, `openai`, `openai-codex`, `openai-chat`, `ollama`, `omlx`, `lmstudio`, `kimi`, `kimi-cn`, `kimi-ai`, `kimi-code`, `glm`, `glm-intl`, `glm-code`, `glm-intl-code`, `minimax`, `minimax-cn`, `openrouter`.

### Kimi returns a 403 error

The `kimi-code` endpoint is restricted to whitelisted agents. Switch to `kimi` or `kimi-cn` (standard API) instead. Re-run `longeragent init` and select the appropriate Kimi variant.
