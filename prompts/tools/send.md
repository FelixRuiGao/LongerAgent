## `send`

Send a message to an agent. Async — returns immediately with a confirmation, not a reply.

- `to` (required): Target agent ID, `"main"` (parent session), or `"all"` (broadcast to all teammates).
- `content` (required): Message content.
- The target agent auto-activates if idle.
- One-shot sub-sessions cannot receive messages.
- If you need the agent's response, call `wait(seconds=60)` after sending.

> Sent a follow-up question to the researcher. **`wait(seconds=60)`** to get the response.
