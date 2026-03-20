---
name: tui-test
description: Interactively test the LongerAgent TUI via tmux. Use when you need to visually verify TUI rendering, test keyboard interactions, debug layout issues, or validate slash command behavior.
---

# TUI Interactive Testing via tmux

Test the Ink-based TUI by running it inside a tmux session. You can send keystrokes, capture the terminal screen as text or as a PNG screenshot, and analyze the output.

## Lifecycle

### 1. Start

**Option A — OpenTUI (bun, faster startup):**
```bash
tmux kill-session -t la-tui 2>/dev/null
tmux new-session -d -s la-tui -x 120 -y 40
tmux send-keys -t la-tui 'clear && pnpm opentui:dev 2>&1' Enter
sleep 5
```

**Option B — CLI entry (tsx):**
```bash
tmux kill-session -t la-tui 2>/dev/null
tmux new-session -d -s la-tui -x 120 -y 40
tmux send-keys -t la-tui 'clear && npx tsx src/cli.ts 2>&1' Enter
sleep 5
```

- `clear &&` prevents shell prompt / command text from lingering above the TUI.
- `-x 120 -y 40` fixes the terminal size for consistent captures.
- `2>&1` merges stderr into the pane so errors are visible.
- Wait 5s for compilation + TUI init (bun is faster but 5s is a safe default for both).

### 2. Capture

#### Text capture

```bash
tmux capture-pane -t la-tui -p
```

Returns the full terminal content as plain text. Use this after every action to verify state.

To include ANSI colors (useful for debugging theme issues):

```bash
tmux capture-pane -t la-tui -p -e
```

To include scrollback history (e.g., after long conversations):

```bash
tmux capture-pane -t la-tui -p -S -100
```

#### Visual screenshot (PNG)

Requires `freeze` (`brew tap charmbracelet/tap && brew install charmbracelet/tap/freeze`).

Pipe ANSI output from `capture-pane -pe` into `freeze` to produce a real PNG image:

```bash
tmux capture-pane -t la-tui -pe | freeze -o /tmp/tui-screenshot.png
```

Then use the Read tool to view the image directly.

Useful `freeze` options:

| Option | Effect |
|--------|--------|
| `-c full` | Add macOS-style window chrome |
| `-c none` | No window decoration (default) |
| `--font.size 14` | Adjust font size |
| `-w 120` | Set image width in columns |
| `--background "#1e1e2e"` | Custom background color |

**Standard pattern — capture + screenshot in one step:**
```bash
tmux capture-pane -t la-tui -pe | freeze -o /tmp/tui-screenshot.png && echo "saved"
```

**With scrollback:**
```bash
tmux capture-pane -t la-tui -pe -S -100 | freeze -o /tmp/tui-screenshot.png
```

**When to use which:**
- **Text capture** — quick checks, verifying specific strings, CI assertions.
- **Visual screenshot** — layout/alignment verification, color/theme debugging, visual regression checks.

**Known limitation:** freeze renders with its own font, which differs from modern terminals (iTerm2, Kitty, etc.). Unicode block characters like `░█▓` appear as dotted patterns in freeze but as solid colored blocks in modern terminals. The freeze screenshot is reliable for verifying **colors, layout, and text content**, but not for pixel-perfect glyph rendering. For exact visual fidelity, test in a real terminal.

### 3. Send Input

**Text:**
```bash
tmux send-keys -t la-tui 'your message here' Enter
```

**Send then capture (standard pattern):**
```bash
tmux send-keys -t la-tui 'hello' Enter && sleep 0.5 && tmux capture-pane -t la-tui -p
```

For model responses, use longer waits:
```bash
tmux send-keys -t la-tui 'say hello' Enter && sleep 10 && tmux capture-pane -t la-tui -p
```

### 4. Cleanup

```bash
tmux kill-session -t la-tui 2>/dev/null
```

## Key Reference

| Action | Command | Notes |
|--------|---------|-------|
| Type text | `send-keys -t la-tui 'text'` | |
| Submit (Enter) | `send-keys -t la-tui Enter` | |
| Arrow down | `send-keys -t la-tui Down` | |
| Arrow up | `send-keys -t la-tui Up` | |
| Tab | `send-keys -t la-tui Tab` | |
| Ctrl+C | `send-keys -t la-tui C-c` | Close picker / cancel / exit |
| Ctrl+L | `send-keys -t la-tui C-l` | Clear/redraw |
| Ctrl+G | `send-keys -t la-tui C-g` | Toggle raw markdown |
| Escape | `send-keys -t la-tui -l $'\x1b[27u'` | **Must use Kitty protocol — see below** |

## Critical: Escape Key Handling

**NEVER use `tmux send-keys Escape` or `send-keys -l $'\x1b'`.**

The TUI's InputProtocolParser treats a lone `\x1b` byte as the potential start of an escape sequence (like arrow keys `\x1b[A`). It buffers the byte and waits for more — but the next bytes never come. This causes:

1. The Escape is never delivered to the application.
2. ALL subsequent keys are consumed: each new byte pairs with the stale `\x1b` and is silently swallowed.
3. The TUI appears completely frozen to input.

**Correct method — use Kitty keyboard protocol:**
```bash
tmux send-keys -t la-tui -l $'\x1b[27u'
```

This sends `ESC [ 27 u` which the parser recognizes as a Kitty-encoded Escape keypress (codepoint 27) and produces the correct `"escape"` event.

**Recovery if you accidentally send a bare Escape:**
The parser buffer is poisoned. Send any printable character to flush the stale `\x1b`:
```bash
tmux send-keys -t la-tui -l 'x'
```
Then the next real key should work. But the flushed `\x1b` + `x` pair will be silently consumed (no visible effect), so this is safe.

## Common Testing Patterns

### Verify startup renders correctly
```bash
tmux kill-session -t la-tui 2>/dev/null
tmux new-session -d -s la-tui -x 120 -y 40
tmux send-keys -t la-tui 'clear && pnpm opentui:dev 2>&1' Enter
sleep 5
tmux capture-pane -t la-tui -p
# Expect: logo, CONTEXT panel, input prompt, status bar with model name
```

**With visual screenshot:**
```bash
sleep 5 && tmux capture-pane -t la-tui -pe | freeze -o /tmp/tui-startup.png
# Then: Read /tmp/tui-startup.png to visually verify layout and colors
```

### Test slash command picker
```bash
tmux send-keys -t la-tui '/model' Enter && sleep 1 && tmux capture-pane -t la-tui -p
# Expect: provider list with > cursor on first item
tmux send-keys -t la-tui Down && sleep 0.3 && tmux capture-pane -t la-tui -p
# Expect: > cursor moved to second item
tmux send-keys -t la-tui C-c && sleep 0.3 && tmux capture-pane -t la-tui -p
# Expect: picker closed, back to normal input
```

### Test message send + model response
```bash
tmux send-keys -t la-tui 'say hello' Enter && sleep 10 && tmux capture-pane -t la-tui -p
# Expect: user message, assistant reply, status bar shows READY + updated context %
```

### Test Ctrl+C cancel during generation
```bash
tmux send-keys -t la-tui 'write a long essay' Enter && sleep 2 && tmux send-keys -t la-tui C-c
sleep 1 && tmux capture-pane -t la-tui -p
# Expect: partial response, status bar shows READY (not Working)
```

### Test dark/light mode switching

**Important:** tmux does not relay macOS appearance changes to the TUI (OSC 11 queries return tmux's own fixed background). Use `VIGIL_THEME` env var to force theme mode, and `freeze --background` to match:

```bash
# Light mode — start a separate session
tmux kill-session -t la-tui 2>/dev/null
tmux new-session -d -s la-tui -x 120 -y 40
tmux send-keys -t la-tui 'clear && VIGIL_THEME=light pnpm opentui:dev 2>&1' Enter
sleep 5 && tmux capture-pane -t la-tui -pe | freeze --background "#ffffff" -o /tmp/tui-light.png

# Dark mode
tmux kill-session -t la-tui 2>/dev/null
tmux new-session -d -s la-tui -x 120 -y 40
tmux send-keys -t la-tui 'clear && VIGIL_THEME=dark pnpm opentui:dev 2>&1' Enter
sleep 5 && tmux capture-pane -t la-tui -pe | freeze -o /tmp/tui-dark.png
```

Note: `freeze` defaults to a dark background. For light mode screenshots, always pass `--background "#ffffff"` so the background matches what a real light terminal would show.

**To toggle macOS system appearance (for real terminals, NOT tmux):**
```bash
osascript -e 'tell application "System Events" to tell appearance preferences to set dark mode to false'
osascript -e 'tell application "System Events" to tell appearance preferences to set dark mode to true'
```

### Test exit
```bash
tmux send-keys -t la-tui C-c && sleep 0.5 && tmux send-keys -t la-tui C-c && sleep 1 && tmux capture-pane -t la-tui -p
# Expect: "Goodbye!" message, shell prompt visible
```

## Wait Time Guidelines

| Scenario | Wait |
|----------|------|
| UI action (key press, picker) | 0.3 – 0.5s |
| Slash command execution | 1s |
| Model response (short) | 5 – 10s |
| Model response (long / tool use) | 15 – 30s |
| TUI startup | 5s |

If the status bar shows `Working` or a spinner, the model hasn't finished yet — wait longer and re-capture.

## Troubleshooting

**All keys ignored after Escape:**
Parser buffer is poisoned. Send a flush character: `send-keys -l 'x'`, then retry.

**capture-pane returns empty or minimal content:**
TUI may still be starting. Wait longer (4s minimum after launch).

**Spinner shows but no response:**
Model API may be slow or rate-limited. Check for error messages in the capture. Try `capture-pane -S -50` to see scrollback.

**Garbled/corrupted display:**
Send Ctrl+L to force a terminal repaint: `send-keys -t la-tui C-l`

**freeze produces blank/empty image:**
Make sure to use `-pe` (not just `-p`) with `capture-pane` so ANSI sequences are included. Without `-e`, freeze receives plain text and may render an empty image if the content is only whitespace.

**freeze not found:**
Install with `brew tap charmbracelet/tap && brew install charmbracelet/tap/freeze`.
