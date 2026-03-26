# Sub-Agents

LongerAgent can spawn parallel sub-agents within a session. Sub-agents run concurrently, each with their own context and tool access, and report back to the main agent when done.

## Spawning Sub-Agents

There are two tools for spawning sub-agents:

### `spawn` — Single Agent (Preferred)

For most cases, the agent uses `spawn` to create a single sub-agent directly:

```text
You: investigate the auth module
```

The agent calls `spawn(id="auth-explorer", template="explorer", mode="oneshot", task="...")` — one tool call, no file needed.

### `spawn_file` — Multiple Agents / Teams

For spawning multiple agents in parallel or creating teams, define tasks in a YAML call file:

```yaml
# tasks.yaml
agents:
  - id: research
    template: explorer
    mode: oneshot
    task: "Investigate how authentication works in this codebase"
  - id: refactor
    template: executor
    mode: oneshot
    task: "Rename all legacy API endpoints to v2"
```

The agent writes this file to its session artifacts directory and calls `spawn_file(file="tasks.yaml")`.

## Templates

Each sub-agent is created from a template that defines its system prompt and available tools. Three built-in templates are available:

### `main`

The full-capability template. Has access to all 15 built-in tools plus orchestration tools. Use this when the sub-agent needs to do everything the main agent can do.

### `explorer`

A read-only template. Has access to file reading, searching, and analysis tools, but cannot edit files or run destructive commands. Use this for investigation, code review, and research tasks.

### `executor`

A task-focused template. Has file editing and shell access but is scoped to completing a specific task. Use this for implementation work like refactoring, renaming, or applying changes.

## Orchestration Tools

The main agent has several tools for managing sub-agents:

| Tool | Description |
|------|-------------|
| `spawn` | Spawn a single sub-agent with inline parameters |
| `spawn_file` | Spawn multiple sub-agents or teams from a YAML call file |
| `kill_agent` | Kill one or more running sub-agents by ID |
| `check_status` | Check the status of running sub-agents |
| `wait` | Wait for specific sub-agents to complete |

## How It Works

1. The main agent calls `spawn` (single agent) or writes a YAML call file and calls `spawn_file` (multiple agents).
2. Sub-agents run concurrently, each in their own agent loop with their own context.
3. When a sub-agent finishes, its results are delivered back to the main agent.
4. The main agent synthesizes the results and continues.

Sub-agents share the same model and provider as the main agent. They have access to the same filesystem and project, but maintain separate conversation contexts.

## Custom Templates

You can override the built-in templates by placing custom versions in `~/.longeragent/agent_templates/`:

```text
~/.longeragent/agent_templates/
├── main/
│   └── system_prompt.md
├── explorer/
│   └── system_prompt.md
└── executor/
    └── system_prompt.md
```

Custom templates follow the same format as the built-in ones. The system prompt is a markdown file that defines the agent's behavior, available tools, and constraints.

## Practical Tips

- **Use `explorer` for investigation.** When you want the agent to look at something without changing it, the explorer template is safer and faster.
- **Use `executor` for scoped changes.** Give it a clear, well-defined task. The executor template is optimized for completing a single task and reporting back.
- **Let the main agent coordinate.** The main agent decides when to spawn, how to split work, and how to synthesize results. You just describe what you want done.
- **Check on progress.** You can ask the main agent about sub-agent status at any time, and it will use `check_status` to report back.
