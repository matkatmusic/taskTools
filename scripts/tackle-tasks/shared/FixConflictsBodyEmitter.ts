// Sole home of the conflict-fix prompt, the "fix conflicts" box in plans/diagram/pipeline-rebase.mmd.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { absolutePathsSection } from "./promptSections.ts";

// The receipt that box hands back.
export type ConflictFixReceipt = {
    resolved: boolean;
    unresolvedPaths: string[];
};

const FIX_CONFLICTS_OUTPUT_PATH = fileURLToPath(new URL("../../../plans/fix-conflicts-output-template.json", import.meta.url));
const COMMIT_TASK_WORK_PATH = fileURLToPath(new URL("./commitTaskWork.ts", import.meta.url));

// Double-quoted for the read-file hook's parser; deduped so a path is never listed twice.
const readFileArgs = (paths: string[]) => [...new Set(paths)].map((path) => `"${path}"`).join(" ");

// Derived here, never accepted from the caller, who could otherwise supply an empty list.
function conflictedPaths(checkoutPath: string): string[] {
    const output = execFileSync("git", ["-C", checkoutPath, "diff", "--name-only", "--diff-filter=U", "-z"], { encoding: "utf8" });
    return output.split("\0").filter((line) => line.length > 0);
}

export function fixConflictsPrompt(checkoutPath: string, taskNumber: number, projectRoot: string, runId: string, sourceBranch: string): string {
    const root = checkoutPath.replace(/\/+$/, "");
    const paths = conflictedPaths(checkoutPath);
    if (paths.length === 0) throw new Error(`fix-conflicts: no unmerged paths in ${root}; this box runs only on a stopped rebase`);
    const absolutePaths = paths.map((path) => `${root}/${path}`);
    // Serialized, never interpolated field-by-field, and delivered on quoted-heredoc stdin.
    const commitPayload = JSON.stringify({
        projectRoot,
        worktreePath: checkoutPath,
        taskNumber,
        runId,
        stepId: "fix-conflicts",
        rootSourceBranch: sourceBranch,
        boxId: "COMMIT_MERGE_CONFLICT_FIX_IF_NEEDED",
    });
    return `## YOUR JOB

A rebase inside \`${root}\` is stopped on live conflict markers. 
It is stopped, not aborted, so the markers are still in the files.
Resolve every conflict in the files listed under WHAT YOU MAY EDIT, and nothing else.

before you do any work, run \`/ponytail:ponytail ultra\` first.

## WHAT TO READ

Run this, verbatim:
\`\`\`
/read-file ${readFileArgs([...absolutePaths, FIX_CONFLICTS_OUTPUT_PATH])}
\`\`\`
This skill puts the files into your context without spending a Read tool call, so you can read them all at once.

You may read any other file, anywhere in the tree, to understand a conflict: callers, callees, tests, other layers.

${absolutePathsSection(root)}

## WHAT YOU MAY EDIT

${absolutePaths.map((path) => `- \`${path}\``).join("\n")}

You may also edit a file in a DIFFERENT repository when resolving a conflict requires it. 
Resolving a conflict often means updating a call site, and a call site can live in another repository.

This list is complete. 
Never search the repository for more conflicted files.

## HOW TO RESOLVE

For each file listed above:
1. Find every \`<<<<<<<\`, \`=======\` and \`>>>>>>>\` block.
2. Combine the two sides so both sides' intent survives.
3. Delete the three marker lines.

## COMMIT YOUR WORK

Never stage or commit anything by hand. As your final step, run this with Bash, exactly as written:
node ${COMMIT_TASK_WORK_PATH} <<'TTCOMMIT'
${commitPayload}
TTCOMMIT

It prints one JSON object. If it fails, say so plainly and return nothing else.
That is an operational failure, and this run's operator owns it.

## DO NOT DRIVE THE REBASE

Never run \`git rebase --continue\` or \`git rebase --abort\`. 
A later box advances the rebase after you return.

## FORBIDDEN ACTIONS

You are forbidden from doing any of the following actions:
- weaken, delete, or stub out code to make a conflict disappear;
- keep one side and discard the other when both sides carry intent;
- edit a file that is not listed above and is not a call site a listed conflict forces you to update;
- force-push or hard-reset anything you did not create;
- run \`git rebase --continue\` or \`git rebase --abort\`;
- stage or commit anything by hand;
- leave a required edit in another repository unmade.

Returning \`resolved: false\` is a correct outcome when a conflict genuinely cannot be resolved.
It is not a failure, and it is always better than a guess.

## WHAT TO RETURN

Return the shape given by \`${FIX_CONFLICTS_OUTPUT_PATH}\`, which the read-file skill put into your
context, replacing every \`<...>\` with a real value.`;
}
