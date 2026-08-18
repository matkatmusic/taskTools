/*
  Names every box one set of decision outcomes visits, in order. Touches no repository.

  The walk starts at the plan pipeline. PreambleDataEmitter.ts runs the preamble beforehand.

  Every step's wording comes from the diagrams. See mmdGraph.ts and L(id) below.
*/
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseMmd } from "./mmdGraph.ts";

export const DIAGRAM_FILES = [
    "pipeline-preambleStatusCheck.mmd",
    "pipeline-worktreeCheck.mmd",
    "pipeline-documentGeneration.mmd",
    "pipeline-plan.mmd",
    "pipeline-reviewPlan.mmd",
    "pipeline-implement.mmd",
    "pipeline-taskTests.mmd",
    "pipeline-reviewTests.mmd",
    "pipeline-rebasePreamble.mmd",
    "pipeline-rebase.mmd",
    "pipeline-suite.mmd",
    "pipeline-merge.mmd",
    "pipeline-mergeSucceededExit.mmd",
    "pipeline-failuresExit.mmd",
    "pipeline-reportOnlyExit.mmd",
    "pipeline.mmd",
];

// Built at module load: every diagram node id mapped to its label. Conflicting labels throw.
export const nodeLabels = new Map<string, string>();
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

// A diagram node label, on one line. Throws immediately on a typo'd id.
export const L = (id: string): string => {
    const label = nodeLabels.get(id);
    if (label === undefined) throw new Error(`tracePipeline: no diagram node named "${id}"`);
    return label.replaceAll("\n", " ");
};

// The orange boxes. Each has one dotted "agent() errored" edge, and no retry.
export type AgentBoxName =
    | "PLANNER"
    | "PLAN_REVIEWER"
    | "IMPLEMENTER"
    | "TEST_RUNNER"
    | "TEST_REVIEWER"
    | "REBASER"
    | "CONFLICT_FIXER"
    | "REBASE_ADVANCER"
    | "SUITE_RUNNER"
    | "SUITE_FIXER";

export type PlannerOutcome = "PLAN" | "CLARIFY" | "ERROR";
export type PlanVerdict = "ACCEPT" | "AMEND_THEN_ACCEPT" | "AMEND" | "SCRAP" | "ERROR";
export type PublicationState = "ALL LANDED" | "NONE LANDED" | "SOME LANDED";

// Loop decisions hold one entry per attempt: taskTestsPass [false, true] fails once, then passes.
export type PipelineDecisions = {
    taskNumber: number;
    plannerOutcome: PlannerOutcome[];
    planVerdict: PlanVerdict[];
    taskTestsPass: boolean[];
    testsFlagged: boolean[];
    lockAcquired: boolean[];
    rebaseConflicts: boolean[];
    rebaseFinished: boolean[];
    suitePasses: boolean[];
    fenceHeld: boolean;
    publicationState: PublicationState[];
    // One entry per visit to an agent box; true means the harness lost that agent's result.
    agentErrors?: Partial<Record<AgentBoxName, boolean[]>>;
};

const MAX_ATTEMPTS = 2;
const INDENT = "  ";
// A box the diagram paints orange: an agent runs it, not a script.
const AGENT = "<-- AGENT -->";
// Divides the trace into the sub-pipelines, one .mmd file each.
const BANNER_RULE = "---------";

const yesNo = (value: boolean): string => (value ? "YES" : "NO");

// Reads one attempt's outcome; past the end of the list the last entry repeats.
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

    /*
      The failures exit. Every exit here reaches it, because the task is already active.
    */
    const failuresExit = (exitType: string, workLanded = false): string[] => {
        banner("failures exit");
        // Paragraph 85: ask git what landed before writing anything, never the incoming exit type.
        push(L("READ_PUBLICATION_STATE"));
        push(`${L("DID_ANY_WORK_LAND")}: ${yesNo(workLanded)}`);
        // Paragraph 86: landed work discards the incoming exit type, run-failed included.
        push(workLanded ? L("WRITE_PUBLICATION_OUTCOME") : `${L("WRITE_EXIT_TYPE_AND_NOTE")}: ${exitType}`);
        push(L("RECORD_MODIFIED_FILES_FAILURE"));
        push(`${L("DOES_RUN_HOLD_LEASE")}: YES`);
        push(L("RELEASE_WORKTREE_LEASE"));
        push(`${L("DOES_RUN_HOLD_SOURCE_LOCK")}: ${yesNo(sourceLockHeld)}`);
        if (sourceLockHeld) push(L("RELEASE_SOURCE_LOCK"));
        push(L("MARK_TASK_INACTIVE_FAILURE"));
        push(`${L("REPORT_EXIT_TYPE_AND_NOTE")}: ${exitType}`);
        push(L("STOP"));
        return trace;
    };

    // Taken from the rebase preamble onward, and released by whichever exit tail runs.
    let sourceLockHeld = false;

    // Every visit an agent box has had, so a box inside a loop keeps its own attempt count.
    const agentVisits = new Map<AgentBoxName, number>();

    // An orange box. Returns true when the agent handed back a result, false on the dotted edge.
    const agentBox = (nodeId: string, box: AgentBoxName): boolean => {
        push(`${AGENT} ${L(nodeId)}`);
        const visit = agentVisits.get(box) ?? 0;
        agentVisits.set(box, visit + 1);
        const errored = attempt(decisions.agentErrors?.[box] ?? [false], visit);
        if (errored) push(L("AGENT_ERRORED"));
        return !errored;
    };

    // Counters count fix attempts, not failing runs. A merge-triggered rebase does not reset one.
    let clarifyRounds = 0;
    let planReviews = 0;
    let testFixes = 0;
    let testReviews = 0;
    let conflictFixes = 0;
    let suiteFixes = 0;
    let mergeAttempts = 0;

    let plannerIndex = 0;
    let verdictIndex = 0;
    let testsIndex = 0;
    let flaggedIndex = 0;
    let lockIndex = 0;
    let conflictsIndex = 0;
    let finishedIndex = 0;
    let suiteIndex = 0;
    let publicationIndex = 0;

    // The diagrams have back-edges, so the pipelines are a state machine, not a straight chain.
    let current = "plan";
    for (;;) {
        if (current === "plan") {
            banner("plan");
            push(L("DOCS_INPUT"));
            if (!agentBox("PLAN_THE_TASK", "PLANNER")) return failuresExit("AGENT-FAILED");

            const outcome = attempt(decisions.plannerOutcome, plannerIndex);
            plannerIndex += 1;
            push(`${L("WHAT_DID_THE_PLANNER_RETURN")}: ${outcome}`);
            if (outcome === "ERROR") return failuresExit("AGENT-FAILED");
            if (outcome === "PLAN") {
                current = "review-plan";
                continue;
            }

            const roundsDone = clarifyRounds >= MAX_ATTEMPTS;
            push(`${L("ARE_2_CLARIFY_ROUNDS_DONE")}: ${yesNo(roundsDone)}`);
            if (roundsDone) return failuresExit("CLARIFY-STUCK");
            clarifyRounds += 1;
            push(L("WRITE_CLARIFY_REQUEST"));
            depth += 1;
            current = "document-generation";
            continue;
        }

        if (current === "document-generation") {
            banner("document generation");
            push(L("WORKTREE_DOCS_MODE_INPUT"));
            // A clarify round always re-enters in UPDATE mode; AUTOGEN belongs to the preamble.
            push(`${L("WHAT_IS_DOCS_MODE")}: UPDATE`);
            push(L("UPDATE_AUTO_GENERATED_DOCS"));
            current = "plan";
            continue;
        }

        if (current === "review-plan") {
            banner("review plan");
            push(L("DRAFT_PLAN_INPUT"));
            if (!agentBox("CODEX_REVIEWS_PLAN", "PLAN_REVIEWER")) return failuresExit("AGENT-FAILED");

            const verdict = attempt(decisions.planVerdict, verdictIndex);
            verdictIndex += 1;
            push(`${L("WHAT_IS_REVIEW_VERDICT")}: ${verdict}`);
            // ERROR means the reviewer never read the plan, so no ruling was possible.
            if (verdict === "ERROR") return failuresExit("RUN-FAILED");
            // AMEND_THEN_ACCEPT already wrote codex's fixes into the plan, so implement reads them.
            if (verdict === "ACCEPT" || verdict === "AMEND_THEN_ACCEPT") {
                current = "implement";
                continue;
            }
            push(L("UPDATE_TASK_ENTRY"));
            planReviews += 1;
            const reviewsDone = planReviews >= MAX_ATTEMPTS;
            push(`${L("ARE_2_REVIEWS_DONE")}: ${yesNo(reviewsDone)}`);
            if (reviewsDone) return failuresExit("PLAN-SCRAPPED");
            depth += 1;
            current = "plan";
            continue;
        }

        if (current === "implement") {
            banner("implement");
            push(L("ACCEPTED_PLAN_INPUT"));
            if (!agentBox("IMPLEMENT_TASK", "IMPLEMENTER")) return failuresExit("AGENT-FAILED");
            push(L("COMMIT_IF_NEEDED"));
            current = "task-tests";
            continue;
        }

        if (current === "task-tests") {
            banner("task tests");
            push(L("COMMITTED_WORK_INPUT"));
            if (!agentBox("RUN_TASK_TESTS", "TEST_RUNNER")) return failuresExit("AGENT-FAILED");
            const testsPass = attempt(decisions.taskTestsPass, testsIndex);
            testsIndex += 1;
            push(`${L("DO_TASK_TESTS_PASS")}: ${yesNo(testsPass)}`);
            if (testsPass) {
                current = "review-tests";
                continue;
            }
            const fixesDone = testFixes >= MAX_ATTEMPTS;
            push(`${L("ARE_2_TEST_FIXES_DONE")}: ${yesNo(fixesDone)}`);
            if (fixesDone) return failuresExit("TESTS-RED");
            push(L("AMEND_ENTRY_WITH_FAILING_TESTS"));
            testFixes += 1;
            depth += 1;
            current = "implement";
            continue;
        }

        if (current === "review-tests") {
            banner("review task tests");
            push(L("GREEN_IMPLEMENTATION_INPUT"));
            if (!agentBox("CODEX_REVIEWS_TESTS", "TEST_REVIEWER")) return failuresExit("AGENT-FAILED");

            const flagged = attempt(decisions.testsFlagged, flaggedIndex);
            flaggedIndex += 1;
            push(`${L("ARE_TESTS_FLAGGED")}: ${yesNo(flagged)}`);
            if (!flagged) {
                current = "rebase-preamble";
                continue;
            }
            const reviewsDone = testReviews >= MAX_ATTEMPTS;
            push(`${L("ARE_2_TEST_REVIEWS_DONE")}: ${yesNo(reviewsDone)}`);
            if (reviewsDone) return failuresExit("TESTS-FLAGGED");
            push(L("AMEND_ENTRY_WITH_CODEX_NOTES"));
            testReviews += 1;
            depth += 1;
            current = "implement";
            continue;
        }

        if (current === "rebase-preamble") {
            banner("rebase preamble");
            push(L("FINISHED_IMPLEMENTATION_INPUT"));
            push(L("LOCK_SOURCE_REPO"));
            const acquired = attempt(decisions.lockAcquired, lockIndex);
            lockIndex += 1;
            push(`${L("WAS_LOCK_ACQUIRED")}: ${yesNo(acquired)}`);
            // The 5s poll and its 15 minute cap live inside the script, so this is one box.
            if (!acquired) {
                push(`${L("HAVE_15_MINUTES_PASSED")}: YES`);
                return failuresExit("RUN-FAILED");
            }
            sourceLockHeld = true;
            current = "rebase";
            continue;
        }

        if (current === "rebase") {
            banner("rebase");
            push(L("SOURCE_REPO_LOCKED_INPUT"));
            for (;;) {
                if (!agentBox("REBASE_ONTO_TARGET_BRANCH", "REBASER")) return failuresExit("AGENT-FAILED");
                const conflicted = attempt(decisions.rebaseConflicts, conflictsIndex);
                conflictsIndex += 1;
                push(`${L("DID_REBASE_REPORT_CONFLICTS")}: ${yesNo(conflicted)}`);
                if (!conflicted) break;

                const fixesDone = conflictFixes >= MAX_ATTEMPTS;
                push(`${L("ARE_2_CONFLICT_FIXES_DONE")}: ${yesNo(fixesDone)}`);
                if (fixesDone) return failuresExit("REBASE-STUCK");
                if (!agentBox("FIX_CONFLICTS", "CONFLICT_FIXER")) return failuresExit("AGENT-FAILED");
                conflictFixes += 1;
                push(L("COMMIT_IF_NEEDED"));
                if (!agentBox("CONTINUE_REBASE", "REBASE_ADVANCER")) return failuresExit("AGENT-FAILED");
                const finished = attempt(decisions.rebaseFinished, finishedIndex);
                finishedIndex += 1;
                push(`${L("IS_REBASE_FINISHED")}: ${yesNo(finished)}`);
                if (finished) break;
                depth += 1;
            }
            current = "suite";
            continue;
        }

        if (current === "suite") {
            banner("full suite");
            push(L("REBASED_WORKTREE_INPUT"));
            for (;;) {
                if (!agentBox("RUN_FULL_SUITE", "SUITE_RUNNER")) return failuresExit("AGENT-FAILED");
                const passes = attempt(decisions.suitePasses, suiteIndex);
                suiteIndex += 1;
                push(`${L("DO_ALL_TESTS_PASS")}: ${yesNo(passes)}`);
                if (passes) break;

                const fixesDone = suiteFixes >= MAX_ATTEMPTS;
                push(`${L("ARE_2_SUITE_FIXES_DONE")}: ${yesNo(fixesDone)}`);
                if (fixesDone) return failuresExit("SUITE-RED");
                if (!agentBox("FIX_THE_CODEBASE_FOR_SUITE", "SUITE_FIXER")) return failuresExit("AGENT-FAILED");
                suiteFixes += 1;
                push(L("COMMIT_IF_NEEDED"));
                depth += 1;
            }
            // The fence gate runs once, after the fix loop and before the merge.
            push(`${L("DID_CHANGES_STAY_INSIDE_FENCE")}: ${yesNo(decisions.fenceHeld)}`);
            if (!decisions.fenceHeld) return failuresExit("FENCE-VIOLATION");
            current = "merge";
            continue;
        }

        if (current === "merge") {
            banner("merge");
            push(L("GREEN_WORKTREE_INPUT"));
            push(L("MERGE_WORKTREES"));
            push(L("READ_PUBLICATION_STATE"));
            const state = attempt(decisions.publicationState, publicationIndex);
            publicationIndex += 1;
            push(`${L("WHAT_IS_PUBLICATION_STATE")}: ${state}`);
            if (state === "ALL LANDED") break;
            // Paragraph 77: a partial publication has landed work, so the tail takes its YES edge.
            if (state === "SOME LANDED") return failuresExit("PARTIALLY-PUBLISHED", true);

            const attemptsDone = mergeAttempts >= MAX_ATTEMPTS;
            push(`${L("ARE_2_MERGE_ATTEMPTS_DONE")}: ${yesNo(attemptsDone)}`);
            if (attemptsDone) return failuresExit("MERGE-FAILED");
            mergeAttempts += 1;
            depth += 1;
            current = "rebase";
            continue;
        }

        throw new Error(`tracePipeline: no pipeline named "${current}"`);
    }

    banner("merge succeeded exit");
    push(L("MERGE_RECEIPT_INPUT"));
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
