# Sub-Agents

Fermi can spawn parallel sub-agents within a session. Each sub-agent has its own context window and tool access, runs concurrently with the main agent, and reports results back when finished.

## How It Works

1. The main agent calls `spawn` to create a sub-agent with a task.
2. The sub-agent runs in its own context, executing tools and producing output.
3. When it finishes, its result is delivered back to the main agent.
4. The main agent synthesizes results and continues.

## The `spawn` Tool

```text
spawn(id, task, mode, template?, template_path?, model_level?)
```

| Parameter | Required | Description |
|-----------|----------|-------------|
| `id` | Yes | Unique agent ID |
| `task` | Yes | Task description |
| `mode` | Yes | `oneshot` (single turn, returns result) or `persistent` (stays alive, receives messages) |
| `template` | No | Built-in template: `explorer`, `executor`, `reviewer` |
| `template_path` | No | Path to a custom template directory |
| `model_level` | No | `high`, `medium`, or `low` — selects from user-configured tiers |

## Templates

Four built-in templates define agent capabilities:

### `main`

Full-capability template. Has all built-in tools plus orchestration tools. Used when a sub-agent needs to coordinate further work.

### `explorer`

Read-only. Can read files, search, grep, and browse — but cannot edit files or run destructive commands. Use for investigation, code review, and research.

### `executor`

Task-focused. Has file editing and shell access, scoped to completing a specific task. Use for implementation work.

### `reviewer`

Verification template. Designed to check work produced by other agents. Use for code review and correctness checks.

## Agent Modes

### Oneshot

The agent runs once, produces output, and terminates. The result is delivered to the parent automatically.

```text
spawn(id="auth-check", template="explorer", mode="oneshot", task="Check how auth middleware validates tokens")
```

### Persistent

The agent stays alive after its initial task. The parent can send follow-up messages via the `send` tool. Useful for long-running coordination.

```text
spawn(id="monitor", mode="persistent", task="Watch the build output and report errors")
send(to="monitor", content="The build started — check for type errors")
```

## Model Tiers

Sub-agents can run on cheaper/faster models via the `model_level` parameter. Configure tiers with the `/tier` command:

```text
/tier
```

This opens a picker where you assign specific models to high, medium, and low tiers. Then when spawning:

```text
spawn(id="scout", template="explorer", mode="oneshot", model_level="low", task="List all .ts files in src/")
```

The sub-agent uses the model assigned to the "low" tier — saving cost on simple tasks.

## Orchestration Tools

| Tool | Description |
|------|-------------|
| `spawn` | Create a sub-agent with inline parameters |
| `send` | Send a message to a persistent child agent |
| `kill_agent` | Kill one or more running sub-agents by ID |
| `check_status` | View sub-agent status and background shell status |
| `await_event` | Pause until a runtime event arrives or timeout expires |

## Custom Templates

Override built-in templates or create new ones by placing directories in `~/.fermi/agent_templates/`:

```text
~/.fermi/agent_templates/
├── main/
│   ├── agent.yaml
│   └── system_prompt.md
├── explorer/
│   ├── agent.yaml
│   └── system_prompt.md
└── my-custom-template/
    ├── agent.yaml
    └── system_prompt.md
```

Project-local templates (`.fermi/agent_templates/` in the project root) take highest priority.

## Practical Tips

- **Use `explorer` for investigation.** When you want the agent to look at something without changing it — safer and uses less context.
- **Use `model_level` to save cost.** Simple tasks (file listing, grep) do not need the most expensive model.
- **Prefer `oneshot` mode** unless you need ongoing interaction with the sub-agent.
- **Let the main agent decide.** Describe what you want done — the agent chooses when to spawn, how to split work, and which template to use.
- **Check progress** by asking the main agent. It will use `check_status` to report back.
