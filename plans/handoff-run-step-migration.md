# Handoff: tackle-tasks → run-step migration

Written 2026-08-23 by the previous session. Repo: `/Users/matkatmusicllc/Programming/taskTools-86` (a git worktree; branch `new-run-step-tool-integration`, HEAD `72a5a10`). Stay in this folder; never `cd` to the parent repo.

## Goal

Make tackle-tasks work again on the run-step block engine (hook `scripts/runStepHook.ts`, generator `scripts/generateSteps.ts` + `scripts/generateWorkflow.ts`, config `scripts/steps.json`, blocks under `scripts/steps/<diagram>/`, tests under `tests/steps/<diagram>/`). Then prove it: user runs `/run-step PREAMBLE_TASK_NUMBER_INPUT {"taskNumber":N,"tasksFile":"..."}`, a subagent runs it, then the generated loop workflow runs it. Parallel tasks come after all that.

## Binding rules from the user

1. **Never commit.** Not even merges. Resolve, leave changes **unstaged**, report, stop. Use `git merge --no-commit --no-ff` when the user wants a merge prepared. The user commits.
2. **Merge one diagram at a time, in this order, and only after the user approves the previous one:** preambleStatusCheck (done, committed by user) → worktreeCheck → documentGeneration → plan → reviewPlan → implement → taskTests → reviewTests → rebasePreamble → rebase → suite → merge → mergeSucceededExit → failuresExit → reportOnlyExit.
3. **Full suite runs go to one subagent**, and that same subagent fixes failures. Fix the **code**, not the test — a test changes only if it is false/fraudulent (tests nothing, fundamentally broken). Migration agents never run the full suite; only their own test files.
4. Ask before acting on anything ambiguous. Small changes stay small. Comment out retired code, never delete. `npm test`, never `bun test`. "all passing" means stop.
5. Ponytail ultra is active (laziest correct solution; delete before add).

## Conventions fixed for every block

- Blocks never hard-code paths; every path rides in the input packet (`tasksFile`, `worktree`, `projectRoot`, …). Entry boxes are strict doors (validate, throw on bad input).
- Output always has `box` + `scriptSignal`. Decision blocks print `next` naming the arm box (bare name = same diagram). Hand-off boxes print no `next`; `steps.json` owns cross-diagram seams (`"other.mmd::BOX"` in `next`).
- Templates are closed-shape: a block's `input` template = the whole output of the block before it (envelope keys included). Both arms of a decision receive the same packet shape; exit fields ride as `""` on happy arms.
- State-changing blocks: `"mutating": true` in `steps.json` + committed `<BOX>.fixture/` folder; `tests/stepTemplates.test.ts` runs those in a temp copy of the fixture. Prompt blocks: `class BOX returns_a_prompt` in the .mmd, `producesPrompt: true`, script prints `{ box, scriptSignal: "prompt", prompt }`.
- Ignoring envelope input keys (`box`, `scriptSignal`, `next`) in a script is by design.

## Current state

- **Merged & user-approved:** preambleStatusCheck (in HEAD).
- **worktreeCheck merge is in the working tree, UNSTAGED, awaiting user review** (45 files). It came from branch `migrate/pipeline-worktreeCheck` (`1442f56`). During that merge one seam conflict was fixed at the root: `MARK_TASK_ACTIVE` now emits `runId`; `WORKTREE_CHECK_PIPELINE` forwards it; `scripts/steps/pipeline-worktreeCheck/ACTIVE_TASK_INPUT.ts` accepts `{taskNumber, tasksFile, runId}` and derives `projectRoot` from `tasksFile`. Templates + tests updated; 31/31 targeted tests green.
- A suite-fix subagent was running `npm test` in this folder when the handoff happened. Its edits (if any) are also unstaged. **Treat the tree as unverified: spawn a fresh suite-fix subagent** (brief below) once the user is ready. Note the merge was originally committed then undone with `git reset HEAD~1`, so a later commit will not carry merge parentage unless redone with `git merge --no-commit`.
- **All 13 remaining diagrams are finished, one commit each, on branches in `/Users/matkatmusicllc/Programming/taskTools-86-migrations/pipeline-<name>/`:**

| slot | diagram | branch → commit |
|---|---|---|
| 3 | documentGeneration | `migrate/pipeline-documentGeneration` → `2619f25` |
| 4 | plan | `migrate/pipeline-plan` → `4f21232` |
| 5 | reviewPlan | `migrate/pipeline-reviewPlan` → `6116287` |
| 6 | implement | `migrate/pipeline-implement` → `b98328d` |
| 7 | taskTests | `migrate/pipeline-taskTests` → `fe976b4` |
| 8 | reviewTests | `migrate/pipeline-reviewTests` → `0637608` |
| 9 | rebasePreamble | `migrate/pipeline-rebasePreamble` → `0671085` |
| 10 | rebase | `migrate/pipeline-rebase` → `9d3a611` |
| 11 | suite | `migrate/pipeline-suite` → `b6a7a21` |
| 12 | merge | `migrate/pipeline-merge` → `822a2e8` |
| 13 | mergeSucceededExit | `migrate/pipeline-mergeSucceededExit` → `05ae0f2` |
| 14 | failuresExit | `migrate/pipeline-failuresExit` → `da5ff0c` |
| 15 | reportOnlyExit | `migrate/pipeline-reportOnlyExit` → `5c421a8` |

All branches are based on `97a0da5` (the generated-stubs base). Expect conflicts in `scripts/steps.json` and in seam-target entry templates at every merge — that is where reconciliation happens.

- Three stray worktrees under `/Users/matkatmusicllc/Programming/taskTools/.claude/worktrees/agent-*` are leftovers from a failed auto-worktree attempt; safe to `git worktree remove` once confirmed empty of unique work.

## Reconcile checklist (apply at each diagram's merge)

1. **Hand-off signal:** rebasePreamble's hand-off boxes print `scriptSignal: "stop"`; every other diagram's hand-offs print `continue` so the walk crosses the seam. Unify on `continue`.
2. **`note` vs `exitNote`:** preamble + reportOnlyExit use `note`; the other diagrams use `exitNote`. User has not chosen yet — ask, default proposal `exitNote`.
3. **taskTests** put `mutating: true` inside packet outputs instead of `steps.json`; move the flags to `steps.json` and strip from packets.
4. **reviewPlan:** verify the counter it writes (`planReviewCount`, a NEW tasks.json field — user may veto) is the one `ARE_2_REVIEWS_DONE` reads (report mentioned `reviewCount`).
5. **suite:** `suiteFixAttempts` rides the packet and is seeded to 0 at `REBASED_WORKTREE_INPUT`; the old invariant says a merge retry that re-runs the suite must NOT reset it. Check the retry path.
6. **Seam shapes:** at every seam the sender's output template must equal the receiver's input template exactly (envelope keys included). Prefer fixing at the receiving door (derive, don't duplicate).
7. **Hook robustness:** `runStepHook.ts` glues stdout+stderr then reads the last line as JSON; git chatter on stderr broke four agents' walks. The rebase branch fixed the root leak in `scripts/repositoryDiscovery.ts` (`readOriginUrl` stdio capture). Consider hardening the hook too and tell the run-step session (peer `uds:/tmp/cc-socks/62531.sock`, "run-step repo 3") — `runStepHook.ts` etc. were cherry-picked from `/Users/matkatmusicllc/Programming/run-step`.
8. Many agents left old shared functions live (imported, not commented out) because other diagrams still use them — deliberate; the user accepted this pattern for preamble.

## Procedures

**Merge one diagram (after user approval of the previous):**
`git merge --no-commit --no-ff migrate/pipeline-<name>` → resolve conflicts per the checklist → run only the touched test files (`node --test "tests/steps/pipeline-<name>/*.test.ts" ...`) → `git reset` to leave everything unstaged → spawn the suite-fix subagent → report to the user for review. Do not commit.

**Suite-fix subagent brief (essentials):** work in this folder; loop `npm test 2>&1 | rg -e '^✖' || echo "all passing"`; fix code not tests (exceptions: fraudulent tests, listed with reasons); for `test_stepEdge_*` failures crossing into a still-stub diagram, align only that stub diagram's entry `input` template to the sender's output; enrich fixtures rather than tests for mutating-block contract failures; known flakes: "sourceRepoLock pausedRefresh" (re-run alone ×3), "renumbered closing-chain files"; never `npm run steps`; never touch `taskTools-86-migrations/`; stage nothing (`git add -N` new files only); report every change.

## Task list to recreate (session-local, was lost)

1. ✅ Generate stubs + steps.json + seams. 2. ✅ preamble (approved). 3. worktreeCheck — merged unstaged, awaiting review. 4–16. one per diagram in the order above: merge → suite-fix subagent → user review. 17. Full suite green (subagent). 18. User runs `/run-step PREAMBLE_TASK_NUMBER_INPUT {...}` on a throwaway task. 19. A subagent runs the same. 20. Generate the workflow (`npm run workflow`) and run it with `args.startStep = "pipeline-preambleStatusCheck.mmd::PREAMBLE_TASK_NUMBER_INPUT"`. Parallel tasks are out of scope for this list.
