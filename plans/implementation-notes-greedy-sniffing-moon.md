## 2026-08-07:17:10:00 — task-stats prints parallel tackle-tasks commands
Chat title: greedy-sniffing-moon
Path to JSONL log: /Users/matkatmusicllc/.claude/projects/-Users-matkatmusicllc-Programming-taskTools/0e851234-b18c-478d-80ca-0a078897768b.jsonl

### References

/Users/matkatmusicllc/.claude/plans/greedy-sniffing-moon.md
/Users/matkatmusicllc/Programming/taskTools/scripts/taskStats.ts
/Users/matkatmusicllc/Programming/taskTools/tests/taskStats.test.ts
/Users/matkatmusicllc/Programming/taskTools/skills/tackle-tasks/implement.workflow.js

### Design decisions

- **"Don't block each other" was read as file overlap, not `blockedBy`.** Tasks
  carrying an open blocker are already dropped at `scripts/taskStats.ts:118`
  (`unblocked` → `forecastable`), so two batched tasks can never have a
  `blockedBy` edge between them. Shared files are the only remaining way they
  interfere, so batches are built to be file-disjoint.
- **Batching is a transpose of the existing overlap groups, not a new grouping
  pass.** `buildParallelBatches` (`scripts/taskStats.ts:105`) takes the i-th task
  of every group as "round i", then chunks each round at 6. Disjointness is
  structural — one round holds at most one task per group, and a chunk is a
  subset of a round — so no file comparison happens at batch time. Reuses
  `groupTasksByFileOverlap` output already computed at line 119.
- **Batches are sorted ascending** before printing so the command lines stay
  stable and readable; round order alone is group order, which is not ascending
  once groups have differing sizes.
- **`TASKS_PER_COMMAND = 6`** is a module constant, referenced by the batching
  code only.

### Deviations

- **No subagents.** The plan is one function, one type field, one output block,
  one test — roughly 15 lines. Delegating would have cost more than it saved.
- **Section header is `parallel commands:`**, not the plan's longer
  `parallel runs (up to 6 non-overlapping tasks each, one command at a time):`.
  The string was shortened in the working tree during implementation; I kept the
  shorter version and pointed the test at it rather than reverting someone
  else's edit. See the open question below.
- **One test, not the plan's list of five.** `tests/taskStats.test.ts:134`
  asserts the three properties that actually matter (≤6 per batch, no shared file
  inside a batch, every runnable task present exactly once) plus the formatted
  line. The blocked/files-less filters are `forecastable`'s job and were already
  covered.

### Tradeoffs

- **Strict disjointness vs. wide commands.** Honoring "the 6 tasks don't block
  each other" means a group can contribute at most one task per command. With 19
  of 31 runnable tasks piled onto `scripts/prepareTasks.ts`, the real backlog now
  prints 22 commands: the first is 6 wide, the second 4, the third 2, and the
  remaining 19 carry a single task each. Packing commands to a full 6 would have
  been prettier and wrong — it would put file-sharing tasks in the same command.
- **Rejected: sorting groups largest-first and dealing into queues.** Same output
  shape, more code. The transpose needs no sort and no queue state.

### Open questions

1. **The shortened header dropped the "one command at a time" guidance.** These
   commands are meant to be run *sequentially* — `tackle-tasks` already
   parallelizes its groups inside a single run
   (`skills/tackle-tasks/implement.workflow.js:134`). Running several of these
   commands simultaneously is the collision open task 104 describes. Want the
   header to say so, or is that understood?
2. **The 19-command single-task tail is noise.** Options if it bothers you: cap
   the printed list, or collapse the tail into one note like
   `remaining 19 tasks serialize on scripts/prepareTasks.ts`. Left as-is for now
   since it is an accurate picture of the contention.
