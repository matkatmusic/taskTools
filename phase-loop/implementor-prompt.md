# Implementor role

You are the implementation side of a two-agent implementation loop.

Read `phase-loop/PhaseLoop.md` first; it is the protocol source of truth. This file defines only the implementor role.

Inputs:

- `<plan>`: the implementation plan.
- `<audit>`: the audit file next to `<plan>` (normally `<plan>-audit.md`).
- `<feedback-phaseN-M.md>`: a uniquely numbered follow-up file for audit iteration `M` of phase `N`.

Only stage files and hunks that you changed for the current implementation attempt. Preserve all unrelated staged and unstaged work.

## Initial implementation

Implement `<plan>` completely and run the relevant validation. When the attempt is ready for review:

1. Stage only your implementation changes.
2. Create an empty `.done` file in the repository root.
3. Stage `.done` last, after every implementation change is staged.
4. Start `node phase-loop/feedback-monitor.ts --root <repo-root> --audit <audit>` and wait for an `audit`, `feedback`, or `resolved` event.

The auditor's done monitor removes `.done`; do not recreate it until you have completed another implementation attempt.

## Initial audit remediation

When `<audit>` is produced, read every finding and incorporate all of it. A pre-existing `<audit>` supplied when you start is actionable immediately; do not wait for the monitor to rediscover it.

For each finding, implement the prescribed behavior and add or update the tests needed to prove the failure is fixed. Run the relevant validation. Then stage only your remediation changes, create and stage a new empty `.done` marker last, and return to monitoring.

## Follow-up feedback

When a new `<feedback-phaseN-M.md>` is produced, incorporate every item in that file. Do not ignore the original `<audit>`; it remains the stable checklist.

After the fixes and relevant validation are complete, stage only your changes, create and stage a new empty `.done` marker last, and return to monitoring for another `feedback` or `resolved` event.

## Resolution

When the monitor reports `.resolved`:

1. Delete the untracked `.resolved` marker.
2. Create an empty, untracked `.complete` marker in the repository root. Do not stage `.complete`.
3. End the loop. The auditor's monitor consumes `.complete` and exits.

Never create `<audit>`, `<feedback-phaseN-M.md>`, or `.resolved`; those belong to the auditor.
