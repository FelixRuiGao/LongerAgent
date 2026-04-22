## `read_file`

`read_file(path, start_line?, end_line?)`

Read text files (max 50 MB). Returns at most 1000 lines / 50,000 chars per call. Use `start_line` / `end_line` to navigate large files in multiple calls.

Also reads image files (PNG, JPG, GIF, WebP, BMP, SVG, ICO, TIFF; max 20 MB) when the model supports multimodal input. The image is returned as a visual content block for direct inspection.

Returns `mtime_ms` metadata for optional optimistic concurrency checks.

## `write_file`

`write_file(path, content, expected_mtime_ms?)`

Create or overwrite a file. Parent directories are created automatically.

```
write_file(path="{PROJECT_ROOT}/example.py", content="print('Hello, world!')")
```

Use `expected_mtime_ms` (from a prior `read_file`) to guard against overwriting concurrent external changes.

To append content to an existing file, use `edit_file(path, append_str=...)` instead.

## `edit_file`

`edit_file(path, edits, expected_mtime_ms?)`

Apply a patch by replacing one or more unique strings. Each `old_str` must appear **exactly once** in the file — if it's not unique, provide more surrounding context.

**Single replacement:**

```
edit_file(path="{PROJECT_ROOT}/example.py", edits=[
  { old_str: "Hello", new_str: "Hi" }
])
```

**Multiple replacements in one call:**

```
edit_file(path="{PROJECT_ROOT}/example.py", edits=[
  { old_str: "Hello", new_str: "Hi" },
  { old_str: "World", new_str: "Earth" }
])
```

All edits must not overlap and are applied atomically.

**Append:**

To append content to the end of a file, use `append_str`:

```
edit_file(path="{PROJECT_ROOT}/log.txt", append_str="\nNew entry")
```

`append_str` can be combined with `edits` — all replacements execute first, then append:

```
edit_file(path="{PROJECT_ROOT}/example.py", edits=[
  { old_str: "v1.0", new_str: "v1.1" }
], append_str="\n# Updated to v1.1")
```

Supports `expected_mtime_ms` for concurrency safety. Prefer `edit_file` over `write_file` for modifications — it's smaller and safer.

## `list_dir`

`list_dir(path?)`

List files and directories in a tree up to 2 levels deep.

## `glob`

`glob(pattern, path?)`

Find files by name pattern. Returns matching paths sorted by modification time (newest first).

Supports patterns like `**/*.ts`, `src/**/*.test.tsx`, `*.{js,jsx}`.

## `grep`

`grep(pattern, path?, output_mode?, glob?, type?, -A?, -B?, -C?, -i?, head_limit?)`

Search file contents using regex. Supports glob filtering, file type filtering, context lines, and multiple output modes.

Key parameters:
- `output_mode`: `"files_with_matches"` (default, paths only), `"content"` (matching lines), `"count"` (match counts).
- `glob`: Filter files by pattern (e.g. `"*.ts"`, `"*.{ts,tsx}"`).
- `type`: Filter by file type (e.g. `"js"`, `"py"`).
- `-A`, `-B`, `-C`: Context lines after/before/around each match (content mode only).
- `-i`: Case insensitive.
- `head_limit`: Limit number of results.

Recommended workflow for large files and logs:

- Start with `grep` to find the relevant area.
- Then use `read_file(start_line, end_line)` to inspect the matching region.
- Prefer this over reading a very large file from the top unless you genuinely need the overall structure.
- When output says "truncated", search the full log file or source file for specific keywords rather than re-requesting full content.

## `bash`

`bash(command, timeout?, cwd?)`

Execute shell commands. Returns stdout, stderr, and exit code.

**Use `bash` for:** running builds, installing dependencies, running tests, git operations, short one-off scripts, checking system state (`ps`, `df`, `env`, `uname`), and operations that genuinely have no dedicated tool.

### Do NOT use `bash` to substitute for dedicated tools

These are hard rules, not preferences. If you catch yourself reaching for one of these patterns, stop and use the right tool.

| ❌ Do not do this in bash | ✅ Use this instead |
|---|---|
| `echo "..." > file.txt`, `cat > file <<EOF`, `printf ... > file`, `tee file` | **`write_file`** |
| `sed -i ...`, `awk -i inplace ...`, `perl -i -pe ...`, any in-place stream edit | **`edit_file`** |
| `cat file.txt`, `head`, `tail`, `less`, `more`, `bat` | **`read_file`** |
| `grep -r`, `rg`, `ag`, `ack` | the dedicated **`grep`** tool |
| `find . -name ...`, `ls -R`, `tree` | **`glob`** or **`list_dir`** |

**Why these restrictions exist:**
- The dedicated tools apply access controls and safety checks that the bash path bypasses.
- They return structured output the system can track, show in the UI, and include in file-change summaries. Bash redirection is invisible to these systems — the user's interface cannot display a file change that was made through `echo >`.
- They respect mtime validation and atomic-write guarantees that `edit_file` / `write_file` provide. A `sed -i` loses all of this.

There are **no exceptions**. Even for "just a one-liner" or "it's faster this way" — use the right tool.

### Allowed bash patterns for filesystem work

Some filesystem operations have no dedicated tool; these are fine via bash:
- `mkdir -p path/to/dir` — creating directories.
- `rm`, `rmdir`, `mv`, `cp` — deleting, moving, copying files (there are no dedicated tools for these; bash is the right path).
- `chmod`, `chown`, `ln` — permissions and links.
- `git` operations on files (`git add`, `git mv`, `git rm`, etc.).

**Before creating a file or directory via bash**, verify the parent directory exists first (via `list_dir` or a separate `mkdir -p`).

### Other notes

- **Timeouts:** Default 60s, max 600s. Long-running commands should specify a timeout explicitly.
- **Output limit:** ~200KB per stream. Large outputs are truncated — if you expect a large output, pipe to a file and read it with `read_file`.
- **Working directory:** Use the `cwd` parameter for one-off directory changes rather than `cd path && command`.

## `bash_background`

`bash_background(command, cwd?, id?)`

Start a tracked background shell command. Use this for long-running processes like dev servers and watchers.

- Returns a shell ID and a stable log file path.
- Use `bash_output` to inspect logs later.
- Use `wait(seconds=60)` if you want to wait for the process to exit.

## `bash_output`

`bash_output(id, tail_lines?, max_chars?)`

Read output from a tracked background shell.

- Without `tail_lines`, returns unread output since the last `bash_output` call for that shell.
- With `tail_lines`, returns the recent tail without advancing the unread cursor.
- If output is truncated, prefer searching the full log file first and then reading the relevant region.

## `kill_shell`

`kill_shell(ids, signal?)`

Terminate one or more tracked background shells. Default signal is `TERM`.

# Tool: time

Use `time` when a task depends on the current date/time or timezone.

- Call with `{}`.
- Prefer reporting absolute timestamps (not only relative words like "today"/"now").

## `web_search`

`web_search(query)`

Search the web for current information. Returns titles, URLs, and snippets.

## `web_fetch`

`web_fetch(url, prompt?)`

Fetch content from a URL and return it as readable text. HTML pages are converted to markdown-like format.

- Only http/https URLs.
- Use `web_search` to discover URLs; use `web_fetch` to read specific pages.
- Results may be truncated for very large pages (~100K char limit).

## `wait`

`wait(seconds)`

Block until a new message arrives or the timeout expires. Available when you are part of a team.

- `seconds` (required, minimum 15): Wall-clock timeout in seconds.
- Returns early when a teammate's message arrives.
- After sending a request to a teammate, call `wait` — do not loop `send`.
