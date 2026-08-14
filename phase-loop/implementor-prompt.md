# Implementor role

You are the implementation side of a two-agent implementation loop.

Read `phase-loop/PhaseLoop.md` first; it is the protocol source of truth. This file defines only the implementor role.

Inputs:

- `<plan>`: the implementation plan.
- `<audit>`: the audit file next to `<plan>` (normally `<plan>-audit.md`).
- `<feedback-phaseN-M.md>`: a uniquely numbered follow-up file for audit iteration `M` of phase `N`.

Only stage files and hunks that you changed for the current implementation attempt. Preserve all unrelated staged and unstaged work.

After following an implementor instruction, the only protocol output you may produce is `.done`
when an implementation attempt is ready or `.complete` when acknowledging `.resolved`.

## Initial implementation

Implement `<plan>` completely and run the relevant validation. When the attempt is ready for review:

1. Stage only your implementation changes.
2. Create an empty `.done` file in the repository root.
3. Stage `.done` last, after every implementation change is staged.
4. Start `node phase-loop/feedback-monitor.ts --root <repo-root>` in the foreground and wait for a
   `feedback` or `resolved` event.

The monitor must remain attached to this implementor turn. If the execution tool yields a running
session, poll that same session until it reports that `.feedback` or `.resolved` landed. Do not
alert the user, send waiting updates, or return a final response while it is waiting. The monitor
consumes the trigger before reporting it. In the same turn, immediately follow the instructions
for the reported event and produce the next protocol marker; do not stop after reporting that the
trigger landed.

The auditor's done monitor removes `.done`; do not recreate it until you have completed another implementation attempt.

For a `feedback` event, verify that its `planPath` and `auditPath` are the supplied `<plan>` and
`<audit>`, then read `reviewPath`. The monitor emits only after the auditor has finished that file
and published it through `.feedback`; do not infer new work from audit or feedback-file creation.
The monitor consumes the marker and includes its exact bytes in the event's `contents` field.
Both `feedback` and `resolved` events report `status:"landed"` and a mandatory `nextAction`.

## Initial audit remediation

When the initial `feedback` event names `<audit>` as `reviewPath`, read every finding and
incorporate all of it. A pre-existing `<audit>` is actionable only when the matching `.feedback`
publication is supplied or the user explicitly resumes from that review.

For each finding, implement the prescribed behavior and add or update the tests needed to prove the failure is fixed. Run the relevant validation. Then stage only your remediation changes, create and stage a new empty `.done` marker last, and return to monitoring.

## Follow-up feedback

When a `feedback` event names a new `<feedback-phaseN-M.md>` as `reviewPath`, incorporate every
item in that file. Do not ignore the original `<audit>`; it remains the stable checklist.

After the fixes and relevant validation are complete, stage only your changes, create and stage a new empty `.done` marker last, and return to silent foreground monitoring for another `feedback` or `resolved` event.

## Resolution

When the monitor consumes `.resolved` and reports `resolved` (including the marker's `contents`):

1. Create an empty, untracked `.complete` marker in the repository root. Do not stage `.complete`.
2. End the loop. The auditor's monitor consumes `.complete` and exits.

Never create `<audit>`, `<feedback-phaseN-M.md>`, `.feedback`, or `.resolved`; those belong to the auditor.
