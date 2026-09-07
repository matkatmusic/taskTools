// Sole home of the conflict-fix prompt, the "fix conflicts" box in plans/diagram/pipeline-rebase.mmd.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { absolutePathsSection } from "./promptSections.ts";
import { resumedRunSection } from "./resumedRunSection.ts";
import { whatToReturnSection } from "./whatToReturn.ts";

// The receipt that box hands back.
export type ConflictFixReceipt = {
    resolved: boolean;
    unresolvedPaths: string[];
};

// Double-quoted for the read-file hook's parser; deduped so a path is never listed twice.
const readFileArgs = (paths: string[]) => [...new Set(paths)].map((path) => `"${path}"`).join(" ");

// Derived here, never accepted from the caller, who could otherwise supply an empty list.
function conflictedPaths(checkoutPath: string): string[] {
    const output = execFileSync("git", ["-C", checkoutPath, "diff", "--name-only", "--diff-filter=U", "-z"], { encoding: "utf8" });
    return output.split("\0").filter((line) => line.length > 0);
}

// Retired (prompt shapes): one template literal became FIX_CONFLICTS_SECTIONS below, so the skeleton view cannot drift.
// export function fixConflictsPrompt(checkoutPath: string, taskNumber: number, projectRoot: string, runId: string, sourceBranch: string): string {
//     const root = checkoutPath.replace(/\/+$/, "");
//     const paths = conflictedPaths(checkoutPath);
//     if (paths.length === 0) throw new Error(`fix-conflicts: no unmerged paths in ${root}; this box runs only on a stopped rebase`);
//     const absolutePaths = paths.map((path) => `${root}/${path}`);
//     return `## YOUR JOB
//
// A rebase inside \`${root}\` is stopped on live conflict markers.
// It is stopped, not aborted, so the markers are still in the files.
// Resolve every conflict in the files listed under WHAT YOU MAY EDIT, and nothing else.
//
// ## WHAT TO READ
//
// Run this, verbatim:
// \`\`\`
// /read-file ${readFileArgs(absolutePaths)}
// \`\`\`
// This skill puts the files into your context without spending a Read tool call, so you can read them all at once.
//
// You may read any other file, anywhere in the tree, to understand a conflict: callers, callees, tests, other layers.
//
// ${absolutePathsSection(root)}
//
// ## WHAT YOU MAY EDIT
//
// ${absolutePaths.map((path) => `- \`${path}\``).join("\n")}
//
// You may also edit a file in a DIFFERENT repository when resolving a conflict requires it.
// Resolving a conflict often means updating a call site, and a call site can live in another repository.
//
// This list is complete.
// Never search the repository for more conflicted files.
//
// ${resumedRunSection(root)}
//
// ## HOW TO RESOLVE
//
// For each file listed above:
// 1. Find every \`<<<<<<<\`, \`=======\` and \`>>>>>>>\` block.
// 2. Combine the two sides so both sides' intent survives.
// 3. Delete the three marker lines.
//
// ## DO NOT DRIVE THE REBASE
//
// Never run \`git rebase --continue\` or \`git rebase --abort\`.
// A later box advances the rebase after you return.
//
// ## FORBIDDEN ACTIONS
//
// You are forbidden from doing any of the following actions:
// - weaken, delete, or stub out code to make a conflict disappear;
// - keep one side and discard the other when both sides carry intent;
// - edit a file that is not listed above and is not a call site a listed conflict forces you to update;
// - force-push or hard-reset anything you did not create;
// - run \`git rebase --continue\` or \`git rebase --abort\`;
// - stage or commit anything by hand;
// - leave a required edit in another repository unmade.
//
// Returning \`resolved: false\` is a correct outcome when a conflict genuinely cannot be resolved.
// It is not a failure, and it is always better than a guess.
//
// ${whatToReturnSection('{ "resolved": "<true only when every listed path has no conflict marker left. false otherwise.>", "unresolvedPaths": ["<absolute path of a file that still contains a conflict marker. Empty array when resolved is true.>"] }', "replacing every `<...>` with a real value", "")}`;
// }

// The prompt never branches, so there is exactly one combo, "default".
export type FixConflictsChoices = Record<string, never>;

// Every value spliced into the prompt; the skeleton view passes each one as its expression text instead.
export type FixConflictsVars = {
    root: string;
    readFileArgs: string;
    absolutePaths: string;
    editablePathsList: string;
    resumedRun: string;
    whatToReturn: string;
};

export type FixConflictsSection = { name: string; when: (c: FixConflictsChoices) => boolean; render: (v: FixConflictsVars) => string };

export const FIX_CONFLICTS_SECTIONS: FixConflictsSection[] = [
    {
        name: "YOUR JOB",
        when: () => true,
        // Pass1: reordered prose to Who/How/Why/What (rule 1); de-pronouned "It" (rule 9).
        render: (v) => `## YOUR JOB

You are a conflict-resolution agent.
Your job is to resolve every conflict in the files listed under WHAT YOU MAY EDIT, and nothing else.
Your goal is to leave every listed file free of conflict markers so a later box can continue the rebase.
A rebase inside \`${v.root}\` is stopped on live conflict markers.
The rebase is stopped, not aborted, so the markers are still in the files.

`,
    },
    {
        name: "WHAT TO READ",
        when: () => true,
        // Pass1: skill-invocation shape (rule 5); was "Run this, verbatim:".
        render: (v) => `## WHAT TO READ

invoke this skill exactly:
\`\`\`
/read-file ${v.readFileArgs}
\`\`\`
This skill puts the files into your context without spending a Read tool call, so you can read them all at once.

You may read any other file, anywhere in the tree, to understand a conflict: callers, callees, tests, other layers.

${v.absolutePaths}

`,
    },
    {
        name: "WHAT YOU MAY EDIT",
        when: () => true,
        // Pass1: submodule wording (rule 10); dropped "This list is complete." (rules 7,9); no-blank-run fix (rule 4).
        render: (v) => `## WHAT YOU MAY EDIT

${v.editablePathsList}

You may also edit a file in a submodule of the parent repository, inside this worktree, when resolving a conflict requires it.
Resolving a conflict often means updating a call site.
A call site can live in that submodule.

Never search the repository for more conflicted files.

${v.resumedRun === "" ? "" : `${v.resumedRun}\n\n`}`,
    },
    {
        name: "HOW TO RESOLVE",
        when: () => true,
        render: () => `## HOW TO RESOLVE

For each file listed above:
1. Find every \`<<<<<<<\`, \`=======\` and \`>>>>>>>\` block.
2. Combine the two sides so both sides' intent survives.
3. Delete the three marker lines.

`,
    },
    {
        name: "DO NOT DRIVE THE REBASE",
        when: () => true,
        render: () => `## DO NOT DRIVE THE REBASE

Never run \`git rebase --continue\` or \`git rebase --abort\`.
A later box advances the rebase after you return.

`,
    },
    {
        name: "FORBIDDEN ACTIONS",
        when: () => true,
        // Pass1: submodule wording (rule 10); split compound + de-pronoun (rules 2,9).
        render: () => `## FORBIDDEN ACTIONS

You are forbidden from doing any of the following actions:
- weaken, delete, or stub out code to make a conflict disappear;
- keep one side and discard the other when both sides carry intent;
- edit a file that is not listed above and is not a call site a listed conflict forces you to update;
- force-push or hard-reset anything you did not create;
- run \`git rebase --continue\` or \`git rebase --abort\`;
- stage or commit anything by hand;
- leave a required edit unmade in a submodule of the parent repository, inside this worktree.

Returning \`resolved: false\` is a correct outcome when a conflict genuinely cannot be resolved.
Returning \`resolved: false\` is not a failure.
Returning \`resolved: false\` is always better than a guess.

`,
    },
    {
        name: "WHAT YOU, THE SPAWNING AGENT, RETURNS",
        when: () => true,
        render: (v) => v.whatToReturn,
    },
];

export function fixConflictsChoices(): FixConflictsChoices {
    return {};
}

// Each value is the source expression, so the skeleton view names what the rendered view splices in.
export const FIX_CONFLICTS_SKELETON_VARS: FixConflictsVars = {
    root: "`${root}`",
    readFileArgs: "`${readFileArgs(absolutePaths)}`",
    absolutePaths: "`${absolutePathsSection(root)}`",
    editablePathsList: '`${absolutePaths.map((path) => `- \\`${path}\\`` ).join("\\n")}`',
    resumedRun: "`${resumedRunSection(root)}`",
    whatToReturn: "`${whatToReturnSection(...)}`",
};

export function renderFixConflictsSections(choices: FixConflictsChoices, vars: FixConflictsVars): string {
    return FIX_CONFLICTS_SECTIONS.filter((s) => s.when(choices)).map((s) => s.render(vars)).join("");
}

export function fixConflictsPromptSkeleton(choices: FixConflictsChoices): string {
    return renderFixConflictsSections(choices, FIX_CONFLICTS_SKELETON_VARS);
}

export function fixConflictsPrompt(checkoutPath: string, taskNumber: number, projectRoot: string, runId: string, sourceBranch: string): string {
    const root = checkoutPath.replace(/\/+$/, "");
    const paths = conflictedPaths(checkoutPath);
    if (paths.length === 0) throw new Error(`fix-conflicts: no unmerged paths in ${root}; this box runs only on a stopped rebase`);
    const absolutePaths = paths.map((path) => `${root}/${path}`);
    return renderFixConflictsSections(fixConflictsChoices(), {
        root,
        readFileArgs: readFileArgs(absolutePaths),
        absolutePaths: absolutePathsSection(root),
        editablePathsList: absolutePaths.map((path) => `- \`${path}\``).join("\n"),
        resumedRun: resumedRunSection(root),
        whatToReturn: whatToReturnSection('{ "resolved": "<true only when every listed path has no conflict marker left. false otherwise.>", "unresolvedPaths": ["<absolute path of a file that still contains a conflict marker. Empty array when resolved is true.>"] }', "replacing every `<...>` with a real value", ""),
    });
}

// Bypasses git entirely: conflictedPaths shells out to a real repo, and faking that output was ruled out.
export function fixConflictsCombos(): { name: string; skeleton: string; rendered: string }[] {
    const c = fixConflictsChoices();
    const root = "/tmp/fake-worktree";
    const absolutePaths = ["src/a.ts", "src/b.ts"].map((path) => `${root}/${path}`);
    const vars: FixConflictsVars = {
        root,
        readFileArgs: readFileArgs(absolutePaths),
        absolutePaths: absolutePathsSection(root),
        editablePathsList: absolutePaths.map((path) => `- \`${path}\``).join("\n"),
        resumedRun: resumedRunSection(root),
        whatToReturn: whatToReturnSection('{ "resolved": "<true only when every listed path has no conflict marker left. false otherwise.>", "unresolvedPaths": ["<absolute path of a file that still contains a conflict marker. Empty array when resolved is true.>"] }', "replacing every `<...>` with a real value", ""),
    };
    return [{ name: "default", skeleton: fixConflictsPromptSkeleton(c), rendered: renderFixConflictsSections(c, vars) }];
}
