// RUN_FULL_SUITE, from pipeline-runFullSuite.mmd. Mutating: runs the target worktree's real test suite.  Entered from COMMIT_SUITE_FIX_IF_NEEDED (loop-back) or, cross-diagram, straight from pipeline-rebase.mmd::REBASE_ONTO_TARGET_BRANCH.
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../contracts.ts";
import { runFullSuite } from "../shared/runFullSuite.ts";
import { loadPreparedTask } from "../shared/preparedTask.ts";
import { getAttemptCount } from "../shared/taskRunState.ts";

type Input = {
    taskNumber: number;
    runId: string;
    projectRoot: string;
    worktree: string;
    branch: string;
};

function baseBranch(projectRoot: string): string {
    // return execFileSync("git", ["-C", projectRoot, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" }).trim();
    return "staging";
}

export async function main(input: string): Promise<Record<string, unknown>> {
    const { next: _next, ...packet } = JSON.parse(input) as Input & { next?: string };
    const targetBranch = baseBranch(packet.projectRoot);
    // Re-derives ownedFilePaths/testFilePaths on every entry, never trusts a carried-forward value.
    const prepared = loadPreparedTask(packet.taskNumber, packet.worktree, packet.projectRoot);
    const attempts = getAttemptCount(packet.taskNumber, "suiteFix", packet.projectRoot);
    const result = await runFullSuite(
        packet.taskNumber, packet.runId, packet.worktree, targetBranch, `run-full-suite-${attempts}`, packet.projectRoot,
    );
    return {
        ...packet,
        box: "RUN_FULL_SUITE",
        scriptSignal: SCRIPT_SIGNAL.CONTINUE,
        ownedFilePaths: prepared.ownedFilePaths,
        testFilePaths: prepared.testFilePaths,
        passed: result.passed,
        output: result.output,
    };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(await main(process.argv[2] ?? "")));
