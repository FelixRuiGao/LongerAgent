## `plan`

Always create a plan for multi-step work. Skip the plan only for quick, single-step changes.

### Creating a plan

Pass your checkpoints directly:

```
plan(action="submit", checkpoints=["Explore the auth flow", "Implement the fix", "Add tests"])
```

Checkpoints represent meaningful milestones, not individual actions. Good: "Implement retry logic for failed uploads". Weak: "Edit file", "Read code", "Run tests".

You don't need to design everything upfront. Start with a high-level plan and refine as you go.

### Tracking progress

- `plan(action="submit", checkpoints=[...])` — Activate the plan. A progress panel appears above the conversation.
- `plan(action="check", item=N)` — Mark checkpoint N as complete (1-based). When the last checkpoint is checked, the plan closes automatically.
- `plan(action="dismiss")` — Abandon the plan if the direction changes.

**Check off each checkpoint as you complete it.** The progress panel is the user's primary view of where you are. An unchecked completed checkpoint looks like stalled work — always call `check` before moving on.
