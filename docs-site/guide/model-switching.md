# Model Switching

LongerAgent lets you switch between models and adjust reasoning depth at any point during a session.

## The `/model` Command

Type `/model` during a session to open a picker showing all configured models:

```text
/model
```

The picker displays each model with its provider and current availability status. Select a model and the agent switches immediately for the remainder of the session.

For GLM, Kimi, and MiniMax, if you select a model whose key is missing, LongerAgent can prompt you to import a detected external env var or paste the key directly, then continue the switch.

Inline API-key arguments such as `/model openai:gpt-5.4 key=...` are no longer supported. Use the picker flow or re-run `longeragent init`.

This is useful for:
- Starting with a fast model for exploration, then switching to a stronger model for implementation.
- Moving to a cheaper model when the task becomes routine.
- Testing how different models handle the same context.

Models are configured during `longeragent init`. Each provider you set up contributes its models to the picker. You can re-run `longeragent init` to add more providers. For the managed cloud providers above, `/model` can also finish the setup by prompting for the missing key. For OpenAI (ChatGPT Login), the picker uses your saved OAuth login from `~/.longeragent/auth.json`; if you are not logged in, run `longeragent oauth`.

## The `/thinking` Command

Use `/thinking` to control the reasoning depth of the current model:

```text
/thinking
```

This opens a picker with the available thinking levels for the active model. Levels vary by provider:

| Provider | Levels |
|----------|--------|
| **Anthropic (Claude 4.6)** | off, low, medium, high, max |
| **Anthropic (Claude 4.5)** | off, low, medium, high |
| **OpenAI** | none, low, medium, high, xhigh |
| **Kimi** | off, on |
| **GLM** | off, on |
| **MiniMax** | always on (not configurable) |

Higher reasoning depth produces more thorough analysis but uses more tokens and takes longer. Lower reasoning depth is faster and cheaper.

### When to Adjust Thinking

- **Raise it** for complex architectural decisions, debugging tricky issues, or multi-step refactors.
- **Lower it** for straightforward file edits, simple searches, or routine tasks.
- The agent operates fine at any level -- this is about cost and speed tradeoffs, not correctness.
