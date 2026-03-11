# Skills

Skills are reusable tool definitions that the agent can load on demand. They extend the agent's capabilities without modifying its core tools.

## Using Skills

### Toggle Skills On/Off

Use the `/skills` command to open a checkbox picker where you can enable or disable installed skills:

```text
/skills
```

### Install a Skill

Ask the agent to install a skill by name. The built-in `skill-manager` handles searching, downloading, and installing:

```text
You: install skill: apple-notes
```

The agent will:
1. Search for the skill (via web search or known repositories).
2. Download it to a staging area (`~/.longeragent/skills/.staging/`).
3. Inspect and validate the skill definition.
4. Move it to the skills directory.
5. Reload skills to make it available.

### Hot-Reload

After installing, removing, or modifying skills on disk, the agent calls `reload_skills` to update the available skills list without restarting.

## Skill Directory Layout

Skills live in `~/.longeragent/skills/`:

```text
~/.longeragent/skills/
  skill-name/
    SKILL.md          # Required: YAML frontmatter + markdown instructions
    scripts/          # Optional: helper scripts
    references/       # Optional: reference docs
  .staging/           # Temporary work area (not loaded as a skill)
```

## Creating a Custom Skill

A skill is a directory containing a `SKILL.md` file. The file has YAML frontmatter followed by markdown instructions.

### SKILL.md Format

```yaml
---
name: lowercase-hyphenated-name
description: One-line description of when to use this skill
disable-model-invocation: false   # Optional: true = only user can invoke via /name
user-invocable: true               # Optional: false = hidden from / menu, agent-only
---

Markdown instructions here.
```

### Frontmatter Fields

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Lowercase letters, numbers, and hyphens only. Must start with a letter or number. |
| `description` | Yes | One-line description of when the skill should be used. |
| `disable-model-invocation` | No | If `true`, only the user can invoke this skill (via `/name`). Default: `false`. |
| `user-invocable` | No | If `false`, the skill is hidden from the `/` menu and only the agent can use it. Default: `true`. |

### Arguments

Skills can accept arguments from the user:

- `$ARGUMENTS` -- the full argument string
- `$ARGUMENTS[0]`, `$ARGUMENTS[1]`, or `$0`, `$1` -- positional arguments

### Example

Here is a simple skill that explains code with diagrams:

```yaml
---
name: explain-code
description: Explains code with diagrams and step-by-step analysis.
---

When explaining code, follow this structure:

1. **Analogy**: Compare the code's behavior to something from everyday life
2. **Diagram**: Draw an ASCII diagram showing the flow, structure, or relationships
3. **Step-by-step walkthrough**: Walk through what happens at each stage
4. **Common pitfall**: Highlight one non-obvious mistake or misconception

If $ARGUMENTS refers to a specific file, read it first and then explain it.
```

## Managing Skills

### Removing a Skill

Ask the agent to remove it, or delete the directory manually:

```bash
rm -rf ~/.longeragent/skills/skill-name
```

Then reload skills in the session (the agent calls `reload_skills` automatically when asked to remove a skill).

### Workflow Summary

| Action | How |
|--------|-----|
| Install from GitHub | Ask the agent: "install skill: name" |
| Create custom | Write a `SKILL.md` in `~/.longeragent/skills/name/` |
| Enable/disable | `/skills` command |
| Remove | Delete the directory, reload |
| Hot-reload | Agent calls `reload_skills` automatically |

## The Built-in Skill Manager

The `skill-manager` is a special skill that comes bundled with LongerAgent. It is not user-invocable (you do not call it directly). Instead, it activates automatically when you ask the agent to find, install, or manage skills.

The skill manager knows how to:
- Search for skills via web search
- Clone repositories to the staging area
- Inspect and validate SKILL.md files
- Move skills from staging to the active directory
- Clean up git metadata
- Call `reload_skills` to activate changes
