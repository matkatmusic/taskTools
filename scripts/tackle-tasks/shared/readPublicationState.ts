// "read the publication state from the layer merge refs" — pipeline-merge.mmd. Read-only.
import { readFileSync } from "node:fs";
import { findRecordedMergedCommit } from "../../mergeTaskWorktrees.ts";
import { taskBranchName } from "./createTaskWorktree.ts";
import { buildWorktreeOccurrences } from "./occurrences.ts";
import type { TaskCommit } from "./taskRunState.ts";
import { logStepOutput } from "./logStepOutput.ts";

export type PublicationState = "ALL LANDED" | "SOME LANDED" | "NONE LANDED";

export type ReadPublicationStateInput = {
    taskNumber: number;
    projectRoot: string;
    worktreePath: string;
    rootSourceBranch: string;
};

export type ReadPublicationStateOutput = {
    state: PublicationState;
    landed: string[];
    notLanded: string[];
    commits: TaskCommit[];
};

// A merge ref is written as its layer lands, so it survives a crash the return value cannot.
export function readPublicationState(input: ReadPublicationStateInput): ReadPublicationStateOutput {
    const branch = taskBranchName(input.taskNumber);
    const occurrences = buildWorktreeOccurrences(input.worktreePath, input.projectRoot, input.rootSourceBranch);
    const landed: string[] = [];
    const notLanded: string[] = [];
    const commits: TaskCommit[] = [];
    for (const occurrence of occurrences) {
        const name = occurrence.occurrenceId || "root";
        const hash = findRecordedMergedCommit(occurrence.sourceCheckoutPath, branch);
        if (hash === null) {
            notLanded.push(name);
            continue;
        }
        landed.push(name);
        commits.push({ occurrenceId: occurrence.occurrenceId, hash, kind: "merge" });
    }
    if (notLanded.length === 0) return { state: "ALL LANDED", landed, notLanded, commits };
    if (landed.length === 0) return { state: "NONE LANDED", landed, notLanded, commits };
    return { state: "SOME LANDED", landed, notLanded, commits };
}

const READ_PUBLICATION_STATE_SOURCE = "scripts/tackle-tasks/readPublicationState.ts:25: readPublicationState";

if (process.argv[1]?.endsWith("readPublicationState.ts")) {
    const payloadText = readFileSync(0, "utf8");
    const input = JSON.parse(payloadText) as ReadPublicationStateInput & { runId?: string; boxId?: string };
    const identity = { projectRoot: input.projectRoot, taskNumber: input.taskNumber, runId: input.runId ?? "" };
    const boxId = input.boxId ?? "readPublicationState";
    const command = `node ${process.argv[1]} <<'TTREAD'\n${payloadText}\nTTREAD`;

    try {
        const output = readPublicationState(input);
        const commandOutput = `${JSON.stringify(output)}\n`;
        logStepOutput(identity, { boxId, source: READ_PUBLICATION_STATE_SOURCE, input, command, commandOutput, output });
        process.stdout.write(commandOutput);
    } catch (error) {
        const message = String((error as Error)?.message ?? error);
        logStepOutput(identity, { boxId, source: READ_PUBLICATION_STATE_SOURCE, input, command, commandOutput: message, output: { error: message } });
        throw error;
    }
}
