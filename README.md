# Fermi

<p align="center">
  <strong>Do more with less context.</strong>
</p>
<p align="center">
  English | <a href="./README.zh-CN.md">中文</a>
</p>
<p align="center">
  <a href="https://felixruigao.github.io/LongerAgent/"><img alt="Docs" src="https://img.shields.io/badge/docs-website-4b4bf0?style=flat-square" /></a>
  <a href="./LICENSE"><img alt="License" src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" /></a>
  <img alt="Author" src="https://img.shields.io/badge/author-Felix%20Rui%20Gao-4b4bf0?style=flat-square" />
</p>

Fermi is a terminal AI coding agent that tries to squeeze the most out of every model by using less context to do more work. It follows an **Explore → Plan → Execute → Review** workflow, supports communicating agent teams, and lets the agent summarize and distill context it deems no longer relevant — even a single tool result — so sessions stay productive longer.

The TUI is built on [OpenTUI](https://github.com/anomalyco/opentui).

> **Platform:** macOS. **Safety:** Fermi does not sandbox shell commands or file edits. Run it in trusted environments and review what it does.

## Install

Requires [Bun](https://bun.com) 1.3 or later.

```bash
bun install -g fermi-code
fermi init
fermi
```

The setup wizard walks you through provider and model selection.

### CLI

```text
fermi                       # Start with auto-detected config
fermi init                  # Run setup wizard
fermi oauth                 # Log in to OpenAI via OAuth (device code / browser)
fermi oauth status          # Check OAuth login status
fermi oauth logout          # Log out
fermi --templates <path>    # Use a specific templates directory
fermi --verbose             # Enable debug logging
fermi --version             # Show the current version
```

### Commands

| Command | Description |
|---------|-------------|
| `/model` | Switch between configured models at runtime |
| `/mcp` | Connect configured MCP servers on demand and list discovered tools |
| `/thinking` | Control thinking/reasoning depth per model |
| `/skills` | Enable/disable skills with a checkbox picker |
| `/sessions` | Resume a previous session (alias: `/resume`) |
| `/summarize` | Summarize older context segments to free up space |
| `/compact` | Full context reset with a continuation summary |
| `/codex` | OpenAI ChatGPT login |
| `/copilot` | GitHub Copilot login |
| `/agents` | Show agent list |
| `/rename` | Rename current session |
| `/raw` | Toggle markdown raw/rendered mode (alias: `/md`) |
| `/new` | Start a new session |

---

## Design

### Explore → Plan → Execute → Review

Fermi structures work around four phases. The main agent explores the problem space, writes a plan (`plan.md` with checkpoints), spawns executor sub-agents to carry out the work, and spawns reviewers to verify results. Each phase feeds into the next, keeping the overall workflow focused and auditable.

### Communicating Agent Teams

Sub-agents aren't isolated workers — they form a team that can communicate with each other. Each agent (explorer, executor, reviewer) has its own context window and tool access, runs in parallel, and reports results back. The main agent synthesizes and coordinates.

### Context Management

Fermi gives the agent tools to inspect its own context distribution (`show_context`) and distill what it chooses (`distill_context`). Each conversation segment is tagged with a unique ID and token-cost annotation, so the agent can make cost-benefit decisions about what to keep.

Three layers work together: hint compression nudges the agent early, agent-initiated summarization gives precise control, and auto-compact catches anything that slips through.

### Interruptible Execution

You can type a message at any time — even while the agent is mid-task. Messages are queued and delivered at the next activation boundary.

### Persistent Memory

Two `AGENTS.md` files (global and project-level) survive across sessions and context resets. The agent reads them for continuity and writes to them to save long-term knowledge.

---

<details>
<summary><strong>Reference</strong></summary>

### Supported Providers

| Provider | Auth |
|----------|------|
| **Anthropic** | `ANTHROPIC_API_KEY` |
| **OpenAI** | `OPENAI_API_KEY` or OAuth |
| **GitHub Copilot** | `/copilot` login |
| **Kimi / Moonshot** | Fermi-managed slots (`FERMI_KIMI_*`) |
| **MiniMax** | Fermi-managed slots (`FERMI_MINIMAX_*`) |
| **GLM / Zhipu** | Fermi-managed slots (`FERMI_GLM_*`) |
| **Ollama** | — |
| **oMLX** | — |
| **LM Studio** | — |
| **OpenRouter** | `OPENROUTER_API_KEY` |

### Tools

**13 built-in tools:**
`read_file` · `list_dir` · `glob` · `grep` · `edit_file` · `write_file` · `bash` · `bash_background` · `bash_output` · `kill_shell` · `time` · `web_search` · `web_fetch`

`read_file` supports image files (PNG, JPG, GIF, WebP) on multimodal models.

**8 orchestration tools:**
`spawn` · `spawn_file` · `kill_agent` · `check_status` · `wait` · `show_context` · `distill_context` · `ask`

**Skills system** — Load reusable skill definitions as a dynamic `skill` tool. Manage with `/skills`. Skills are auto-discovered each turn. Includes a built-in `skill-manager` that teaches the agent to search, download, and install new skills.

**MCP Integration** — Connect to Model Context Protocol servers for additional tools. Use `/mcp` to inspect configured servers.

### Configuration

```text
~/.fermi/
├── tui-preferences.json   # Model selection, provider config, preferences
├── .env                   # API keys and managed provider slots (0600 perms)
├── mcp.json               # MCP server configurations (optional)
├── state/
│   └── oauth.json         # OAuth tokens
├── agent_templates/       # User template overrides
├── skills/                # User skills
└── prompts/               # User prompt overrides
```

### Architecture

Fermi is built around a **Session → Agent → Provider** pipeline:

- **Session** orchestrates the turn loop, message delivery, summarization, compaction, and sub-agent lifecycle
- **Session Log** is the single source of truth — 20+ entry types capture every runtime event; the TUI display and provider input are both projections of the same data
- **Agent** wraps a model + system prompt + tools into a reusable execution unit
- **Provider** adapters normalize streaming, reasoning, tool calls, and usage across all supported providers

</details>

<details>
<summary><strong>Development</strong></summary>

```bash
bun install         # Install dependencies
bun run dev         # Run the TUI (OpenTUI)
bun run build       # Build
bun test            # Run tests (bun:test)
bun run typecheck   # Type check
```

</details>

## License

[MIT](./LICENSE)

The TUI is built on [OpenTUI](https://github.com/anomalyco/opentui) (MIT). See [`opentui-src/forked/LICENSE.opentui`](opentui-src/forked/LICENSE.opentui) for the original license.
