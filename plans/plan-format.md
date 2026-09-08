# Plan format

The plan is JSON so a script can apply codex's feedback. No agent rewrites a plan to
absorb review notes — that is what burned three rounds and ~268K tokens in run B.

## plan.json

Written by the planning agent to the task worktree.

```json
{
  "task": 169,
  "revision": 1,
  "sections": [
    { "id": "problem",  "title": "Problem",  "body": "markdown" },
    { "id": "step-1",   "title": "Add the QueueEndState union", "body": "markdown" },
    { "id": "step-2",   "title": "Update shouldEndQueue", "body": "markdown" }
  ]
}
```

- `sections` order is the plan order. Nothing else encodes sequence.
- `id` is stable, lowercase, kebab-case, unique within the plan. Codex addresses sections
  by `id`, so renaming one silently orphans its feedback.
- `body` is markdown, and follows `~/.claude/guides/planning.md` — how and in what order,
  not why. Test-first per `~/.claude/guides/tdd.md`.
- `revision` starts at 1 and increments once per applied amendment batch.

## codex-review.json

Returned by the review agent. It never edits the plan.

```json
{
  "verdict": "amend",
  "notes": "step-2 does not say which file the union goes in",
  "amendments": [
    { "op": "replace", "id": "step-2", "body": "markdown" },
    { "op": "insert", "after": "step-2", "id": "step-2a", "title": "…", "body": "markdown" },
    { "op": "remove", "id": "step-5" }
  ]
}
```

- `verdict` is `"amend"` or `"scrap"`.
- `"scrap"` carries `notes` and no `amendments`. The planning agent is respawned once with
  those notes. A second `"scrap"` stops the run.
- `"amend"` carries at least one amendment. The script applies them and goes straight to
  implement — there is no second review round.

## Applying amendments

A pure function, no agent:

1. Reject the batch whole if any `id` (or `after`) names a section that is not in the plan,
   or if an `insert` reuses an existing `id`. A partial apply is worse than none.
2. Apply in the order given. `replace` swaps `title`/`body` in place and keeps position.
   `insert` places the new section immediately after `after`. `remove` drops it.
3. Increment `revision`, write the file back.

## Why the ids matter

Codex must quote an `id` to change anything. That is the whole mechanism: feedback that
cannot name a section cannot be applied, which forces the review to be specific instead of
returning prose an agent then has to interpret.
