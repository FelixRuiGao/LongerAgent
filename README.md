# Fermi

<p align="center">
  <strong>The coding agent that compresses its own memory.</strong>
</p>
<p align="center">
  English | <a href="./README.zh-CN.md">中文</a>
</p>
<p align="center">
  <a href="https://felixruigao.github.io/Fermi/"><img alt="Docs" src="https://img.shields.io/badge/docs-website-4b4bf0?style=flat-square" /></a>
  <a href="./LICENSE"><img alt="License" src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" /></a>
</p>

<!-- MEDIA: Hero screenshot — TUI mid-session with context annotations visible, showing the agent working on a real task -->

Fermi is a terminal AI coding agent that can run for hours without losing important context. The agent inspects its own context window, decides what is still valuable, and surgically compresses the rest — down to a single tool call result. No blind resets, no lost decisions.

> **Platform:** macOS (Apple Silicon). **License:** MIT.

## Install

```bash
bun install -g fermi-code
fermi init      # setup wizard — pick providers, models, API keys
fermi           # start a session
```

Requires [Bun](https://bun.sh) 1.3+.

## Context Management

The core feature. The agent has two tools for inspecting and compressing its own context:

| Tool | What it does |
|------|-------------|
| `show_context` | Display a context map — all groups with token sizes, types, and inline annotations |
| `summarize` | Compress selected context groups — extract decisions and facts, discard the rest |

The user can also intervene directly:

| Command | What it does |
|---------|-------------|
| `/summarize` | Interactive range picker — select turns, provide a focus prompt |
| `/compact` | Full context reset with continuation summary |

<!-- MEDIA: Two-panel comparison — left: /summarize interactive picker UI; right: agent calling show_context → summarize autonomously -->

Three layers prevent context from ever silently overflowing: system hints nudge early (60%), agent-initiated summarization gives precise control, and auto-compact (85%) catches anything that slips through.

[Full context management guide →](https://felixruigao.github.io/Fermi/guide/context)

## Async Messaging

Type messages at any time — even while the agent is mid-task. Messages queue and deliver at the next activation boundary. No need to wait for the agent to finish.

## Sub-Agents

Spawn parallel workers with their own context windows:

```
spawn(id="auth-check", template="explorer", mode="oneshot", model_level="low", task="...")
```

- **Templates:** `explorer` (read-only), `executor` (task-focused), `reviewer` (verification)
- **Model tiers:** Assign high/medium/low models via `/tier` — save cost on simple tasks
- **Modes:** `oneshot` (run once, return result) or `persistent` (stays alive, receives messages)

## Rewind & Fork

- `/rewind` — roll back to any previous turn. Reverts conversation **and** file system state (tracked edits, bash mutations)
- `/fork` — branch the current session into a new direction

---

## Providers

Anthropic · OpenAI · GitHub Copilot · DeepSeek · Kimi · MiniMax · GLM · Xiaomi · OpenRouter · Ollama · oMLX · LM Studio

Cloud or local, your choice. Switch at runtime with `/model`. `fermi init` handles setup.

[Provider setup guide →](https://felixruigao.github.io/Fermi/providers/)

## Key Commands

`/model` switch model · `/summarize` compress context · `/compact` full reset · `/rewind` undo turns + files · `/permission` safety mode · `/tier` sub-agent models · `/session` resume · `/fork` branch session · `/skills` manage skills · `/mcp` MCP tools

[Full command reference →](https://felixruigao.github.io/Fermi/guide/commands)

## Limitations

- **macOS + Apple Silicon only** — no Windows or Linux support
- **No sandbox** — shell commands and file edits execute directly (use `/permission` to control)
- **Third-party coding plans** (Kimi-Code, GLM-Code) use provider-side whitelists and may reject requests

## Documentation

Full documentation: **[felixruigao.github.io/Fermi](https://felixruigao.github.io/Fermi/)**

## Development

```bash
bun install         # Install dependencies
bun run dev         # Run the TUI (OpenTUI)
bun run build       # Build binary
bun test            # Run tests
bun run typecheck   # Type check
```

## License

[MIT](./LICENSE)

The TUI is built on [OpenTUI](https://github.com/anomalyco/opentui) (MIT). See [`opentui-src/forked/LICENSE.opentui`](opentui-src/forked/LICENSE.opentui).
