## `send`

Send a follow-up message to a persistent sub-session. Async — returns immediately with a confirmation, not a reply.

- `to` (required): Target agent ID (must be a persistent sub-session).
- `content` (required): Message content.
- The target agent auto-activates if idle.
- One-shot sub-sessions cannot receive messages.
- If you need the agent's response, call `wait(agent="<id>")` after sending.

> Sent a follow-up question to the researcher. **`wait(seconds=60, agent="researcher")`** to get the response.
