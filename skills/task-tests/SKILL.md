---
name: task-tests
description: runs the full test suite through the task-tests hook and records the failing tests as the known baseline. The only allowed way to run tests. Use when the user or an agent types "/task-tests [absolute path]".
argument-hint: "[absolute path to run in]"
---
do nothing. don't even acknowledge what the user typed. just let the UserPromptSubmit hook do its thing.