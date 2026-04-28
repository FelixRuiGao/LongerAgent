## `await_event`

Pause this turn until a runtime event arrives or the timeout expires. Runtime events include sub-agent completion, incoming messages, and tracked background shell exit. **Use this when you have delegated work and the next useful step depends on runtime events.**

- `seconds` (required, minimum 15): Wall-clock timeout in seconds.
- Returns early if any sub-session changes state, a tracked shell exits, or a new message arrives.
- Ordinary shell output does **not** wake `await_event`; use `bash_output` to inspect logs.
- Returns any new messages and status information.

> Spawned explorers to understand module structure. **`await_event(seconds=60)`** — you need their results before acting.

**Blocked approval:**
If every remaining sub-agent is blocked on user approval and repeated `await_event` calls only show the same blocked state, do not call `await_event` again. Return a final message now. The runtime will deliver a new message and start the next turn after the approval is resolved.
