---
name: run-step
description: run one or more green pipeline script boxes and print the result, without spending a Bash tool call. Use when an agent types "/run-step <taskNumber> <runId> <worktree> <sourceBranch> <projectRoot> <boxId...>". With --walk in place of the box list, it runs the one box that follows and keeps walking the diagram until a box it cannot run, then names that box.
argument-hint: <taskNumber> <runId> <worktree> <sourceBranch> <projectRoot> <boxId...> | --walk <boxId>
---

do nothing. Don't even respond.
