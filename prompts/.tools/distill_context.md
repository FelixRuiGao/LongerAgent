## `distill_context`

Extract and preserve valuable information from earlier context. **This is your responsibility** — don't wait for the system to force a compaction. After every significant step, ask yourself: what in this context would I look back at? Preserve that — in whatever length it requires — and let go only of what is genuinely redundant.

The goal is to **distill**, not to shorten. A 2000-token extract from a 5000-token exchange is appropriate when the original was information-dense. A 200-token extract is appropriate only when most of those 5000 tokens were genuinely repetitive scaffolding. Let the value of the content determine the length — and **when in doubt, keep more** (see below).

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

### Default to Over-Preservation

When in doubt, **keep more**. Context window pressure is a real cost, but losing information you later need is a much larger cost — you'll have to re-fetch, re-read, or re-derive it, often at many times the original effort. A slightly bloated distillation is cheap; a distillation that lost the one detail you needed is expensive.

Three categories demand especially thorough preservation:

**1. Tool results and information-dense context.** If you're distilling the output of `read_file`, `grep`, `web_fetch`, or a sub-agent's report, preserve every concrete fact you might reference: file paths, line numbers, function signatures, configuration values, error messages, version numbers, URLs, package names. Drop only narrative scaffolding and genuine repetition. **Do not worry about keeping "too much"** — keeping the useful facts is the whole point of distilling rather than discarding.

**2. Work the session has completed.** If you're distilling a phase of your own work, preserve **both what you did and how you did it**. Not just "fixed the bug" but "fixed the bug by changing X in file Y at line Z, chose this approach because W, verified with test command V." Future-you (after this distillation) will need the "how" to answer follow-up questions, to undo if asked, or to apply the same pattern elsewhere. A summary that loses the mechanism has lost most of its value.

**3. User messages — preserve verbatim, with zero omission.** If the context being distilled contains messages from the user, their words must appear in the distilled content **word-for-word**. Do not paraphrase the user. Do not "summarize" the user. Do not drop any part of a user message, even if it seems tangential — you are not the judge of what the user considered important. Copy their message into the distilled content and annotate around it if you must, but never rewrite it. User requirements, constraints, preferences, and clarifications are the anchor points of the entire session; losing them through paraphrase is how tasks end up completed wrong.

The shortest acceptable distillation is not the goal. The **most faithful** distillation is. If a distillation ends up almost as long as the original, that is not a failure — it means the original had very little redundancy, and the right action was to keep most of it.

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

**Anti-example 1 — Over-compressed, decision context destroyed:**

Same caching scenario as Example C, but written too aggressively:

> Decided on in-memory LRU caching. Will implement next.

This is **bad** — it drops the package name, configuration, rejection reasons, and target files. When you start implementing, you'll need to re-investigate all of this. The "distilled" content saved tokens but created more work than it saved.

**Anti-example 2 — Tool result gutted:**

You ran `grep -n "handleRequest" src/` and got 40 matches across 12 files, with file:line:content for each. You distill to:

> Found `handleRequest` usages in 12 files, mainly in `src/api/` and `src/middleware/`.

This is **bad** — you dropped every line number and every specific filename. Next time you need to touch these call sites, you'll have to re-run the grep. The entire point of having run the grep was to collect those specific locations; compressing them away undoes the work. The correct distillation keeps the full file:line list verbatim, dropping only the duplicated match text if that's truly redundant.

**Anti-example 3 — User message paraphrased:**

The user said:

> "I want you to refactor the auth module so that it supports OAuth2 PKCE, but don't touch the session store, and make sure the existing Google login still works. Also the Sentry integration needs to keep reporting the same event names."

You distill to:

> User asked to refactor auth for OAuth2 PKCE support.

This is **catastrophically bad** — you dropped three constraints (don't touch session store, preserve Google login, preserve Sentry event names) that will absolutely determine whether your implementation is accepted. Every one of those constraints is a landmine. **User messages go in verbatim.** Always. If the user message is long, that is not a reason to paraphrase it — it is a reason to be even more careful about preserving it exactly.

### What happens

Original messages are replaced by the distilled content. Original IDs cease to exist; use the new ID for future reference. Distilled content can be re-distilled like any other context.
