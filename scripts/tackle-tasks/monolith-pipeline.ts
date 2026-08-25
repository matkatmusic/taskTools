// bun scripts/tackle-tasks/monolith-pipeline.ts <taskNumber> scripts/tackle-tasks/monolith-pipeline.fixture/tasks.json
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";

// ponytail: worktreeSafe and touchedFiles are fixture-only; the real checks read git.
type Run = {
    active?: boolean;
    worktree?: string;
    leaseRunId?: string;
    history?: { endedAt: string | null; implementationNotesFile: string | null }[];
    worktreeSafe?: boolean;
    touchedFiles?: string[];
};

// ponytail: sim is fixture-only. One answer per visit, keyed by the block that asks.
type Task = {
    taskNumber: number;
    files?: string[];
    blockedBy?: { taskNum: number }[];
    run?: Run;
    sim?: Record<string, (string | null)[]>;
};

type State = {
    tasks: Task[];
    task: Task | undefined;
    runId: string;
    docsMode: string;
    exitType: string;
    exitNote: string;
    answer: string | null;
    counts: Record<string, number>;
    ran: string[];
};

type Input = State & {
    command: "/run-step";
    block: string | null;
};

type Packet = Partial<State> & {
    next: string | null;
};

// ponytail: the last answer repeats, so a fixture writes ["NO"] and not 180 of them.
function sim(input: Input, block: string): string | null {
    const answers = input.task!.sim![block]!;
    const visitIndex = input.counts[block]! - 1;
    const lastAnswerIndex = answers.length - 1;
    const answerIndex = Math.min(visitIndex, lastAnswerIndex);
    const answer = answers[answerIndex]!;
    return answer;
}

const blocks: Record<string, (input: Input) => Packet> = {
    // --- pipeline-preambleStatusCheck.mmd ---

    PREAMBLE_TASK_NUMBER_INPUT(input) {
        return { next: "IS_TASK_NUMBER_VALID" };
    },

    IS_TASK_NUMBER_VALID(input) {
        if (input.task === undefined) {
            return {
                next: "REPORT_ONLY_EXIT",
                exitType: "invalid-number",
                exitNote: "task number is not in tasks.json",
            };
        }
        return { next: "IS_TASK_BLOCKED" };
    },

    IS_TASK_BLOCKED(input) {
        const blockers = input.task!.blockedBy ?? [];
        let blocked = false;
        for (const blocker of blockers) {
            for (const openTask of input.tasks) {
                if (openTask.taskNumber === blocker.taskNum) {
                    blocked = true;
                }
            }
        }
        if (blocked) {
            return {
                next: "REPORT_ONLY_EXIT",
                exitType: "blocked",
                exitNote: "an open blocker remains",
            };
        }
        return { next: "IS_TASK_ACTIVE" };
    },

    IS_TASK_ACTIVE(input) {
        if (input.task!.run?.active === true) {
            return {
                next: "REPORT_ONLY_EXIT",
                exitType: "already-active",
                exitNote: "a previous run left the task active",
            };
        }
        return { next: "MARK_TASK_ACTIVE" };
    },

    MARK_TASK_ACTIVE(input) {
        const run = input.task!.run ?? {};
        run.active = true;
        input.task!.run = run;
        return { next: "WORKTREE_CHECK_PIPELINE" };
    },

    WORKTREE_CHECK_PIPELINE(input) {
        return { next: "ACTIVE_TASK_INPUT" };
    },

    REPORT_ONLY_EXIT(input) {
        return { next: null };
    },

    // --- pipeline-worktreeCheck.mmd ---

    ACTIVE_TASK_INPUT(input) {
        return { next: "DOES_WORKTREE_EXIST" };
    },

    DOES_WORKTREE_EXIST(input) {
        const exists = input.task!.run?.worktree !== undefined;
        if (exists) {
            return { next: "IS_WORKTREE_SAFE_TO_USE" };
        }
        return { next: "CREATE_WORKTREE" };
    },

    IS_WORKTREE_SAFE_TO_USE(input) {
        const safe = input.task!.run?.worktreeSafe === true;
        if (safe) {
            return { next: "IS_PREVIOUS_RUN_RESUMABLE" };
        }
        return { next: "TAKE_WORKTREE_LEASE_BEFORE_RESET" };
    },

    IS_PREVIOUS_RUN_RESUMABLE(input) {
        input.task!.run!.leaseRunId = input.runId;
        const history = input.task!.run!.history ?? [];
        const endedRuns = [];
        for (const previousRun of history) {
            if (previousRun.endedAt !== null) {
                endedRuns.push(previousRun);
            }
        }
        const newest = endedRuns[endedRuns.length - 1];
        if (newest?.implementationNotesFile == null) {
            return {
                next: "FAILURES_EXIT",
                exitType: "not-resumable",
                exitNote: "a safe worktree holds work no run recorded a stopping point for",
            };
        }
        return { next: "DOES_FENCE_COVER_WORKTREE" };
    },

    DOES_FENCE_COVER_WORKTREE(input) {
        const files = input.task!.files ?? [];
        const touchedFiles = input.task!.run!.touchedFiles ?? [];
        const violations = [];
        for (const touchedFile of touchedFiles) {
            if (!files.includes(touchedFile)) {
                violations.push(touchedFile);
            }
        }
        if (violations.length > 0) {
            return {
                next: "FAILURES_EXIT",
                exitType: "fence-violation",
                exitNote: `the resumed worktree touched files the task does not own: ${violations.join(", ")}`,
            };
        }
        return {
            next: "INIT_SUBMODULES_RECURSIVELY",
            docsMode: "UPDATE",
        };
    },

    CREATE_WORKTREE(input) {
        input.task!.run!.worktree = `.taskTools/worktrees/task-${input.task!.taskNumber}`;
        return {
            next: "TAKE_WORKTREE_LEASE",
            docsMode: "AUTOGEN",
        };
    },

    TAKE_WORKTREE_LEASE(input) {
        input.task!.run!.leaseRunId = input.runId;
        return { next: "INIT_SUBMODULES_RECURSIVELY" };
    },

    TAKE_WORKTREE_LEASE_BEFORE_RESET(input) {
        input.task!.run!.leaseRunId = input.runId;
        return { next: "RESET_WORKTREE" };
    },

    RESET_WORKTREE(input) {
        input.task!.run!.worktree = `.taskTools/worktrees/task-${input.task!.taskNumber}`;
        input.task!.run!.worktreeSafe = true;
        return {
            next: "INIT_SUBMODULES_RECURSIVELY",
            docsMode: "AUTOGEN",
        };
    },

    INIT_SUBMODULES_RECURSIVELY(input) {
        return { next: "DOCUMENT_GENERATION_PIPELINE" };
    },

    DOCUMENT_GENERATION_PIPELINE(input) {
        return { next: "WORKTREE_DOCS_MODE_INPUT" };
    },

    FAILURES_EXIT(input) {
        return { next: null };
    },

    // --- pipeline-documentGeneration.mmd ---

    WORKTREE_DOCS_MODE_INPUT(input) {
        return { next: "WHAT_IS_DOCS_MODE" };
    },

    WHAT_IS_DOCS_MODE(input) {
        if (input.docsMode === "AUTOGEN") return { next: "DOCS_MODE_AUTOGEN" };
        if (input.docsMode === "UPDATE") return { next: "DOCS_MODE_UPDATE" };
        throw new Error(`unknown docs mode ${JSON.stringify(input.docsMode)}`);
    },

    DOCS_MODE_AUTOGEN(input) {
        return { next: "AUTO_GENERATE_DOCS" };
    },

    DOCS_MODE_UPDATE(input) {
        return { next: "UPDATE_AUTO_GENERATED_DOCS" };
    },

    AUTO_GENERATE_DOCS(input) {
        return { next: "PLAN_PIPELINE" };
    },

    UPDATE_AUTO_GENERATED_DOCS(input) {
        return { next: "PLAN_PIPELINE" };
    },

    PLAN_PIPELINE(input) {
        return { next: "DOCS_INPUT" };
    },

    // --- pipeline-plan.mmd ---

    DOCS_INPUT(input) {
        return { next: "PLAN_THE_TASK" };
    },

    PLAN_THE_TASK(input) {
        return { next: "WHAT_DID_THE_PLANNER_RETURN" };
    },

    WHAT_DID_THE_PLANNER_RETURN(input) {
        if (input.answer === "PLAN") return { next: "PLANNER_RETURNED_PLAN" };
        if (input.answer === "CLARIFY") return { next: "PLANNER_RETURNED_CLARIFY" };
        throw new Error(`unknown planner answer ${JSON.stringify(input.answer)}`);
    },

    PLANNER_RETURNED_PLAN(input) {
        return { next: "REVIEW_PLAN_PIPELINE" };
    },

    PLANNER_RETURNED_CLARIFY(input) {
        return { next: "ARE_2_CLARIFY_ROUNDS_DONE" };
    },

    ARE_2_CLARIFY_ROUNDS_DONE(input) {
        if (input.counts.PLANNER_RETURNED_CLARIFY >= 2) {
            return {
                next: "EXIT_WORKFLOW_PLAN",
                exitType: "clarify-stuck",
                exitNote: "the planner asked twice for something the docs cannot supply. worktree preserved.",
            };
        }
        return { next: "WRITE_CLARIFY_REQUEST" };
    },

    WRITE_CLARIFY_REQUEST(input) {
        return {
            next: "DOCUMENT_GENERATION_PIPELINE",
            docsMode: "UPDATE",
        };
    },

    EXIT_WORKFLOW_PLAN(input) {
        return { next: null };
    },

    // --- pipeline-reviewPlan.mmd ---

    REVIEW_PLAN_PIPELINE(input) {
        return { next: "DRAFT_PLAN_INPUT" };
    },

    DRAFT_PLAN_INPUT(input) {
        return { next: "CODEX_REVIEWS_PLAN" };
    },

    CODEX_REVIEWS_PLAN(input) {
        return { next: "WHAT_IS_REVIEW_VERDICT" };
    },

    WHAT_IS_REVIEW_VERDICT(input) {
        const verdicts = ["ACCEPT", "AMEND_THEN_ACCEPT", "AMEND", "SCRAP", "ERROR"];
        if (!verdicts.includes(input.answer!)) throw new Error(`unknown review verdict ${JSON.stringify(input.answer)}`);
        return { next: `VERDICT_${input.answer}` };
    },

    VERDICT_ACCEPT(input) {
        return { next: "IMPLEMENT_PIPELINE" };
    },

    VERDICT_AMEND_THEN_ACCEPT(input) {
        return { next: "IMPLEMENT_PIPELINE" };
    },

    VERDICT_AMEND(input) {
        return { next: "UPDATE_TASK_ENTRY" };
    },

    VERDICT_SCRAP(input) {
        return { next: "UPDATE_TASK_ENTRY" };
    },

    VERDICT_ERROR(input) {
        return {
            next: "EXIT_WORKFLOW_REVIEW_PLAN",
            exitType: "run-failed",
            exitNote: "the plan review could not run",
        };
    },

    UPDATE_TASK_ENTRY(input) {
        return { next: "ARE_2_REVIEWS_DONE" };
    },

    ARE_2_REVIEWS_DONE(input) {
        if (input.counts.CODEX_REVIEWS_PLAN >= 2) {
            return {
                next: "EXIT_WORKFLOW_REVIEW_PLAN",
                exitType: "plan-scrapped",
                exitNote: "codex did not accept the plan in two reviews",
            };
        }
        return { next: "PLAN_PIPELINE" };
    },

    EXIT_WORKFLOW_REVIEW_PLAN(input) {
        return { next: null };
    },

    // --- pipeline-implement.mmd ---

    IMPLEMENT_PIPELINE(input) {
        return { next: "ACCEPTED_PLAN_INPUT" };
    },

    ACCEPTED_PLAN_INPUT(input) {
        return { next: "IMPLEMENT_TASK" };
    },

    IMPLEMENT_TASK(input) {
        return { next: "COMMIT_IMPLEMENTATION_IF_NEEDED" };
    },

    COMMIT_IMPLEMENTATION_IF_NEEDED(input) {
        return { next: "TASK_TESTS_PIPELINE" };
    },

    EXIT_WORKFLOW_IMPLEMENT(input) {
        return { next: null };
    },

    // --- pipeline-taskTests.mmd ---

    TASK_TESTS_PIPELINE(input) {
        return { next: "COMMITTED_WORK_INPUT" };
    },

    COMMITTED_WORK_INPUT(input) {
        return { next: "RUN_TASK_TESTS" };
    },

    RUN_TASK_TESTS(input) {
        return { next: "DO_TASK_TESTS_PASS" };
    },

    DO_TASK_TESTS_PASS(input) {
        const pass = sim(input, "DO_TASK_TESTS_PASS") === "YES";
        if (pass) {
            return { next: "REVIEW_TESTS_PIPELINE" };
        }
        return { next: "ARE_2_TEST_FIXES_DONE" };
    },

    ARE_2_TEST_FIXES_DONE(input) {
        if (input.counts.AMEND_ENTRY_WITH_FAILING_TESTS >= 2) {
            return {
                next: "EXIT_WORKFLOW_TASK_TESTS",
                exitType: "tests-red",
                exitNote: "task tests still failing after 2 fix attempts",
            };
        }
        return { next: "AMEND_ENTRY_WITH_FAILING_TESTS" };
    },

    AMEND_ENTRY_WITH_FAILING_TESTS(input) {
        return { next: "IMPLEMENT_PIPELINE" };
    },

    EXIT_WORKFLOW_TASK_TESTS(input) {
        return { next: null };
    },

    // --- pipeline-reviewTests.mmd ---

    REVIEW_TESTS_PIPELINE(input) {
        return { next: "GREEN_IMPLEMENTATION_INPUT" };
    },

    GREEN_IMPLEMENTATION_INPUT(input) {
        return { next: "CODEX_REVIEWS_TESTS" };
    },

    CODEX_REVIEWS_TESTS(input) {
        return { next: "ARE_TESTS_FLAGGED" };
    },

    ARE_TESTS_FLAGGED(input) {
        const flagged = input.answer === "YES";
        if (flagged) {
            return { next: "ARE_2_TEST_REVIEWS_DONE" };
        }
        return { next: "REBASE_PREAMBLE_PIPELINE" };
    },

    ARE_2_TEST_REVIEWS_DONE(input) {
        if (input.counts.CODEX_REVIEWS_TESTS >= 2) {
            return {
                next: "EXIT_WORKFLOW_REVIEW_TESTS",
                exitType: "tests-flagged",
                exitNote: "task tests failed codex review",
            };
        }
        return { next: "AMEND_ENTRY_WITH_CODEX_NOTES" };
    },

    AMEND_ENTRY_WITH_CODEX_NOTES(input) {
        return { next: "IMPLEMENT_PIPELINE" };
    },

    EXIT_WORKFLOW_REVIEW_TESTS(input) {
        return { next: null };
    },

    // --- pipeline-rebasePreamble.mmd ---

    REBASE_PREAMBLE_PIPELINE(input) {
        return { next: "FINISHED_IMPLEMENTATION_INPUT" };
    },

    FINISHED_IMPLEMENTATION_INPUT(input) {
        return { next: "LOCK_SOURCE_REPO" };
    },

    LOCK_SOURCE_REPO(input) {
        return { next: "WAS_LOCK_ACQUIRED" };
    },

    WAS_LOCK_ACQUIRED(input) {
        const acquired = sim(input, "WAS_LOCK_ACQUIRED") === "YES";
        if (acquired) {
            return { next: "REBASE_PIPELINE" };
        }
        return { next: "HAVE_15_MINUTES_PASSED" };
    },

    HAVE_15_MINUTES_PASSED(input) {
        if ((input.counts.WAIT_FOR_LOCK ?? 0) * 5 >= 15 * 60) {
            return {
                next: "EXIT_WORKFLOW_REBASE_PREAMBLE",
                exitType: "run-failed",
                exitNote: "the source repo lock did not come free within 15 minutes",
            };
        }
        return { next: "WAIT_FOR_LOCK" };
    },

    WAIT_FOR_LOCK(input) {
        return { next: "LOCK_SOURCE_REPO" };
    },

    EXIT_WORKFLOW_REBASE_PREAMBLE(input) {
        return { next: null };
    },

    // --- pipeline-rebase.mmd ---

    REBASE_PIPELINE(input) {
        return { next: "SOURCE_REPO_LOCKED_INPUT" };
    },

    SOURCE_REPO_LOCKED_INPUT(input) {
        return { next: "REBASE_ONTO_TARGET_BRANCH" };
    },

    REBASE_ONTO_TARGET_BRANCH(input) {
        return { next: "DID_REBASE_REPORT_CONFLICTS" };
    },

    DID_REBASE_REPORT_CONFLICTS(input) {
        const conflicts = sim(input, "DID_REBASE_REPORT_CONFLICTS") === "YES";
        if (conflicts) {
            return { next: "ARE_2_CONFLICT_FIXES_DONE" };
        }
        return { next: "SUITE_PIPELINE" };
    },

    ARE_2_CONFLICT_FIXES_DONE(input) {
        if (input.counts.FIX_CONFLICTS >= 2) {
            return {
                next: "EXIT_WORKFLOW_REBASE",
                exitType: "rebase-stuck",
                exitNote: "the rebase did not advance after 2 conflict fixes",
            };
        }
        return { next: "FIX_CONFLICTS" };
    },

    FIX_CONFLICTS(input) {
        return { next: "COMMIT_MERGE_CONFLICT_FIX_IF_NEEDED" };
    },

    COMMIT_MERGE_CONFLICT_FIX_IF_NEEDED(input) {
        return { next: "CONTINUE_REBASE" };
    },

    CONTINUE_REBASE(input) {
        return { next: "IS_REBASE_FINISHED" };
    },

    IS_REBASE_FINISHED(input) {
        const finished = sim(input, "IS_REBASE_FINISHED") === "YES";
        if (finished) {
            return { next: "SUITE_PIPELINE" };
        }
        return { next: "DID_REBASE_REPORT_CONFLICTS" };
    },

    AGENT_ERRORED(input) {
        return {
            next: "EXIT_WORKFLOW_REBASE",
            exitType: "agent-failed",
            exitNote: "the agent returned nothing usable",
        };
    },

    EXIT_WORKFLOW_REBASE(input) {
        return { next: null };
    },

    // --- pipeline-suite.mmd ---

    SUITE_PIPELINE(input) {
        return { next: "REBASED_WORKTREE_INPUT" };
    },

    REBASED_WORKTREE_INPUT(input) {
        return { next: "RUN_FULL_SUITE" };
    },

    RUN_FULL_SUITE(input) {
        return { next: "DO_ALL_TESTS_PASS" };
    },

    DO_ALL_TESTS_PASS(input) {
        const pass = sim(input, "DO_ALL_TESTS_PASS") === "YES";
        if (pass) {
            return { next: "DID_CHANGES_STAY_INSIDE_FENCE" };
        }
        return { next: "ARE_2_SUITE_FIXES_DONE" };
    },

    ARE_2_SUITE_FIXES_DONE(input) {
        if (input.counts.FIX_THE_CODEBASE_FOR_SUITE >= 2) {
            return {
                next: "EXIT_WORKFLOW_SUITE",
                exitType: "suite-red",
                exitNote: "full suite still red after 2 fix attempts. merge aborted. worktree preserved.",
            };
        }
        return { next: "FIX_THE_CODEBASE_FOR_SUITE" };
    },

    FIX_THE_CODEBASE_FOR_SUITE(input) {
        return { next: "COMMIT_SUITE_FIX_IF_NEEDED" };
    },

    COMMIT_SUITE_FIX_IF_NEEDED(input) {
        return { next: "RUN_FULL_SUITE" };
    },

    DID_CHANGES_STAY_INSIDE_FENCE(input) {
        if (sim(input, "DID_CHANGES_STAY_INSIDE_FENCE") !== "YES") {
            return {
                next: "EXIT_WORKFLOW_SUITE",
                exitType: "fence-violation",
                exitNote: "a repair edited files the task does not own. nothing merged. worktree preserved.",
            };
        }
        return { next: "MERGE_PIPELINE" };
    },

    EXIT_WORKFLOW_SUITE(input) {
        return { next: null };
    },

    // --- pipeline-merge.mmd ---

    MERGE_PIPELINE(input) {
        return { next: "GREEN_WORKTREE_INPUT" };
    },

    GREEN_WORKTREE_INPUT(input) {
        return { next: "MERGE_WORKTREES" };
    },

    MERGE_WORKTREES(input) {
        return { next: "READ_MERGE_PUBLICATION_STATE" };
    },

    READ_MERGE_PUBLICATION_STATE(input) {
        return { next: "WHAT_IS_PUBLICATION_STATE" };
    },

    WHAT_IS_PUBLICATION_STATE(input) {
        const state = sim(input, "WHAT_IS_PUBLICATION_STATE");
        if (state === "ALL") return { next: "PUBLICATION_ALL" };
        if (state === "NONE") return { next: "PUBLICATION_NONE" };
        if (state === "PARTIAL") return { next: "PUBLICATION_PARTIAL" };
        throw new Error(`unknown publication state ${JSON.stringify(state)}`);
    },

    PUBLICATION_ALL(input) {
        return { next: "EXIT_WORKFLOW_SUCCESS" };
    },

    PUBLICATION_NONE(input) {
        return { next: "ARE_2_MERGE_ATTEMPTS_DONE" };
    },

    PUBLICATION_PARTIAL(input) {
        return {
            next: "EXIT_WORKFLOW_MERGE",
            exitType: "partially-published",
            exitNote: "some layers are on their target branch and some are not. RECOVERY ONLY. worktree preserved.",
        };
    },

    ARE_2_MERGE_ATTEMPTS_DONE(input) {
        if (input.counts.MERGE_WORKTREES >= 2) {
            return {
                next: "EXIT_WORKFLOW_MERGE",
                exitType: "merge-failed",
                exitNote: "nothing landed after 2 attempts. worktree preserved.",
            };
        }
        return { next: "REBASE_PIPELINE" };
    },

    EXIT_WORKFLOW_MERGE(input) {
        return { next: null };
    },

    // --- pipeline-mergeSucceededExit.mmd ---

    EXIT_WORKFLOW_SUCCESS(input) {
        return { next: "MERGE_RECEIPT_INPUT" };
    },

    MERGE_RECEIPT_INPUT(input) {
        return { next: "RECORD_MERGE_COMMIT_HASHES" };
    },

    RECORD_MERGE_COMMIT_HASHES(input) {
        return { next: "WRITE_EXIT_TYPE_COMPLETED" };
    },

    WRITE_EXIT_TYPE_COMPLETED(input) {
        return {
            next: "RECORD_MODIFIED_FILES_SUCCESS",
            exitType: "completed",
        };
    },

    RECORD_MODIFIED_FILES_SUCCESS(input) {
        return { next: "CLEAN_UP_WORKTREES" };
    },

    CLEAN_UP_WORKTREES(input) {
        delete input.task!.run!.worktree;
        delete input.task!.run!.leaseRunId;
        return { next: "BUILD_CLOSURE_NOTE" };
    },

    BUILD_CLOSURE_NOTE(input) {
        return { next: "MARK_TASK_INACTIVE_SUCCESS" };
    },

    MARK_TASK_INACTIVE_SUCCESS(input) {
        input.task!.run!.active = false;
        return { next: "ARCHIVE_TASK" };
    },

    ARCHIVE_TASK(input) {
        const remainingTasks = [];
        for (const openTask of input.tasks) {
            if (openTask !== input.task) {
                remainingTasks.push(openTask);
            }
        }
        return {
            next: "REPORT_CLOSURE_NOTE",
            tasks: remainingTasks,
        };
    },

    REPORT_CLOSURE_NOTE(input) {
        return { next: "STOP" };
    },

    STOP(input) {
        return { next: null };
    },
};

// --- the scaffolding between the workflow loop and a block's script ---

// A diagram node, read from the .mmd files; a misspelled block name fails at startup.
type Block = {
    name: string;
    diagram: string;
    fedBy: string[];
    feeds: string[];
};

// The function the hook runs for a block. In the live system, a scripts/steps/*.ts file.
type Script = {
    run: (input: Input) => Packet;
    isPromptGenerating: boolean;
};

// What one script execution produced, before the hook decides whether to keep walking.
type RunStepResult = {
    output: Input;
    nextBlock: string | null;
    prompt: string;
};

// The hook's output. This lands in the agent's context as the directions to follow.
type Directions = {
    prompt: string;
    payload: Input;
    previousBlockWasTerminal: boolean;
};

// The object shape the agent must return, per block: the field names of that block's input.
type Schema = Record<string, string[]>;

type AgentResult = {
    previousBlockWasTerminal: boolean;
    schema: Schema;
    output: Input;
};

const pipelines = [
    "preambleStatusCheck", "worktreeCheck", "documentGeneration", "plan", "reviewPlan", "implement",
    "taskTests", "reviewTests", "rebasePreamble", "rebase", "suite", "merge", "mergeSucceededExit",
];

// The live templates mark these scriptSignal: "prompt". Every other block continues.
const promptGeneratingBlocks = new Set([
    "PLAN_THE_TASK", "CODEX_REVIEWS_PLAN", "IMPLEMENT_TASK", "CODEX_REVIEWS_TESTS", "FIX_CONFLICTS", "FIX_THE_CODEBASE_FOR_SUITE",
]);

const blockToScriptMap = new Map<string, Script>();
for (const name in blocks) {
    const script: Script = {
        run: blocks[name]!,
        isPromptGenerating: promptGeneratingBlocks.has(name),
    };
    blockToScriptMap.set(name, script);
}

let blockList: Block[] = [];

function getDiagramsForPipelines(pipelines: string[]): string[] {
    const diagramDir = fileURLToPath(new URL("../../plans/diagram/", import.meta.url));
    const diagrams = [];
    for (const pipeline of pipelines) {
        diagrams.push(`${diagramDir}pipeline-${pipeline}.mmd`);
    }
    return diagrams;
}

// ponytail: strips quoted labels and |YES| tags, then reads every ALL_CAPS id left on an edge line.
function getBlocksForDiagrams(diagrams: string[]): Block[] {
    const byName = new Map<string, Block>();
    for (const diagram of diagrams) {
        const lines = readFileSync(diagram, "utf8").split("\n");
        for (const line of lines) {
            if (/^\s*(%%|flowchart|classDef|class )/.test(line)) continue;
            const withoutLabels = line.replace(/"[^"]*"/g, "");
            const withoutEdgeTags = withoutLabels.replace(/\|[^|]*\|/g, "");
            const ids = withoutEdgeTags.match(/[A-Z][A-Z0-9_]+/g) ?? [];
            for (const id of ids) {
                if (!byName.has(id)) {
                    const block: Block = {
                        name: id,
                        diagram: basename(diagram),
                        fedBy: [],
                        feeds: [],
                    };
                    byName.set(id, block);
                }
            }
            if (!line.includes("->")) continue;
            for (let i = 1; i < ids.length; i++) {
                const from = byName.get(ids[i - 1]!)!;
                const to = byName.get(ids[i]!)!;
                from.feeds.push(to.name);
                to.fedBy.push(from.name);
            }
        }
    }
    const blockList = [];
    for (const block of byName.values()) {
        blockList.push(block);
    }
    return blockList;
}

// ponytail: every block reads and writes the same State today, so one field list serves all of them.
function loadSchema(blockList: Block[]): Schema {
    const fields = ["tasks", "task", "runId", "docsMode", "exitType", "exitNote", "answer", "counts", "ran"];
    const schema: Schema = {};
    for (const block of blockList) {
        schema[block.name] = fields;
    }
    return schema;
}

function getBlockFor(input: Input): Block {
    for (const block of blockList) {
        if (block.name === input.block) {
            return block;
        }
    }
    throw new Error(`no diagram block named ${JSON.stringify(input.block)}`);
}

function prepareInputForBlock(input: Input, block: Block): Input {
    const counts = { ...input.counts };
    counts[block.name] = (counts[block.name] ?? 0) + 1;
    const scriptInput: Input = { ...input };
    scriptInput.block = block.name;
    scriptInput.counts = counts;
    return scriptInput;
}

function run(script: Script, scriptInput: Input): RunStepResult {
    const { next, ...changes } = script.run(scriptInput);
    const output: Input = { ...scriptInput };
    output.answer = "";
    Object.assign(output, changes);
    output.block = next;
    output.ran = [...scriptInput.ran];
    output.ran.push(scriptInput.block!);
    let prompt = "";
    if (script.isPromptGenerating) {
        prompt = scriptInput.block!;
    }
    const result: RunStepResult = {
        output,
        nextBlock: next,
        prompt,
    };
    return result;
}

function runStep(input: Input): Directions {
    /*
      invokes the runStepHook.ts hook with the given input.  Looks up the script (here emulated as a function) that should be executed for the block, and passes the input to it.  If the script is matched to a 'continue' block, the output of the script says what block to run next, and the output is passed to the next block in the chain.  If the script is matched to a 'prompt' block, the script output stops the loop here, and the output is returned to the caller of 'runStep'.
    */
    let block = getBlockFor(input);
    let scriptInput = prepareInputForBlock(input, block); //input contains 'blockName'
    let result: RunStepResult;
    while (true) {
        // find the script (function) for the block being run.
        console.log(`${block.name} being executed`);
        const script = blockToScriptMap.get(block.name);
        if (script === undefined) throw new Error(`no script found for block ${block.name}`);
        // execute the script (function) matched to the block being run.
        result = run(script, scriptInput);
        // if the script is a prompt-generating script, return the generated prompt.
        if (script.isPromptGenerating) {
            return { 
                prompt: result.prompt, 
                payload: result.output, 
                previousBlockWasTerminal: false 
            };
        }
        // if the block is the last block in the chain, return the output of that
        const nextBlock = result.nextBlock;
        if (nextBlock === null) {
            return {
                prompt: "return the payload verbatim",
                payload: result.output,
                previousBlockWasTerminal: true,
            };
        }
        // if the script is a continue-generating script, get the next block to run.
        block = getBlockFor(result.output);
        // else pass the output from the script execution to the next block in the chain.
        scriptInput = prepareInputForBlock(result.output, block);
        // loop back to find and execute the next block in the chain.
    }
}

const commands = {
    "/run-step": runStep,
};

// The agent's answer. null is the live agent() dying or being skipped.
function followPrompt(directions: Directions, schema: Schema): AgentResult | null {
    if (directions.previousBlockWasTerminal) {
        return {
            previousBlockWasTerminal: true,
            schema,
            output: directions.payload,
        };
    }
    const answer = sim(directions.payload, directions.prompt);
    if (answer === null) return null;
    const output: Input = { ...directions.payload };
    output.answer = answer;
    const result: AgentResult = {
        previousBlockWasTerminal: false,
        schema,
        output,
    };
    return result;
}

function agent(input: Input, schema: Schema): AgentResult | null {
    /*
      emulates the "invoke `/run-step <BLOCK> <args>` and follow directions" prompt to the agent in the live workflow.
    */
    const directions = runStep(input); //the output of the hook, shows up in the agent's context
    if (directions.prompt === "") {
        throw new Error("the hook returned an empty prompt to the agent. the agent has nothing to do and is idle.");
    }

    /*
      the agent follows the prompt and returns a specific output shape (based on a schema)
    */
    const resultFromFollowingThePrompt = followPrompt(directions, schema);
    return resultFromFollowingThePrompt;
}

function main(taskNumber: number, tasksJsonPath: string) {
    const tasks = JSON.parse(readFileSync(tasksJsonPath, "utf8")) as Task[];
    let task: Task | undefined = undefined;
    for (const candidate of tasks) {
        if (candidate.taskNumber === taskNumber) {
            task = candidate;
        }
    }
    let input: Input = {
        command: "/run-step",
        block: "PREAMBLE_TASK_NUMBER_INPUT",
        tasks,
        task,
        runId: randomUUID(),
        docsMode: "",
        exitType: "",
        exitNote: "",
        answer: "",
        counts: {},
        ran: [],
    };
    const diagrams = getDiagramsForPipelines(pipelines);
    blockList = getBlocksForDiagrams(diagrams);
    let schema = loadSchema(blockList);
    while (true) {
        const result = agent(input, schema);
        // handle errors
        if (result === null) {
            // agent errored or terminated prematurely. exit the loop.
            break;
        }

        if (result.previousBlockWasTerminal) {
            console.log("reached end of pipeline. loop terminated.");
            break;
        }

        // the agent returned a valid output. update the input for the next agent call.
        schema = result.schema;
        input = result.output;
    }
    // console.log(`task ${taskNumber}: ${input.ran.join(" -> ")}`);
    // console.log(`  docsMode=${JSON.stringify(input.docsMode)} exitType=${JSON.stringify(input.exitType)} exitNote=${JSON.stringify(input.exitNote)}`);
}

main(Number(process.argv[2]), process.argv[3]);
