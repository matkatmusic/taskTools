# Phase loop

`phase-loop` is a lightweight sibling of `audit-loop`. It coordinates one implementor and one auditor around a plan using Markdown review files and small filesystem signals. It does not maintain a structured JSON issue database or commit each repair attempt.

Neither agent commits. The user or another external mechanism owns every commit.

## Inputs and names

- `<plan>` is the plan being implemented.
- `<audit>` is the initial audit written next to the plan, normally `<plan>-audit.md`.
- `<feedback-phaseN-M.md>` is follow-up feedback for iteration `M` of phase `N`. Every follow-up filename must be unique and must match `feedback-phase<number>-<number>.md`.
- `.feedback` publishes one finished auditor review. Its `.plan`, `.audit`, and `.review` fields
  identify the loop and the exact review file that is ready to consume.

The concrete `<plan>` and `<audit>` paths must be supplied to both agents before the loop starts. Do not infer the active plan from whichever audit or plan file was modified most recently.

## Signal ownership

| Artifact | Producer | Consumer | Staged? | Meaning and consumption |
| --- | --- | --- | --- | --- |
| `.done` | Implementor | Auditor | Yes, staged last | One complete implementation attempt is staged. `done-monitor.ts` reads its staged contents, removes it from the index and working tree, then emits `done` with `contents`. |
| `<audit>` | Auditor | Implementor | No protocol requirement | Initial plan review and stable remediation checklist. It remains intact throughout follow-up rounds. |
| `<feedback-phaseN-M.md>` | Auditor | Implementor | No protocol requirement | Only the still-unresolved audit items for one follow-up round. It is not a terminal signal. |
| `.feedback` | Auditor | Implementor | No, created last | The review named by `.review` is complete. On detection, `feedback-monitor.ts` reads and removes the marker, then validates the referenced plan/audit/review files and emits `feedback` with `contents`. |
| `.resolved` | Auditor | Implementor | No | Every audit item is resolved. `feedback-monitor.ts` reads and removes it, then emits `resolved` with `contents`. |
| `.complete` | Implementor | Auditor | No | The implementor acknowledged `.resolved`. `done-monitor.ts` reads and removes it, then emits `complete` with `contents`; both agents then exit. |

There are two monitor channels:

- The auditor monitors implementor signals: staged `.done` and `.complete`.
- The implementor monitors auditor signals: `.feedback` and `.resolved`. Audit and feedback files
  are durable content, not signals by themselves.

Typical one-shot invocations are:

```sh
node phase-loop/done-monitor.ts --root <repo-root>
node phase-loop/feedback-monitor.ts --root <repo-root>
```

Each agent runs its monitor in the foreground in its current turn. It does not alert the user or
return while waiting. When the monitor reports and consumes a trigger, that same agent immediately
performs the next auditing or feedback-implementation step, produces its next protocol marker,
and returns to a new foreground wait. A monitor event is a work order, not a status update.

The only protocol outputs produced after following those instructions are:

- `.done` — the implementor publishes a staged implementation attempt;
- `.feedback` — the auditor publishes an audit or remediation review;
- `.resolved` — the auditor declares every audit finding resolved;
- `.complete` — the implementor acknowledges `.resolved`.

Every monitor consumes the marker that triggers it. Its JSON event includes a `contents` field
holding the exact triggering-file bytes, so consuming transient protocol state does not remove
that state from the receiving agent's context. It also reports `status:"landed"` and a mandatory
`nextAction` so the receiving agent continues the protocol instead of merely announcing the event.

`<audit>` and `<feedback-phaseN-M.md>` are durable auditor instructions. `.feedback` is their
publication boundary: its exact three-line format is:

```text
.plan=<plan>
.audit=<audit>
.review=<latest review file>
```

For the initial audit, `.review` equals `<audit>`. For remediation, it names the newly completed
`<feedback-phaseN-M.md>`. The auditor writes the review and finishes validation first, then creates
`.feedback` in one write as the final action. A published review is immutable; corrections use a
new uniquely numbered feedback file and a new marker.

## Sequence

### 1. Initial implementation

1. The implementor follows `<plan>` and validates the result.
2. The implementor stages only its implementation and test changes.
3. The implementor creates an empty root `.done` file and stages it last.
4. The implementor begins silent foreground monitoring for `.feedback` or `.resolved`.

### 2. Initial audit

1. The auditor's foreground monitor consumes `.done`, reports it landed, and emits `done`.
2. The auditor freezes the staged snapshot and reviews it against the entire `<plan>`.
3. The auditor finishes `<audit>` and its validation notes, then creates `.feedback` last with
   `.review=<audit>`.
4. The user reviews and commits the implementation and initial audit.

If the initial audit contains no findings, the auditor publishes it through `.feedback`, waits
for the implementor to consume that marker, and then proceeds to the resolution handshake in
step 5. `.feedback` and `.resolved` must not coexist.

### 3. Audit remediation

1. The implementor reads the `<audit>` and incorporates every finding.
2. The implementor stages only its remediation changes, creates and stages `.done` last, and monitors in the foreground for `.feedback` or `.resolved`.
3. The auditor's foreground monitor consumes `.done`, reports it landed, and emits `done`.
4. The auditor reviews only the items already flagged in `<audit>` and `<feedback-phaseN-M.md>`. It does not add new audit scope during remediation.

### 4. Follow-up decision

If any flagged item remains unresolved:

1. The auditor leaves `<audit>` intact.
2. The auditor finishes a new, uniquely numbered `<feedback-phaseN-M.md>` containing only unresolved items, evidence, complete fixes, and proving tests.
3. The auditor creates `.feedback` last with `.review=<feedback-phaseN-M.md>`, then returns to silent foreground monitoring for `.done` or `.complete`.
4. The implementor's foreground monitor consumes `.feedback`; the implementor immediately reads the named review,
   validates, stages only its changes, creates and stages `.done` last, and returns to monitoring
   for a new `.feedback` marker or `.resolved`.
5. Repeat steps 3 and 4 until all flagged items are resolved.

If all flagged items are resolved, continue to the terminal handshake.

### 5. Terminal handshake

1. The auditor creates an empty, untracked root `.resolved` and continues monitoring.
2. The implementor's foreground monitor consumes `.resolved` and reports that it landed.
3. That same implementor immediately creates an empty, untracked root `.complete` and ends its loop.
4. The auditor's foreground monitor consumes `.complete`, reports that it landed, and ends its loop.
5. The user or external mechanism performs any final review and commit.

The `.resolved`/`.complete` acknowledgement prevents the auditor from exiting before the implementor has observed the final decision. Consuming terminal markers prevents stale files from terminating a later loop.

## Review boundaries

- The first audit compares the full staged implementation with `<plan>`.
- Every later audit compares the staged snapshot only with findings already recorded in `<audit>` or a prior feedback file.
- Green tests do not close a finding unless its failure mode and acceptance criteria are actually covered.
- Do not report optional improvements (nitpicks), style preferences (nitpicks), or unrelated defects during remediation.
- Minor inconsistencies and speculative edge cases belong in a finding only when they imply a plausible correctness failure.

## Index and file rules

- The implementor creates and stages `.done` only after all implementation changes are staged, making it the final publication step.
- The implementor never uses broad staging commands that could capture another actor's work.
- The auditor never edits implementation files and never changes the staged snapshot except for consuming protocol markers through the monitor.
- `<audit>` is the stable checklist. Follow-up rounds create new feedback files rather than erasing or rewriting the checklist.
- `.feedback` is created only after its referenced review is final. Review files are never amended
  after publication.
- `.done`, `.feedback`, `.resolved`, and `.complete` are transient protocol files and must never be committed.

## Recovery

- If an agent restarts, inspect the root markers and the explicitly supplied plan/audit paths before waiting. An unconsumed `.feedback`, `.resolved`, or `.complete` is actionable immediately; once consumed, its contents remain in the monitor event.
- Existing audit and feedback files are not automatically new work. Only `.feedback` publishes
  one, unless the user explicitly resumes from a named review.
- If `.done` exists but is not staged, the implementation handoff was not published; the auditor must keep waiting.
- If unrelated staged files appear, stop and ask the owner to restore a reviewable staged boundary. Do not unstage or overwrite another actor's work.
