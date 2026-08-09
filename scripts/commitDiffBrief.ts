import { stagedDiffs } from "./stagedDiffs.ts";

export const commitDiffBrief = (diffs: string) => `Generate, per affected repo, a short (40 words or less) single-sentence summary of the work done in that repo, so the user can use each summary as that repo's commit message.
The diff below has one section per affected repo (the current repo plus any submodule whose pointer moved).
A parent repo whose only change is a submodule pointer counts as an affected repo — its message should name the submodule being updated and why.

Return {summaries}: one {repo, message} per affected repo.

${diffs}`;

if (process.argv[1]?.endsWith("commitDiffBrief.ts")) process.stdout.write(commitDiffBrief(stagedDiffs()));
