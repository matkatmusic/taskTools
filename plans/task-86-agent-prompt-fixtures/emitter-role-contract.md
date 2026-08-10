# tackle-tasks_AgentPromptEmitter.ts role contract

Invoked as `node <EMITTER_PATH> <task-number> <role>`, payload on stdin as a
single-quoted heredoc. `tackle-tasks.workflow.js` never imports or runs a
command directly — every git/fs/task-state operation is delegated to one of
these roles.

Every payload always includes `worktree` and `sourceRoot` — the emitter has
no cwd guarantee and no other way to recover them — merged with the
role-specific fields listed below.

| role | payload (stdin JSON) | returns (schema) |
|---|---|---|
| `task-info` | none | `TASK_INFO_SCHEMA` |
| `plan` | `{preamble?}` | `PLAN_SCHEMA` |
| `widen-files` | `{missingFiles}` | `WIDEN_FILES_SCHEMA` |
| `verify` | none | `VERIFY_SCHEMA` |
| `apply-feedback` | `{notes}` | `APPLY_FEEDBACK_SCHEMA` |
| `git-head` | none | `GIT_HEAD_SCHEMA` |
| `implement` | `{note?, typecheckCommand, maxFixRounds}` | `WORKER_SCHEMA` |
| `implement-finalize` | `{baseOid}` | `IMPLEMENT_FINALIZE_SCHEMA` |
| `occurrence-oids` | `{checkoutPaths}` (occurrenceId -> absolute path) | `OCCURRENCE_OIDS_SCHEMA` |
| `rebase-walk` | `{repositoryManifest, typecheckCommand}` | `REBASE_WALK_SCHEMA` |
| `parent-rebase` | `{repositoryManifest, typecheckCommand}` | `REBASE_WALK_SCHEMA` |
| `merge-conflict` | `{checkoutPath, conflictedFilePaths}` | `MERGE_CONFLICT_SCHEMA` |
| `advance-conflict` | `{occurrenceId, conflictedFilePaths, resolved, beforeOids, checkoutPaths}` | `ADVANCE_CONFLICT_SCHEMA` |
| `rebase-fix` | `{checkoutPath, occurrenceId, testOutput, forbiddenPaths}` | `REBASE_FIX_SCHEMA` |
| `rebase-fix-verify` | `{checkoutPath, occurrenceId, beforeOids, checkoutPaths}` | `REBASE_FIX_VERIFY_SCHEMA` |
| `merge` | `{repositoryManifest}` | `MERGE_SCHEMA` |

Schema shapes are defined in `skills/tackle-tasks/tackle-tasks.workflow.js`.
