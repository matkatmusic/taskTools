# taskTools

A Claude Code plugin carrying five task-list management skills, usable from any directory:

- `/create-task <description>` — append a task to `tasks.json` (refines vague descriptions first).
- `/pick-a-task [N]` — compare open tasks against the project and report the N easiest.
- `/tackle-tasks <N...>` — verify the named tasks are still relevant, then plan and implement them.
- `/update-tasks` — harvest open items from `plans/` notes/handoffs into tasks, archive the notes.
- `/view-task <N...>` — print a task human-readably; answered entirely by a UserPromptSubmit
  hook (zero token cost — the prompt never reaches the model).

## Where the task files live

Each project's tasks are two JSON arrays: `tasks.json` (open) and `completedTasks.json`
(archived). Resolution order, per project root:

1. `.taskTools/tasks.json` if it exists (the preferred housing folder);
2. otherwise the project root (pre-plugin repos keep working untouched);
3. otherwise `.taskTools/` — the first `/create-task` in a fresh project seeds
   `.taskTools/tasks.json` and `.taskTools/completedTasks.json` with `[]`.

## Enabling the plugin

Launch Claude Code with the plugin directory (the flag is `--plugin-dir`, which loads a
plugin — NOT `--add-dir`, which only grants file access):

```sh
claude --plugin-dir ~/Programming/taskTools
```

The `claude()` wrapper in `~/.claude/init.sh` can pass the flag automatically.

## Tests

```sh
node --test tests/taskFiles.test.ts
```
