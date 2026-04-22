## `send`

Send a message to a sub-agent or teammate. Async — returns immediately with a confirmation, not a reply.

**As the main agent:**
- `to` (required): Target agent ID, or `"all"` (broadcast to all persistent agents).
- `content` (required): Message content.
- The target agent auto-activates if idle.
- One-shot sub-sessions cannot receive messages.
- If you need the agent's response, call `wait(seconds=60)` after sending.

> Sent a follow-up question to the researcher. **`wait(seconds=60)`** to get the response.

**As a team member:**
- `to` (required): Teammate agent ID, or `"all"` (broadcast to all teammates).
- `content` (required): Message content.
- To communicate with the parent session, use your turn output — do not use `send`.
