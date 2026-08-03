# `tackle-tasks` Goal Assessment

## Intended outcome

`tackle-tasks` should be a safe batch executor for repository tasks, not merely a way to launch several agents.

Given a selected set of open tasks, it should:

1. Validate that the repository and task metadata are safe to work with.
2. Determine which tasks can run concurrently based on the files and repositories they own.
3. Give every concurrent group an isolated, recoverable checkout.
4. Plan tasks in parallel.
5. Implement tasks serially when they overlap and concurrently when they do not.
6. Support changes in the parent repository and recursive submodules.
7. Verify the final state of each group.
8. Merge only work that is complete and verified.
9. Preserve every commit and working tree when anything fails.
10. Report results at task level: completed, clarification needed, blocked, partial, typecheck failed, or merge conflict.
11. After user approval and full closing verification, archive exactly the successfully completed tasks.

The central promise is that concurrency improves throughput without weakening correctness or risking work. “No data loss” means both that commits remain reachable and that failed or incomplete work cannot accidentally enter a source branch.

## Required features

### Preparation and isolation

- Resolve the actual Git top-level directory regardless of the current working directory.
- Validate task numbers, blockers, and declared file ownership.
- Canonicalize every declared path.
- Inventory the parent and every recursive submodule.
- Detect detached, uninitialized, dirty, or otherwise unsafe repositories before creating worktrees.
- Create run-unique worktrees and branches.
- Record a run manifest containing source commits, source branches, worktrees, branches, groups, tasks, and repository paths.
- Support explicit resume of a previous run without silently reusing it.

### Conflict-safe grouping

- Group tasks by canonical repository-and-path identity, not raw strings.
- Recognize aliases such as `src/a.ts` and `./src/a.ts`.
- Define and enforce how directory declarations overlap contained files.
- Handle case-insensitive filesystems and symlink aliases conservatively.
- Reject paths outside the repository.
- Preserve each task’s own ownership list while also recording the group’s union.

### Planning and implementation

- Plan each task independently and concurrently.
- Run implementations serially within an overlapping group.
- Run independent groups concurrently through an overlapping pipeline.
- Limit partial retries to one.
- Validate all agent results and turn missing or malformed results into explicit failures.
- Detect actual changed paths and reject out-of-scope edits.
- Commit changes in the Git repository that owns each file.
- For submodule changes, commit deepest-first and then update gitlinks through each parent repository.

### Verification and merge eligibility

- Run one final report-only typecheck per group.
- Do not merge a group unless every relevant task in it is `done`.
- Do not merge groups containing clarification, blocked, partial, missing-result, or typecheck-failed tasks.
- Treat a group with no implemented work as skipped, not merged.
- Return task numbers with every merge outcome.
- Keep completed and unsuccessful task sets unambiguous.

### Durable and safe merging

- Create durable refs for every parent and submodule commit before modifying source branches.
- Merge recursive repositories deepest-first.
- Test all group merges on temporary integration refs before changing source branches.
- Avoid leaving some submodule source branches merged when a later repository conflicts.
- Resolve only verified gitlink conflicts automatically.
- Abort and report any ordinary file conflict.
- Preserve worktrees, branches, integration refs, and recovery metadata after failure.
- Provide an explicit, separately invoked cleanup operation.
- Avoid constructing shell commands from single-quoted JSON.

### Task lifecycle

- Present merged, conflicted, blocked, partial, irrelevant, and clarification results separately.
- Ask clarification questions without classifying those groups as merged.
- Require user approval before closing tasks, if that remains the desired policy.
- Run the full closing verification before archival.
- Archive only task IDs proven complete and successfully merged.
- Never infer completion merely because their group branch had a clean or no-op merge.

## Things to fix

### P0: correctness and data safety

1. **Use run-scoped identities.**

   Include `runId` and a repository identity hash in every worktree path and branch name. Never reuse an existing worktree unless the caller explicitly requests resume and its manifest matches.

2. **Gate merging on outcomes.**

   Build merge input only from groups where all applicable tasks returned `done` and final typecheck passed. Skip every other group.

3. **Resolve the real repository root.**

   Replace `process.cwd()` as the root with `git rev-parse --show-toplevel`. Anchor tasks, plans, declared files, worktrees, metrics, and merges to that path.

4. **Implement submodule-aware committing.**

   Map each owned file to its containing Git repository. Commit deepest submodule changes first, then stage and commit updated gitlinks in parent repositories.

5. **Canonicalize and validate task paths.**

   Normalize separators and `.` segments, reject absolute and escaping paths, resolve repository ownership, and conservatively group aliases, directories, symlinks, and case-equivalent paths.

6. **Inventory the complete repository graph.**

   Do not silently omit uninitialized submodules. Either initialize the source checkout during preflight or abort with a clear remediation message.

### P1: reliable workflow behavior

7. **Keep ownership task-specific.**

   Set `PreparedTask.files` from that task’s declaration. Store `group.filePaths` separately as the union.

8. **Enforce ownership after implementation.**

   Compare Git status and diffs before and after each worker. A worker touching undeclared paths should become blocked rather than committing those changes.

9. **Harden agent-result handling.**

   Validate that returned task numbers match the requested task, supply fallbacks for retries, reject duplicates, and never dereference an absent requeue result.

10. **Define group success explicitly.**

    Use an all-or-nothing rule at group level: if one task sharing files is incomplete, defer the entire group because completed edits may depend on the incomplete task.

11. **Make cross-repository merging transactional where practical.**

    Attempt merges on temporary integration branches first. Update source branches only after every repository in the group merges cleanly. Record original refs so unexpected update failures can be recovered.

12. **Check dirty source repositories.**

    Refuse or clearly isolate runs when tracked, staged, conflicted, or untracked files could interfere with checkout and merge operations.

13. **Invoke the merge script without shell quoting.**

    Prefer a structured workflow or tool invocation, or an argument file. At minimum, use an execution API that passes arguments directly instead of embedding JSON in shell source.

### P2: lifecycle and interface accuracy

14. **Return task-level merge results.**

    Each outcome should include `groupId`, `taskNumbers`, eligible tasks, merged tasks, skipped tasks, repository refs, and conflicts.

15. **Emit supported model overrides.**

    Either parse and return `planModel` and `workerModel` from preparation or remove the unused workflow fields and synopsis claim.

16. **Separate fresh-run and resume behavior.**

    Add explicit commands or flags for listing recoverable runs, resuming one, and cleaning one up.

17. **Make archival deterministic.**

    Pass the exact successfully merged task numbers to closing. Do not derive them indirectly from group IDs or no-op merge results.

18. **Provide a working test command.**

    Add a package script compatible with the supported Node version rather than documenting `node --test tests/`.

## Missing tests

- A second run after a successful preserved worktree.
- Two repositories with the same basename.
- Invocation from a repository subdirectory.
- Canonical path aliases and directory/file overlap.
- Absolute paths and `../` escapes.
- Uninitialized and nested submodules.
- End-to-end worker commits inside a submodule.
- Failed typecheck preventing merge.
- Clarification, blocked, partial, and missing worker results preventing merge.
- A missing result on the partial retry.
- A conflict in the second of multiple submodules without partial source mutation.
- Repository paths containing spaces and apostrophes.
- Dirty or staged source repositories.
- Exact task-level archival after a mixed-success run.

## Recommended first milestone

Implement fresh-run isolation, canonical grouping, strict merge gating, and working submodule commits first. Until those four areas are fixed, the tool cannot safely make its main concurrency and no-data-loss guarantees.
