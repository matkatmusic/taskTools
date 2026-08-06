## 2026-08-06:15:00:00 — Retry `agent()` on API disconnect in the tackle-tasks workflows
Chat title: curried-sparkle
Path to JSONL log: /Users/matkatmusicllc/.claude/projects/-Users-matkatmusicllc-Programming-taskTools/94571ef4-fe65-45b8-8f70-b565daaf09a2.jsonl

### References

/Users/matkatmusicllc/Programming/taskTools/plans/ultra-fuzzy-star.md
/Users/matkatmusicllc/Programming/taskTools/plans/ultra-fuzzy-star-amendment.md
/Users/matkatmusicllc/.claude/plans/read-users-matkatmusicllc-programming-ta-curried-sparkle.md
/Users/matkatmusicllc/Programming/taskTools/skills/tackle-tasks/plan.workflow.js
/Users/matkatmusicllc/Programming/taskTools/skills/tackle-tasks/verify.workflow.js
/Users/matkatmusicllc/Programming/taskTools/skills/tackle-tasks/implement.workflow.js
/Users/matkatmusicllc/Programming/taskTools/skills/tackle-tasks/test.workflow.js
/Users/matkatmusicllc/Programming/taskTools/skills/tackle-tasks/merge.workflow.js
/Users/matkatmusicllc/Programming/taskTools/tests/tackleTasksRetry.test.ts

### Design decisions

- The helper is duplicated byte-for-byte in all five workflow files, as the plan
  requires; the sandbox rejects both static and dynamic `import`. A test asserts
  the five copies are identical so they cannot drift apart.
- The wiring gate counts `agent(` occurrences and `retryAgent(() => agent(`
  occurrences per file and asserts they are equal, with per-file expected totals
  `{plan: 1, verify: 1, implement: 1, test: 2, merge: 1}`. `retryAgent(` uses a
  capital `A`, so it never inflates the `agent(` count. No workflow brief string
  contains the literal `agent(`, so the count is exact.
- The helper is extracted for testing by locating its `// ponytail:` marker
  comment and slicing to the first line-start `}`. The marker doubles as the
  extraction anchor, so removing it fails the drift test loudly rather than
  silently skipping it.

### Deviations

- The plan's Tests section lists two behaviour tests (`null` retry, three-failure
  stop). Four shipped: `test_retryAgentRetriesUndefined` and
  `test_retryAgentPreservesFalsyZero` were added because the two listed cases
  both pass under a wrong `if (result)` implementation (which would re-spawn a
  valid `0`) and under a wrong `result !== null` implementation (which would
  return `undefined`). This closes the gap named in the amendment.
- Two negative controls were added beyond the plan's wording:
  `test_theWiringGateFailsOnADirectAgentCall` and
  `test_theParseGateFailsOnBrokenSource`. The plan asked for negative fixtures
  inside the wiring and parse tests; separate named tests report which gate
  broke instead of one test failing for two possible reasons.
- `test.workflow.js:129` fallback text was reworded to
  `'test agent returned no result after 3 attempts'`. The plan listed this edit
  at line 129 but described it under the `test.workflow.js:129` bullet as the
  `'test agent returned no result'` detail; the wording change was applied as
  described for the other four sites.

### Tradeoffs

- The `bun build --target=node` syntax gate the earlier plan proposed was
  dropped, as the plan directs: it prints `FAIL` for all five unmodified files
  (top-level `return` is illegal in ESM) and still exits `0`. Replaced by
  `test_everyWorkflowFileParsesInItsSandboxShape`, which wraps each source in
  `(async () => { … })()` and compiles it with `new Function`. A parse error now
  fails the test run nonzero.
- No backoff between attempts, per the plan. Three immediate re-spawns against a
  still-overloaded API will all fail fast. Accepted; add backoff only if
  observed to matter.
- A `null` result does not distinguish a dropped connection from a safety-block
  or a killed agent, so a permanently-blocked agent burns all three attempts.
  Accepted ceiling, documented in the plan.

### Open questions

- Accepted ceiling, restated for confirmation: a retried agent gets the same
  brief as the first and cannot see what its predecessor already did. The
  worker, the test fixer, and the merge diagnoser all stage and commit, so a
  retry can repeat side effects on a repository the dead attempt already
  changed. The plan explicitly defers this ("Revisit only if observed in
  practice"). Confirm that is still the call.
- `merge.workflow.js` no longer claims "nothing was diagnosed and nothing was
  fixed" after three failed attempts; it now tells the reader to inspect the
  repository because an earlier attempt may have changed it. Confirm that
  wording reads correctly for you.
