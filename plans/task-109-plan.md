# Task 109 Plan: Format task-stats output as markdown sections

## Summary

`formatTaskStats` in `scripts/taskStats.ts` currently returns flat prose lines
(no ANSI, never did). Reshape it into markdown: three `##` headed sections
(Backlog, Velocity, Parallelism) built from the existing lines, plus a
`## Contended files` section rendered as a markdown table, present only when
`stats.contendedFiles` is non-empty. `computeTaskStats` and the `TaskStats`
type are untouched — presentation only. Add one assertion to the existing
zero-contended-files test to lock in that the table section is omitted, not
emitted empty.

## Edit 1 — scripts/taskStats.ts, lines 143-170

Replace the whole `formatTaskStats` function body.

Current text (lines 143-170):

```ts
export function formatTaskStats(stats: TaskStats): string {
    const lines = [
        `${stats.openCount} open (${stats.unblockedCount} unblocked, ${stats.blockedCount} blocked)`,
        `${stats.openWithFiles} of ${stats.openCount} open tasks declare files — ${stats.openWithoutFiles} would be refused by tackle-tasks`,
        `${stats.completedCount} completed, ${stats.completedWithCommitHashes} with commit hashes recorded`,
        `closed: ${stats.closedLast7} in the last 7 days, ${stats.closedLast30} in the last 30`,
    ];
    if (stats.busiestDay) lines.push(`busiest day: ${stats.busiestDay.date} (${stats.busiestDay.count} closed)`);
    lines.push(
        stats.forecastTaskCount > 0
            ? `parallelism: ${stats.forecastTaskCount} runnable tasks would form ${stats.groupCount} groups, largest ${stats.largestGroupSize} tasks (serialized within a group)`
            : `parallelism: no runnable tasks — nothing to group`,
    );
    if (stats.contendedFiles.length > 0) {
        lines.push("contended files (each shared task serializes):");
        for (const file of stats.contendedFiles) lines.push(`  ${file.path} — ${file.taskCount} tasks`);
    }
    if (stats.blockerChains.length > 0) {
        lines.push("blocked task chains:");
        for (const chain of stats.blockerChains) lines.push(`  ${chain.map(level => `[${level.join(",")}]`).join(" <- ")}`);
        lines.push(`fastest unblocking sequence: tackle-tasks [${stats.fastestUnblockingSequence.join(",")}]`);
    }
    if (stats.parallelBatches.length > 0) {
        lines.push(`parallel commands:`);
        for (const batch of stats.parallelBatches) lines.push(`  tackle-tasks [${batch.join(",")}]`);
    }
    return lines.join("\n") + "\n";
}
```

New text:

```ts
export function formatTaskStats(stats: TaskStats): string {
    const lines = [
        "## Backlog",
        "",
        `${stats.openCount} open (${stats.unblockedCount} unblocked, ${stats.blockedCount} blocked)`,
        `${stats.openWithFiles} of ${stats.openCount} open tasks declare files — ${stats.openWithoutFiles} would be refused by tackle-tasks`,
        "",
        "## Velocity",
        "",
        `${stats.completedCount} completed, ${stats.completedWithCommitHashes} with commit hashes recorded`,
        `closed: ${stats.closedLast7} in the last 7 days, ${stats.closedLast30} in the last 30`,
    ];
    if (stats.busiestDay) lines.push(`busiest day: ${stats.busiestDay.date} (${stats.busiestDay.count} closed)`);
    lines.push(
        "",
        "## Parallelism",
        "",
        stats.forecastTaskCount > 0
            ? `parallelism: ${stats.forecastTaskCount} runnable tasks would form ${stats.groupCount} groups, largest ${stats.largestGroupSize} tasks (serialized within a group)`
            : `parallelism: no runnable tasks — nothing to group`,
    );
    if (stats.blockerChains.length > 0) {
        lines.push("blocked task chains:");
        for (const chain of stats.blockerChains) lines.push(`  ${chain.map(level => `[${level.join(",")}]`).join(" <- ")}`);
        lines.push(`fastest unblocking sequence: tackle-tasks [${stats.fastestUnblockingSequence.join(",")}]`);
    }
    if (stats.parallelBatches.length > 0) {
        lines.push(`parallel commands:`);
        for (const batch of stats.parallelBatches) lines.push(`  tackle-tasks [${batch.join(",")}]`);
    }
    if (stats.contendedFiles.length > 0) {
        lines.push("", "## Contended files", "", "Each shared task serializes.", "", "| File | Tasks |", "| --- | --- |");
        for (const file of stats.contendedFiles) lines.push(`| ${file.path} | ${file.taskCount} |`);
    }
    return lines.join("\n") + "\n";
}
```

Notes on why this satisfies the brief:

- `computeTaskStats` (lines 114-141) and the `TaskStats` type (lines 5-23) are
  not touched — presentation only, as the brief requires.
- Backlog/Velocity/Parallelism sections reuse every existing line verbatim
  (same template literals, same conditionals for `busiestDay`,
  `blockerChains`, `parallelBatches`), so every number and label the current
  formatter emits still appears — only markdown `##` headers and blank-line
  separators are added around them.
- `blocked task chains:` and `parallel commands:` keep their exact original
  text and two-space-indented child lines (unchanged), so they continue to
  read as sub-content of the Parallelism section without breaking any
  substring match against them.
- Contended files becomes a markdown table (`| File | Tasks |` header,
  `| --- | --- |` separator, one `| path | count |` row per entry) instead of
  the old two-space-indented bullet lines, satisfying "one table for
  contended files." The old descriptive text "each shared task serializes" is
  kept as a plain caption line above the table so that label still appears.
- The whole block stays a flat array of `string`/template-literal pushes and
  one `.join("\n")` — no markdown-generation helper, table library, or
  styling logic, matching "layout stays plain enough to hand-tweak later; no
  clever or generated styling."
- No `\x1b` (ESC) byte is introduced anywhere in this text — it never was
  present in the plain formatter either, so the "no ESC byte" requirement
  holds trivially and needs no runtime stripping logic.
- The `if (stats.contendedFiles.length > 0)` guard is preserved unchanged, so
  a fixture with zero contended files continues to omit the whole section
  (now including its heading and table) rather than emitting empty table
  markup.

## Edit 2 — tests/taskStats.test.ts, lines 181-189

Add one assertion to the existing "no blocked tasks" test so the
zero-contended-files omission (goal criterion 6) has a direct regression
check, using the fixture already in that test (`open = [openTask(1),
openTask(2)]`, neither task declares `files`, so `stats.contendedFiles` is
empty by construction).

Current text (lines 181-189):

```ts
test("no blocked tasks produces empty chain data and no chain section in output", () => {
    const open = [openTask(1), openTask(2)];
    const stats = computeTaskStats(open, [], TODAY);
    assert.deepEqual(stats.blockerChains, []);
    assert.deepEqual(stats.fastestUnblockingSequence, []);
    const text = formatTaskStats(stats);
    assert.equal(/blocked task chains:/.test(text), false);
    assert.equal(/fastest unblocking sequence:/.test(text), false);
});
```

New text:

```ts
test("no blocked tasks produces empty chain data and no chain section in output", () => {
    const open = [openTask(1), openTask(2)];
    const stats = computeTaskStats(open, [], TODAY);
    assert.deepEqual(stats.blockerChains, []);
    assert.deepEqual(stats.fastestUnblockingSequence, []);
    const text = formatTaskStats(stats);
    assert.equal(/blocked task chains:/.test(text), false);
    assert.equal(/fastest unblocking sequence:/.test(text), false);
    assert.equal(/## Contended files/.test(text), false);
});
```

No other change to this file. All other existing assertions keep matching
the new output unmodified, because:

- "formatted output names every headline number" (lines 110-115) checks the
  fragments `open`, `completed`, `closed`, `groups`, `files` are present
  anywhere in the text — all five still occur verbatim in the Backlog/
  Velocity/Parallelism lines.
- "CLI prints stats for the project it is run from" (lines 117-124) and "CLI
  reports empty projects without crashing" (lines 126-132) match `/2 open/`,
  `/1 completed/`, `/0 open/` — all still occur verbatim.
- "each parallel command holds at most 6 tasks that share no files"
  (lines 134-150) matches
  `/parallel commands:\n {2}tackle-tasks \[1,10,11,12,13,14\]\n/` — the
  `parallel commands:` line and its two-space-indented batch lines are
  unchanged text, so this substring match still succeeds regardless of the
  `## Contended files` table that follows it in this fixture (tasks 1-8 all
  declare `files: ["hot.ts"]`, so `hot.ts` is contended).
- "collapses a diamond blockedBy graph into one chain per sink"
  (lines 152-168) matches `/blocked task chains:\n {2}\[1\] <- \[2,3\] <- \[4\]\n/`
  and `/fastest unblocking sequence: tackle-tasks \[1\]/`, and asserts three
  chain substrings are absent — all unaffected since that block's text is
  unchanged and none of these tasks declare `files` (no contended-files
  table appears to interfere).
- "two sinks sharing one root..." (lines 170-179) and "a blockedBy cycle
  behind a genuine sink..." (lines 191-201) only assert on
  `stats.blockerChains` / `stats.fastestUnblockingSequence` values, never on
  `formatTaskStats` text, so they are unaffected by this edit.

## Files accounted for

- `scripts/taskStats.ts`: Edit 1 above (lines 143-170 replaced). No other
  change in this file — `computeTaskStats`, `TaskStats`, and all helper
  functions above line 143 are untouched.
- `tests/taskStats.test.ts`: Edit 2 above (one assertion line added inside
  the test at lines 181-189). No other change in this file.

## Verification

Run from the repo root after both edits:

1. `npm test`
   Expected: full suite passes (0 failures), including all tests in
   `tests/taskStats.test.ts`.

2. `node --test tests/taskStats.test.ts`
   Expected: all tests in this file pass, including the newly added
   `## Contended files` absence assertion.

3. `node scripts/taskStats.ts`
   Expected: stdout starts with `## Backlog`, contains `## Velocity` and
   `## Parallelism` headers, and — only if the repo's live `tasks.json` has
   any file declared by more than one open task — a `## Contended files`
   section with a `| File | Tasks |` markdown table.

4. `node scripts/taskStats.ts | cat -v`
   Expected: no `^[` sequence anywhere in the output, confirming no ESC
   (0x1b) byte is emitted.
