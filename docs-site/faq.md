# FAQ

## General

### What platforms does Fermi support?

macOS with Apple Silicon (M-series chips) only at this time.

### What runtime is required?

Bun 1.3 or later.

### Is Fermi free?

Fermi itself is free and open source under the MIT license. You pay for the API usage of whichever model provider you use. Local providers (Ollama, oMLX, LM Studio) have no API costs.

## Setup

### How do I add a new provider after initial setup?

Re-run the setup wizard:

```bash
fermi init
```

It detects your existing configuration and lets you add new providers without losing the ones already set up.

### My API key is not working

Check that the key is correctly stored in `~/.fermi/.env`:

```bash
cat ~/.fermi/.env
```

For Kimi, MiniMax, GLM, DeepSeek, and Xiaomi, Fermi stores keys in its own internal slots (e.g., `FERMI_KIMI_API_KEY`). External env vars are only imported during `fermi init` or when `/model` prompts for a missing key.

### The init wizard cannot find models for my local server

Make sure the local server is running before you start `fermi init`. The wizard queries the server's model endpoint:

- **Ollama:** `http://localhost:11434/v1/models` — run `ollama serve` first
- **oMLX:** `http://localhost:8000/v1/models`
- **LM Studio:** `http://localhost:1234/v1/models` — start the local server from LM Studio's UI

### How do I use my ChatGPT subscription instead of an API key?

Use the OAuth login flow:

```bash
fermi oauth
```

Or use `/codex` inside a session. This authenticates with your ChatGPT account.

See [ChatGPT OAuth Login](/providers/openai-oauth) for details.

### How do I use GitHub Copilot?

Use `/copilot` inside Fermi to log in with your GitHub account via device flow. Once authenticated, Copilot models appear in the `/model` picker.

See [GitHub Copilot](/providers/copilot) for details.

## Usage

### The agent is running slowly

Context size affects performance. Try:

1. **Summarize:** `/summarize` to compress older context segments
2. **Compact:** `/compact` for a full context reset
3. **Switch models:** `/model` to switch to a faster model
4. **Reduce context budget:** Set `context_budget_percent` lower in tui-preferences.json

### How do I stop the agent mid-task?

Press `Ctrl+C` to interrupt the current turn. The agent stops cleanly, and you can continue the conversation.

You can also type a new message at any time — it queues and delivers when the agent pauses between actions without interrupting the agent.

### Can I undo something the agent did?

Yes. `/rewind` (or `/undo`) rolls back to a previous turn. It reverts both the conversation state and any file changes the agent made after that turn. File revert uses tracked mutations with conflict detection.

### Can I resume a previous session?

Yes. Use `/session` (or `/resume`) to pick from previous session logs and continue where you left off.

### How does context management work?

Three cooperating layers:

1. **Hint compression** — system prompts the agent to summarize as context grows (60%/80%)
2. **Agent-initiated summarization** — agent inspects context map and surgically compresses selected blocks
3. **Auto-compact** — safety net that triggers a full reset near the limit (85%/90%)

See [Context Management](/guide/context) for the full explanation.

### What are AGENTS.md files?

Persistent memory files loaded on every turn:

- `~/AGENTS.md` — global preferences
- `<project>/AGENTS.md` — project-specific notes

The agent reads them for context and can write to them. They persist across sessions and compact resets.

### How does /rewind work?

`/rewind` shows a picker of previous turns. When you select one, Fermi:

1. Rolls back the conversation to that turn (all later entries are discarded)
2. Reverts file changes the agent made after that turn (tracked edits, writes, mkdir/cp/mv)
3. Reports any conflicts (files modified externally after the agent changed them are skipped)

This means you can undo both the conversation direction and its real-world effects in one step.

## Sub-Agents

### How many sub-agents can run at once?

There is no hard limit. The practical limit depends on your model provider's rate limits and task complexity.

### Do sub-agents share context with the main agent?

No. Each sub-agent has its own context window. They share the same filesystem and project, but maintain separate conversations. Results are delivered back when the sub-agent finishes.

### Can sub-agents use cheaper models?

Yes. Use `/tier` to configure high/medium/low model tiers. When spawning a sub-agent, the agent can set `model_level="low"` to use the cheaper model for simple tasks.

## Skills

### Where do skills live?

In `~/.fermi/skills/`. Each skill is a directory containing a `SKILL.md` file.

### How do I create a custom skill?

Create a directory in `~/.fermi/skills/` with a `SKILL.md` file:

```yaml
---
name: my-skill
description: What this skill does
---

Instructions for the agent when this skill is active.
```

See [Skills](/guide/skills) for the full guide.

## Troubleshooting

### "Environment variable 'X' is not set"

Fermi could not find the API key for a configured provider. Either:

1. Run `fermi init` to reconfigure the provider and set the key
2. Export the variable in your shell: `export ANTHROPIC_API_KEY=sk-ant-...`
3. Add it directly to `~/.fermi/.env`

### "Unknown provider 'X'"

Supported provider identifiers: `anthropic`, `openai`, `openai-codex`, `copilot`, `openai-chat`, `ollama`, `omlx`, `lmstudio`, `kimi`, `kimi-cn`, `kimi-ai`, `kimi-code`, `glm`, `glm-intl`, `glm-code`, `glm-intl-code`, `minimax`, `minimax-cn`, `deepseek`, `xiaomi`, `openrouter`.

### Kimi/GLM coding endpoints return 403

The `-code` endpoints (kimi-code, glm-code, glm-intl-code) are restricted to whitelisted agents by the providers. Switch to the standard API endpoints (kimi, kimi-cn, glm, glm-intl) instead.
