---
name: config-guide
description: Explains Fermi's configuration system, settings.json, local project settings, model tiers, and directory structure. Use when users ask about configuration, settings, how to set up providers, or project-local overrides.
---

# Fermi Configuration Guide

## Directory Structure

```
~/.fermi/                              # Global config
├── settings.json                      # User-editable settings (JSONC, supports comments)
├── state/                             # System-managed (do not edit)
│   ├── model-selection.json           #   Last /model selection
│   ├── oauth.json                     #   OAuth tokens
│   └── copilot-models.json            #   Copilot model cache
├── .env                               # API keys
├── skills/                            # Global skills
├── projects/                          # Session storage
└── AGENTS.md                          # Global persistent memory

{PROJECT}/.fermi/                      # Project-local (user creates manually)
├── settings.json                      # Local overrides (can be committed to git)
├── skills/                            # Project-local skills
├── AGENTS.md                          # Project memory (auto-gitignored)
└── .gitignore                         # Auto-generated
```

## settings.json

The single user-editable config file. Supports `//` and `/* */` comments.

```jsonc
{
  // Model configuration
  "default_model": "anthropic:claude-opus-4-6",  // Declarative default
  "thinking_level": "high",                       // Default thinking level
  "context_budget_percent": 100,                  // Main-session context budget percentage (1-100)

  // Sub-agent model tiers
  "model_tiers": {
    "high":   { "model": "anthropic:claude-opus-4-6", "thinking_level": "high" },
    "medium": { "model": "kimi-cn:kimi-k2.5",        "thinking_level": "medium" },
    "low":    { "model": "ollama:qwen3.5:9b",         "thinking_level": "off" }
  },

  // Provider registration
  "providers": {
    "anthropic": { "api_key_env": "ANTHROPIC_API_KEY" },
    "openai":    { "api_key_env": "OPENAI_API_KEY" },
    "lmstudio":  {
      "base_url": "http://localhost:1234/v1",
      "model": "qwen/qwen3.5-9b",
      "context_length": 131072
    }
  },

  // Display
  "accent_color": "#4b4bf0",

  // Skills
  "disabled_skills": [],

  // MCP Servers
  "mcp_servers": {
    "my-server": {
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@some/mcp-server"]
    }
  }
}
```

## Project-Local Settings

Create `{PROJECT}/.fermi/settings.json` to override global settings for a specific project. Only include the fields you want to override:

```jsonc
{
  "default_model": "anthropic:claude-opus-4-6",
  "model_tiers": {
    "low": { "model": "kimi-cn:kimi-k2.5", "thinking_level": "medium" }
  }
}
```

### Override Rules

| Type | Behavior |
|------|----------|
| Scalars (`default_model`, `thinking_level`, etc.) | Local replaces global |
| Objects (`model_tiers`, `mcp_servers`) | Per-key merge (local keys win) |
| Arrays (`disabled_skills`) | Local replaces global |
| `providers` | Global only, local value ignored |

## Model Tiers

Configure different model capability levels for sub-agents:

- Use `/tier` command in the TUI to configure interactively
- Or edit `model_tiers` in settings.json directly
- Sub-agents specify `model_level: "high"/"medium"/"low"` in spawn calls
- If a tier is not configured or fails, the sub-agent inherits the parent model

## Slash Commands

| Command | Purpose |
|---------|---------|
| `/model` | Select main model + thinking level |
| `/tier` | Configure sub-agent model tiers |
| `/local` | Add/discover local inference servers |

## First-Time Setup

Run `fermi init` to:
1. Configure providers (add API keys, set up local servers)
2. Select your main model and thinking level
3. Optionally configure sub-agent model tiers
