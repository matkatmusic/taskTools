# Task 108 Plan: task-stats prints each blocked task's collapsed blocker chain plus the fastest unblocking sequence

## Scope

Owned files: `scripts/taskStats.ts` (110 lines as read for this plan) and
`tests/taskStats.test.ts` (133 lines as read for this plan).

`scripts/taskStats.ts` gets four edits (type fields, two new helper functions, a
`computeTaskStats` call-site addition, and a `formatTaskStats` rendering addition).
`tests/taskStats.test.ts` gets four new `test(...)` blocks appended — see "Edits to
tests/taskStats.test.ts" below.

## Design

**Collapse rule (from the brief, restated as the algorithm implemented below).** A
"sink" is an open task with at least one open blocker that no other open task lists as
a blocker. For each sink, walk backward: level 0 (rendered leftmost) accumulates until
a level's union of open blockers is empty. Concretely: start `levels = [[sink]]`,
`seen = {sink}`; repeatedly compute `next` = the union of `openBlockersOf` over every
task number in the most-recently-added level, minus `seen`; if `next` is non-empty,
sort it ascending, `unshift` it onto `levels`, add its members to `seen`, and repeat
using it as the new frontier; stop when `next` is empty. The `seen` set is also the
cycle guard — a task already in `seen` is never added to `next` again, so a `blockedBy`
cycle produces a shrinking frontier that empties out instead of looping forever.

**Why this needs no per-task loop of its own for "who's a sink".** A task is a sink iff
it has an open blocker AND no open task lists it as a blocker. Both conditions are
computed with the existing `openBlockersOf` helper: the first is
`openBlockersOf(t, openNumbers).length > 0`; the second is "not present in the union of
every task's `openBlockersOf` result", computed once up front as a `Set<number>`
(`blockedTaskNumbers`) reused across the sink filter.

**The roots line.** `fastestUnblockingSequence` is the deduplicated, ascending-sorted
union of `chain[0]` (the leftmost/level-0 array) across every chain. Two sinks may
legitimately share a root (task 93 blocking both a 96-chain and a 97-chain in the
brief's worked example) — that produces two chain lines with the same level-0 array,
which is correct per the brief ("two lines with the same level0 are correct output, not
a duplication bug").

**Field types.** `blockerChains: number[][][]` — an array of chains, each chain an
array of levels, each level an ascending `number[]`. This mirrors the existing
`contendedFiles: { path: string; taskCount: number }[]` pattern: `computeTaskStats`
returns structured data, `formatTaskStats` does the string rendering
(`[${level.join(",")}] <- [${level.join(",")}] <- ...`). `fastestUnblockingSequence:
number[]` is the plain sorted root list; `formatTaskStats` wraps it as
`tackle-tasks [n,m,o...]`.

**Reuse, not reimplementation.** Both new functions call the existing
`openBlockersOf` (lines 24-27) rather than re-deriving "still-open blockers of a task".
The brief's own "Duplication worth folding in" note about extracting `openBlockersOf`
into a shared module across `taskStats.ts` / `checkBlockers.ts` / `runStartup.ts` is
explicitly "Not blocking in either direction" for task 108 — this plan does not touch
those other two files or extract a shared module.

**Where the new section goes in the printed output.** Appended after the existing
`contendedFiles` block (the last existing block in `formatTaskStats`), guarded the same
way the `contendedFiles` block is guarded — only printed `if
(stats.blockerChains.length > 0)` — so a project with no blocked tasks prints nothing
new (no empty "blocked task chains:" header, no `tackle-tasks []` line with nothing to
paste).

## Edits to scripts/taskStats.ts

### Edit 1 — lines 19-20 (`TaskStats` type, add two fields)

Current text (exact):
```
    contendedFiles: { path: string; taskCount: number }[];
};
```

New text:
```
    contendedFiles: { path: string; taskCount: number }[];
    blockerChains: number[][][];
    fastestUnblockingSequence: number[];
};
```

### Edit 2 — insert two new functions between line 57 and line 59

Current text (lines 56-59, exact):
```
        .map(([path, taskCount]) => ({ path, taskCount }));
}

export function computeTaskStats(open: TaskRecord[], completed: TaskRecord[], today: string): TaskStats {
```

New text:
```
        .map(([path, taskCount]) => ({ path, taskCount }));
}

function collapsedBlockerChains(open: TaskRecord[], openNumbers: Set<number>): number[][][] {
    const byNumber = new Map<number, TaskRecord>(open.map(t => [t.taskNumber, t] as const));
    const blockedTaskNumbers = new Set<number>();
    for (const task of open) {
        for (const blocker of openBlockersOf(task, openNumbers)) blockedTaskNumbers.add(blocker);
    }
    const sinks = open
        .filter(t => openBlockersOf(t, openNumbers).length > 0 && !blockedTaskNumbers.has(t.taskNumber))
        .map(t => t.taskNumber)
        .sort((a, b) => a - b);

    return sinks.map(sink => {
        const levels: number[][] = [[sink]];
        const seen = new Set<number>([sink]);
        let frontier = [sink];
        while (true) {
            const next = new Set<number>();
            for (const taskNumber of frontier) {
                const task = byNumber.get(taskNumber);
                if (!task) continue;
                for (const blocker of openBlockersOf(task, openNumbers)) {
                    if (!seen.has(blocker)) next.add(blocker);
                }
            }
            if (next.size === 0) break;
            const nextLevel = [...next].sort((a, b) => a - b);
            levels.unshift(nextLevel);
            for (const n of nextLevel) seen.add(n);
            frontier = nextLevel;
        }
        return levels;
    });
}

function unblockingRoots(chains: number[][][]): number[] {
    const roots = new Set<number>();
    for (const chain of chains) for (const n of chain[0]) roots.add(n);
    return [...roots].sort((a, b) => a - b);
}

export function computeTaskStats(open: TaskRecord[], completed: TaskRecord[], today: string): TaskStats {
```

`byNumber` is explicitly typed `Map<number, TaskRecord>` via the constructor's generic
argument, with `as const` on each tuple so the array-of-pairs literal isn't widened —
under `strict` mode, `open.map(t => [t.taskNumber, t])` alone infers the array element
type as `(number | TaskRecord)[]`, not the `[number, TaskRecord]` tuple the `Map`
constructor needs, so the plain (untyped) form does not type-check. `TaskRecord` is
already imported in this file (see the top-of-file `import { readTaskFile,
resolveTaskFiles, type TaskRecord } from "./taskFiles.ts";`), so no new import is
needed. The `if (!task) continue;` guard is defensive against `Map.get` returning
`undefined` under `strict` mode (`tsconfig.json` has `"strict": true`) — it is
unreachable in practice because every `blocker` returned by `openBlockersOf` is filtered
through `openNumbers`, which is built from `open`, so `byNumber` always has an entry —
but `strict` mode requires the guard to type-check.

### Edit 3a — line 64 (`computeTaskStats` body, add the chain computation)

Current text (exact):
```
    const groups = forecastable.length > 0 ? groupTasksByFileOverlap(forecastable) : [];
```

New text:
```
    const groups = forecastable.length > 0 ? groupTasksByFileOverlap(forecastable) : [];
    const blockerChains = collapsedBlockerChains(open, openNumbers);
```

### Edit 3b — lines 80-81 (`computeTaskStats` return object, add two fields)

Current text (exact):
```
        contendedFiles: rankContendedFiles(open),
    };
```

New text:
```
        contendedFiles: rankContendedFiles(open),
        blockerChains,
        fastestUnblockingSequence: unblockingRoots(blockerChains),
    };
```

### Edit 4 — lines 97-102 (`formatTaskStats`, add rendering after the `contendedFiles` block)

Current text (exact):
```
    if (stats.contendedFiles.length > 0) {
        lines.push("contended files (each shared task serializes):");
        for (const file of stats.contendedFiles) lines.push(`  ${file.path} — ${file.taskCount} tasks`);
    }
    return lines.join("\n") + "\n";
}
```

New text:
```
    if (stats.contendedFiles.length > 0) {
        lines.push("contended files (each shared task serializes):");
        for (const file of stats.contendedFiles) lines.push(`  ${file.path} — ${file.taskCount} tasks`);
    }
    if (stats.blockerChains.length > 0) {
        lines.push("blocked task chains:");
        for (const chain of stats.blockerChains) lines.push(`  ${chain.map(level => `[${level.join(",")}]`).join(" <- ")}`);
        lines.push(`fastest unblocking sequence: tackle-tasks [${stats.fastestUnblockingSequence.join(",")}]`);
    }
    return lines.join("\n") + "\n";
}
```

For the brief's worked 4-task example (b, c each `blockedBy` a; d `blockedBy` b and c),
this produces the line `  [1] <- [2,3] <- [4]` (using task numbers 1=a, 2=b, 3=c, 4=d)
and `fastest unblocking sequence: tackle-tasks [1]` — one line per sink, not four,
satisfying the no-duplication requirement because b, c, and a never independently
qualify as sinks (each is listed as another open task's blocker).

## Lines NOT edited (and why)

- Lines 1-18 (header comment, imports, `dayNumber`): unrelated to blocking, unchanged.
- Lines 24-27 (`openBlockersOf`): reused as-is by both new functions; the brief's
  dedup-across-files note is explicitly non-blocking for this task.
- Lines 29-45 (`countClosedWithin`, `findBusiestDay`): unrelated, unchanged.
- Lines 47-57 (`rankContendedFiles`): unrelated, unchanged (Edit 2 inserts after it,
  does not modify it).
- Lines 60-63, 66-79 of the original `computeTaskStats` body (openNumbers/unblocked/
  forecastable/groups computation and the unrelated return fields): unchanged except for
  the two additions in Edit 3a/3b.
- Lines 84-96 of the original `formatTaskStats` (the four unconditional lines plus the
  `busiestDay` and `parallelism` pushes): unchanged; Edit 4 only inserts after the
  existing `contendedFiles` block.
- Lines 104-109 (CLI entrypoint): the brief states explicitly "The CLI at :104-109 needs
  no change" — `formatTaskStats` and `computeTaskStats` are called exactly as before,
  and the new fields flow through automatically since both functions already return/
  consume the full `TaskStats` object.

## Edits to tests/taskStats.test.ts

Read in full (133 lines, 15 existing `test(...)` blocks). None of them construct a
`blockedBy` chain longer than one level (the only chain-shaped fixture, lines 27-32, is
a single-level 1-blocks-3-tasks case with no multi-level or diamond structure), so none
of the new collapse/sink logic is exercised by the existing suite. Append the following
four `test(...)` blocks after the last existing test (the `"CLI reports empty projects
without crashing"` block, ending at line 133), before the file's closing newline. Insert
verbatim, in this order:

```
test("collapses a diamond blockedBy graph into one chain per sink", () => {
    const open = [
        openTask(1),
        openTask(2, { blockedBy: [{ taskNum: 1, reason: "needs 1" }] }),
        openTask(3, { blockedBy: [{ taskNum: 1, reason: "needs 1" }] }),
        openTask(4, { blockedBy: [{ taskNum: 2, reason: "needs 2" }, { taskNum: 3, reason: "needs 3" }] }),
    ];
    const stats = computeTaskStats(open, [], TODAY);
    assert.deepEqual(stats.blockerChains, [[[1], [2, 3], [4]]]);
    assert.deepEqual(stats.fastestUnblockingSequence, [1]);
    const text = formatTaskStats(stats);
    assert.match(text, /blocked task chains:\n {2}\[1\] <- \[2,3\] <- \[4\]\n/);
    assert.match(text, /fastest unblocking sequence: tackle-tasks \[1\]/);
    assert.equal(/\[1\] <- \[2\]/.test(text), false);
    assert.equal(/\[2\] <- \[4\]/.test(text), false);
    assert.equal(/\[3\] <- \[4\]/.test(text), false);
});

test("two sinks sharing one root produce two chains and one deduplicated fastest sequence", () => {
    const open = [
        openTask(1),
        openTask(2, { blockedBy: [{ taskNum: 1, reason: "needs 1" }] }),
        openTask(3, { blockedBy: [{ taskNum: 1, reason: "needs 1" }] }),
    ];
    const stats = computeTaskStats(open, [], TODAY);
    assert.deepEqual(stats.blockerChains, [[[1], [2]], [[1], [3]]]);
    assert.deepEqual(stats.fastestUnblockingSequence, [1]);
});

test("no blocked tasks produces empty chain data and no chain section in output", () => {
    const open = [openTask(1), openTask(2)];
    const stats = computeTaskStats(open, [], TODAY);
    assert.deepEqual(stats.blockerChains, []);
    assert.deepEqual(stats.fastestUnblockingSequence, []);
    const text = formatTaskStats(stats);
    assert.equal(/blocked task chains:/.test(text), false);
    assert.equal(/fastest unblocking sequence:/.test(text), false);
});

test("a blockedBy cycle behind a genuine sink terminates with a finite chain", () => {
    const open = [
        openTask(1, { blockedBy: [{ taskNum: 2, reason: "needs 2" }] }),
        openTask(2, { blockedBy: [{ taskNum: 3, reason: "needs 3" }] }),
        openTask(3, { blockedBy: [{ taskNum: 1, reason: "needs 1" }] }),
        openTask(4, { blockedBy: [{ taskNum: 1, reason: "needs 1" }] }),
    ];
    const stats = computeTaskStats(open, [], TODAY);
    assert.deepEqual(stats.blockerChains, [[[3], [2], [1], [4]]]);
    assert.deepEqual(stats.fastestUnblockingSequence, [3]);
});
```

These four tests give TDD-style coverage for the diamond collapse, shared-root
deduplication, the empty-input guard, and the cycle guard — the same four scenarios the
command-based verification below also checks by running the CLI, so the verification
section doubles as an end-to-end (process-level) confirmation of what the unit tests
already assert at the function level.

## Verification

Run from `/Users/matkatmusicllc/Programming/taskTools`:

1. Full existing suite still passes (proves no regression in any of the 15 current
   tests across all test files, not just this one):
   ```
   node --test "tests/**/*.test.ts"
   ```
   Expected: all `tests/taskStats.test.ts` cases pass (`# fail 0` in the summary), no
   new failures anywhere in the run.

2. TypeScript compiles under `strict` mode (proves the `Map.get` guard, the
   `number[][][]` typing, and the new `TaskStats` fields all type-check):
   ```
   tsc --noEmit -p tsconfig.json
   ```
   Expected: exits 0, no output.

3. The brief's 4-task worked example produces exactly one collapsed line, not four:
   ```
   mkdir -p /tmp/taskstats-108-check && cd /tmp/taskstats-108-check
   cat > tasks.json <<'EOF'
   [
     {"taskNumber": 1, "title": "a"},
     {"taskNumber": 2, "title": "b", "blockedBy": [{"taskNum": 1, "reason": "needs 1"}]},
     {"taskNumber": 3, "title": "c", "blockedBy": [{"taskNum": 1, "reason": "needs 1"}]},
     {"taskNumber": 4, "title": "d", "blockedBy": [{"taskNum": 2, "reason": "needs 2"}, {"taskNum": 3, "reason": "needs 3"}]}
   ]
   EOF
   echo "[]" > completedTasks.json
   node /Users/matkatmusicllc/Programming/taskTools/scripts/taskStats.ts
   ```
   Expected output includes exactly these two new lines (and no `[1] <- [2]`,
   `[2] <- [4]`, or `[3] <- [4]` lines):
   ```
   blocked task chains:
     [1] <- [2,3] <- [4]
   fastest unblocking sequence: tackle-tasks [1]
   ```

4. A task with no open blockers produces no new section (guards the `if
   (stats.blockerChains.length > 0)` branch):
   ```
   mkdir -p /tmp/taskstats-108-empty && cd /tmp/taskstats-108-empty
   echo '[{"taskNumber": 1, "title": "a"}]' > tasks.json
   echo "[]" > completedTasks.json
   node /Users/matkatmusicllc/Programming/taskTools/scripts/taskStats.ts
   ```
   Expected: output contains no `blocked task chains:` line and no `fastest unblocking
   sequence:` line.

5. A `blockedBy` cycle behind a genuine sink terminates instead of hanging (this
   exercises the `while` loop's own `seen`-set guard, not just the sink filter — tasks
   1, 2, 3 form a cycle: 1 blockedBy 2, 2 blockedBy 3, 3 blockedBy 1; task 4 is blocked
   by 1 and has no blocker of its own, so 4 is the only sink and the backward walk from
   4 must traverse into the cycle and stop instead of looping):
   ```
   mkdir -p /tmp/taskstats-108-cycle && cd /tmp/taskstats-108-cycle
   cat > tasks.json <<'EOF'
   [
     {"taskNumber": 1, "title": "a", "blockedBy": [{"taskNum": 2, "reason": "needs 2"}]},
     {"taskNumber": 2, "title": "b", "blockedBy": [{"taskNum": 3, "reason": "needs 3"}]},
     {"taskNumber": 3, "title": "c", "blockedBy": [{"taskNum": 1, "reason": "needs 1"}]},
     {"taskNumber": 4, "title": "d", "blockedBy": [{"taskNum": 1, "reason": "needs 1"}]}
   ]
   EOF
   echo "[]" > completedTasks.json
   node -e '
   const { spawnSync } = require("node:child_process");
   const result = spawnSync("node", ["/Users/matkatmusicllc/Programming/taskTools/scripts/taskStats.ts"], { encoding: "utf8", timeout: 5000 });
   if (result.error) { console.error(result.error); process.exit(1); }
   process.stdout.write(result.stdout);
   process.exit(result.status ?? 1);
   '
   ```
   Expected: exits within the 5-second timeout (`result.error` unset, exit code 0, not
   killed by the timeout) and prints:
   ```
   blocked task chains:
     [3] <- [2] <- [1] <- [4]
   fastest unblocking sequence: tackle-tasks [3]
   ```
   (Walk trace: sink 4 → level `[1]` [4's only open blocker] → level `[2]` [1's blocker]
   → level `[3]` [2's blocker] → next candidate is 1 again, already in `seen`, so the
   union is empty and the walk stops — proving the guard fires instead of re-entering
   the cycle.)

## Declined review suggestion

A reviewer asked for strongly-connected-component sink selection so a *standalone*
blockedBy cycle (one with no downstream sink) still prints. Declined: the real
`.taskTools/tasks.json` has 36 open tasks, 8 blocked, and zero cycles of any kind. The
`seen`-set guard already prevents a hang. Do not implement SCC. If a standalone cycle
ever appears, that is the moment to add it.

## Follow-up note carried from the brief (not part of this plan's edits)

The brief's "Duplication worth folding in" section says whichever of task 84 or task
108 lands first should export the shared `openBlockersOf`/chain-walk logic for the
other to reuse, and that this is "Not blocking in either direction." This plan does not
perform that extraction — `collapsedBlockerChains` and `unblockingRoots` are added as
unexported (module-private) functions in `scripts/taskStats.ts`, matching the existing
privacy of `openBlockersOf`, `countClosedWithin`, `findBusiestDay`, and
`rankContendedFiles` (none of which are exported either). If task 84 lands after this
task, it can import or duplicate this walk at that time; this plan's scope is task 108
only.
