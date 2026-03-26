# Context Management

LongerAgent is built around the idea that context management should be proactive, not reactive. Instead of hitting context limits and failing, the system monitors, compresses, and resets context to keep sessions productive.

## Three Layers

Context management works through three cooperating layers:

### 1. Hint Compression

As context grows, the system prompts the agent to proactively summarize older segments. This happens automatically in the background -- you do not need to take any action.

### 2. Agent-Initiated Distillation

The agent can inspect its own context distribution using the `show_context` tool and surgically compress selected segments with the `distill_context` tool. This preserves key decisions and unresolved issues while freeing space. The agent does this on its own when it detects context pressure.

### 3. Auto-Compact

When context approaches the limit, the system performs a full context reset with a continuation summary. The agent picks up exactly where it left off. This is the safety net that prevents context collapse.

## Manual Intervention

While the system handles context automatically, you can intervene at any time.

### `/summarize`

Compresses older context segments while preserving key decisions. Use it when context is growing but you are not ready for a full reset.

```text
/summarize                                # Summarize older segments
/summarize Keep the auth refactor details  # Summarize with specific instructions
```

When you provide instructions, the summarizer prioritizes keeping the information you specify. This is useful for ensuring that specific findings, file references, or decisions survive the compression.

### `/compact`

Full context reset with a continuation summary. This is the nuclear option.

```text
/compact                                   # Full reset
/compact Preserve the DB schema decisions  # Reset with specific instructions
```

After a compact, the agent starts with a fresh context window containing only:
- The continuation summary (what was happening, what was decided, what is left to do)
- The Important Log
- AGENTS.md files

Use `/compact` when the session is getting slow or when you want a clean slate while keeping project continuity.

## The Important Log

Throughout a session, the agent maintains an **Important Log** -- a persistent record of key discoveries, failed approaches, and architectural decisions. This log:

- Is written to automatically by the agent as it works.
- Survives every summarization and compaction.
- Carries forward across context resets.
- Provides continuity even after aggressive context compression.

You do not need to manage the Important Log directly. It is the agent's own memory for maintaining project context across compactions.

## AGENTS.md -- Persistent Memory

Two `AGENTS.md` files are loaded on every turn:

- **`~/AGENTS.md`** -- Global preferences that apply across all projects.
- **`<project>/AGENTS.md`** -- Project-specific patterns, architecture notes, and conventions.

The agent reads these for context and can write to them to save long-term knowledge. Unlike the Important Log (which is session-scoped), AGENTS.md files persist across sessions.

Use AGENTS.md to store:
- Project architecture decisions
- Coding conventions and patterns
- Known issues or constraints
- Preferred approaches for recurring tasks

## Practical Tips

- **Let the system work.** In most sessions, you will not need to manually summarize or compact. The three automatic layers handle it.
- **Use `/summarize` early.** If you know a long exploration phase is over and you only need the conclusions, summarize to free up space for the next phase.
- **Add instructions when summarizing.** Telling the summarizer what to keep makes compression much more effective.
- **Do not fear `/compact`.** The continuation summary is thorough. The agent will pick up where it left off.
- **Write to AGENTS.md.** If a session produces important architectural decisions, ask the agent to save them to the project's AGENTS.md so they persist across sessions.
