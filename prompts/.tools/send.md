## `send`

Send a message to a persistent sub-agent. Async — returns immediately with a confirmation, not a reply.

- `to` (required): Target agent ID, or `"all"` (broadcast to all persistent agents).
- `content` (required): Message content.
- The target agent auto-activates if idle.
- One-shot sub-sessions cannot receive messages.
- If you need the agent's response, call `await_event(seconds=60)` after sending.

> Sent a follow-up question to the researcher. **`await_event(seconds=60)`** to get the response.
