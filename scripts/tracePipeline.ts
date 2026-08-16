/*
  Walks the five diagrams in plans/diagram for one set of decision outcomes and names every box it visits, in order. Nothing here touches a repository — it is the diagram made runnable, so a path can be read end to end without running a task.

  plans/diagram/pipeline-preamble.mmd       banner "preamble" plans/diagram/pipeline-planning.mmd       banner "planning" plans/diagram/pipeline-implementTest.mmd  banner "implement and test" plans/diagram/pipeline-rebaseMerge.mmd    banner "rebase and merge" plans/diagram/pipeline-exitWorkflow.mmd   banner "exit workflow"

  Every step's wording comes from the diagrams themselves, not from a hand-written copy. See mmdGraph.ts for the parser and L(id) below for the lookup that keeps this file honest.
*/
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseMmd } from "./mmdGraph.ts";

const DIAGRAM_FILES = [
    "pipeline-preamble.mmd",
    "pipeline-planning.mmd",
    "pipeline-implementTest.mmd",
    "pipeline-rebaseMerge.mmd",
    "pipeline-exitWorkflow.mmd",
    "pipeline.mmd",
];

// Built at module load: every diagram node id mapped to its label. Conflicting labels throw.
const nodeLabels = new Map<string, string>();
for (const file of DIAGRAM_FILES) {
    const path = fileURLToPath(new URL(`../plans/diagram/${file}`, import.meta.url));
    const { nodes } = parseMmd(readFileSync(path, "utf8"));
    for (const [id, label] of nodes) {
        const existing = nodeLabels.get(id);
        if (existing !== undefined && existing !== label) {
            throw new Error(`tracePipeline: node "${id}" has conflicting labels across diagrams: ${JSON.stringify(existing)} vs ${JSON.stringify(label)}`);
        }
        nodeLabels.set(id, label);
    }
}

// A diagram node label, on one line. Throws immediately on a typo’d id.
export const L = (id: string): string => {
    const label = nodeLabels.get(id);
    if (label === undefined) throw new Error(`tracePipeline: no diagram node named "${id}"`);
    return label.replaceAll("\n", " ");
};

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

// The five diagram node ids behind one receipt’s chain, spelled out per receipt.
const RECEIPT_NODES: Record<ReceiptName, { output: string; receipt: string; valid: string; outputTrusted: string; receiptTrusted: string }> = {
    "active task": {
        output: "ACTIVE_TASK_WORKTREE_OUTPUT",
        receipt: "ACTIVE_TASK_WORKTREE_RECEIPT",
        valid: "IS_ACTIVE_TASK_RECEIPT_VALID",
        outputTrusted: "ACTIVE_TASK_WORKTREE_OUTPUT_TRUSTED",
        receiptTrusted: "ACTIVE_TASK_WORKTREE_RECEIPT_TRUSTED",
    },
    "plan file": {
        output: "DRAFT_PLAN_FILE_OUTPUT",
        receipt: "DRAFT_PLAN_FILE_RECEIPT",
        valid: "IS_PLAN_FILE_VALID",
        outputTrusted: "DRAFT_PLAN_FILE_OUTPUT_TRUSTED",
        receiptTrusted: "DRAFT_PLAN_FILE_RECEIPT_TRUSTED",
    },
    "codex review": {
        output: "CODEX_REVIEW_OUTPUT",
        receipt: "CODEX_REVIEW_RECEIPT",
        valid: "IS_REVIEW_FILE_VALID",
        outputTrusted: "CODEX_REVIEW_OUTPUT_TRUSTED",
        receiptTrusted: "CODEX_REVIEW_RECEIPT_TRUSTED",
    },
    "finished plan": {
        output: "FINISHED_PLAN_OUTPUT",
        receipt: "FINISHED_PLAN_RECEIPT",
        valid: "IS_FINISHED_PLAN_RECEIPT_VALID",
        outputTrusted: "FINISHED_PLAN_OUTPUT_TRUSTED",
        receiptTrusted: "FINISHED_PLAN_RECEIPT_TRUSTED",
    },
    "fix the codebase": {
        output: "FIXED_CODEBASE_OUTPUT",
        receipt: "FIXED_CODEBASE_RECEIPT",
        valid: "IS_FIX_RECEIPT_VALID",
        outputTrusted: "FIXED_CODEBASE_OUTPUT_TRUSTED",
        receiptTrusted: "FIXED_CODEBASE_RECEIPT_TRUSTED",
    },
    "test review": {
        output: "TEST_REVIEW_OUTPUT",
        receipt: "TEST_REVIEW_RECEIPT",
        valid: "IS_TEST_REVIEW_RECEIPT_VALID",
        outputTrusted: "TEST_REVIEW_OUTPUT_TRUSTED",
        receiptTrusted: "TEST_REVIEW_RECEIPT_TRUSTED",
    },
    "amend tests": {
        output: "AMEND_TESTS_OUTPUT",
        receipt: "AMEND_TESTS_RECEIPT",
        valid: "IS_AMENDMENT_RECEIPT_VALID",
        outputTrusted: "AMEND_TESTS_OUTPUT_TRUSTED",
        receiptTrusted: "AMEND_TESTS_RECEIPT_TRUSTED",
    },
    "finished implementation": {
        output: "FINISHED_IMPLEMENTATION_OUTPUT",
        receipt: "FINISHED_IMPLEMENTATION_RECEIPT",
        valid: "IS_FINISHED_IMPLEMENTATION_RECEIPT_VALID",
        outputTrusted: "FINISHED_IMPLEMENTATION_OUTPUT_TRUSTED",
        receiptTrusted: "FINISHED_IMPLEMENTATION_RECEIPT_TRUSTED",
    },
    "conflict fix": {
        output: "CONFLICT_FIX_OUTPUT",
        receipt: "CONFLICT_FIX_RECEIPT",
        valid: "IS_CONFLICT_FIX_RECEIPT_VALID",
        outputTrusted: "CONFLICT_FIX_OUTPUT_TRUSTED",
        receiptTrusted: "CONFLICT_FIX_RECEIPT_TRUSTED",
    },
    "fix the full suite": {
        output: "FIXED_CODEBASE_SUITE_OUTPUT",
        receipt: "FIXED_CODEBASE_SUITE_RECEIPT",
        valid: "IS_SUITE_FIX_RECEIPT_VALID",
        outputTrusted: "FIXED_CODEBASE_SUITE_OUTPUT_TRUSTED",
        receiptTrusted: "FIXED_CODEBASE_SUITE_RECEIPT_TRUSTED",
    },
    merge: {
        output: "MERGE_RECEIPT_OUTPUT",
        receipt: "MERGE_RECEIPT",
        valid: "IS_MERGE_RECEIPT_VALID",
        outputTrusted: "MERGE_RECEIPT_OUTPUT_TRUSTED",
        receiptTrusted: "MERGE_RECEIPT_TRUSTED",
    },
};

// The eight orange boxes, named by the diagram ids DID_<name>_RETURN_A_RESULT and RETRY_<name>.
export type AgentBoxName =
    | "PLANNER"
    | "PLAN_REVIEWER"
    | "IMPLEMENTER"
    | "TEST_REVIEWER"
    | "CODEBASE_FIXER"
    | "TEST_AMENDER"
    | "CONFLICT_FIXER"
    | "SUITE_FIXER";

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
    // Names the one receipt whose structure check fails; absent means every receipt validates.
    malformedReceipt?: ReceiptName;
    // One entry per visit to an agent box; false means the harness lost that agent's result.  Absent, or short, means the agent returned: an untouched fixture never loses one.
    agentReturnsResult?: Partial<Record<AgentBoxName, boolean[]>>;
};

const MAX_ATTEMPTS = 2;
const INDENT = "  ";
// A box the diagram paints orange: an agent runs it, not a script.
const AGENT = "<-- AGENT -->";
// Divides the trace into the sub-pipelines, one .mmd file each.
const BANNER_RULE = "---------";

const yesNo = (value: boolean): string => (value ? "YES" : "NO");

// Reads one attempt’s outcome; past the end of the list the last entry repeats.
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
        push(`${L("REPORT_EXIT_TYPE_NO_WRITE")}: ${exitType}`);
        push(L("STOP"));
        return trace;
    };
    // The release box says "if held", so an exit reaching neither has nothing to release.
    let leaseHeld = false;
    let sourceLockHeld = false;

    // Every other exit runs the common exit chain, then reports from the ended run record.
    const exitChain = (exitType: string): string[] => {
        banner("exit workflow");
        push(`${L("WRITE_EXIT_TYPE_AND_NOTE")}: ${exitType}`);
        push(L("RECORD_MODIFIED_FILES_FAILURE"));
        push(L("MARK_TASK_INACTIVE_FAILURE"));
        push(`${L("WAS_WORKTREE_CREATED")}: ${yesNo(leaseHeld)}`);
        if (!leaseHeld) {
            push(L("NOTHING_TO_RELEASE"));
        } else {
            push(`${L("WAS_SOURCE_REPO_LOCKED")}: ${yesNo(sourceLockHeld)}`);
            push(sourceLockHeld ? L("RELEASE_WORKTREE_LEASE_AND_LOCK") : L("RELEASE_WORKTREE_LEASE"));
        }
        push(`${L("REPORT_EXIT_TYPE_AND_NOTE")}: ${exitType}`);
        push(L("STOP"));
        return trace;
    };

    // Returns the finished trace when the structure check fails, null when the run continues.
    const receipt = (name: ReceiptName): string[] | null => {
        const nodes = RECEIPT_NODES[name];
        push(L(nodes.output));
        push(L(nodes.receipt));
        const valid = decisions.malformedReceipt !== name;
        push(`${L(nodes.valid)}: ${yesNo(valid)}`);
        if (!valid) return exitChain("RUN-FAILED");
        push(L(nodes.outputTrusted));
        push(L(nodes.receiptTrusted));
        return null;
    };

    // Every visit an agent box has already had, so a box inside a loop keeps its own attempt count.
    const agentVisits = new Map<AgentBoxName, number>();

    // An orange box. The harness can lose the agent, and the diagram sends that back to the box.
    const agentBox = (nodeId: string, box: AgentBoxName): void => {
        for (let round = 0; round < MAX_ATTEMPTS; round += 1) {
            push(`${AGENT} ${L(nodeId)}`);
            const visit = agentVisits.get(box) ?? 0;
            agentVisits.set(box, visit + 1);
            const returned = attempt(decisions.agentReturnsResult?.[box] ?? [true], visit);
            push(`${L(`DID_${box}_RETURN_A_RESULT`)}: ${yesNo(returned)}`);
            if (returned) return;
            push(L(`RETRY_${box}`));
        }
    };

    banner("preamble");
    push(`${L("IS_TASK_NUMBER_VALID")}: ${yesNo(decisions.taskNumberValid)}`);
    if (!decisions.taskNumberValid) return reportAndStop("INVALID-NUMBER");

    push(`${L("IS_TASK_BLOCKED")}: ${yesNo(decisions.taskBlocked)}`);
    if (decisions.taskBlocked) return reportAndStop("BLOCKED");
    // Drawn as two boxes, but one atomic read-modify-write: nothing can make the task active between the question and the write.
    push(`${L("IS_TASK_ACTIVE")}: ${yesNo(decisions.taskActive)}`);
    if (decisions.taskActive) return reportAndStop("ALREADY-ACTIVE");
    push(L("MARK_TASK_ACTIVE"));

    // Four worktree shapes converge on "init submodules recursively".
    push(`${L("DOES_WORKTREE_EXIST")}: ${yesNo(decisions.worktreeExists)}`);
    if (!decisions.worktreeExists) {
        push(L("CREATE_WORKTREE"));
        push(L("AUTO_GENERATE_DOCS"));
    } else {
        push(`${L("IS_WORKTREE_SAFE_TO_USE")}: ${yesNo(decisions.worktreeSafe)}`);
        if (decisions.worktreeSafe) {
            push(L("UPDATE_AUTO_GENERATED_DOCS"));
        } else {
            push(`${L("IS_PREVIOUS_RUN_RESUMABLE")}: ${yesNo(decisions.previousWorkResumable)}`);
            if (decisions.previousWorkResumable) {
                push(L("UPDATE_AUTO_GENERATED_DOCS"));
            } else {
                push(L("RESET_WORKTREE"));
                push(L("AUTO_GENERATE_DOCS"));
            }
        }
    }
    push(L("INIT_SUBMODULES_RECURSIVELY"));
    leaseHeld = true;
    const preambleReceipt = receipt("active task");
    if (preambleReceipt) return preambleReceipt;

    banner("planning");
    // The scrap loop re-enters at "plan the task"; the amend loop re-enters at "codex reviews".
    const planDepth = depth;
    let scrapAttempt = 0;
    let amendRound = 0;
    let verdict: "accept" | "amend" | "scrap" = "accept";
    let verdictIndex = 0;
    planning: for (;;) {
        agentBox("PLAN_THE_TASK", "PLANNER");
        const planReceipt = receipt("plan file");
        if (planReceipt) return planReceipt;

        for (;;) {
            agentBox("CODEX_REVIEWS_PLAN", "PLAN_REVIEWER");
            const reviewReceipt = receipt("codex review");
            if (reviewReceipt) return reviewReceipt;

            verdict = attempt(decisions.codexPlanVerdict, verdictIndex);
            verdictIndex += 1;
            push(`${L("WHAT_IS_REVIEW_VERDICT")}: ${verdict.toUpperCase()}`);

            if (verdict === "accept") break planning;

            if (verdict === "scrap") {
                scrapAttempt += 1;
                push(`${L("IS_FIRST_TIME_SCRAP")}: ${yesNo(scrapAttempt < MAX_ATTEMPTS)}`);
                if (scrapAttempt >= MAX_ATTEMPTS) {
                    push(L("PLAN_SCRAPPED_2X"));
                    return exitChain("PLAN-SCRAPPED");
                }
                push(L("ADD_SCRAP_NOTES_TO_BRIEF"));
                depth += 1;
                continue planning;
            }

            push(L("APPLY_CODEX_AMENDMENTS"));
            amendRound += 1;
            const roundsDone = amendRound >= MAX_ATTEMPTS;
            push(`${L("ARE_2_AMEND_ROUNDS_DONE")}: ${yesNo(roundsDone)}`);
            if (roundsDone) break planning;
            depth += 1;
        }
    }
    depth = planDepth;
    const planFileReceipt = receipt("finished plan");
    if (planFileReceipt) return planFileReceipt;

    banner("implement and test");
    agentBox("IMPLEMENT_TASK", "IMPLEMENTER");
    push(L("RECORD_IMPLEMENTATION_NOTES"));

    // Rule: every repair re-enters at "commit if needed", never at the test box.
    const testDepth = depth;
    let testAttempt = 0;
    let codexTestAttempt = 0;
    for (;;) {
        push(L("COMMIT_IF_NEEDED"));
        push(L("RUN_TASK_TESTS"));
        const testsFail = attempt(decisions.taskTestsFail, testAttempt);
        push(`${L("DO_TASK_TESTS_FAIL")}: ${yesNo(testsFail)}`);
        if (testsFail) {
            testAttempt += 1;
            push(`${L("IS_FIRST_TASK_TEST_FAIL")}: ${yesNo(testAttempt < MAX_ATTEMPTS)}`);
            if (testAttempt >= MAX_ATTEMPTS) {
                push(L("TESTS_FAILED_2X"));
                return exitChain("TESTS-RED");
            }
            agentBox("FIX_THE_CODEBASE", "CODEBASE_FIXER");
            const fixReceipt = receipt("fix the codebase");
            if (fixReceipt) return fixReceipt;
            depth += 1;
            continue;
        }
        agentBox("CODEX_REVIEWS_TESTS", "TEST_REVIEWER");
        const testReviewReceipt = receipt("test review");
        if (testReviewReceipt) return testReviewReceipt;

        const flagged = attempt(decisions.codexTestsFlagged, codexTestAttempt);
        push(`${L("ARE_TESTS_FLAGGED")}: ${yesNo(flagged)}`);
        if (!flagged) break;
        codexTestAttempt += 1;
        push(`${L("IS_FIRST_FLAGGING")}: ${yesNo(codexTestAttempt < MAX_ATTEMPTS)}`);
        if (codexTestAttempt >= MAX_ATTEMPTS) {
            push(L("TESTS_FLAGGED_2X"));
            return exitChain("TESTS-FLAGGED");
        }
        agentBox("AMEND_TESTS", "TEST_AMENDER");
        const amendReceipt = receipt("amend tests");
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
        push(`${L("CAN_SOURCE_REPO_BE_LOCKED")}: ${yesNo(free)}`);
        if (!free) {
            heldAttempt += 1;
            push(`${L("IS_FIRST_TIME_HELD")}: ${yesNo(heldAttempt < MAX_ATTEMPTS)}`);
            if (heldAttempt >= MAX_ATTEMPTS) {
                push(L("SOURCE_REPO_HELD_2X"));
                return exitChain("RUN-FAILED");
            }
            push(L("WAIT_FOR_LOCK_FREE"));
            depth += 1;
            continue;
        }
        push(L("LOCK_SOURCE_REPO"));
        const locked = attempt(decisions.lockSucceeds, lockIndex);
        lockIndex += 1;
        push(`${L("DID_LOCKING_SOURCE_REPO_SUCCEED")}: ${yesNo(locked)}`);
        if (locked) {
            sourceLockHeld = true;
            break;
        }
        lockFailAttempt += 1;
        push(`${L("IS_FIRST_LOCK_FAILURE")}: ${yesNo(lockFailAttempt < MAX_ATTEMPTS)}`);
        if (lockFailAttempt >= MAX_ATTEMPTS) {
            push(L("LOCK_FAILED_2X"));
            return exitChain("RUN-FAILED");
        }
        push(L("WAIT_AFTER_LOCK_RACE"));
        depth += 1;
    }
    depth = lockDepth;
    const implReceipt = receipt("finished implementation");
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
        push(L("REBASE_ONTO_TARGET_BRANCH"));
        let conflicted = attempt(decisions.rebase, rebaseAttempt) === "conflict";
        push(`${L("DID_REBASE_REPORT_CONFLICTS")}: ${yesNo(conflicted)}`);
        rebaseAttempt += 1;

        // "did the rebase report conflicts?" is re-entered by the replay box, not just the rebase.
        const rebaseTailDepth = depth;
        for (;;) {
            if (conflicted) {
                conflictAttempt += 1;
                push(`${L("IS_FIRST_CONFLICT")}: ${yesNo(conflictAttempt < MAX_ATTEMPTS)}`);
                if (conflictAttempt >= MAX_ATTEMPTS) {
                    push(L("REBASE_CONFLICTED_2X"));
                    return exitChain("REBASE-STUCK");
                }
                agentBox("FIX_CONFLICTS", "CONFLICT_FIXER");
                const conflictReceipt = receipt("conflict fix");
                if (conflictReceipt) return conflictReceipt;
            }
            push(L("COMMIT_IF_NEEDED"));
            push(L("REPLAY_COMMITS_ON_TARGET_BRANCH"));
            const advance = attempt(decisions.rebaseAdvance, advanceAttempt);
            push(`${L("IS_REBASE_FINISHED")}: ${yesNo(advance === "finished")}`);
            advanceAttempt += 1;
            if (advance === "finished") {
                push(L("RUN_FULL_SUITE"));
                const suitePasses = attempt(decisions.fullSuitePasses, suiteAttempt);
                push(`${L("DO_ALL_TESTS_PASS")}: ${yesNo(suitePasses)}`);
                if (suitePasses) break;
                suiteAttempt += 1;
                push(`${L("IS_FIRST_SUITE_FAILURE")}: ${yesNo(suiteAttempt < MAX_ATTEMPTS)}`);
                if (suiteAttempt >= MAX_ATTEMPTS) {
                    push(L("SUITE_FAILED_2X"));
                    return exitChain("SUITE-RED");
                }
                agentBox("FIX_THE_CODEBASE_FOR_SUITE", "SUITE_FIXER");
                const suiteFixReceipt = receipt("fix the full suite");
                if (suiteFixReceipt) return suiteFixReceipt;
                conflicted = false;
                depth += 1;
                continue;
            }
            conflicted = attempt(decisions.rebase, rebaseAttempt) === "conflict";
            depth += 1;
            push(`${L("DID_REBASE_REPORT_CONFLICTS")}: ${yesNo(conflicted)}`);
            rebaseAttempt += 1;
        }
        depth = rebaseTailDepth;

        push(`${L("DID_CHANGES_STAY_INSIDE_FENCE")}: ${yesNo(decisions.fenceHeld)}`);
        if (!decisions.fenceHeld) return exitChain("FENCE-VIOLATION");

        push(L("MERGE_WORKTREES"));
        const merged = attempt(decisions.mergeLands, mergeAttempt);
        push(`${L("DID_MERGE_LAND")}: ${yesNo(merged)}`);
        if (merged) break;
        mergeAttempt += 1;
        push(`${L("IS_FIRST_MERGE_FAILURE")}: ${yesNo(mergeAttempt < MAX_ATTEMPTS)}`);
        if (mergeAttempt >= MAX_ATTEMPTS) {
            push(L("MERGE_FAILED_2X"));
            return exitChain("MERGE-FAILED");
        }
        conflictAttempt = 0;
        suiteAttempt = 0;
        depth += 1;
    }
    depth = mergeDepth;
    const mergeReceipt = receipt("merge");
    if (mergeReceipt) return mergeReceipt;

    banner("exit workflow");
    push(L("RECORD_MERGE_COMMIT_HASHES"));
    push(L("WRITE_EXIT_TYPE_COMPLETED"));
    push(L("RECORD_MODIFIED_FILES_SUCCESS"));
    push(L("CLEAN_UP_WORKTREES"));
    push(L("BUILD_CLOSURE_NOTE"));
    push(L("MARK_TASK_INACTIVE_SUCCESS"));
    push(L("ARCHIVE_TASK"));
    push(L("REPORT_CLOSURE_NOTE"));
    push(L("STOP"));
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
