import { fileURLToPath } from "node:url";

// Absolute, because the reading agent's shell has no CLAUDE_PLUGIN_ROOT to expand.
const WORKFLOW_PATH = fileURLToPath(new URL("../../skills/commit-message/commitMessage.workflow.js", import.meta.url));
const COMMIT_DIFF_BRIEF_PATH = fileURLToPath(new URL("./commitDiffBrief.ts", import.meta.url));

export const commitMessageBrief = (workflowPath: string, commitDiffBriefPath: string) => `WORKFLOW: {"scriptPath": "${workflowPath}", "args": {"commitDiffBriefPath": "${commitDiffBriefPath}"}}

execute \`Workflow(WORKFLOW)\`

The workflow's subagent reads the staged diff itself, so the diff never enters your context. It returns this shape, one entry per affected repo — the current repo plus any submodule whose pointer moved:
\`\`\`
{
   "summaries": [
      { "repo": <repoName>, "message": <commitMessage> }
   ]
}
\`\`\`

Report the summaries to the user, one line per repo, in the following format:
\`\`\`
Repo: <repo name>
Message: <summary>
\`\`\`
`;

if (process.argv[1]?.endsWith("commitMessageBrief.ts")) process.stdout.write(commitMessageBrief(WORKFLOW_PATH, COMMIT_DIFF_BRIEF_PATH));
