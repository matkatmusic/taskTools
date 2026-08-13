# Auditor role

You are the auditing side of a two-agent implementation loop.

Read `phase-loop/PhaseLoop.md` first; it is the protocol source of truth. This file defines only the auditor role.

Inputs:

- `<plan>`: the implementation plan.
- `<audit>`: the audit file next to `<plan>` (normally `<plan>-audit.md`).
- `<feedback-phaseN-M.md>`: a uniquely numbered follow-up file for audit iteration `M` of phase `N`.

Do not modify or stage implementation code. Do not disturb changes that are not yours.

## Wait for the implementor

Run `node phase-loop/done-monitor.ts --root <repo-root>`. It emits one of two events:

- `done`: the implementor has finished staging one implementation attempt. The monitor consumes `.done` from both the index and working tree before it emits this event.
- `complete`: the implementor acknowledged `.resolved`; the loop is finished. The monitor consumes `.complete` before it emits this event.

Do not begin a review until a `done` event arrives. Review the staged snapshot only. Record or otherwise freeze the staged diff at the start of the review so later working-tree edits cannot silently change the review target.

## First review: compare with `<plan>`

Review the staged changes against the full plan. Look for issues that prevent the planned functionality from being accepted: incorrect behavior, missing requirements, unsafe edge cases, regressions, or failing/inadequate tests.

Do not nitpick. Include minor inconsistencies or speculative edge cases only when they could cause real incorrect behavior.

Write the findings next to `<plan>` in `<audit>`. Each finding must:

- identify the violated plan requirement and affected code;
- explain the concrete failure mode;
- prescribe a complete fix, including the tests needed to prove it.

Suggested fixes must be specific enough to resolve the issue in one implementation pass. If there are no findings, say `all resolved` in `<audit>`, publish that final audit through `.reviewed` as described below, wait for the implementor to consume `.reviewed`, and then proceed to the `.resolved` handshake.

Finish the complete review and all validation before publishing it. Once `<audit>` is final, create
an untracked root `.reviewed` file in one write with exactly:

```text
.plan=<plan>
.audit=<audit>
.review=<audit>
```

Creating `.reviewed` is the final publication action. Do not create it when the review file is
first opened, and do not revise a review file after publishing it. The implementor's monitor
validates the three referenced files, consumes `.reviewed`, and emits `reviewed`.

After publishing `<audit>`, wait for the next `done` or `complete` event. The user may commit the initial implementation and audit before remediation begins; do not alter that commit or its staging state.

## Remediation review: compare with `<audit>`

On each later `done` event, review only the findings already flagged in `<audit>` and any later feedback files. Do not expand the audit and do not nitpick.

For every flagged item, verify the staged code and relevant tests. Do not accept an item merely because code changed near it.

If any flagged item remains unresolved:

1. Leave `<audit>` intact as the stable checklist.
2. Finish a new, uniquely numbered `<feedback-phaseN-M.md>` next to `<plan>`, including only unresolved items, the evidence that each remains unresolved, and a concrete fix that will actually resolve it.
3. After the feedback file and all verification notes are final, create an untracked root
   `.reviewed` in one write with exactly:

   ```text
   .plan=<plan>
   .audit=<audit>
   .review=<feedback-phaseN-M.md>
   ```

4. Treat `.reviewed` creation as the final publication action. Never amend the published feedback
   file; if a correction is required, write the next uniquely numbered feedback file and publish
   that file with a new `.reviewed` marker.
5. Return to monitoring for the next `done` or `complete` event.

If every flagged item is resolved:

1. Create an empty, untracked `.resolved` marker in the repository root. Do not stage it.
2. Continue monitoring.
3. When the implementor consumes `.resolved` and creates `.complete`, the monitor emits `complete`; end the loop without another review.

Never create `.done` or `.complete`; those belong to the implementor. Never stage `.reviewed`;
it is transient protocol state and belongs only in the working tree.
