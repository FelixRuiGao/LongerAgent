# Vigil

<p align="center">
  <strong>Exploring agent autonomy.</strong>
</p>
<p align="center">
  English | <a href="./README.zh-CN.md">中文</a>
</p>
<p align="center">
  <a href="https://felixruigao.github.io/LongerAgent/"><img alt="Docs" src="https://img.shields.io/badge/docs-website-4b4bf0?style=flat-square" /></a>
  <a href="./LICENSE"><img alt="License" src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" /></a>
  <img alt="Author" src="https://img.shields.io/badge/author-Felix%20Rui%20Gao-4b4bf0?style=flat-square" />
</p>

LongerAgent is an OpenTUI-based TUI demo exploring a design philosophy: what if the system just provided the tools and safety net, and let the agent proactively manage its own context and workflow?

Parallel sub-agents investigating a codebase, an async message mid-task, and context summarization — all in one session:

https://github.com/user-attachments/assets/377fe648-d43c-45da-b111-9434b2a0dc61

---

## Try It

```bash
npm install -g longer-agent
longeragent init
longeragent
```

The setup wizard walks you through provider selection (Anthropic, OpenAI, Kimi, MiniMax, GLM, Ollama, oMLX, LM Studio, OpenRouter) and model selection.

> **Platform:** macOS. **Safety:** LongerAgent does not sandbox shell commands or file edits. Run it in trusted environments and review what it does.

### CLI

```text
longeragent                     # Start with auto-detected config
longeragent init                # Run setup wizard
longeragent oauth               # Log in to OpenAI via OAuth (device code / browser)
longeragent oauth status        # Check OAuth login status
longeragent oauth logout        # Log out
longeragent --templates <path>  # Use a specific templates directory
longeragent --verbose           # Enable debug logging
longeragent --version           # Show the current version
```

### Commands

| Command | Description |
|---------|-------------|
| `/model` | Switch between configured models at runtime; can prompt for missing managed-provider keys |
| `/mcp` | Connect configured MCP servers on demand and list discovered tools |
| `/thinking` | Control thinking/reasoning depth per model |
| `/skills` | Enable/disable skills with a checkbox picker |
| `/resume` | Resume a previous session from its log |
| `/summarize` | Summarize older context segments to free up space |
| `/compact` | Full context reset with a continuation summary |

---

## The Design Ideas

### Agent-Driven Context Management

LongerAgent gives the agent tools to inspect its own context distribution (`show_context`) and distill what it chooses (`distill_context`). Each conversation segment is internally tagged with a unique ID and a token-cost annotation, so the agent can make rational cost-benefit decisions about what to keep and what to let go. The system only steps in as a last-resort safety net.

Three layers work together: hint compression nudges the agent early, agent-initiated summarization gives it precise control, and auto-compact catches anything that slips through.

### Parallel Sub-Agents

Instead of doing everything sequentially, the agent can spawn sub-agents — each with its own context window and tool access — to explore or execute in parallel. Three built-in templates (`main`, `explorer`, `executor`) scope what each sub-agent can do. Results are delivered back to the main agent for synthesis.

### Interruptible Execution

You can type a message at any time — even while the agent is mid-task. Messages are queued and delivered at the next activation boundary. No need to wait, no need to restart.

### Persistent Memory

Two `AGENTS.md` files (global and project-level) and an Important Log survive across sessions and context resets. The agent reads them for continuity and writes to them to save long-term knowledge.

## What It Feels Like

LongerAgent is optimized for a specific workflow:

1. Start a real task, not a toy prompt.
2. Let the agent explore, edit, and test for a while.
3. Interrupt it with clarifications or side requests without losing momentum.
4. Keep the session alive by summarizing or compacting instead of restarting from scratch.

That combination is the core of the demo, more than any individual slash command or tool.

## Read More

- **[Design Philosophy Deep-Dive](https://felixruigao.hashnode.dev/exploring-agent-autonomy-building-a-coding-cli-that-manages-its-own-context)** — the ideas behind this demo in detail
- **[Documentation Site](https://felixruigao.github.io/LongerAgent/)** — full guides on context management, sub-agents, skills, providers, and more

---

<details>
<summary><strong>Reference</strong></summary>

### Supported Providers

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

### Tools

**13 built-in tools:**

`read_file` · `list_dir` · `glob` · `grep` · `edit_file` · `write_file` · `bash` · `bash_background` · `bash_output` · `kill_shell` · `time` · `web_search` · `web_fetch`

`read_file` supports image files (PNG, JPG, GIF, WebP, etc.) on multimodal models — the agent can directly see and analyze images.

**8 orchestration tools:**

`spawn` · `spawn_file` · `kill_agent` · `check_status` · `wait` · `show_context` · `distill_context` · `ask`

**Skills system** — Load reusable skill definitions as a dynamic `skill` tool. Manage with `/skills` (checkbox picker for enable/disable). Skills are auto-discovered each turn — install or remove skill directories and changes take effect immediately. Includes a built-in `skill-manager` that teaches the agent to search, download, and install new skills autonomously.

**MCP Integration** — Connect to Model Context Protocol servers for additional tools. Use `/mcp` to verify configured servers and inspect discovered tools before your first turn.

### Configuration

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

### Architecture

LongerAgent is built around a **Session → Agent → Provider** pipeline:

- **Session** orchestrates the turn loop, message delivery, summarization, compaction, and sub-agent lifecycle
- **Session Log** is the single source of truth — 20+ entry types capture every runtime event; the TUI display and provider input are both projections of the same data
- **Agent** wraps a model + system prompt + tools into a reusable execution unit
- **Provider** adapters normalize streaming, reasoning, tool calls, and usage across 10 providers

</details>

<details>
<summary><strong>Development</strong></summary>

```bash
pnpm install        # Install dependencies
pnpm dev            # Run the active OpenTUI development UI
pnpm build          # Build
pnpm test           # Run tests (vitest)
pnpm typecheck      # Type check
```

</details>

## License

[MIT](./LICENSE)
