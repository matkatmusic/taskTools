## Pipeline State Files
- plans/checkpoint.json and the run log are LIVE run state. Never `git checkout --`, `git restore`, or otherwise revert them. If state looks stale, inspect and repair it explicitly instead.
- Worktrees must always be cut from `staging`, never from the current branch or `main`.
## Test Baseline
- Every agent runs the suite with `npm run test:baseline` (scripts/checkTestBaseline.ts). Never read raw `npm test` output to decide pass or fail.
- It exits non-zero only on failures that are not in `.taskTools/knownFailingTests.json`. Those known failures are the committed baseline.
- Only `/task-tests` may rewrite the baseline, and only when the user asks for it.
