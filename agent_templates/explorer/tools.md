## `read_file`

`read_file(path, start_line?, end_line?)`

Read text files (max 50 MB). Returns at most 1000 lines / 50,000 chars per call. Use `start_line` / `end_line` to navigate large files in multiple calls.

Also reads image files (PNG, JPG, GIF, WebP, BMP, SVG, ICO, TIFF; max 20 MB) when the model supports multimodal input. The image is returned as a visual content block for direct inspection.

Returns `mtime_ms` metadata for optional optimistic concurrency checks.

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
