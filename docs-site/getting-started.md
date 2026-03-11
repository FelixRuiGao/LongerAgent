# Getting Started

LongerAgent is a terminal AI coding agent designed for long sessions. It manages its own context proactively, runs parallel sub-agents, and lets you send messages while the agent is working.

**Platform:** macOS.

## Install

Install LongerAgent globally via npm:

```bash
npm install -g longer-agent
```

Requires Node.js 18 or later.

## Run the Setup Wizard

The `init` command walks you through provider selection, API key configuration, and model selection:

```bash
longeragent init
```

The wizard will:

1. Show you the list of supported providers (Anthropic, OpenAI, Kimi, MiniMax, GLM, Ollama, oMLX, LM Studio, OpenRouter).
2. Prompt you to select one or more providers.
3. Ask for API keys for each selected cloud provider, or import detected external env vars for GLM, Kimi, and MiniMax.
4. For local providers (Ollama, oMLX, LM Studio), auto-discover available models from the running server.
5. Let you pick a default model.

All preferences are saved to `~/.longeragent/tui-preferences.json`. API keys are stored in `~/.longeragent/.env` with `0600` permissions. GLM, Kimi, and MiniMax use LongerAgent-managed internal env slots there; external env vars are only imported during `init` or `/model`. OpenAI (ChatGPT Login) stores OAuth tokens in `~/.longeragent/auth.json` instead of using an API-key env var.

You can re-run `longeragent init` at any time to add providers or change your default model.

## Start a Session

```bash
longeragent
```

That's it. You are now in a conversation with the agent. Type a task and press Enter.

## Useful Early Commands

```text
/model       # switch model/provider; can import or paste missing keys
/mcp         # connect configured MCP servers and list discovered tools
/thinking    # raise or lower reasoning depth
/skills      # enable or disable installed skills
/resume      # reopen an older session from log
/summarize   # compress older context to free up space
/compact     # full context reset with continuation summary
```

## What Happens During a Session

LongerAgent is optimized for a specific workflow:

1. **Start a real task** -- not a toy prompt. Give it something substantial.
2. **Let the agent work** -- it will explore, edit, and test for a while.
3. **Interrupt freely** -- add clarifications or side requests without restarting.
4. **Manage context** -- use `/summarize` or `/compact` to keep the session alive instead of starting over when context grows large.

The agent manages context automatically through three layers (hint compression, agent-initiated summarization, and auto-compact), but you can also intervene manually at any point.

## CLI Options

```text
longeragent                     # Start with auto-detected config
longeragent --version           # Show the current version
longeragent init                # Run setup wizard
longeragent oauth               # Log in to OpenAI via OAuth (device code / browser)
longeragent oauth status        # Check OAuth login status
longeragent oauth logout        # Log out
longeragent --templates <path>  # Use a specific templates directory
longeragent --verbose           # Enable debug logging
```

## Safety

LongerAgent does not sandbox shell commands or file edits. It executes commands and writes files directly. Run it in trusted environments and review what it does.

## Next Steps

- [Providers](/providers/) -- set up cloud or local model providers
- [Context Management](/guide/context) -- understand how context stays under control
- [Sub-Agents](/guide/sub-agents) -- run parallel workers within a session
- [Configuration](/configuration) -- full reference for `~/.longeragent/`
