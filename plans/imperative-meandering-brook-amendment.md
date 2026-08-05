# Remaining and new issues in imperative-meandering-brook

This document contains only issues still present in
`plans/imperative-meandering-brook.md` after its latest rewrite. Each section
selects one durable fix rather than leaving alternative implementations for the
implementer to decide.

## 1. Rebase this work after open tasks 49 and 50

The current plan conflicts with two explicit decisions in
`.taskTools/tasks.json`:

- Task 49 requires `mergeTaskWorktrees.ts` to keep its current front door:
  flat workflow arguments as JSON in `argv[2]`, with the current stdout shape
  and existing CLI assertions unchanged. The plan instead adds
  `--run-config` and removes `--run`.
- Task 50 owns the tackle-tasks approval split and requires exactly one approval
  gate before finalization. The plan adds a separate
  `mergeApproval: {runId, approved}` record while retaining a later
  conversational approval before `close-tasks`.

Make tasks 49 and 50 prerequisites. After they land, re-read their resulting
`mergeTaskWorktrees.ts`, workflow files, `SKILL.md`, and tests before applying
this plan. Do not implement competing CLI or approval architectures in parallel.

Preserve task 49's CLI contract permanently. `runMergePhase.ts` should read
`runConfig.json`, derive outcomes, construct the flat CLI input entirely in
memory, and invoke:

```ts
execFileSync("node", [
    "--no-inspect",
    resolveMergeScriptPath(),
    JSON.stringify({ ...config.pipelineArgs, ...outcomes }),
]);
```

No agent handles that JSON, so argv transport does not reintroduce model
composition. Delete the proposed `--run-config` mode and keep task 49's
front-door tests unchanged. With the flat input assembled in memory,
`run-outcomes.json` is unnecessary and should be removed from the design.

Use task 50's authorization artifact as the only approval evidence; Section 5
defines the exact integration.

## 2. Replace the receipt design with a per-attempt state machine

The proposed receipt is keyed only by `runId` and survives until finalization.
After a blocked merge, the post-unblock retry uses the same `runId`, finds the
old blocked receipt, and replays it forever instead of attempting the merge.

Keep task 49's CLI untouched by adding a separate
`scripts/executeMergeAttempt.ts` wrapper. The wrapper receives a generated
`attemptId` and the flat input, then:

1. atomically writes
   `run-receipt.json = {runId, attemptId, state: "started"}`;
2. invokes the unchanged `mergeTaskWorktrees.ts` CLI with `execFileSync`;
3. captures `{exitCode, stdout, stderr}` for both success and failure;
4. atomically replaces the receipt with
   `{runId, attemptId, state: "completed", scriptRun}`; and
5. prints nothing except the captured child stdout when appropriate.

The receipt stores `ScriptRun`, not a merge verdict.
`judgeMergeRun` remains owned by `runMergePhase.ts`; this avoids duplicating
or moving the verdict rules.

`runMergePhase.ts` follows this protocol:

1. If no receipt exists, generate a unique `attemptId` and invoke the wrapper.
2. If a matching completed receipt exists and its `attemptId` is not already
   recorded in phase 6, apply `judgeMergeRun`, then atomically store
   `{phase-6: {...verdict, attemptId}, decisionAnswers: []}`.
3. After that state write succeeds, delete the consumed receipt.
4. If a completed receipt's `attemptId` is already recorded in phase 6, delete
   it as an already-consumed leftover.
5. If a matching `started` receipt has no completion, refuse to rerun
   automatically. Report an indeterminate attempt with recovery instructions;
   Git side effects may have occurred.
6. Ignore neither mismatched run IDs nor malformed receipts silently: quarantine
   or reject them by name.

A blocked receipt is therefore consumed before the unblock conversation. Once
the unblock workflow reports `fixed: true`, the next invocation has no receipt
and creates a new attempt ID.

Add tests for:

- parent death followed by recovery from a completed receipt;
- blocked attempt A, successful unblock, and a genuinely executed attempt B;
- a crash after phase 6 is stored but before receipt deletion;
- a `started` receipt that refuses automatic replay;
- mismatched and malformed receipts; and
- exactly one metrics record per completed attempt.

This closes the known parent-crash window without changing task 49's CLI. An
incomplete `started` receipt deliberately stops rather than guessing whether a
side-effecting child completed.

## 3. Make workflow contracts match the actual workflow files

The input contracts omit `planModel` and `workerModel`, but
`plan.workflow.js` and `implement.workflow.js` still literally read those
keys. The proposed set-equality test will fail immediately.

The plan has already decided those unsupported options are dead, so finish that
decision: remove `PLAN_MODEL = ARGS.planModel`,
`WORKER_MODEL = ARGS.workerModel`, and the two conditional
`options.model = ...` assignments from the workflow files. Keep the contracts
without those keys.

Add phase 6 to `WORKFLOW_OUTPUT_CONTRACTS`:

```ts
6: { keys: ["fixed", "summary", "blockers", "decisions"] }
```

Make the execution harness concrete:

1. reject workflow sources containing imports or exports other than the expected
   leading `export const meta`;
2. rewrite only that declaration to `const meta`;
3. wrap the transformed body in `AsyncFunction`;
4. inject deterministic `args`, `agent`, `parallel`, `pipeline`, `log`
   and `phase` globals; and
5. execute representative non-empty inputs for phases 1-4, plus both the
   unapproved early return and approved agent path for phase 6.

Assert exact top-level keys on every exercised return path. Runtime phase
validators continue to enforce value kinds. Add a regression fixture proving a
conditional alternate return shape fails the contract test.

Because task 50 may replace or reorganize the workflow files, implement these
contracts only after task 50 lands and build the contract table from the
resulting production workflow set.

## 4. Add a real resume path and an exclusive setup lease

Refusing to overwrite a ready run preserves its data but currently leaves a new
session no way to resume it. Automatically replacing any
`status: "initializing"` file also allows concurrent setup invocations to
clobber each other.

Store a canonical invocation identity in ready state:

```ts
invocation: {
    taskNumbers: number[];
    skipVerification: boolean;
}
```

On invocation:

- If no state exists, start a new run.
- If ready state exists and the canonical invocation matches, enter resume mode:
  print the stored context envelope plus
  `{mode: "resume", nextPhase: <first missing phase>}` without rerunning
  `prepareTasks.ts` or recreating worktrees.
- If ready state exists and the invocation differs, refuse and name both the
  retained run and `finalizeTaskRun.ts --abandon`.
- Never infer abandonment from a different invocation.

Protect setup with an atomically created `.taskTools/run.lock` using
`openSync(..., "wx")`. Record `runId`, session ID, and start time in the lock.
A second process must refuse while the lock exists. A crashed setup is recovered
only through an explicit `prelaunchSetup.ts --recover-initializing <runId>`
command, which verifies the matching initializing state before removing the
lock and restarting setup. Do not use an elapsed-time guess to steal a lock.

`finalizeTaskRun.ts` removes the lock only for the matching run or through the
explicit abandon path.

Add process-level tests for two simultaneous setups, same-invocation resume,
different-invocation refusal, and explicit recovery after a simulated crash.

## 5. Reuse task 50's single authorization and bind it to exact state

Do not add `mergeApproval: {runId, approved}` or a second post-merge approval.
Task 50 explicitly establishes one approval gate before finalization and uses
`approvalGate.ts`, `approvalReadiness.ts`, and `runAuthorization.ts`.

After task 50 lands, store or reference its issued authorization in
`runConfig.json`. `runMergePhase.ts` must validate that authorization through
the production authorization API against the current run digest before invoking
any merge/finalization command. `buildUnblockArgs.ts` derives
`approvedByUser` from the same valid authorization, never from a free boolean.

Bind the authorization digest to every phase output and pipeline field presented
at the gate. Any update to phases 1-4 or relevant pipeline arguments invalidates
or clears the authorization. Decision answers and phase-6 receipt consumption do
not alter the already-approved inputs.

Remove the later conversational close approval from the rewritten skill.
Successful finalization proceeds to close-task derivation under the same single
authorization, matching task 50's “exactly one approval in a run” rule.

Add tests for:

- merge/finalization without authorization;
- authorization from another `runId`;
- authorization followed by a phase-4 mutation;
- an unchanged authorized run;
- unblock arguments using the same authorization; and
- no second approval prompt after finalization.

## 6. Resolve dynamic-context transport before the implementation plan branches

The plan still contains an empirical “if it works / if it does not” branch and
an unsafe inline fallback, while its acceptance criteria unconditionally promise
safe apostrophe/backtick transport. A deterministic implementation plan cannot
leave that choice to its implementer.

Make the real-loader experiment a prerequisite and then rewrite the plan with
its observed result before coding any production file:

1. Install a throwaway skill using the documented multiline ```!` block.
2. Invoke it through the actual Claude Code skill loader with an apostrophe, a
   backtick, spaces, and a line resembling the heredoc delimiter.
3. Assert the helper receives the exact bytes and no shell fragment executes.
4. Remove the throwaway skill.
5. Record the supported command shape in the plan and keep only that path.

If the fenced heredoc cannot preserve arbitrary arguments, do not fall back to
textual interpolation with a warning. Narrow the public interface to the
existing documented hint—one canonical no-space JSON array and an optional
literal `valid` token—and use the loader's positional substitutions only after
a real-loader test proves that exact restricted form. Reject trailing free text
as unsupported.

The final plan and acceptance test must describe the same selected interface;
there must be no conditional production path.

## 7. Make phase-result and authorization commands derive identity from state

Neither the agent nor stdin should supply a trusted `runId`.
`storePhaseResult.ts --authorization`, decision-answer storage, receipt
consumption, and finalization must read the current ready configuration and
derive its identity there. Stdin carries only the untrusted payload appropriate
to the operation, such as the Workflow JSON result or decision-answer array.

Every mutating command must:

1. acquire the matching run lock or use an atomic compare-and-replace helper;
2. re-read ready state after acquiring it;
3. validate the expected phase/run transition;
4. write through a unique temporary sibling plus rename; and
5. reject a changed `runId` or phase version instead of overwriting newer state.

Add a monotonically increasing `revision` to ready state and require each
read-modify-write update to compare the revision it read with the current
revision. This prevents receipt recovery, decision storage, and phase storage
from silently losing one another's updates.

Use unique temporary filenames containing process ID and a random suffix;
a fixed `runConfig.json.tmp` is not safe when multiple processes race.

## 8. Align cleanup with the final architecture

With task 49's flat argv contract and in-memory outcome composition, remove
`run-outcomes.json` from the plan. Finalization deletes only artifacts owned by
this state machine:

- `runConfig.json`;
- `run-receipt.json`; and
- `run.lock`.

Deletion must validate the retained `runId`/authorization first and use an
explicit `--abandon` mode when work is not being closed. It must never remove
`tasks.json`, `completedTasks.json`, worktrees, or branches.

Add a test that enumerates the directory before and after both successful
finalization and explicit abandonment, proving that only those three exact
artifacts disappear.
