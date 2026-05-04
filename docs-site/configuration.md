# Configuration

Fermi loads bundled defaults from the installed package and user overrides from `~/.fermi/`. Run `fermi init` to create the initial configuration.

## Directory Structure

```text
~/.fermi/
├── tui-preferences.json   # Model selection, local provider config, preferences
├── .env                   # API keys and managed provider slots (0600 permissions)
├── mcp.json               # MCP server configurations (optional, user-edited)
├── auth.json              # OAuth tokens (auto-managed)
├── agent_templates/       # User template overrides
├── hooks/                 # User hooks (global)
├── skills/                # User skills
└── prompts/               # User prompt overrides
```

## tui-preferences.json

The primary configuration file. Created and managed by `fermi init`. Stores:

- Model selection (provider, model ID, thinking level)
- Local provider configurations (base URL, context length)
- UI preferences (accent color, raw mode)
- Context budget percent

This file is auto-managed. While you can edit it by hand, running `fermi init` or using `/model` is the recommended way to make changes.

### Notable Settings

| Setting | Type | Description |
|---------|------|-------------|
| `context_budget_percent` | number (1–100) | Restricts effective context to this percentage of model max. Default: 100. |

## .env

API keys stored with `0600` permissions. The init wizard creates it automatically.

```bash
# Example ~/.fermi/.env
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...
OPENROUTER_API_KEY=sk-or-...
FERMI_DEEPSEEK_API_KEY=...
FERMI_XIAOMI_API_KEY=...
FERMI_GLM_CODE_API_KEY=...
FERMI_KIMI_API_KEY=...
FERMI_MINIMAX_CN_API_KEY=...
```

For Kimi, MiniMax, GLM, DeepSeek, and Xiaomi, Fermi stores endpoint-specific managed slots and resolves them at startup. External env vars (e.g., `MOONSHOT_API_KEY`) are only detected and imported during `fermi init` or when `/model` prompts for a missing key.

OpenAI (ChatGPT Login) and GitHub Copilot use OAuth flows instead of API keys.

## mcp.json

Optional. Configure MCP servers for additional tools. Create this file manually.

```json
{
  "server-name": {
    "transport": "stdio",
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-something"],
    "env": {
      "API_KEY": "${MY_API_KEY}"
    }
  }
}
```

See [MCP Integration](/guide/mcp) for the full reference.

## auth.json

Auto-managed. Stores OAuth tokens for the ChatGPT login flow. Use `fermi oauth` commands to manage.

## agent_templates/

Override built-in sub-agent templates or add new ones:

```text
~/.fermi/agent_templates/
├── main/
│   ├── agent.yaml
│   └── system_prompt.md
├── explorer/
│   ├── agent.yaml
│   └── system_prompt.md
├── executor/
│   ├── agent.yaml
│   └── system_prompt.md
└── reviewer/
    ├── agent.yaml
    └── system_prompt.md
```

Templates here override bundled defaults. Only the ones you place are overridden — the rest fall through.

Project-local templates (`.fermi/agent_templates/` in the project root) take highest priority.

## skills/

User-installed skills. Each skill is a directory containing a `SKILL.md` file:

```text
~/.fermi/skills/
├── explain-code/
│   └── SKILL.md
├── skill-manager/
│   └── SKILL.md
└── .staging/           # Temporary work area (ignored by skill loader)
```

See [Skills](/guide/skills) for details.

## AGENTS.md Files

Two `AGENTS.md` files provide persistent memory across sessions:

- **`~/AGENTS.md`** — Global preferences across all projects
- **`<project>/AGENTS.md`** — Project-specific patterns and conventions

These live in your home directory and project root, not inside `~/.fermi/`. The agent reads them every turn and can write to them.

## CLI Flags

```text
fermi --version           # Show version
fermi --templates <path>  # Use a specific templates directory
fermi --verbose           # Enable debug logging
```

## Asset Discovery Priority

Templates, prompts, and skills are discovered in this order:

1. **CLI flag** (e.g., `--templates`)
2. **Project-local** (`.fermi/` in the current working directory)
3. **User-global** (`~/.fermi/`)
4. **Bundled defaults** (installed package)

Project-local overrides take priority over user-global, which takes priority over bundled.
