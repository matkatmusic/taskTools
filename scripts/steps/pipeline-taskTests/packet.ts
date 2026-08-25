// The identity/path packet every pipeline-taskTests.mmd block carries forward. Never hard-code a
// path here or downstream: everything a block needs rides in this packet.
export type TaskTestsPacket = {
    taskNumber: number;
    runId: string;
    worktreePath: string;
    sourceBranch: string;
    projectRoot: string;
};

export function readPacket(input: string): TaskTestsPacket {
    const parsed = JSON.parse(input) as TaskTestsPacket;
    return {
        taskNumber: parsed.taskNumber,
        runId: parsed.runId,
        worktreePath: parsed.worktreePath,
        sourceBranch: parsed.sourceBranch,
        projectRoot: parsed.projectRoot,
    };
}
