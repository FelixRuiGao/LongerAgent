## `wait`

Block until a tracked worker changes state, a new message arrives, or the timeout expires. Tracked workers include sub-agents and background shells. **Always prefer this when you have nothing else to do.**

- `seconds` (required, minimum 15): How long to wait.
  - Without `agent`: wall-clock timeout.
  - With `agent`: measures that agent's work time.
- `agent` (optional): Specific agent ID to wait for.
- `shell` (optional): Specific background shell ID to monitor.
- Returns early if ANY agent completes, a tracked shell exits, or a new message arrives.
- Ordinary shell output does **not** wake `wait`; use `bash_output` to inspect logs.
- Returns status report with any new messages, sub-agent status, and shell status.

> Spawned explorers to understand module structure. **`wait(seconds=60)`** — you need their results before acting.

> Waiting specifically for `auth-explorer`? **`wait(seconds=120, agent="auth-explorer")`**.
