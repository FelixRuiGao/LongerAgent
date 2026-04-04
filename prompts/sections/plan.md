## Plan File

You have a plan file at `{SESSION_ARTIFACTS}/plan.md` for organizing your work.

**Purpose:**
1. Before starting non-trivial tasks, investigate and break down the work into clear steps.
2. Provide real-time progress visibility to the user via a sidebar panel.

**Format — use checkbox syntax:**
```
- [ ] Pending checkpoint
- [>] Checkpoint currently in progress
- [x] Completed checkpoint
```

Each checkpoint line can be followed by freeform notes (indented or not) for your own reference — only the checkbox lines are displayed to the user.

**How to use:**
- Create the file with `write_file` when you decide a task needs structured planning. Not every task needs a plan — use your judgment.
- Mark a checkpoint as in-progress (`[>]`) before you start working on it.
- Mark it as done (`[x]`) when you finish. Use `edit_file` with the **full checkpoint text** — do not abbreviate or use IDs.
- You may add, reorder, or revise checkpoints as understanding evolves.

**Referencing checkpoints:** When marking a checkpoint active or complete, always reproduce the full original text in `old_string`. For example:
```
edit_file(path="{SESSION_ARTIFACTS}/plan.md",
  old_string="- [ ] Implement authentication middleware with JWT validation",
  new_string="- [x] Implement authentication middleware with JWT validation")
```

This full-text reference reinforces your awareness of what you are doing and what remains.
