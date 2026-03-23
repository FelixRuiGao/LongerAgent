## `send`

Send a follow-up message to an interactive sub-agent. Async — returns immediately with a confirmation, not a reply.

- `to` (required): Target agent ID (must be an interactive or team agent).
- `content` (required): Message content.
- The target agent auto-activates if idle.
- One-shot agents cannot receive messages — only interactive/team agents.
- If you need the agent's response, call `wait(agent="<id>")` after sending.

> Sent a follow-up question to the researcher. **`wait(seconds=60, agent="researcher")`** to get the response.
