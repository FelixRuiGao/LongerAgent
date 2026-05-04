# MCP Integration

Fermi supports the [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) for connecting to external tool servers. MCP servers provide additional tools that the agent can use alongside its built-in tools.

## Configuration

MCP servers are configured in `~/.fermi/mcp.json`. This file is optional and user-edited (it is not created by `fermi init`).

### Format

The file is a JSON object where each key is a server name and each value is a server configuration:

```json
{
  "filesystem": {
    "transport": "stdio",
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/allowed/dir"]
  },
  "github": {
    "transport": "stdio",
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-github"],
    "env": {
      "GITHUB_TOKEN": "${GITHUB_TOKEN}"
    }
  }
}
```

### Configuration Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `transport` | `"stdio"` or `"sse"` | No | Transport protocol. Default: `"stdio"`. |
| `command` | string | Yes (stdio) | The command to run the MCP server. |
| `args` | string[] | No | Arguments passed to the command. |
| `url` | string | Yes (sse) | URL for SSE transport servers. |
| `env` | object | No | Environment variables passed to the server process. Supports `${VAR}` syntax to reference your shell environment. |
| `env_allowlist` | string[] | No | List of environment variable names to pass through from the parent process. |
| `sensitive_tools` | string[] | No | Tool names that should be treated as sensitive (may require extra confirmation). |

### Environment Variable Resolution

Environment variables in the `env` field support the `${VAR}` syntax:

```json
{
  "env": {
    "API_KEY": "${MY_API_KEY}"
  }
}
```

This resolves `${MY_API_KEY}` from your shell environment at startup. If the variable is not set, Fermi will throw an error.

## Transport Types

### stdio (Default)

The most common transport. Fermi spawns the MCP server as a child process and communicates via stdin/stdout.

```json
{
  "my-server": {
    "transport": "stdio",
    "command": "node",
    "args": ["path/to/server.js"]
  }
}
```

### SSE

For servers that run as a separate HTTP service. Fermi connects to the server's SSE endpoint.

```json
{
  "remote-server": {
    "transport": "sse",
    "url": "http://localhost:3000/sse"
  }
}
```

## Using MCP Tools

Once configured, MCP tools are available to the agent automatically. They appear alongside the built-in tools. You do not need to do anything special to use them -- the agent discovers and calls MCP tools as needed.

You can also run `/mcp` inside Fermi to connect the configured servers on demand and list the discovered tools. This works before your first agent turn, which makes it a useful quick verification step.

## Example: Adding a Database Tool

```json
{
  "sqlite": {
    "transport": "stdio",
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-sqlite", "path/to/database.db"]
  }
}
```

After saving this to `~/.fermi/mcp.json` and restarting Fermi, run `/mcp` to verify the SQLite tools were discovered. The agent will then be able to call them during normal turns.
