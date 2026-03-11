# Tools Reference

LongerAgent comes with 15 built-in tools and 8 orchestration tools. Additional tools can be added through the [Skills](/guide/skills) system and [MCP integration](/guide/mcp).

## Built-in Tools (15)

These tools are available to the agent in every session.

### File Operations

| Tool | Description |
|------|-------------|
| `read_file` | Read a file's contents. Supports text files and images (PNG, JPG, GIF, WebP) on multimodal models -- the agent can directly see and analyze images. |
| `write_file` | Write content to a file, creating it if it does not exist. |
| `edit_file` | Edit a file with targeted find-and-replace operations. |
| `apply_patch` | Apply a unified diff patch to one or more files. |
| `list_dir` | List the contents of a directory. |
| `glob` | Find files matching a glob pattern (e.g., `**/*.ts`). |
| `grep` | Search file contents with regular expressions. |
| `diff` | Show the diff between two files or a file and a string. |

### Shell

| Tool | Description |
|------|-------------|
| `bash` | Run a shell command and return its output. Has a 10-minute hard timeout and 200KB output cap per stream. |
| `bash_background` | Run a shell command in the background. Useful for starting dev servers or long-running processes. |
| `bash_output` | Read output from a background shell process. |
| `kill_shell` | Kill a running background shell process. |

### Testing

| Tool | Description |
|------|-------------|
| `test` | Run the project's test suite or a specific test file. |

### Web

| Tool | Description |
|------|-------------|
| `web_search` | Search the web. Uses the provider's native web search when available (OpenAI, Kimi, GLM), or falls back to a web search tool. |
| `web_fetch` | Fetch and read the content of a URL. |

## Orchestration Tools (8)

These tools manage sub-agents, context, and user interaction.

### Sub-Agent Management

| Tool | Description |
|------|-------------|
| `spawn_agent` | Spawn sub-agents from a YAML call file. See [Sub-Agents](/guide/sub-agents). |
| `kill_agent` | Kill one or more running sub-agents by ID. |
| `check_status` | Check the status of running sub-agents. |
| `wait` | Wait for specific sub-agents to complete. |

### Context Management

| Tool | Description |
|------|-------------|
| `show_context` | Inspect the current context distribution -- how much space each segment uses. The agent uses this to decide what to summarize. |
| `summarize_context` | Surgically compress selected context segments while preserving key decisions. |

### User Interaction

| Tool | Description |
|------|-------------|
| `ask` | Ask the user 1-4 structured questions with 1-4 options each. Used when the agent needs a decision before proceeding. |
| `plan` | Present a plan to the user for review before executing. |

## Skills Tool

When skills are enabled, a dynamic `skill` tool becomes available. This tool dispatches to the active skill's instructions. Manage skills with the `/skills` command or by asking the agent to install new ones.

The built-in `skill-manager` skill enables the agent to autonomously search for, download, and install new skills.

See [Skills](/guide/skills) for details.

## MCP Tools

MCP servers can provide any number of additional tools. These are configured in `~/.longeragent/mcp.json` and appear alongside the built-in tools automatically.

See [MCP Integration](/guide/mcp) for details.

## Tool Safety

LongerAgent does not sandbox tool execution. The `bash` tool runs shell commands directly, and file tools write to disk without confirmation. This is by design for productivity, but it means you should:

- Run LongerAgent in trusted environments.
- Review what the agent does, especially for destructive operations.
- Use the `explorer` sub-agent template for read-only investigation tasks.
