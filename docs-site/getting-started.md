# Getting Started

Get Fermi running in under a minute. Three commands — install, configure, launch.

<!-- MEDIA: Hero screenshot of Fermi TUI in action — showing a mid-session conversation with context annotations visible -->

**Platform:** macOS (Apple Silicon).

## Install

```bash
bun install -g fermi-code
```

Requires [Bun](https://bun.sh) 1.3 or later.

## Setup

The init wizard walks you through provider selection, API key configuration, and model selection:

```bash
fermi init
```

The wizard will:

1. Show supported providers (Anthropic, OpenAI, GitHub Copilot, DeepSeek, Kimi, MiniMax, GLM, Xiaomi, Ollama, oMLX, LM Studio, OpenRouter).
2. Prompt for API keys or OAuth login.
3. For local providers (Ollama, oMLX, LM Studio), auto-discover available models from the running server.
4. Let you pick a default model.

All preferences are saved to `~/.fermi/tui-preferences.json`. API keys are stored in `~/.fermi/.env` with `0600` permissions.

Re-run `fermi init` at any time to add providers or change your default model.

## Start a Session

```bash
fermi
```

Type a task and press Enter. The agent will explore, plan, and execute.

## Key Commands

| Command | Description |
|---------|-------------|
| `/model` | Switch model/provider at runtime |
| `/summarize` | Compress older context to free space |
| `/compact` | Full context reset with continuation summary |
| `/rewind` | Roll back to a previous turn (alias: `/undo`) |
| `/session` | Resume a previous session (alias: `/resume`) |
| `/permission` | Set permission mode (read_only / reversible / yolo) |
| `/tier` | Configure sub-agent model tiers |
| `/skills` | Enable/disable installed skills |
| `/mcp` | Show MCP server status and tools |
| `/fork` | Fork current session into a new branch |
| `/new` | Start a new session |
| `/help` | Show all commands and shortcuts |

See [Slash Commands](/guide/commands) for the full reference.

## Context Management at a Glance

Fermi manages context through three cooperating layers:

| Layer | Trigger | What happens |
|-------|---------|--------------|
| **Hint compression** | Context reaches ~60% / ~80% | System nudges the agent to summarize older segments |
| **Agent summarization** | Agent decides (or user runs `/summarize`) | Agent inspects context map, surgically compresses selected blocks |
| **Auto-compact** | Context reaches ~85-90% | Full reset with continuation prompt — agent resumes seamlessly |

In most sessions you will not need to intervene. The three layers handle it automatically.

See [Context Management](/guide/context) for details.

## CLI Options

```text
fermi                       # Start with auto-detected config
fermi init                  # Run setup wizard
fermi --resume <id>         # Resume a specific session by ID
fermi -c key=value          # Override a setting for this session
fermi oauth                 # Log in to OpenAI via OAuth
fermi oauth status          # Check OAuth login status
fermi oauth logout          # Log out
fermi --templates <path>    # Use a specific templates directory
fermi --verbose             # Enable debug logging
fermi --version             # Show version
```

## Safety

Fermi does not sandbox shell commands or file edits. It executes commands and writes files directly. The `/permission` command lets you set the mode:

- **read_only** — only read tools auto-allowed; everything else asks for approval
- **reversible** — read + reversible writes auto-allowed
- **yolo** — everything auto-allowed except catastrophic operations

## Persistent Memory

Two `AGENTS.md` files are loaded on every turn and survive compact resets:

- **`~/AGENTS.md`** — global preferences across all projects
- **`<project>/AGENTS.md`** — project-specific patterns, conventions, and decisions

The agent reads these automatically and can write to them when you ask it to save knowledge for future sessions.

## Next Steps

- [Context Management](/guide/context) — the core feature in depth
- [Providers](/providers/) — set up cloud or local model providers
- [Sub-Agents](/guide/sub-agents) — parallel workers within a session
- [Configuration](/configuration) — full reference for `~/.fermi/`
