# Implementation notes — convert `create-task` to the workflow-only-context-injection pattern

- **Timestamp:** 2026-08-09T14:40:00-07:00
- **Conversation:** ultra-velvet-rocket
- **Conversation JSONL log:** /Users/matkatmusicllc/.claude/projects/-Users-matkatmusicllc-Programming-taskTools/839bf02a-64c9-4b34-8090-20f37b641fdc.jsonl

## References

- /Users/matkatmusicllc/.claude/plans/ultra-velvet-rocket.md
- /Users/matkatmusicllc/Programming/taskTools/scripts/workflow-only-context-injection.md
- /Users/matkatmusicllc/Programming/taskTools/scripts/createTaskBrief.ts
- /Users/matkatmusicllc/Programming/taskTools/skills/commit-message/commitMessage.workflow.js
- /Users/matkatmusicllc/Programming/taskTools/skills/create-task/SKILL.md

## Design decisions

- **2026-08-09T14:40 — Phases 1, 2 and 4 ran as three parallel subagents.** The three
  file pairs are disjoint, so they could not collide. Phase 3 (the workflow script) and
  Phase 5 (SKILL.md and the retirement of the old brief) stayed in the main agent,
  because they touch shared files.
- **2026-08-09T14:40 — `nextTaskNumber.ts` is invoked as a subprocess, not imported.**
  The plan allowed either. That file exports nothing usable — it is a bare CLI script
  whose whole body runs on import — so `execFileSync("node", [nextTaskNumberPath])` is
  the only safe call, matching what `createTaskBrief.ts` already does.
- **2026-08-09T14:40 — The workflow returns safe defaults when a workflow agent dies.**
  `parallel()` resolves a failed thunk to `null`. Rather than crash the whole run, the
  script falls back to `files: []`, `description: ""`, `difficulty: 5`, `blockedBy: []`.
  A missing `files` array is a field the skill omits, which the template already allows.
- **2026-08-09T14:40 — The Sonnet-then-Opus fallback wraps each workflow agent
  separately.** `commitMessage.workflow.js` has one agent, so it fell back once. Here a
  shared fallback would rerun both workflow agents when only one failed.

## Deviations

- **2026-08-09T14:40 — The comment-out of `scripts/createTaskBrief.ts` and
  `tests/createTaskBrief.test.ts` was deferred to the end of the run.** The plan puts it
  in Phase 5. The three subagents each had to read the old brief to carry its prose
  forward verbatim, and a half-commented file would have garbled those reads.

- **2026-08-09T14:50 — `commitTasksJson` resolves the tasks path instead of hardcoding
  `.taskTools/tasks.json`.** The plan's text hardcodes it, but `resolveTaskFiles` also
  returns a project-root pair for pre-plugin repos. There the hardcoded `git add` would
  have staged nothing and the commit would have failed. The signature the plan specifies
  is unchanged; only the path inside the function is now resolved.
- **2026-08-09T14:45 — Subagent comment style bent to a repo hook.** A `PostToolUse` hook
  reflows consecutive `//` lines into one line and blocks the edit unless it is under 20
  words. The plan's "one comment line per step" style tripped it, so the first test's
  two-line scenario comment became one short line. Test logic is unaffected.
- **2026-08-09T14:45 — The file-hunter prompt says "omit `files` rather than guessing",
  but the workflow schema marks `files` as required.** In practice the workflow agent
  returns `[]`, and `buildTaskEntry` drops empty arrays, so the entry comes out the same
  as an omission. Left as is rather than adding a schema branch.

- **2026-08-09T15:10 — `commitTasksJson` now passes `--only`.** Verification step 8 caught
  this live: a bare `git commit` commits the whole index, so the first real `/create-task`
  run swept eleven unrelated staged files into the `created task 160` commit. That commit
  was undone with `git reset --soft`. `test_appendTaskCommitsOnlyTheTasksJsonPath` had
  left its unrelated file merely dirty, never staged, so it could not catch this; the test
  now stages that file first.

## Tradeoffs

- **2026-08-09T14:40 — No unit test for `createTask.workflow.js`.** The workflow sandbox
  is not importable, so a test would have to reimplement the sandbox. The plan accepts
  this and covers the file with the Phase 6 end-to-end run instead.

## Open questions

- None yet.
