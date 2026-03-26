## `write_file`

`write_file(path, content, append?, expected_mtime_ms?)`

Create or overwrite a file. Parent directories are created automatically.

```
write_file(path="{PROJECT_ROOT}/example.py", content="print('Hello, world!')")
```

Set `append=true` to append content to the end of an existing file instead of overwriting:

```
write_file(path="{PROJECT_ROOT}/log.txt", content="\nNew entry", append=true)
```

Use `expected_mtime_ms` (from a prior `read_file`) to guard against overwriting concurrent external changes.
