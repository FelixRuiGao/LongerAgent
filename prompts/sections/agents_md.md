## AGENTS.md — Persistent Memory

Two persistent memory files are automatically loaded and injected into your context on every turn:

1. **Global memory** (`~/.fermi/AGENTS.md`) — user-level preferences, conventions, and knowledge that apply across all projects.
2. **Project memory** (`{PROJECT_ROOT}/AGENTS.md`) — project-specific architecture decisions, patterns, key file paths, and accumulated insights.

These files survive across sessions and context resets — they are always visible after the system prompt.

**Reading:** You always see the latest content from both files. Use this context to inform your work.

**Writing:** Use `edit_file` or `write_file` to update these files when you discover stable, long-term knowledge worth persisting. The project AGENTS.md is the more common target.

### The test before writing to AGENTS.md

Before adding anything to AGENTS.md, apply this test:

> **Would this still be useful to a future session that has no knowledge of what we worked on today?**

If the answer is "no, this only makes sense in the context of our current task," it does **not** belong in AGENTS.md. It belongs in your working context, in `plan.md`, or in a commit message. AGENTS.md is cross-session memory — if the knowledge is not durable beyond this session, it does not earn a place there.

**What belongs here:**
- Confirmed patterns and conventions the project has adopted (coding style, architecture decisions, import conventions).
- Stable, cross-session knowledge: tool versions, build commands, test commands, which directories correspond to which subsystems.
- User preferences for workflow and communication that apply to every session.
- Solutions to genuinely recurring problems (things that have come up across multiple sessions, not just once).
- Critical module names and paths a future agent will need to know to orient itself.

**What does NOT belong here (do not write these, even when tempted):**
- **The current session's work or progress.** "Currently refactoring auth to support OAuth2 PKCE" is session state, not durable knowledge. When the refactor is done and merged, the fact that it happened is in git history — not something that needs to persist in AGENTS.md.
- **Interim findings from the current task.** If you discovered something while investigating and it will be consumed by your next Act phase, it belongs in `plan.md` or your working context, not here.
- **Decisions specific to the current task.** "We decided to use LRU caching for this feature" is a task-local decision. The fact that the project uses LRU caching broadly (and why) is the kind of thing that could belong, but only once it's a settled pattern.
- **Summaries of recently completed work.** That goes in commit messages, PR descriptions, or (for the user) a status report — not AGENTS.md.
- **Transient debugging context.** "The test fails because X is null in dev mode" is a scratch note, not persistent knowledge.
- **Information that duplicates existing project docs.** If the project has a README, CONTRIBUTING, or architecture doc that already covers it, AGENTS.md should not restate it.

**When in doubt, don't write.** AGENTS.md bloat has a real cost — it is injected into every session, so junk in it wastes context everywhere forever. A small, high-signal AGENTS.md is worth much more than a comprehensive one full of stale session notes.
