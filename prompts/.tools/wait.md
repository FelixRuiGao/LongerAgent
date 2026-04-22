## `wait`

Block until a tracked worker changes state, a new message arrives, or the timeout expires. **Always prefer this when you have nothing else to do.**

- `seconds` (required, minimum 15): Wall-clock timeout in seconds.
- Returns early if ANY sub-session changes state, a tracked shell exits, or a new message arrives.
- Ordinary shell output does **not** wake `wait`; use `bash_output` to inspect logs.
- Returns any new messages and status information.

**As the main agent:**
> Spawned explorers to understand module structure. **`wait(seconds=60)`** — you need their results before acting.

**As a team member:**
> Sent a request to `implementer`. **`wait(seconds=60)`** — block until their reply arrives. Do not loop `send`.
