// Walks the five diagrams in plans/diagram for one set of decision outcomes and names every box
// it visits, in order. Nothing here touches a repository — it is the diagram made runnable, so a
// path can be read end to end without running a task.
//
//   plans/diagram/pipeline-preamble.mmd       banner "preamble"
//   plans/diagram/pipeline-planning.mmd       banner "planning"
//   plans/diagram/pipeline-implementTest.mmd  banner "implement and test"
//   plans/diagram/pipeline-rebaseMerge.mmd    banner "rebase and merge"
//   plans/diagram/pipeline-exitWorkflow.mmd   banner "exit workflow"
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Every receipt a pipeline emits. Each one is validated before anything reads its contents.
export type ReceiptName =
    | "active task"
    | "plan file"
    | "codex review"
    | "finished plan"
    | "fix the codebase"
    | "test review"
    | "amend tests"
    | "finished implementation"
    | "conflict fix"
    | "fix the full suite"
    | "merge";

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
    codexPlanVerdict: ("accept" | "amend" | "scrap")[];
    taskTestsFail: boolean[];
    codexTestsFlagged: boolean[];
    sourceRepoFree: boolean[];
    lockSucceeds: boolean[];
    rebase: ("ok" | "conflict")[];
    rebaseAdvance: ("finished" | "conflicts")[];
    fullSuitePasses: boolean[];
    fenceHeld: boolean;
    mergeLands: boolean[];
    // Names the one receipt whose structure check fails. Absent means every receipt validates.
    // One field, not one flag per receipt: a run only ever dies on the first malformed receipt.
    malformedReceipt?: ReceiptName;
};

const MAX_ATTEMPTS = 2;
const INDENT = "  ";
// A box the diagram paints orange: an agent runs it, not a script.
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
    // A lease exists only once a worktree does; the source lock is taken in "implement and test".
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

    // Output -> receipt -> structure check -> output -> the same receipt, now trusted.
    // Returns the finished trace when the structure check fails, null when the run continues.
    const receipt = (name: ReceiptName, fields: string): string[] | null => {
        push("OUTPUT");
        push(`RECEIPT: ${fields}`);
        const valid = decisions.malformedReceipt !== name;
        push(`IS THE ${name.toUpperCase()} RECEIPT VALID: ${yesNo(valid)}`);
        if (!valid) return exitChain("RUN-FAILED");
        push("OUTPUT");
        push(`RECEIPT (TRUSTED): ${fields}`);
        return null;
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
    const preambleReceipt = receipt("active task", "{ active task, initialized worktree }");
    if (preambleReceipt) return preambleReceipt;

    banner("planning");
    // The scrap loop re-enters at "plan the task"; the amend loop re-enters at "codex reviews".
    const planDepth = depth;
    let scrapAttempt = 0;
    let amendRound = 0;
    let verdict: "accept" | "amend" | "scrap" = "accept";
    let verdictIndex = 0;
    planning: for (;;) {
        push(`${AGENT} PLAN THE TASK`);
        const planReceipt = receipt("plan file", "{ plan file: task, revision, sections }");
        if (planReceipt) return planReceipt;

        for (;;) {
            push(`${AGENT} CODEX REVIEWS THE PLAN`);
            const reviewReceipt = receipt("codex review", "{ codex review: verdict, notes, amendments }");
            if (reviewReceipt) return reviewReceipt;

            verdict = attempt(decisions.codexPlanVerdict, verdictIndex);
            verdictIndex += 1;
            push(`REVIEW VERDICT (ACCEPT, AMEND, SCRAP): ${verdict.toUpperCase()}`);

            if (verdict === "accept") break planning;

            if (verdict === "scrap") {
                scrapAttempt += 1;
                push(`FIRST TIME SCRAP: ${yesNo(scrapAttempt < MAX_ATTEMPTS)}`);
                if (scrapAttempt >= MAX_ATTEMPTS) {
                    push("SECOND TIME SCRAP");
                    return exitChain("PLAN-SCRAPPED");
                }
                push("SCRIPT ADDS THE CODEX SCRAP NOTES TO THE TASK BRIEF");
                depth += 1;
                continue planning;
            }

            push("SCRIPT APPLIES CODEX AMENDMENTS TO THE PLAN");
            amendRound += 1;
            const roundsDone = amendRound >= MAX_ATTEMPTS;
            push(`2 AMEND ROUNDS DONE: ${yesNo(roundsDone)}`);
            if (roundsDone) break planning;
            depth += 1;
        }
    }
    depth = planDepth;
    const planFileReceipt = receipt("finished plan", "{ plan file }");
    if (planFileReceipt) return planFileReceipt;

    banner("implement and test");
    push(`${AGENT} IMPLEMENT TASK`);
    push("RECORD IMPL NOTES");

    // Rule: every repair re-enters at "commit if needed", never at the test box.
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
            push(`FIRST FAIL: ${yesNo(testAttempt < MAX_ATTEMPTS)}`);
            if (testAttempt >= MAX_ATTEMPTS) {
                push("TESTS FAILED 2X");
                return exitChain("TESTS-RED");
            }
            push(`${AGENT} FIX THE CODEBASE`);
            const fixReceipt = receipt("fix the codebase", "{ fixed }");
            if (fixReceipt) return fixReceipt;
            depth += 1;
            continue;
        }
        push(`${AGENT} CODEX REVIEWS TESTS`);
        const testReviewReceipt = receipt("test review", "{ flagged, reviewer, test review file }");
        if (testReviewReceipt) return testReviewReceipt;

        const flagged = attempt(decisions.codexTestsFlagged, codexTestAttempt);
        push(`TESTS FLAGGED: ${yesNo(flagged)}`);
        if (!flagged) break;
        codexTestAttempt += 1;
        push(`FIRST FLAGGING: ${yesNo(codexTestAttempt < MAX_ATTEMPTS)}`);
        if (codexTestAttempt >= MAX_ATTEMPTS) {
            push("TESTS FLAGGED 2X");
            return exitChain("TESTS-FLAGGED");
        }
        push(`${AGENT} AMEND THE TESTS`);
        const amendReceipt = receipt("amend tests", "{ amended }");
        if (amendReceipt) return amendReceipt;
        testAttempt += 1;
        depth += 1;
    }
    depth = testDepth;

    // Two boxes, two two-strike waits: reading whether the lock is free, then taking it.
    const lockDepth = depth;
    let heldAttempt = 0;
    let lockFailAttempt = 0;
    let freeIndex = 0;
    let lockIndex = 0;
    for (;;) {
        const free = attempt(decisions.sourceRepoFree, freeIndex);
        freeIndex += 1;
        push(`SOURCE REPO CAN BE LOCKED: ${yesNo(free)}`);
        if (!free) {
            heldAttempt += 1;
            push(`FIRST TIME HELD: ${yesNo(heldAttempt < MAX_ATTEMPTS)}`);
            if (heldAttempt >= MAX_ATTEMPTS) {
                push("SOURCE REPO HELD 2X");
                return exitChain("RUN-FAILED");
            }
            push("WAIT");
            depth += 1;
            continue;
        }
        push("LOCK THE SOURCE REPO");
        const locked = attempt(decisions.lockSucceeds, lockIndex);
        lockIndex += 1;
        push(`LOCKING SUCCEEDED: ${yesNo(locked)}`);
        if (locked) {
            sourceLockHeld = true;
            break;
        }
        lockFailAttempt += 1;
        push(`FIRST LOCK FAILURE: ${yesNo(lockFailAttempt < MAX_ATTEMPTS)}`);
        if (lockFailAttempt >= MAX_ATTEMPTS) {
            push("LOCK FAILED 2X");
            return exitChain("RUN-FAILED");
        }
        push("WAIT");
        depth += 1;
    }
    depth = lockDepth;
    const implReceipt = receipt("finished implementation", "{ finished implementation, source repo lock }");
    if (implReceipt) return implReceipt;

    banner("rebase and merge");
    // The merge retry re-enters at the rebase box, so the whole tail below can run twice.
    const mergeDepth = depth;
    let conflictAttempt = 0;
    let suiteAttempt = 0;
    let rebaseAttempt = 0;
    let advanceAttempt = 0;
    let mergeAttempt = 0;
    for (;;) {
        push("REBASE ONTO THE TARGET BRANCH IF NEEDED");
        let conflicted = attempt(decisions.rebase, rebaseAttempt) === "conflict";
        push(`REBASE REPORTED CONFLICTS: ${yesNo(conflicted)}`);
        rebaseAttempt += 1;

        // "did the rebase report conflicts?" is re-entered by the replay box, not just the rebase.
        const rebaseTailDepth = depth;
        for (;;) {
            if (conflicted) {
                conflictAttempt += 1;
                push(`FIRST CONFLICT: ${yesNo(conflictAttempt < MAX_ATTEMPTS)}`);
                if (conflictAttempt >= MAX_ATTEMPTS) {
                    push("REBASE CONFLICTED 2X");
                    return exitChain("REBASE-STUCK");
                }
                push(`${AGENT} FIX CONFLICTS`);
                const conflictReceipt = receipt("conflict fix", "{ resolved, unresolvedPaths }");
                if (conflictReceipt) return conflictReceipt;
            }
            push("COMMIT (IF NEEDED)");
            push("CONTINUE REPLAYING COMMITS ON TOP OF THE TARGET BRANCH");
            const advance = attempt(decisions.rebaseAdvance, advanceAttempt);
            push(`REBASE FINISHED: ${yesNo(advance === "finished")}`);
            advanceAttempt += 1;
            if (advance === "finished") {
                push("RUN THE FULL SUITE");
                const suitePasses = attempt(decisions.fullSuitePasses, suiteAttempt);
                push(`ALL TESTS PASS: ${yesNo(suitePasses)}`);
                if (suitePasses) break;
                suiteAttempt += 1;
                push(`FIRST SUITE FAILURE: ${yesNo(suiteAttempt < MAX_ATTEMPTS)}`);
                if (suiteAttempt >= MAX_ATTEMPTS) {
                    push("SUITE FAILED 2X");
                    return exitChain("SUITE-RED");
                }
                push(`${AGENT} FIX THE CODEBASE`);
                const suiteFixReceipt = receipt("fix the full suite", "{ fixed }");
                if (suiteFixReceipt) return suiteFixReceipt;
                conflicted = false;
                depth += 1;
                continue;
            }
            conflicted = attempt(decisions.rebase, rebaseAttempt) === "conflict";
            depth += 1;
            push(`REBASE REPORTED CONFLICTS: ${yesNo(conflicted)}`);
            rebaseAttempt += 1;
        }
        depth = rebaseTailDepth;

        push(`EVERY CHANGE STAYED INSIDE THE OWNED FILES: ${yesNo(decisions.fenceHeld)}`);
        if (!decisions.fenceHeld) return exitChain("FENCE-VIOLATION");

        push("MERGE WORKTREES AND SUBMODULES, NO FAST-FORWARD");
        const merged = attempt(decisions.mergeLands, mergeAttempt);
        push(`MERGE LANDED: ${yesNo(merged)}`);
        if (merged) break;
        mergeAttempt += 1;
        push(`FIRST MERGE FAILURE: ${yesNo(mergeAttempt < MAX_ATTEMPTS)}`);
        if (mergeAttempt >= MAX_ATTEMPTS) {
            push("MERGE FAILED 2X");
            return exitChain("MERGE-FAILED");
        }
        conflictAttempt = 0;
        suiteAttempt = 0;
        depth += 1;
    }
    depth = mergeDepth;
    const mergeReceipt = receipt("merge", "{ merge commit hashes, modified files }");
    if (mergeReceipt) return mergeReceipt;

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
