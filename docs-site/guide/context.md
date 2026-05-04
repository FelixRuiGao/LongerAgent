# Context Management

Fermi's context management is the core feature that enables long sessions. Instead of hitting context limits and performing a blind reset, the system monitors usage, compresses strategically, and only resets as a last resort. The agent can inspect its own context distribution and surgically summarize selected blocks — down to a single tool call result.

## Three Layers

### 1. Hint Compression

As context grows, the system injects guidance at two thresholds:

| Level | Default trigger | What the agent sees |
|-------|----------------|---------------------|
| Level 1 | 60% of budget | A nudge to call `show_context` and consider summarizing older groups |
| Level 2 | 80% of budget | A stronger prompt to summarize immediately before auto-compact triggers |

Hysteresis prevents oscillation — once a hint fires, context must drop meaningfully before the hint can fire again.

### 2. Agent-Initiated Summarization

The agent has two tools for fine-grained context control:

#### `show_context`

Displays a context map showing all context groups with their sizes and types. Also activates inline annotations so the agent can see exactly what each context ID covers.

#### `summarize`

Operates on groups of spatially contiguous context IDs. For each group, the agent writes a summary that preserves decisions, key facts, code references, and unresolved issues — then the original content is replaced by the summary.

The key property: this is **append-only**. Original content is never deleted — summaries are appended, and the system dynamically determines what is visible based on what has been summarized. This means summarization is safe and reversible at the system level.

<!-- MEDIA: Side-by-side showing context map before and after a summarize operation — token counts visibly reduced -->

### 3. Auto-Compact

When context reaches critical levels despite hints and summarization:

| Trigger | Default threshold | When it fires |
|---------|-------------------|---------------|
| Before-turn | 85% | Before processing the next user message |
| Mid-turn | 90% | After a tool call result pushes context over the limit |

Auto-compact produces a continuation prompt — a comprehensive briefing that lets the agent resume exactly where it left off. After compact, the context window contains only:
- The continuation prompt
- AGENTS.md files (persistent memory)

Before-turn compact is interruptible: pressing Ctrl+C cancels the compact and preserves the original context.

## User vs. Agent Summarization

| | `/summarize` (user) | `summarize` tool (agent) |
|---|---|---|
| **Trigger** | User runs the slash command | Agent decides autonomously (or prompted by hints) |
| **Selection** | Interactive picker: choose start/end turn range | Agent picks context IDs after inspecting the map |
| **Focus** | Optional focus prompt ("Keep the auth details") | Agent writes the summary directly |
| **Granularity** | Turn-level ranges | Can target individual tool results |

<!-- MEDIA: Screen recording of /summarize interactive picker — selecting turns, providing focus prompt -->

## Context Budget

The effective context size can be restricted without switching models. In `~/.fermi/settings.json` (or `<project>/.fermi/settings.json` for per-project override):

```jsonc
{
  "context_budget_percent": 70
}
```

This sets the effective budget to 70% of the model's maximum context length. All threshold calculations (hints, compact) operate against this budget. Useful when you want to leave headroom for large tool results.

You can also set it per-session via the CLI: `fermi -c context_budget_percent=70`.

## Manual Intervention

### `/summarize`

Opens an interactive picker:

1. **Select start turn** — pick where summarization begins
2. **Select end turn** — pick where it ends
3. **Focus prompt** (optional) — instructions about what to preserve

The selected range is converted to context IDs and summarized.

```text
/summarize
```

### `/compact`

Full context reset with a continuation summary. Optionally provide instructions:

```text
/compact
/compact Preserve the DB schema decisions
```

## AGENTS.md — Persistent Memory

Two `AGENTS.md` files are loaded on every turn and survive compact:

- **`~/AGENTS.md`** — Global preferences across all projects
- **`<project>/AGENTS.md`** — Project-specific patterns and conventions

The agent reads these for context and can write to them to save long-term knowledge. Use AGENTS.md to store architectural decisions, coding conventions, known constraints, and preferred approaches.

## Practical Tips

- **Let the system work.** In most sessions the three automatic layers handle everything.
- **Use `/summarize` after exploration.** Once you have conclusions from a long investigation, summarize the exploration to free space for execution.
- **Provide a focus prompt.** Telling the summarizer what matters makes compression more effective.
- **Adjust `context_budget_percent`** if you routinely hit limits with large files or many tool results.
- **Write to AGENTS.md** for knowledge that should persist across sessions — the agent can do this on your behalf.
