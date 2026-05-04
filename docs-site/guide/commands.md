# Slash Commands

Slash commands are typed directly in the input during a session. They control context, models, permissions, and session lifecycle.

## Command Reference

| Command | Aliases | Description |
|---------|---------|-------------|
| `/help` | | Show commands and keyboard shortcuts |
| `/model` | | Switch between configured models |
| `/tier` | | Configure sub-agent model tiers (high/medium/low) |
| `/permission` | | Set permission mode (read_only / reversible / yolo) |
| `/summarize` | | Interactively summarize older context |
| `/compact` | | Full context reset with continuation summary |
| `/rewind` | `/undo` | Rewind to a previous turn (reverts conversation + files) |
| `/session` | `/resume` | Resume a previous session |
| `/new` | | Start a new session |
| `/fork` | | Fork current session into a new branch |
| `/rename` | | Rename current session |
| `/skills` | | Enable/disable skills (checkbox picker) |
| `/mcp` | | Show MCP server status and tools |
| `/agents` | | Show active agent list |
| `/codex` | | OpenAI ChatGPT OAuth login |
| `/copilot` | | GitHub Copilot login |
| `/hooks` | | Show registered hooks |
| `/copy` | | Copy the agent's most recent text response |
| `/raw` | `/md` | Toggle markdown raw/rendered mode |
| `/quit` | `/exit` | Exit the application |

## Context Commands

### `/summarize`

Opens an interactive range picker:

1. Select the **start** turn
2. Select the **end** turn
3. Optionally provide a **focus prompt** — instructions about what to preserve

The selected range is converted to context IDs and summarized. Key decisions and findings are preserved; the rest is discarded.

```text
/summarize
```

See [Context Management](/guide/context) for details.

### `/compact`

Full context reset with a continuation summary. Optionally provide instructions:

```text
/compact
/compact Preserve the DB schema decisions
```

After compact, the agent starts with a fresh context window containing only the continuation summary and AGENTS.md files.

### `/rewind`

Roll back to a previous turn. Opens a picker showing turn history. Reverts both the conversation **and** file system changes made after that turn.

```text
/rewind
```

File revert uses tracked mutations (edits, writes, bash mkdir/cp/mv) with conflict detection — if a file was modified externally after the agent changed it, the rewind skips that file and reports the conflict.

## Model Commands

### `/model`

Opens a hierarchical picker showing all configured providers and models. Select one to switch immediately.

For providers with missing API keys (GLM, Kimi, MiniMax), selecting a model can prompt you to paste or import the key on the spot.

### `/tier`

Configure which models sub-agents use at each tier level (high, medium, low). When the agent spawns a sub-agent with `model_level="low"`, it uses the model you assigned to the low tier.

## Permission & Safety

### `/permission`

Set the permission mode for tool execution:

| Mode | Behavior |
|------|----------|
| `read_only` | Only read tools auto-allowed; all writes require approval |
| `reversible` | Read + reversible writes auto-allowed |
| `yolo` | Everything auto-allowed except catastrophic operations |

### `/hooks`

Show all registered hooks and their configuration. Hooks are shell commands that run in response to events (PreToolUse, PostToolUse, UserPromptSubmit, etc.).

## Session Commands

### `/session`

Resume a previous session. Shows a list of saved sessions with timestamps. Select one to restore its full conversation state.

```text
/session
/session <id>
```

### `/new`

Start a new session. The current session is auto-saved first.

### `/fork`

Fork the current session into a new branch — creates a copy of the current state that you can take in a different direction.

### `/rename`

Give the current session a descriptive name for easier identification in the session list.

## Other Commands

### `/skills`

Opens a checkbox picker to enable or disable installed skills. Skills are auto-discovered from `~/.fermi/skills/` each turn.

### `/mcp`

Connects configured MCP servers and lists discovered tools. Useful as a health check before starting work.

### `/agents`

Shows the list of currently active agents (main agent and any running sub-agents) with their status.

### `/codex` / `/copilot`

OAuth login flows for OpenAI (ChatGPT) and GitHub Copilot respectively.

### `/copy`

Copy the agent's most recent text response to the system clipboard.

### `/raw`

Toggle between rendered markdown and raw markdown display. Also available as `/md`.

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| Enter | Send message |
| Option+Enter | Insert newline |
| Ctrl+N | Insert newline |
| Ctrl+G | Toggle markdown raw view |
| Cmd+Delete | Delete to line start (Ghostty/kitty protocol) |
| Alt+Backspace / Ctrl+W | Delete previous word |
| Ctrl+C | Cancel / Exit |
| @filename | Attach file |
