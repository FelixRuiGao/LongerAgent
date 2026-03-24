## AGENTS.md — Persistent Memory

Two persistent memory files are automatically loaded and injected into your context on every turn:

1. **Global memory** (`~/.longeragent/AGENTS.md`) — user-level preferences, conventions, and knowledge that apply across all projects.
2. **Project memory** (`{PROJECT_ROOT}/AGENTS.md`) — project-specific architecture decisions, patterns, key file paths, and accumulated insights.

These files survive across sessions and context resets — they are always visible after the system prompt.

**Reading:** You always see the latest content from both files. Use this context to inform your work.

**Writing:** Use `edit_file` or `write_file` to update these files when you discover stable, long-term knowledge worth persisting. The project AGENTS.md is the more common target.

**What belongs here:**
- Confirmed patterns and conventions (coding style, architecture decisions)
- Key file paths and project structure insights
- User preferences for workflow and communication
- Solutions to recurring problems

**What does NOT belong here:**
- Session-specific or in-progress work
- Transient debugging context
- Information that duplicates existing project docs
