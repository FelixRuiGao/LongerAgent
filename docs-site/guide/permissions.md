# Permissions & Hooks

Fermi provides two systems for controlling agent behavior: a permission system that gates tool execution, and a hook system that lets you run custom commands in response to runtime events.

## Permission Modes

Set the mode with `/permission` during a session:

| Mode | Auto-allowed | Asks approval for |
|------|-------------|-------------------|
| `read_only` | Read operations (read_file, list_dir, glob, grep) | All writes and shell commands |
| `reversible` | Read + reversible writes (edit_file, write_file to new files) | Destructive operations |
| `yolo` | Everything except catastrophic | rm -rf, force push, etc. |

### How Classification Works

The permission system uses tree-sitter to parse bash commands and classify them into risk tiers:

- **read** — ls, cat, grep, git status
- **write_reversible** — mkdir, cp, git add
- **write_potent** — rm (single file), mv, git commit
- **write_danger** — rm -rf, git push --force, operations on broad paths
- **catastrophic** — dd to device files, rm targeting / or $HOME (always requires approval even in yolo mode)

File tools are classified by their operation type: `read_file` is always read, `edit_file` is write_reversible, `bash` depends on the command content.

### Permission Rules

You can save rules to avoid repeated approval prompts. When the system asks for approval, it offers to remember your choice. Rules are stored per-project.

## Hooks

Hooks are shell commands that execute in response to runtime events. They allow custom automation, validation, and context injection.

### Supported Events

| Event | When it fires | Can decide? |
|-------|--------------|-------------|
| `SessionStart` | Session begins | Yes (fail-closed) |
| `SessionEnd` | Session ends | No |
| `UserPromptSubmit` | User sends a message | Yes |
| `PreToolUse` | Before a tool executes | Yes |
| `PostToolUse` | After a tool succeeds | No |
| `PostToolUseFailure` | After a tool fails | No |
| `SubagentStart` | Sub-agent spawned | No |
| `SubagentStop` | Sub-agent finished | No |
| `Stop` | Agent turn ends | No |

### Decision Events

Hooks on decision events (`UserPromptSubmit`, `PreToolUse`) can approve or deny the action by returning a JSON `decision` field. If a hook denies, the action is blocked.

### Context Injection

Hooks on most events can inject additional context via the `additionalContext` field. This context is included in the agent's next prompt.

### Input Update

Hooks on `PreToolUse` can modify tool arguments via the `updatedInput` field before execution.

### Configuration

Hooks live in subdirectories of `~/.fermi/hooks/` (global) or `<project>/.fermi/hooks/` (project-scoped). Each hook is a directory containing a `hook.json` manifest:

```json
{
  "name": "my-hook",
  "type": "command",
  "event": "PreToolUse",
  "command": "/path/to/script.sh",
  "failClosed": true
}
```

Optional fields: `args` (string array), `env` (key-value), `matcher` (filter by tool names or agent IDs), `timeoutMs` (default 10000), `disabled`.

When `failClosed` is true, hook failure (crash, timeout) is treated as denial. Supported on: SessionStart, UserPromptSubmit, PreToolUse.

### Viewing Hooks

Use `/hooks` during a session to see all registered hooks and their configuration.
