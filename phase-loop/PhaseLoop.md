# Phase loop

`phase-loop` is a lightweight sibling of `audit-loop`. It coordinates one implementor and one auditor around a plan using Markdown review files and small filesystem signals. It does not maintain a structured JSON issue database or commit each repair attempt.

Neither agent commits. The user or another external mechanism owns every commit.

## Inputs and names

- `<plan>` is the plan being implemented.
- `<audit>` is the initial audit written next to the plan, normally `<plan>-audit.md`.
- `<feedback-phaseN-M.md>` is follow-up feedback for iteration `M` of phase `N`. Every follow-up filename must be unique and must match `feedback-phase<number>-<number>.md`.

The concrete `<plan>` and `<audit>` paths must be supplied to both agents before the loop starts. Do not infer the active plan from whichever audit or plan file was modified most recently.

## Signal ownership

| Artifact | Producer | Consumer | Staged? | Meaning and consumption |
| --- | --- | --- | --- | --- |
| `.done` | Implementor | Auditor | Yes, staged last | One complete implementation attempt is staged. `done-monitor.ts` removes it from the index and working tree before emitting `done`. |
| `<audit>` | Auditor | Implementor | No protocol requirement | Initial plan review and stable remediation checklist. It remains intact throughout follow-up rounds. |
| `<feedback-phaseN-M.md>` | Auditor | Implementor | No protocol requirement | Only the still-unresolved audit items for one follow-up round. It is not a terminal signal. |
| `.resolved` | Auditor | Implementor | No | Every audit item is resolved. The implementor deletes it after receiving it. |
| `.complete` | Implementor | Auditor | No | The implementor acknowledged `.resolved`. `done-monitor.ts` consumes it and emits `complete`; both agents then exit. |

There are two monitor channels:

- The auditor monitors implementor signals: staged `.done` and `.complete`.
- The implementor monitors auditor signals: `<audit>`, `<feedback-phaseN-M.md>`, and `.resolved`.

Typical one-shot invocations are:

```sh
node phase-loop/done-monitor.ts --root <repo-root>
node phase-loop/feedback-monitor.ts --root <repo-root> --audit <audit>
```

The orchestrator launches the appropriate agent again after a nonterminal event; the agent then starts a fresh monitor when it returns to a waiting state.

Although five artifact names appear in the table, `<audit>` and `<feedback-phaseN-M.md>` are the same kind of handoff at different stages: durable auditor instructions for the implementor.

## Sequence

### 1. Initial implementation

1. The implementor follows `<plan>` and validates the result.
2. The implementor stages only its implementation and test changes.
3. The implementor creates an empty root `.done` file and stages it last.
4. The implementor begins monitoring for `<audit>`, follow-up feedback, or `.resolved`.

### 2. Initial audit

1. The auditor's monitor consumes `.done` and emits `done`.
2. The auditor freezes the staged snapshot and reviews it against the entire `<plan>`.
3. The auditor writes `<audit>` next to `<plan>`. Findings include a concrete failure mode, a complete suggested fix, and proving tests. The auditor does not nitpick.
4. The user reviews and commits the implementation and initial audit.

If the initial audit contains no findings, the auditor may proceed directly to the resolution handshake in step 5.

### 3. Audit remediation

1. The implementor reads the committed `<audit>` and incorporates every finding.
2. The implementor stages only its remediation changes, creates and stages `.done` last, and monitors for feedback or `.resolved`.
3. The auditor's monitor consumes `.done` and emits `done`.
4. The auditor reviews only the items already flagged in `<audit>` and prior feedback. It does not add new audit scope during remediation.

### 4. Follow-up decision

If any flagged item remains unresolved:

1. The auditor leaves `<audit>` intact.
2. The auditor writes a new, uniquely numbered `<feedback-phaseN-M.md>` containing only unresolved items, evidence, complete fixes, and proving tests.
3. The auditor returns to monitoring for `.done` or `.complete`.
4. The implementor incorporates all feedback, validates, stages only its changes, creates and stages `.done` last, and returns to monitoring.
5. Repeat steps 3 and 4 until all flagged items are resolved.

If all flagged items are resolved, continue to the terminal handshake.

### 5. Terminal handshake

1. The auditor creates an empty, untracked root `.resolved` and continues monitoring.
2. The implementor's monitor reports `resolved`.
3. The implementor deletes `.resolved`, creates an empty, untracked root `.complete`, and exits.
4. The auditor's monitor consumes `.complete`, emits `complete`, and exits.
5. The user or external mechanism performs any final review and commit.

The `.resolved`/`.complete` acknowledgement prevents the auditor from exiting before the implementor has observed the final decision. Consuming terminal markers prevents stale files from terminating a later loop.

## Review boundaries

- The first audit compares the full staged implementation with `<plan>`.
- Every later audit compares the staged snapshot only with findings already recorded in `<audit>` or a prior feedback file.
- Green tests do not close a finding unless its failure mode and acceptance criteria are actually covered.
- Do not report optional improvements, style preferences, or unrelated defects during remediation.
- Minor inconsistencies and speculative edge cases belong in a finding only when they imply a plausible correctness failure.

## Index and file rules

- The implementor stages `.done` only after all implementation changes are staged, making it the final publication step.
- The implementor never uses broad staging commands that could capture another actor's work.
- The auditor never edits implementation files and never changes the staged snapshot except for consuming protocol markers through the monitor.
- `<audit>` is the stable checklist. Follow-up rounds create new feedback files rather than erasing or rewriting the checklist.
- `.done`, `.resolved`, and `.complete` are transient protocol files and must never be committed.

## Recovery

- If an agent restarts, inspect the root markers and the explicitly supplied `<audit>` path before waiting. An unconsumed `.resolved` or `.complete` is actionable immediately.
- Existing audit and feedback files are not automatically new work. Resume from the explicitly selected file or use the monitor's existing-file option deliberately.
- If `.done` exists but is not staged, the implementation handoff was not published; the auditor must keep waiting.
- If unrelated staged files appear, stop and ask the owner to restore a reviewable staged boundary. Do not unstage or overwrite another actor's work.
