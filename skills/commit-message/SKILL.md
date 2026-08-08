---
name: commit-message
description: generate a short commit-message summary for each git repo with staged changes, from the diff injected fresh at invocation
---

!`printf 'workflowPath=%s\nstagedDiffsPath=%s\n' "${CLAUDE_PLUGIN_ROOT}/skills/commit-message/commitMessage.workflow.js" "${CLAUDE_PLUGIN_ROOT}/scripts/stagedDiffs.ts"`

Call Workflow with scriptPath the `workflowPath` value above, args `{"stagedDiffsPath": "<the stagedDiffsPath value above>"}`. The workflow runs that script itself and pastes the resulting staged diff straight into its subagent's prompt, so the diff never enters your context. It returns `{summaries}`, one `{repo, message}` per affected repo — the current repo plus any submodule whose pointer moved.

Report the summaries to the user, one line per repo, in the following format:
```
Repo: <repo name> 
Message: <summary>
```
