# Model Switching

Fermi lets you switch between models at any point during a session. Thinking level is configured as part of the model switch flow.

## The `/model` Command

Type `/model` during a session to open a hierarchical picker:

```text
/model
```

The picker shows all configured providers and their models. Select one and the agent switches immediately for the remainder of the session.

For GLM, Kimi, and MiniMax, if you select a model whose key is missing, Fermi can prompt you to import a detected external env var or paste the key directly.

This is useful for:
- Starting with a fast/cheap model for exploration, then switching to a stronger model for implementation
- Moving to a cheaper model when the task becomes routine
- Testing how different models handle the same context

## Thinking Levels

After switching models, Fermi prompts you to select a thinking level (if the model supports multiple levels). The available levels vary by provider:

| Provider | Levels |
|----------|--------|
| **Anthropic (Claude 4.6+)** | off, low, medium, high, max |
| **Anthropic (Claude 4.5)** | off, low, medium, high |
| **OpenAI** | none, low, medium, high, xhigh |
| **GitHub Copilot** | follows the underlying model's levels |
| **Kimi** | off, on |
| **GLM** | off, on |
| **MiniMax** | always on (not configurable) |
| **DeepSeek** | off, on |

Higher reasoning depth produces more thorough analysis but uses more tokens and takes longer.

## Model Tiers for Sub-Agents

Use `/tier` to configure which models sub-agents use at different capability levels:

```text
/tier
```

This opens a picker where you assign specific models to three tiers:

| Tier | Typical use |
|------|-------------|
| **high** | Complex reasoning, architectural decisions |
| **medium** | Standard implementation work |
| **low** | Simple tasks — file listing, grep, basic edits |

When the agent spawns a sub-agent with `model_level="low"`, it uses the model assigned to the low tier. This saves cost on routine work while keeping the main agent on a powerful model.

## Adding More Models

Models come from the providers you configure during `fermi init`. To add more:

1. Re-run `fermi init` to add new providers
2. For local providers, start the server and re-run init to discover new models
3. For OpenRouter, any model available through their API can be used

For OpenAI (ChatGPT Login), use `fermi oauth` or `/codex` to authenticate. For GitHub Copilot, use `/copilot` to log in first.
