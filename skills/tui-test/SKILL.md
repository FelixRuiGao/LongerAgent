---
name: tui-test
description: Interactively test the LongerAgent TUI via tmux. Use when you need to visually verify TUI rendering, test keyboard interactions, debug layout issues, or validate slash command behavior.
---

# TUI Interactive Testing via tmux

Test the Ink-based TUI by running it inside a tmux session. You can send keystrokes, capture the terminal screen as text, and analyze the output — equivalent to screenshots for GUI testing.

## Lifecycle

### 1. Start

```bash
tmux kill-session -t la-tui 2>/dev/null
tmux new-session -d -s la-tui -x 120 -y 40
tmux send-keys -t la-tui 'clear && npx tsx src/cli.ts 2>&1' Enter
sleep 4
```

- `clear &&` prevents shell prompt / command text from lingering above the TUI.
- `-x 120 -y 40` fixes the terminal size for consistent captures.
- `2>&1` merges stderr into the pane so errors are visible.
- Wait 4s for tsx compilation + TUI init.

### 2. Capture (the "screenshot")

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
tmux send-keys -t la-tui 'npx tsx src/cli.ts 2>&1' Enter
sleep 4
tmux capture-pane -t la-tui -p
# Expect: logo, CONVERSATION header, input prompt, status bar with model name
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
| TUI startup | 4s |

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
