---
name: pipeline-doctor
description: Diagnose a stalled tackle-tasks run
---
Do NOT modify state. Report only.
1. Run `scripts/pipeline/health-check.sh` first, always. Paste its full output. It prints the branch, worktrees, checkpoint, lock/lease files, last 5 run-log entries, and disk free.
2. From that output report stage, exitType, lease holder, and the last non-null error.
3. Confirm the task worktree was cut from `staging`.
4. Check for duplicate hook registrations in hooks/hooks.json and settings.json.
5. Output a table: blocker | evidence | proposed fix. Stop. Await approval.
