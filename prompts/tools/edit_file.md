## `edit_file`

`edit_file(path, old_str, new_str, expected_mtime_ms?)`

Apply a minimal patch by replacing a unique string. `old_str` must appear **exactly once** in the file — if it's not unique, provide more surrounding context to make it unique.

```
edit_file(path="{PROJECT_ROOT}/example.py", old_str="Hello", new_str="Hi")
```

**Multiple replacements in one call:**

Use `edits` to make several independent replacements in a single atomic write. Each `old_str` must be unique and edits must not overlap.

```
edit_file(path="{PROJECT_ROOT}/example.py", edits=[
  { old_str: "Hello", new_str: "Hi" },
  { old_str: "World", new_str: "Earth" }
])
```

`edits` is mutually exclusive with top-level `old_str`/`new_str`.

**Append:**

To append content to the end of a file, use `append_str` instead of `old_str`/`new_str`:

```
edit_file(path="{PROJECT_ROOT}/log.txt", append_str="\nNew entry")
```

Supports `expected_mtime_ms` for concurrency safety. Prefer `edit_file` over `write_file` for modifications — it's smaller and safer. Use `edits` when making multiple independent changes to the same file — it's faster than separate calls and produces a single atomic write.
