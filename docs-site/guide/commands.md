# Slash Commands

Slash commands are typed directly in the chat input during a session. They control session behavior, model selection, and context management.

## Command Reference

| Command | Description |
|---------|-------------|
| `/model` | Switch between configured models at runtime |
| `/mcp` | Connect configured MCP servers and list discovered tools |
| `/thinking` | Control thinking/reasoning depth per model |
| `/skills` | Enable/disable skills with a checkbox picker |
| `/resume` | Resume a previous session from its log |
| `/summarize` | Summarize older context segments to free up space |
| `/compact` | Full context reset with a continuation summary |

## `/model`

Opens a picker showing all configured models. Select one to switch the active model for the remainder of the session.

```text
/model
```

Models come from the providers you set up during `longeragent init`. If you need a model that is not listed, re-run the init wizard to add more providers. For GLM, Kimi, and MiniMax, selecting a model with a missing key can prompt you to import a detected env var or paste the key directly.

Inline API-key arguments such as `/model openai:gpt-5.4 key=...` or `api_key=...` are no longer supported. Use the picker flow or re-run `longeragent init`.

See [Model Switching](/guide/model-switching) for details.

## `/mcp`

Connects the MCP servers configured in `~/.longeragent/mcp.json` and prints the discovered tool list.

```text
/mcp
```

This is useful as a quick health check before your first agent turn. If a server is misconfigured or not exposing tools, `/mcp` will show that immediately.

See [MCP Integration](/guide/mcp) for details.

## `/thinking`

Opens a picker showing the available reasoning levels for the current model.

```text
/thinking
```

Levels vary by provider. For example, Anthropic Claude 4.6 supports: off, low, medium, high, max. OpenAI models support: none, low, medium, high, xhigh.

See [Model Switching](/guide/model-switching) for the full table.

## `/skills`

Opens a checkbox picker where you can toggle skills on or off.

```text
/skills
```

Enabled skills are loaded as dynamic tools that the agent can use. Disabled skills are ignored.

See [Skills](/guide/skills) for details.

## `/resume`

Resume a previous session from its session log.

```text
/resume
```

LongerAgent keeps session logs that record every runtime event. The `/resume` command lets you pick a previous session and continue from where it left off.

## `/summarize`

Summarize older context segments to free up space. You can optionally provide instructions about what to preserve.

```text
/summarize
/summarize Keep the auth refactor details
/summarize Preserve file references and test results
```

Summarization compresses selected segments while keeping key decisions and findings intact. It is a lighter alternative to `/compact` -- use it when context is growing but you do not need a full reset.

See [Context Management](/guide/context) for details.

## `/compact`

Full context reset with a continuation summary. You can optionally provide instructions about what to preserve.

```text
/compact
/compact Preserve the DB schema decisions
```

After compaction, the agent starts with a fresh context window containing only the continuation summary, the Important Log, and AGENTS.md files. Use this when the session is getting slow or when you want a clean slate.

See [Context Management](/guide/context) for details.
