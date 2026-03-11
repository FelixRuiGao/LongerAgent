<p align="center">
  <img src="https://raw.githubusercontent.com/FelixRuiGao/LongerAgent/main/assets/logo.png" alt="LongerAgent" width="360" />
</p>
<p align="center">
  <strong>Built to work longer.</strong>
</p>
<p align="center">
  English | <a href="./README.zh-CN.md">中文</a>
</p>
<p align="center">
  <a href="https://felixruigao.github.io/LongerAgent/"><img alt="Docs" src="https://img.shields.io/badge/docs-website-4b4bf0?style=flat-square" /></a>
  <a href="./LICENSE"><img alt="License" src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" /></a>
  <img alt="Author" src="https://img.shields.io/badge/author-Felix%20Rui%20Gao-4b4bf0?style=flat-square" />
</p>

A terminal AI coding agent that manages its own context proactively, runs parallel sub-agents, and lets you message it while it's working.

![LongerAgent Terminal UI](https://raw.githubusercontent.com/FelixRuiGao/LongerAgent/main/assets/screenshot.png)

> **Platform:** macOS.

## Why LongerAgent

Most coding agents work well for short bursts, then degrade as the session gets longer. LongerAgent is built for the opposite case:

- **Long-running sessions** — context is monitored, summarized, and compacted before it collapses
- **Interruptible work** — you can send a new message while the agent is still executing
- **Parallel execution** — delegate exploration and implementation to sub-agents in the same session
- **Project memory** — `AGENTS.md` and the Important Log survive across sessions and compactions

If you want a terminal-native agent that can stay productive through a long refactor, investigation, or multi-step task, this is the point of the project.

## Quick Start

Install globally:

```bash
npm install -g longer-agent
```

Run the setup wizard:

```bash
longeragent init
```

Start:

```bash
longeragent
```

The setup wizard walks you through provider selection, API key configuration, and model selection. All preferences are saved to `~/.longeragent/tui-preferences.json`. For GLM, Kimi, and MiniMax, LongerAgent stores endpoint-specific keys in its own managed env slots inside `~/.longeragent/.env` and can import detected external env vars during `init` or `/model`. For OpenAI (ChatGPT Login), OAuth tokens are stored in `~/.longeragent/auth.json`; no runtime API-key env var is required.

### Useful Early Commands

```text
/model       # switch model/provider; can import or paste missing keys
/mcp         # connect configured MCP servers and list discovered tools
/thinking    # raise or lower reasoning depth
/skills      # enable or disable installed skills
/resume      # reopen an older session from log
/summarize   # compress older context to free up space
/compact     # full context reset with continuation summary
```

> **Safety:** LongerAgent does not sandbox shell commands or file edits. Run it in trusted environments and review what it does.

## Demo

Parallel sub-agents investigating a codebase, an async message mid-task, and context summarization — all in one session.

https://github.com/user-attachments/assets/377fe648-d43c-45da-b111-9434b2a0dc61

---

## Highlights

- **Three-layer context management** — hinting, surgical summarization, and full compaction
- **Parallel sub-agents** — spawn workers from chat or YAML call files
- **Skills system** — install, manage, and create reusable skill packages from inside the agent
- **Persistent memory** — `AGENTS.md` files and Important Log survive across sessions and compactions
- **Async messaging** — talk to the agent while it's mid-task
- **10 providers** — Anthropic, OpenAI, Kimi, MiniMax, GLM, Ollama, oMLX, LM Studio, OpenRouter, and more

## What It Feels Like

LongerAgent is optimized for a specific workflow:

1. Start a real task, not a toy prompt.
2. Let the agent explore, edit, and test for a while.
3. Interrupt it with clarifications or side requests without losing momentum.
4. Keep the session alive by summarizing or compacting instead of restarting from scratch.

That combination is the core product, more than any individual slash command or tool.

## Usage

### Context Management

The agent manages its own context automatically, but you can also intervene:

```text
/summarize                                # Summarize older context segments
/summarize Keep the auth refactor details # Summarize with specific instructions
/compact                                  # Full context reset with continuation summary
/compact Preserve the DB schema decisions # Compact with specific instructions
```

`/summarize` surgically compresses selected segments while preserving key decisions — use it when context is growing but you're not ready for a full reset. `/compact` is the nuclear option: full reset with a continuation summary so the agent picks up where it left off.

The agent can also do both on its own via `show_context` and `summarize_context` tools — no user action needed.

An **Important Log** is maintained throughout the session — key discoveries, failed approaches, and architectural decisions are written here and survive every compaction.

### Sub-Agents

Tell the agent to spawn sub-agents, or define tasks in a YAML call file:

```yaml
# tasks.yaml
tasks:
  - name: research
    template: explorer
    prompt: "Investigate how authentication works in this codebase"
  - name: refactor
    template: executor
    prompt: "Rename all legacy API endpoints to v2"
```

Three built-in templates: **main** (full tools), **explorer** (read-only), **executor** (task-focused). Sub-agents run concurrently and report back when done.

### Skills

Skills are reusable tool definitions the agent can load on demand.

```text
You:   "Install skill: apple-notes"        # Agent uses built-in skill-manager
You:   /skills                              # Toggle skills on/off with a picker
```

Create your own by adding a `SKILL.md` to `~/.longeragent/skills/<name>/`.

### Persistent Memory

Two `AGENTS.md` files are loaded on every turn:

- **`~/AGENTS.md`** — Global preferences across all projects
- **`<project>/AGENTS.md`** — Project-specific patterns and architecture notes

The agent reads them for context and can write to them to save long-term knowledge. These persist across sessions and context resets.

### Async Messaging

Type messages at any time — even while the agent is working. Messages are queued and delivered at the next activation boundary.

<details>
<summary><strong>How context management works (details)</strong></summary>

Three layers work together to keep context under control:

1. **Hint Compression** — As context grows, the system prompts the agent to proactively summarize older segments
2. **Agent-Initiated Summarization** — The agent inspects its own context distribution via `show_context` and surgically compresses selected segments with `summarize_context`, preserving key decisions and unresolved issues
3. **Auto-Compact** — Near the limit, the system performs a full context reset with a continuation summary — the agent picks up exactly where it left off

</details>

## Supported Providers

| Provider | Models | Auth |
|----------|--------|-------------|
| **Anthropic** | Claude Haiku 4.5, Opus 4.6, Sonnet 4.6 (+ 1M context variants) | `ANTHROPIC_API_KEY` |
| **OpenAI** | GPT-5.2, GPT-5.2 Codex, GPT-5.3 Codex, GPT-5.4 | `OPENAI_API_KEY` or OAuth |
| **Kimi / Moonshot** | Kimi K2.5, K2 Instruct (Global, China, Coding Plan\*) | LongerAgent-managed slots (`LONGERAGENT_KIMI_*`); detects `MOONSHOT_API_KEY` and `KIMI_*` during setup |
| **MiniMax** | M2.1, M2.5 (Global, China) | LongerAgent-managed slots (`LONGERAGENT_MINIMAX_*`); detects `MINIMAX_*` during setup |
| **GLM / Zhipu** | GLM-5, GLM-4.7 (Global, China, Coding Plan) | LongerAgent-managed slots (`LONGERAGENT_GLM_*`); detects `GLM_*` during setup |
| **Ollama** | Any local Ollama model (dynamic discovery) | — |
| **oMLX** | Any local MLX model (dynamic discovery) | — |
| **LM Studio** | Any local GGUF model (dynamic discovery) | — |
| **OpenRouter** | Curated presets for Claude, GPT, Kimi, MiniMax, GLM, plus any custom model | `OPENROUTER_API_KEY` |

> \* **Kimi Coding Plan note:** The `kimi-code` endpoint (`api.kimi.com/coding/v1`) is currently restricted by Moonshot to whitelisted agents. You may receive a `403 Kimi For Coding is currently only available for Coding Agents` error. Use `kimi` or `kimi-cn` (standard API) instead.

## Tools

**15 built-in tools:**

`read_file` · `list_dir` · `glob` · `grep` · `edit_file` · `write_file` · `apply_patch` · `bash` · `bash_background` · `bash_output` · `kill_shell` · `diff` · `test` · `web_search` · `web_fetch`

`read_file` supports image files (PNG, JPG, GIF, WebP, etc.) on multimodal models — the agent can directly see and analyze images.

**8 orchestration tools:**

`spawn_agent` · `kill_agent` · `check_status` · `wait` · `show_context` · `summarize_context` · `ask` · `plan`

**Skills system** — Load reusable skill definitions as a dynamic `skill` tool. Manage with `/skills` (checkbox picker for enable/disable), hot-reload with `reload_skills`. Includes a built-in `skill-manager` that teaches the agent to search, download, and install new skills autonomously.

**MCP Integration** — Connect to Model Context Protocol servers for additional tools. Use `/mcp` to verify configured servers and inspect discovered tools before your first turn.

## Slash Commands

| Command | Description |
|---------|-------------|
| `/model` | Switch between configured models at runtime; can prompt for missing managed-provider keys |
| `/mcp` | Connect configured MCP servers on demand and list discovered tools |
| `/thinking` | Control thinking/reasoning depth per model |
| `/skills` | Enable/disable skills with a checkbox picker |
| `/resume` | Resume a previous session from its log |
| `/summarize` | Summarize older context segments to free up space |
| `/compact` | Full context reset with a continuation summary |

## Configuration

LongerAgent loads bundled defaults from the installed package and user overrides from `~/.longeragent/`.
`longeragent init` creates and updates the LongerAgent home directory, including managed API-key slots in `~/.longeragent/.env`.

```text
~/.longeragent/
├── tui-preferences.json   # Model selection, local provider config, preferences (auto-managed)
├── .env                   # API keys and managed provider slots (0600 perms)
├── mcp.json               # MCP server configurations (optional, user-edited)
├── auth.json              # OAuth tokens (auto-managed)
├── agent_templates/       # User template overrides
├── skills/                # User skills
└── prompts/               # User prompt overrides
```

## Architecture

LongerAgent is built around a **Session → Agent → Provider** pipeline:

- **Session** orchestrates the turn loop, message delivery, summarization, compaction, and sub-agent lifecycle
- **Session Log** is the single source of truth — 20+ entry types capture every runtime event; the TUI display and provider input are both projections of the same data
- **Agent** wraps a model + system prompt + tools into a reusable execution unit
- **Provider** adapters normalize streaming, reasoning, tool calls, and usage across 10 providers

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

## Development

```bash
pnpm install        # Install dependencies
pnpm dev            # Development mode (auto-reload)
pnpm build          # Build
pnpm test           # Run tests (vitest)
pnpm typecheck      # Type check
```

## Security

LongerAgent does not sandbox commands or require approval before file edits and shell execution. Use it in trusted environments and review what it does.

## License

[MIT](./LICENSE)
