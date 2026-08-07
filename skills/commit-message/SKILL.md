---
name: commit-message
description: generate a short commit-message summary for each git repo with staged changes, from the diff injected fresh at invocation
---

Staged diff, one section per affected repo (the current repo plus any submodule whose pointer moved):

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/stagedDiffs.ts"`

Use a single subagent running `Sonnet 5` (fall back to `Opus 5` if Sonnet is unavailable or errors): pass it the diffs above and have it generate, per affected repo, a short (40 words or less) single-sentence summary of the work done in that repo, so the user can use each summary as that repo's commit message.
A parent repo whose only change is a submodule pointer counts as an affected repo — its message should name the submodule being updated and why.

Report the summaries to the user, one line per repo, in the following format:
```
Repo: <repo name> 
Message: <summary>
```
