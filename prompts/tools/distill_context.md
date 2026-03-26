## `distill_context`

Extract and preserve valuable information from earlier context. **This is your responsibility** — don't wait for the system to force a compaction. After every significant step, ask yourself: what in this context would I look back at? Preserve that — in whatever length it requires — and let go of the rest.

The goal is to **distill**, not to shorten. A 200-token extract from a 5000-token exchange is appropriate when 200 tokens captures everything useful. A 2000-token extract is equally appropriate when the original was information-dense. Let the value of the content determine the length.

### How to use

```
distill_context(operations=[
  {context_ids: ["a3f1", "7b2e"], content: "...", reason: "exploration complete"},
])
```

Multiple operations in one call:

```
distill_context(operations=[
  {context_ids: ["a3f1", "7b2e"], content: "...", reason: "auth exploration complete"},
  {context_ids: ["d5e6"], content: "...", reason: "config investigation digested"},
])
```

**Rules:**
- Context IDs must be **spatially contiguous** — no gaps between them.
- Each operation is validated independently — one failure won't block others.
- Submit all groups in **one call** (conversation structure changes after distillation, so sequential calls may target stale positions).

### Before you write: self-check

Before writing the `content` for each operation, ask yourself:

1. **Will my next steps reference this content?** If yes — preserve the specific details (file paths, line numbers, code snippets, function signatures) that you will need.
2. **Did I make or encounter decisions here?** Preserve the decision, the alternatives considered, and why they were rejected. Future-you needs the reasoning, not just the conclusion.
3. **Are there unresolved issues or open questions?** Preserve them verbatim — they are the most likely things to be needed and the hardest to reconstruct.

### Writing good distilled content

Distilled content replaces the original permanently within this session. Anything you drop can be fetched again with tools (`read_file`, `grep`, `web_fetch`), but re-fetching costs time — so keep what you'd actually look back at.

**Example A — Distilling a large exploration that feeds the next step:**

You read 3 files (1200 lines total), ran several greps, and identified an authentication architecture spanning `src/auth/`, `src/middleware/guard.ts`, and `src/config/roles.yaml`. You'll implement changes based on these findings next.

> Architecture of the auth subsystem:
> - `src/auth/provider.ts` — OAuth2 provider abstraction, supports Google/GitHub. Token refresh in `refreshToken()` (line 82-110).
> - `src/middleware/guard.ts` — Route guard. Checks `req.session.roles` against route metadata. Key function: `checkAccess(route, session)` (line 45).
> - `src/config/roles.yaml` — Role hierarchy. `admin > editor > viewer`. Custom roles via `extensions:` block.
> - Discovery: guard.ts hardcodes a fallback role (`viewer`) when session has no roles (line 67). This is the behavior we need to change.
> - Code at `src/auth/provider.ts` line 95-103 (will need `edit_file`):
>   ```typescript
>   if (token.exp < now) {
>     return this.refreshToken(token.refreshToken);
>   }
>   ```
>
> Reason: Auth exploration complete, implementation phase next.

Long, because the findings are rich and directly feed the next step. Preserves a verbatim code snippet needed for editing.

**Example B — Closing a finished phase:**

You fixed a CSS bug in `src/ui/panel.tsx`, verified the fix with a test, user confirmed it looks correct. Nothing from this phase is needed going forward.

> Fixed vertical overflow in `src/ui/panel.tsx` by changing `height: 100%` to `height: auto` on `.panel-body`. Test added in `panel.test.tsx`. User confirmed fix.
>
> Reason: CSS bug fix complete.

Short, because there's nothing to carry forward.

**Example C — Phase handoff with selective preservation:**

You explored three different caching strategies, tried and rejected Redis-based approach (connection pooling issues), decided on in-memory LRU. Next step is implementation.

> Caching strategy decision:
> - **Chosen: in-memory LRU** via `lru-cache` package. Max 500 entries, 5min TTL.
> - Rejected Redis: connection pooling under high concurrency caused 2-3s stalls in testing. Not viable without major infra changes.
> - Rejected filesystem cache: too slow for the p95 latency target (< 50ms).
> - Implementation targets: `src/api/handlers.ts` (wrap `fetchResource()`), `src/cache/lru.ts` (new file).
>
> Reason: Caching exploration complete, starting implementation.

Preserves the decision and reasoning; drops the exploration steps, Redis config attempts, and benchmark output.

**Anti-example — Over-compressed, information destroyed:**

Same caching scenario as Example C, but written too aggressively:

> Decided on in-memory LRU caching. Will implement next.

This is **bad** — it drops the package name, configuration, rejection reasons, and target files. When you start implementing, you'll need to re-investigate all of this. The "distilled" content saved tokens but created more work than it saved.

### What happens

Original messages are replaced by the distilled content. Original IDs cease to exist; use the new ID for future reference. Distilled content can be re-distilled like any other context.
