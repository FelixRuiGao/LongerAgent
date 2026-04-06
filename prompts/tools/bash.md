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
