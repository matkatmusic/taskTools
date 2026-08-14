// Walks plans/diagram/pipeline.mmd for one set of decision outcomes and names every box it
// visits, in order. Nothing here touches a repository — it is the diagram made runnable, so a
// path can be read end to end without running a task.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Loop decisions hold one entry per attempt: taskTestsFail [true, false] fails once, then passes.
export type PipelineDecisions = {
    taskNumber: number;
    taskNumberValid: boolean;
    taskOpen: boolean;
    taskActive: boolean;
    taskBlocked: boolean;
    worktreeExists: boolean;
    worktreeSafe: boolean;
    previousWorkResumable: boolean;
    planFileValid: boolean[];
    codexPlanVerdict: ("accept" | "amend" | "scrap")[];
    taskTestsFail: boolean[];
    codexTestsFlagged: boolean[];
    rebase: ("ok" | "conflict")[];
    rebaseAdvance: ("finished" | "conflicts")[];
    fullSuitePasses: boolean[];
    fenceHeld: boolean;
    mergeLands: boolean[];
};

const MAX_ATTEMPTS = 2;
const INDENT = "  ";
// A box the diagram paints yellow: an agent runs it, not a script.
const AGENT = "<-- AGENT -->";
// Divides the trace into the sub-pipelines, one .mmd file each.
const BANNER_RULE = "---------";

const yesNo = (value: boolean): string => (value ? "YES" : "NO");

// Reads one attempt's outcome. Past the end of the list the last entry repeats, so a settings
// object only has to spell out the attempts whose outcome actually differs.
const attempt = <T,>(outcomes: T[], index: number): T => outcomes[Math.min(index, outcomes.length - 1)]!;

export function traceTaskPipeline(decisions: PipelineDecisions): string[] {
    const trace: string[] = [`Run start: Task Num [${decisions.taskNumber}]`];
    // Every repeat of a loop indents one more level, so a second pass is visible at a glance.
    let depth = 0;
    const push = (line: string): void => {
        trace.push(INDENT.repeat(depth) + line);
    };
    // A sub-pipeline boundary. Never indented: it is a divider, not a step inside a loop.
    const banner = (pipeline: string): void => {
        trace.push(`${BANNER_RULE} ${pipeline} ${BANNER_RULE}`);
    };

    // Exits reached before the task was marked active: the report reads the edge, not tasks.json.
    const reportAndStop = (exitType: string): string[] => {
        banner("exit workflow");
        push(`REPORT EXIT TYPE AND NOTE: ${exitType}`);
        push("STOP");
        return trace;
    };
    // A lease exists only once a worktree does; the source lock is taken at the rebase box.
    // The release box says "if held", so an exit that reached neither has nothing to release.
    let leaseHeld = false;
    let sourceLockHeld = false;

    // Every other exit runs the common exit chain, then reports from the ended run record.
    const exitChain = (exitType: string): string[] => {
        banner("exit workflow");
        push(`WRITE EXIT TYPE: ${exitType}`);
        push("RECORD MODIFIED FILES");
        push("MARK INACTIVE");
        if (sourceLockHeld) push("RELEASE THE WORKTREE LEASE AND SOURCE LOCK");
        else if (leaseHeld) push("RELEASE THE WORKTREE LEASE");
        push(`REPORT THE RUN'S EXIT TYPE AND NOTE: ${exitType}`);
        push("STOP");
        return trace;
    };

    banner("preamble");
    push(`TASK VALID: ${yesNo(decisions.taskNumberValid)}`);
    if (!decisions.taskNumberValid) return reportAndStop("INVALID-NUMBER");

    push(`TASK OPEN: ${yesNo(decisions.taskOpen)}`);
    if (!decisions.taskOpen) return reportAndStop("NOT-OPEN");

    // Drawn as two boxes, but one atomic read-modify-write: nothing can make the task
    // active between the question and the write.
    push(`TASK ACTIVE: ${yesNo(decisions.taskActive)}`);
    if (decisions.taskActive) return reportAndStop("ALREADY-ACTIVE");
    push("MARK THE TASK ACTIVE");

    push(`TASK BLOCKED: ${yesNo(decisions.taskBlocked)}`);
    if (decisions.taskBlocked) return exitChain("BLOCKED");

    // Four worktree shapes converge on "init submodules recursively".
    push(`WORKTREE EXISTS: ${yesNo(decisions.worktreeExists)}`);
    if (!decisions.worktreeExists) {
        push("CREATE A WORKTREE");
        push("AUTO GENERATE DOCS");
    } else {
        push(`WORKTREE SAFE: ${yesNo(decisions.worktreeSafe)}`);
        if (decisions.worktreeSafe) {
            push("UPDATE AUTO GENERATED DOCS");
        } else {
            push(`PREVIOUS WORK RESUMABLE: ${yesNo(decisions.previousWorkResumable)}`);
            if (decisions.previousWorkResumable) {
                push("UPDATE AUTO GENERATED DOCS");
            } else {
                push("RESET THE WORKTREE");
                push("AUTO GENERATE DOCS");
            }
        }
    }
    push("INIT SUBMODULES RECURSIVELY");
    leaseHeld = true;
    banner("planning");

    // An invalid plan file counts as a scrap, and skips the codex call entirely.
    const planDepth = depth;
    let planAttempt = 0;
    let codexPlanAttempt = 0;
    for (;;) {
        push(`${AGENT} PLAN THE TASK`);
        push("VALIDATE PLAN");
        if (!attempt(decisions.planFileValid, planAttempt)) {
            push("PLAN INVALID: COUNTS AS A SCRAP");
            planAttempt += 1;
            if (planAttempt >= MAX_ATTEMPTS) return exitChain("PLAN-SCRAPPED");
            depth += 1;
            continue;
        }
        push(`${AGENT} CODEX REVIEWS PLAN`);
        const verdict = attempt(decisions.codexPlanVerdict, codexPlanAttempt);
        push(`CODEX REVIEW RESULT (ACCEPT,AMEND,SCRAP): ${verdict.toUpperCase()}`);
        if (verdict !== "scrap") {
            if (verdict === "amend") push("APPLY CODEX AMENDMENTS TO THE PLAN");
            break;
        }
        planAttempt += 1;
        codexPlanAttempt += 1;
        if (planAttempt >= MAX_ATTEMPTS) return exitChain("PLAN-SCRAPPED");
        depth += 1;
    }
    depth = planDepth;

    banner("implement and test");
    push(`${AGENT} IMPLEMENT TASK`);
    push("RECORD IMPL NOTES");

    // Rule 6: every repair re-enters at "commit if needed", never at the test box.
    const testDepth = depth;
    let testAttempt = 0;
    let codexTestAttempt = 0;
    for (;;) {
        push("COMMIT (IF NEEDED)");
        push("RUN TASK TESTS");
        const testsFail = attempt(decisions.taskTestsFail, testAttempt);
        push(`TESTS FAIL: ${yesNo(testsFail)}`);
        if (testsFail) {
            testAttempt += 1;
            if (testAttempt >= MAX_ATTEMPTS) return exitChain("TESTS-RED");
            push(`${AGENT} FIX THE CODEBASE`);
            depth += 1;
            continue;
        }
        push(`${AGENT} CODEX REVIEWS TEST`);
        const flagged = attempt(decisions.codexTestsFlagged, codexTestAttempt);
        push(`CODEX REVIEW TEST RESULT (FLAG, ACCEPT): ${flagged ? "FLAG" : "ACCEPTED"}`);
        if (!flagged) break;
        codexTestAttempt += 1;
        if (codexTestAttempt >= MAX_ATTEMPTS) return exitChain("TESTS-FLAGGED");
        push(`${AGENT} AMEND THE TESTS`);
        testAttempt += 1;
        depth += 1;
    }
    depth = testDepth;

    // The last box of "implement and test": the lock is held from here to the exit workflow.
    push("LOCK SOURCE");
    sourceLockHeld = true;

    banner("rebase and merge");
    // The merge retry re-enters at the rebase box, so the whole tail below can run twice.
    const mergeDepth = depth;
    let conflictAttempt = 0;
    let suiteAttempt = 0;
    let rebaseAttempt = 0;
    let advanceAttempt = 0;
    let mergeAttempt = 0;
    for (;;) {
        // Re-entered on a merge retry, where the lock is already ours and the rebase may be a no-op.
        push("REBASE IF NEEDED");
        let conflicted = attempt(decisions.rebase, rebaseAttempt) === "conflict";
        push(`REBASE RESULT (OK, CONFLICT): ${conflicted ? "CONFLICT" : "OK"}`);
        rebaseAttempt += 1;

        // "did the rebase report conflicts?" is re-entered by the advance box, not just by the rebase.
        const rebaseTailDepth = depth;
        for (;;) {
            if (conflicted) {
                conflictAttempt += 1;
                if (conflictAttempt >= MAX_ATTEMPTS) return exitChain("REBASE-STUCK");
                push(`${AGENT} FIX CONFLICTS`);
            }
            push("COMMIT (IF NEEDED)");
            const advance = attempt(decisions.rebaseAdvance, advanceAttempt);
            push(`ADVANCE REBASE RESULT (FINISHED, CONFLICTS): ${advance.toUpperCase()}`);
            advanceAttempt += 1;
            if (advance === "finished") {
                const suitePasses = attempt(decisions.fullSuitePasses, suiteAttempt);
                push(`RUN FULL SUITE RESULTS (PASS, FAIL): ${suitePasses ? "PASS" : "FAIL"}`);
                if (suitePasses) break;
                suiteAttempt += 1;
                if (suiteAttempt >= MAX_ATTEMPTS) return exitChain("SUITE-RED");
                push(`${AGENT} FIX THE CODEBASE`);
                conflicted = false;
                depth += 1;
                continue;
            }
            conflicted = attempt(decisions.rebase, rebaseAttempt) === "conflict";
            depth += 1;
            push(`REBASE RESULT (OK, CONFLICT): ${conflicted ? "CONFLICT" : "OK"}`);
            rebaseAttempt += 1;
        }
        depth = rebaseTailDepth;

        push(`CHECK FILE FENCE RESULT (PASS, FAIL): ${decisions.fenceHeld ? "PASS" : "FAIL"}`);
        if (!decisions.fenceHeld) return exitChain("FENCE-VIOLATION");

        const merged = attempt(decisions.mergeLands, mergeAttempt);
        push(`MERGE WORKTREES AND SUBMODULES RESULT (PASS, FAIL): ${merged ? "PASS" : "FAIL"}`);
        if (merged) break;
        mergeAttempt += 1;
        if (mergeAttempt >= MAX_ATTEMPTS) return exitChain("MERGE-FAILED");
        conflictAttempt = 0;
        suiteAttempt = 0;
        depth += 1;
    }
    depth = mergeDepth;

    banner("exit workflow");
    push("RECORD MERGE COMMIT HASHES");
    push("WRITE EXIT TYPE: COMPLETED");
    push("RECORD MODIFIED FILES");
    push("CLEAN UP WORKTREES");
    push("BUILD CLOSURE NOTE");
    push("MARK INACTIVE");
    push("MOVE TASK TO completedTasks.json");
    push("REPORT THE CLOSURE NOTE");
    push("STOP");
    return trace;
}

// The named paths live beside this file so one path can be exercised without composing JSON.
export const PATHS_FILE = fileURLToPath(new URL("./tracePipelinePaths.json", import.meta.url));

export function readNamedPaths(): Record<string, PipelineDecisions> {
    return JSON.parse(readFileSync(PATHS_FILE, "utf8")) as Record<string, PipelineDecisions>;
}

if (process.argv[1]?.endsWith("tracePipeline.ts")) {
    const [name] = process.argv.slice(2);
    const paths = readNamedPaths();

    if (name === "--list") {
        process.stdout.write(`${Object.keys(paths).join("\n")}\n`);
    } else if (name === "--all") {
        for (const [pathName, decisions] of Object.entries(paths)) {
            process.stdout.write(`=== ${pathName} ===\n${traceTaskPipeline(decisions).join("\n")}\n\n`);
        }
    } else if (name === undefined) {
        process.stdout.write(`${traceTaskPipeline(JSON.parse(readFileSync(0, "utf8")) as PipelineDecisions).join("\n")}\n`);
    } else if (paths[name] === undefined) {
        process.stderr.write(`tracePipeline: no path named "${name}"\nknown paths:\n${Object.keys(paths).map((known) => `  ${known}`).join("\n")}\n`);
        process.exit(1);
    } else {
        process.stdout.write(`${traceTaskPipeline(paths[name]).join("\n")}\n`);
    }
}
