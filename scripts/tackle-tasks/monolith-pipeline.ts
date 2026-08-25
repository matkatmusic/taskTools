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
    simCounts?: Record<string, number>;
    counts?: Record<string, number>;
    attempts?: Record<string, number>;
    sourceLockOwner?: string;
    commits?: { hash: string; kind: string; stepId: string }[];
    taskTests?: { passed: boolean; output: string };
    fullSuite?: { passed: boolean; output: string };
    publicationState?: string;
    modifiedFiles?: string[];
    exitType?: string;
    exitNote?: string;
    cleanupIncomplete?: boolean;
    endedAt?: string;
};

// ponytail: sim is fixture-only. One answer per visit, keyed by the block that asks.
type Task = {
    taskNumber: number;
    files?: string[];
    blockedBy?: { taskNum: number }[];
    clarifyRequest?: string;
    codexReviewNotes?: string;
    planReviewCount?: number;
    run?: Run;
    sim?: Record<string, (string | null)[]>;
};

type State = {
    taskNumber: number;
    tasks: Task[];
    task: Task | undefined;
    runId: string;
    docsMode: string;
    plan: string;
    codexNotes: string;
    suiteFixAttempts: number;
    exitType: string;
    exitNote: string;
    answer: string | null;
    ran: string[];
};

type Input = State & {
    command: "/run-step";
    block: string | null;
};

type Packet = Partial<State> & {
    next: string | null;
    prompt?: string;
};

// ponytail: the last answer repeats, so a fixture writes ["NO"] and not 180 of them.
function sim(input: Input, question: string): string | null {
    const run = input.task!.run!;
    const answers = input.task!.sim![question]!;
    const simCounts = run.simCounts ?? {};
    run.simCounts = simCounts;
    const visitIndex = simCounts[question] ?? 0;
    simCounts[question] = visitIndex + 1;
    const lastAnswerIndex = answers.length - 1;
    const answerIndex = Math.min(visitIndex, lastAnswerIndex);
    const answer = answers[answerIndex]!;
    return answer;
}

// pipeline-failuresExit.mmd as one function. Every failures-exit box in the other diagrams lands here.
function reportRunsExitType(input: Input): Packet {
    const task = input.task!;
    const run = task.run!;

    // --- read the publication state from the layer merge refs ---
    console.log("  skipping: git rev-parse --verify refs/taskTools/merged-commits/... per layer");
    const publicationState = run.publicationState ?? "NONE LANDED";

    // --- did ANY of this task's work land? ---
    if (publicationState !== "NONE LANDED") {
        // write the publication outcome: keep completed if it is there, else partially-published. never run-failed.
        if (run.exitType !== "completed") run.exitType = "partially-published";
        run.exitNote = input.exitNote;
        run.cleanupIncomplete = true;
    } else {
        // write exit type and exit notes to tasks.json
        run.exitType = input.exitType;
        run.exitNote = input.exitNote;
    }

    // --- record modified files to tasks.json ---
    console.log("  skipping: git diff --name-only <baseRef>...HEAD per layer to record modifiedFiles");
    run.modifiedFiles = run.touchedFiles ?? [];

    // --- mark task inactive in tasks.json ---
    run.active = false;
    run.endedAt = new Date().toISOString();

    // --- does this run still hold the worktree lease? ---
    if (run.leaseRunId === input.runId) {
        // release the worktree lease, keep the worktree. F5: the lease stays while the worktree still exists.
        console.log(`  skipping: the worktree ${run.worktree} remains, so the lease is retained`);
    }

    // --- does this run still hold the source repo lock? ---
    if (run.sourceLockOwner === `${input.runId}:${task.taskNumber}`) {
        console.log("  skipping: release the source repo lock");
        delete run.sourceLockOwner;
    }

    // --- report the run's exit type and note, then stop ---
    console.log(`task ${task.taskNumber} ${run.exitType}: ${run.exitNote}`);
    return { next: null };
}

// pipeline-reportOnlyExit.mmd as one function. Writes nothing.
function reportExitTypeAndStop(input: Input): Packet {
    console.log(`task ${input.taskNumber} ${input.exitType}: ${input.exitNote}`);
    return { next: null };
}

const blocks: Record<string, (input: Input) => Packet> = {
    // One block for pipeline-preambleStatusCheck.mmd, pipeline-worktreeCheck.mmd, and init submodules.
    PREAMBLE_STATUS_CHECK(input) {
        // --- task status ---
        let task: Task | undefined = undefined;
        for (const candidate of input.tasks) {
            if (candidate.taskNumber === input.taskNumber) {
                task = candidate;
            }
        }
        if (task === undefined) {
            return {
                next: "REPORT_ONLY_EXIT",
                exitType: "invalid-number",
                exitNote: "task number is not in tasks.json",
            };
        }
        const blockers = task.blockedBy ?? [];
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
                task,
                exitType: "blocked",
                exitNote: "an open blocker remains",
            };
        }
        const run = task.run ?? {};
        task.run = run;
        if (run.active === true) {
            return {
                next: "REPORT_ONLY_EXIT",
                task,
                exitType: "already-active",
                exitNote: "a previous run left the task active",
            };
        }
        run.active = true;

        // --- worktree status ---
        let docsMode = "";
        if (run.worktree === undefined) {
            run.worktree = `.taskTools/worktrees/task-${task.taskNumber}`;
            run.leaseRunId = input.runId;
            docsMode = "AUTOGEN";
        } else if (run.worktreeSafe !== true) {
            run.leaseRunId = input.runId;
            run.worktree = `.taskTools/worktrees/task-${task.taskNumber}`;
            run.worktreeSafe = true;
            docsMode = "AUTOGEN";
        } else {
            run.leaseRunId = input.runId;
            const history = run.history ?? [];
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
                    task,
                    exitType: "not-resumable",
                    exitNote: "a safe worktree holds work no run recorded a stopping point for",
                };
            }
            const files = task.files ?? [];
            const touchedFiles = run.touchedFiles ?? [];
            const violations = [];
            for (const touchedFile of touchedFiles) {
                if (!files.includes(touchedFile)) {
                    violations.push(touchedFile);
                }
            }
            if (violations.length > 0) {
                return {
                    next: "FAILURES_EXIT",
                    task,
                    exitType: "fence-violation",
                    exitNote: `the resumed worktree touched files the task does not own: ${violations.join(", ")}`,
                };
            }
            docsMode = "UPDATE";
        }

        // --- init submodules recursively ---
        console.log(`  skipping: git submodule update --init --recursive in ${run.worktree}`);

        return {
            next: "DOCUMENT_GENERATION",
            task,
            docsMode,
        };
    },

    // One block for pipeline-documentGeneration.mmd.
    DOCUMENT_GENERATION(input) {
        // --- what is the docs mode? ---
        if (input.docsMode !== "AUTOGEN") {
            if (input.docsMode !== "UPDATE") {
                throw new Error(`unknown docs mode ${JSON.stringify(input.docsMode)}`);
            }
        }

        // --- auto generate docs / update auto generated docs ---
        console.log(`  skipping: ${input.docsMode} write of the task brief into the worktree`);

        return { next: "PLAN_THE_TASK" };
    },

    // --- pipeline-reportOnlyExit.mmd ---

    REPORT_ONLY_EXIT(input) {
        return reportExitTypeAndStop(input);
    },

    // --- pipeline-failuresExit.mmd ---

    FAILURES_EXIT(input) {
        return reportRunsExitType(input);
    },

    // --- pipeline-plan.mmd ---

    // Prompt block. The live script builds the planner prompt from the brief in the worktree.
    PLAN_THE_TASK(input) {
        const task = input.task!;
        const run = task.run!;
        const briefFile = `${run.worktree}/plans/task-${task.taskNumber}-brief.md`;
        const planFile = `${run.worktree}/plans/task-${task.taskNumber}-plan.md`;
        let prompt = `Plan task ${task.taskNumber} from ${briefFile}. Write the plan to ${planFile} and answer PLAN, or answer CLARIFY with what the brief does not say. Codex reviews this plan before it is implemented.`;
        if (input.codexNotes !== "") {
            prompt = `${prompt}\nCodex's notes on the previous plan:\n${input.codexNotes}`;
        }
        return {
            next: "WHAT_DID_THE_PLANNER_RETURN",
            prompt,
        };
    },

    // One block for "what did the planner return?" and every path after it in pipeline-plan.mmd.
    WHAT_DID_THE_PLANNER_RETURN(input) {
        const task = input.task!;
        const run = task.run!;

        // --- PLAN ---
        if (input.answer === "PLAN") {
            return {
                next: "CODEX_REVIEWS_PLAN",
                plan: input.plan,
            };
        }

        // --- CLARIFY ---
        if (input.answer === "CLARIFY") {
            // ponytail: the live agent words the request; the sim uses one fixed sentence.
            const clarifyRequest = "the planner needs something the docs do not say";

            // --- 2 clarify rounds done? ---
            const attempts = run.attempts ?? {};
            run.attempts = attempts;
            const clarifyRounds = attempts.clarify ?? 0;
            if (clarifyRounds >= 2) {
                return {
                    next: "FAILURES_EXIT",
                    exitType: "clarify-stuck",
                    exitNote: "the planner asked twice for something the docs cannot supply. worktree preserved.",
                };
            }

            // --- write the clarify request into the tasks.json entry ---
            task.clarifyRequest = clarifyRequest;
            attempts.clarify = clarifyRounds + 1;
            return {
                next: "DOCUMENT_GENERATION",
                docsMode: "UPDATE",
            };
        }

        throw new Error(`unknown planner answer ${JSON.stringify(input.answer)}`);
    },

    // --- pipeline-reviewPlan.mmd ---

    // Prompt block. The live script builds the review prompt; the agent runs codex with it in a shell.
    CODEX_REVIEWS_PLAN(input) {
        const task = input.task!;
        const run = task.run!;
        const briefFile = `${run.worktree}/plans/task-${task.taskNumber}-brief.md`;
        const reviewFile = `${run.worktree}/plans/task-${task.taskNumber}-plan-review.json`;
        const ownedFiles = task.files ?? [];
        const reviewPrompt = `You are a read-only review agent tasked with reviewing the implementation plan for task ${task.taskNumber}. Read only: ${briefFile}, ${input.plan}, ${ownedFiles.join(", ")}.`;
        const command = `codex exec -s read-only --output-schema plans/review-plan-schema.json -o "${reviewFile}" "${reviewPrompt}" </dev/null`;
        const prompt = `Run this with Bash:\n${command}\nThen return the JSON written to ${reviewFile}, unchanged.`;
        return {
            next: "WHAT_IS_REVIEW_VERDICT",
            prompt,
        };
    },

    // One block for "what is the review verdict?" and every path after it in pipeline-reviewPlan.mmd.
    WHAT_IS_REVIEW_VERDICT(input) {
        const task = input.task!;
        const review = JSON.parse(input.answer!);

        // --- decide the verdict from codex's review JSON ---
        let verdict = "";
        let notes = "";
        if (review.outcome === "ERROR") {
            verdict = "ERROR";
            notes = `${review.message} missing: ${review.missingFiles.join(", ")}`;
        } else {
            const fixCount = review.fixes.length;
            verdict = "SCRAP";
            if (fixCount === 0) verdict = "ACCEPT";
            if (fixCount === 1) verdict = "AMEND_THEN_ACCEPT";
            if (fixCount >= 2) {
                if (fixCount <= 4) verdict = "AMEND";
            }
            const noteLines = [];
            for (const fix of review.fixes) {
                noteLines.push(`[${fix.sectionId}] ${fix.fix}\n\nDurable because: ${fix.durableBecause}`);
            }
            notes = noteLines.join("\n\n");
        }

        // --- ERROR ---
        if (verdict === "ERROR") {
            return {
                next: "FAILURES_EXIT",
                exitType: "run-failed",
                exitNote: "the plan review could not run",
            };
        }

        // --- ACCEPT ---
        if (verdict === "ACCEPT") {
            return { next: "IMPLEMENT_TASK" };
        }

        // --- AMEND_THEN_ACCEPT: write codex's fixes into the plan, then implement ---
        if (verdict === "AMEND_THEN_ACCEPT") {
            console.log(`  skipping: write codex's fixes into the sections of ${input.plan} and bump its revision`);
            return { next: "IMPLEMENT_TASK" };
        }

        // --- AMEND / SCRAP: update the tasks.json entry ---
        task.codexReviewNotes = notes;
        const reviewCount = (task.planReviewCount ?? 0) + 1;
        task.planReviewCount = reviewCount;

        // --- 2 codex reviews done? ---
        if (reviewCount >= 2) {
            return {
                next: "FAILURES_EXIT",
                exitType: "plan-scrapped",
                exitNote: "codex did not accept the plan in two reviews",
            };
        }
        return {
            next: "PLAN_THE_TASK",
            codexNotes: notes,
        };
    },

    // One block for "what is the review verdict?" and the paths after it in pipeline-reviewPlan.mmd.
    // --- pipeline-implement.mmd ---

    // Prompt block. The live script builds the implementer prompt from the brief, the plan, and the entry's notes.
    IMPLEMENT_TASK(input) {
        const task = input.task!;
        const run = task.run!;
        let prompt = `Implement task ${task.taskNumber} in ${run.worktree}, following ${input.plan}. Edit only the owned files and their tests. Do not commit. Answer with {message, additionalData: {implemented, notes}}.`;
        if (task.codexReviewNotes !== undefined) {
            prompt = `${prompt}\nNotes on the previous attempt:\n${task.codexReviewNotes}`;
        }
        return {
            next: "COMMIT_IMPLEMENTATION_IF_NEEDED",
            prompt,
        };
    },

    // One block for "commit if needed" and all of pipeline-taskTests.mmd.
    COMMIT_IMPLEMENTATION_IF_NEEDED(input) {
        const task = input.task!;
        const run = task.run!;

        // --- commit if needed ---
        const commits = run.commits ?? [];
        run.commits = commits;
        let kind = "work";
        if (commits.length > 0) kind = "repair";
        console.log(`  skipping: git add -A && git commit -q in ${run.worktree} (Task-Step: implement, kind: ${kind})`);
        commits.push({
            hash: `sim-${commits.length + 1}`,
            kind,
            stepId: "implement",
        });

        // --- run task tests ---
        console.log(`  skipping: node --test <the task's test files> in ${run.worktree}`);
        const passed = sim(input, "DO_TASK_TESTS_PASS") === "YES";
        let output = "";
        if (!passed) output = "simulated failing task test output";
        run.taskTests = { passed, output };

        // --- do the task tests pass? ---
        if (passed) {
            return { next: "CODEX_REVIEWS_TESTS" };
        }

        // --- have 2 fixes already been attempted? ---
        const attempts = run.attempts ?? {};
        run.attempts = attempts;
        const fixesSoFar = attempts.testFixes ?? 0;
        if (fixesSoFar >= 2) {
            return {
                next: "FAILURES_EXIT",
                exitType: "tests-red",
                exitNote: "task tests still failing after 2 fix attempts",
            };
        }

        // --- amend tasks.json entry with the failing tests ---
        task.codexReviewNotes = `The task tests failed. Fix the cause, and change no test.\n\n${output}`;
        attempts.testFixes = fixesSoFar + 1;
        return { next: "IMPLEMENT_TASK" };
    },

    // --- pipeline-reviewTests.mmd ---

    // Prompt block. The live script writes the implementation diff, then builds the test-review prompt.
    CODEX_REVIEWS_TESTS(input) {
        const task = input.task!;
        const run = task.run!;
        const diffFile = `${run.worktree}/plans/implementation-diff-${task.taskNumber}.patch`;
        const prompt = `Run this with Bash: git -C ${run.worktree} diff <mergeBase>..HEAD > ${diffFile}. Then run the read-only reviewer over the brief, ${input.plan}, the test files, and ${diffFile}. Return its {flagged, notes} JSON, unchanged.`;
        return {
            next: "ARE_TESTS_FLAGGED",
            prompt,
        };
    },

    // One block for "are the tests flagged?" onward, and all of pipeline-rebasePreamble.mmd.
    ARE_TESTS_FLAGGED(input) {
        const task = input.task!;
        const run = task.run!;
        const review = JSON.parse(input.answer!);

        // --- are the tests flagged? ---
        if (review.flagged === true) {
            // --- 2 codex test reviews done? the live check: the entry already carries review notes ---
            const alreadyAmended = (task.codexReviewNotes ?? "").trim() !== "";
            if (alreadyAmended) {
                return {
                    next: "FAILURES_EXIT",
                    exitType: "tests-flagged",
                    exitNote: "task tests failed codex review",
                };
            }

            // --- amend tasks.json entry with codex's notes and fixes ---
            task.codexReviewNotes = `A reviewer flagged the task tests. Apply every fix below.\n\n${review.notes}`;
            return { next: "IMPLEMENT_TASK" };
        }

        // --- rebase preamble: try to lock the source repo, wait 5s, give up after 15 minutes ---
        const lockOwner = `${input.runId}:${task.taskNumber}`;
        let waitedSeconds = 0;
        while (true) {
            console.log(`  skipping: write the source repo lock file for owner ${lockOwner}`);
            const acquired = sim(input, "WAS_LOCK_ACQUIRED") === "YES";
            if (acquired) {
                run.sourceLockOwner = lockOwner;
                return {
                    next: "REBASE_ONTO_TARGET_BRANCH",
                    suiteFixAttempts: 0,
                };
            }
            if (waitedSeconds >= 15 * 60) {
                return {
                    next: "FAILURES_EXIT",
                    exitType: "run-failed",
                    exitNote: "the source repo lock did not come free within 15 minutes",
                };
            }
            console.log("  skipping: wait 5s");
            waitedSeconds += 5;
        }
    },

    // --- pipeline-rebase.mmd ---

    // One block for the rebase and its conflict check. A merge retry re-enters here.
    REBASE_ONTO_TARGET_BRANCH(input) {
        const task = input.task!;
        const run = task.run!;
        console.log(`  skipping: git rebase onto the target branch in ${run.worktree}, deepest submodule first, skipping every layer the receipt records as landed`);

        // --- did the rebase report conflicts? ---
        const conflicted = sim(input, "DID_REBASE_REPORT_CONFLICTS") === "YES";
        if (!conflicted) {
            console.log("  skipping: record sourceTipsAtRebase and the rebase step receipt in tasks.json");
            return { next: "RUN_FULL_SUITE" };
        }

        // --- 2 conflict fixes done? ---
        const attempts = run.attempts ?? {};
        run.attempts = attempts;
        const fixesSoFar = attempts["pipeline-rebase-conflict-fix"] ?? 0;
        if (fixesSoFar >= 2) {
            return {
                next: "FAILURES_EXIT",
                exitType: "rebase-stuck",
                exitNote: "the rebase did not advance after 2 conflict fixes",
            };
        }
        attempts["pipeline-rebase-conflict-fix"] = fixesSoFar + 1;
        return { next: "FIX_CONFLICTS" };
    },

    // Prompt block. The live script lists the conflicted files with git, then builds the fix prompt.
    FIX_CONFLICTS(input) {
        const run = input.task!.run!;
        const prompt = `A rebase in ${run.worktree} is stopped on conflict markers. List the files with git diff --name-only --diff-filter=U -z, resolve every conflict in them, and never run git rebase --continue. Answer with {resolved, unresolvedPaths}.`;
        return {
            next: "COMMIT_MERGE_CONFLICT_FIX_IF_NEEDED",
            prompt,
        };
    },

    // One block for "commit if needed", "continue the rebase", and "is the rebase finished?".
    COMMIT_MERGE_CONFLICT_FIX_IF_NEEDED(input) {
        const task = input.task!;
        const run = task.run!;

        // --- commit if needed ---
        const commits = run.commits ?? [];
        run.commits = commits;
        console.log(`  skipping: git add -A && git commit -q in the stopped layer of ${run.worktree} (Task-Step: rebase)`);
        commits.push({
            hash: `sim-${commits.length + 1}`,
            kind: "repair",
            stepId: "rebase",
        });

        // --- continue the rebase ---
        console.log(`  skipping: GIT_EDITOR=true git rebase --continue in ${run.worktree}, then resume the deepest-first walk`);

        // --- is the rebase finished? ---
        const finished = sim(input, "IS_REBASE_FINISHED") === "YES";
        if (finished) {
            console.log("  skipping: record sourceTipsAtRebase and the rebase step receipt in tasks.json");
            return { next: "RUN_FULL_SUITE" };
        }

        // --- it stopped on new conflicts: 2 conflict fixes done? ---
        const attempts = run.attempts ?? {};
        run.attempts = attempts;
        const fixesSoFar = attempts["pipeline-rebase-conflict-fix"] ?? 0;
        if (fixesSoFar >= 2) {
            return {
                next: "FAILURES_EXIT",
                exitType: "rebase-stuck",
                exitNote: "the rebase did not advance after 2 conflict fixes",
            };
        }
        attempts["pipeline-rebase-conflict-fix"] = fixesSoFar + 1;
        return { next: "FIX_CONFLICTS" };
    },

    AGENT_ERRORED(input) {
        return {
            next: "FAILURES_EXIT",
            exitType: "agent-failed",
            exitNote: "the agent returned nothing usable",
        };
    },

    // --- pipeline-suite.mmd ---

    // One block for pipeline-suite.mmd (minus its fix prompt), pipeline-merge.mmd, and pipeline-mergeSucceededExit.mmd.
    RUN_FULL_SUITE(input) {
        const task = input.task!;
        const run = task.run!;
        const commits = run.commits ?? [];
        run.commits = commits;

        // --- commit the suite fix if needed ---
        if (input.suiteFixAttempts > 0) {
            console.log(`  skipping: git add -A && git commit -q in ${run.worktree} (Task-Step: fix-suite-${input.suiteFixAttempts})`);
            commits.push({
                hash: `sim-${commits.length + 1}`,
                kind: "repair",
                stepId: `fix-suite-${input.suiteFixAttempts}`,
            });
        }

        // --- run the full suite ---
        console.log(`  skipping: run each layer's full suite command in ${run.worktree}, deepest first`);
        const passed = sim(input, "DO_ALL_TESTS_PASS") === "YES";
        let output = "";
        if (!passed) output = "simulated failing suite output";
        run.fullSuite = { passed, output };

        // --- do all tests pass? ---
        if (!passed) {
            // --- 2 suite fix attempts done? ---
            if (input.suiteFixAttempts >= 2) {
                return {
                    next: "FAILURES_EXIT",
                    exitType: "suite-red",
                    exitNote: "full suite still red after 2 fix attempts. merge aborted. worktree preserved.",
                };
            }
            return {
                next: "FIX_THE_CODEBASE_FOR_SUITE",
                suiteFixAttempts: input.suiteFixAttempts + 1,
            };
        }

        // --- did every change stay inside the task's file fence? ---
        console.log(`  skipping: git diff --name-only <baseRef>...HEAD per layer in ${run.worktree}, checked against the task's files`);
        const insideFence = sim(input, "DID_CHANGES_STAY_INSIDE_FENCE") === "YES";
        if (!insideFence) {
            return {
                next: "FAILURES_EXIT",
                exitType: "fence-violation",
                exitNote: "a repair edited files the task does not own. nothing merged. worktree preserved.",
            };
        }

        // --- merge worktrees and submodules, no fast-forward; each layer writes its merge ref as it lands ---
        console.log(`  skipping: git merge --no-ff task-${task.taskNumber} on each layer's target branch, writing refs/taskTools/merged-commits/... as each lands`);

        // --- read the publication state from the layer merge refs ---
        console.log("  skipping: git rev-parse --verify refs/taskTools/merged-commits/... per layer");
        const publicationState = sim(input, "WHAT_IS_PUBLICATION_STATE")!;
        run.publicationState = publicationState;

        // --- what is the publication state? ---
        if (publicationState === "SOME LANDED") {
            return {
                next: "FAILURES_EXIT",
                exitType: "partially-published",
                exitNote: "some layers are on their target branch and some are not. RECOVERY ONLY. worktree preserved.",
            };
        }
        if (publicationState === "NONE LANDED") {
            // --- 2 merge attempts done? the live check raises the count on every visit ---
            const attempts = run.attempts ?? {};
            run.attempts = attempts;
            const mergeAttempts = (attempts.merge ?? 0) + 1;
            attempts.merge = mergeAttempts;
            if (mergeAttempts >= 2) {
                return {
                    next: "FAILURES_EXIT",
                    exitType: "merge-failed",
                    exitNote: "nothing landed after 2 attempts. worktree preserved.",
                };
            }
            // the target branch tip moved. the receipt travels with the run.
            return { next: "REBASE_ONTO_TARGET_BRANCH" };
        }
        if (publicationState !== "ALL LANDED") {
            throw new Error(`unknown publication state ${JSON.stringify(publicationState)}`);
        }

        // --- merge succeeded exit: write exit type completed to tasks.json (the point of no return) ---
        run.exitType = "completed";
        run.exitNote = "All layers merged successfully.";

        // --- record merge commit hashes to tasks.json ---
        commits.push({
            hash: `sim-${commits.length + 1}`,
            kind: "merge",
            stepId: "merge",
        });

        // --- record modified files to tasks.json ---
        console.log("  skipping: git diff --name-only <baseRef>...HEAD per layer to record modifiedFiles");
        run.modifiedFiles = task.files ?? [];

        // --- clean up worktrees, leases, persistence refs and source lock ---
        console.log(`  skipping: delete the generated docs, the merge refs, the worktree ${run.worktree} and its branch; release the lease, then the source lock`);
        delete run.worktree;
        delete run.leaseRunId;
        delete run.sourceLockOwner;

        // --- build the closure note from the recorded run ---
        const closureLines = [`Task ${task.taskNumber} ${run.exitType}.`, "", "Commits:"];
        for (const commit of commits) {
            closureLines.push(`  ${commit.hash}  ${commit.kind}  ${commit.stepId}`);
        }
        closureLines.push(`Modified files: ${run.modifiedFiles.join(", ")}`);
        const closureNote = closureLines.join("\n");

        // --- mark task inactive in tasks.json ---
        run.active = false;
        run.endedAt = new Date().toISOString();

        // --- move task to completedTasks.json and update tasks blocked by it ---
        console.log(`  skipping: move task ${task.taskNumber} from tasks.json to completedTasks.json`);
        const remainingTasks = [];
        for (const openTask of input.tasks) {
            if (openTask === task) continue;
            if (openTask.blockedBy !== undefined) {
                const remainingBlockers = [];
                for (const blocker of openTask.blockedBy) {
                    if (blocker.taskNum !== task.taskNumber) remainingBlockers.push(blocker);
                }
                openTask.blockedBy = remainingBlockers;
            }
            remainingTasks.push(openTask);
        }

        // --- report the closure note, then stop ---
        console.log(closureNote);
        return {
            next: null,
            tasks: remainingTasks,
        };
    },

    // Prompt block. The live script builds the fix prompt from the owned files and the failing suite output.
    FIX_THE_CODEBASE_FOR_SUITE(input) {
        const run = input.task!.run!;
        const prompt = `Fix the cause of every failure below in ${run.worktree}, editing only the owned files and never a test. Do not commit. Answer with {fixSummary}.\n\nFAILING SUITE OUTPUT:\n${run.fullSuite!.output}`;
        return {
            next: "RUN_FULL_SUITE",
            prompt,
        };
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
};

// What one script execution produced, before the hook decides whether to keep walking.
type RunStepResult = {
    output: Input;
    nextBlock: string | null;
    prompt: string;
};

// The hook's output. This lands in the agent's context as the directions to follow.
type Directions = {
    block: string;
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

// The fields each block reads from the run state. The live hook keeps these in *.template.json.
const blockInputFields: Record<string, (keyof State)[]> = {
    PREAMBLE_STATUS_CHECK: ["taskNumber", "tasks", "runId"],
    DOCUMENT_GENERATION: ["docsMode"],
    PREAMBLE_TASK_NUMBER_INPUT: [],
    IS_TASK_NUMBER_VALID: ["task"],
    IS_TASK_BLOCKED: ["task", "tasks"],
    IS_TASK_ACTIVE: ["task"],
    MARK_TASK_ACTIVE: ["task"],
    WORKTREE_CHECK_PIPELINE: [],
    REPORT_ONLY_EXIT: ["taskNumber", "exitType", "exitNote"],
    ACTIVE_TASK_INPUT: [],
    DOES_WORKTREE_EXIST: ["task"],
    IS_WORKTREE_SAFE_TO_USE: ["task"],
    IS_PREVIOUS_RUN_RESUMABLE: ["task", "runId"],
    DOES_FENCE_COVER_WORKTREE: ["task"],
    CREATE_WORKTREE: ["task"],
    TAKE_WORKTREE_LEASE: ["task", "runId"],
    TAKE_WORKTREE_LEASE_BEFORE_RESET: ["task", "runId"],
    RESET_WORKTREE: ["task"],
    INIT_SUBMODULES_RECURSIVELY: [],
    DOCUMENT_GENERATION_PIPELINE: [],
    FAILURES_EXIT: ["task", "runId", "exitType", "exitNote"],
    WORKTREE_DOCS_MODE_INPUT: [],
    WHAT_IS_DOCS_MODE: ["docsMode"],
    DOCS_MODE_AUTOGEN: [],
    DOCS_MODE_UPDATE: [],
    AUTO_GENERATE_DOCS: [],
    UPDATE_AUTO_GENERATED_DOCS: [],
    PLAN_PIPELINE: [],
    DOCS_INPUT: [],
    PLAN_THE_TASK: ["task", "codexNotes"],
    WHAT_DID_THE_PLANNER_RETURN: ["task", "answer", "plan"],
    PLANNER_RETURNED_PLAN: [],
    PLANNER_RETURNED_CLARIFY: [],
    ARE_2_CLARIFY_ROUNDS_DONE: ["task"],
    WRITE_CLARIFY_REQUEST: [],
    EXIT_WORKFLOW_PLAN: [],
    REVIEW_PLAN_PIPELINE: [],
    DRAFT_PLAN_INPUT: [],
    CODEX_REVIEWS_PLAN: ["task", "plan"],
    WHAT_IS_REVIEW_VERDICT: ["task", "plan", "answer"],
    VERDICT_ACCEPT: [],
    VERDICT_AMEND_THEN_ACCEPT: [],
    VERDICT_AMEND: [],
    VERDICT_SCRAP: [],
    VERDICT_ERROR: [],
    UPDATE_TASK_ENTRY: [],
    ARE_2_REVIEWS_DONE: ["task"],
    EXIT_WORKFLOW_REVIEW_PLAN: [],
    IMPLEMENT_PIPELINE: [],
    ACCEPTED_PLAN_INPUT: [],
    IMPLEMENT_TASK: ["task", "plan"],
    COMMIT_IMPLEMENTATION_IF_NEEDED: ["task"],
    EXIT_WORKFLOW_IMPLEMENT: [],
    TASK_TESTS_PIPELINE: [],
    COMMITTED_WORK_INPUT: [],
    RUN_TASK_TESTS: [],
    DO_TASK_TESTS_PASS: ["task"],
    ARE_2_TEST_FIXES_DONE: ["task"],
    AMEND_ENTRY_WITH_FAILING_TESTS: [],
    EXIT_WORKFLOW_TASK_TESTS: [],
    REVIEW_TESTS_PIPELINE: [],
    GREEN_IMPLEMENTATION_INPUT: [],
    CODEX_REVIEWS_TESTS: ["task", "plan"],
    ARE_TESTS_FLAGGED: ["task", "answer", "runId"],
    ARE_2_TEST_REVIEWS_DONE: ["task"],
    AMEND_ENTRY_WITH_CODEX_NOTES: [],
    EXIT_WORKFLOW_REVIEW_TESTS: [],
    REBASE_PREAMBLE_PIPELINE: [],
    FINISHED_IMPLEMENTATION_INPUT: [],
    LOCK_SOURCE_REPO: [],
    WAS_LOCK_ACQUIRED: ["task"],
    HAVE_15_MINUTES_PASSED: ["task"],
    WAIT_FOR_LOCK: [],
    EXIT_WORKFLOW_REBASE_PREAMBLE: [],
    REBASE_PIPELINE: [],
    SOURCE_REPO_LOCKED_INPUT: [],
    REBASE_ONTO_TARGET_BRANCH: ["task"],
    DID_REBASE_REPORT_CONFLICTS: ["task"],
    ARE_2_CONFLICT_FIXES_DONE: ["task"],
    FIX_CONFLICTS: ["task"],
    COMMIT_MERGE_CONFLICT_FIX_IF_NEEDED: ["task"],
    CONTINUE_REBASE: [],
    IS_REBASE_FINISHED: ["task"],
    AGENT_ERRORED: [],
    EXIT_WORKFLOW_REBASE: [],
    SUITE_PIPELINE: [],
    REBASED_WORKTREE_INPUT: [],
    RUN_FULL_SUITE: ["task", "tasks", "suiteFixAttempts"],
    DO_ALL_TESTS_PASS: ["task"],
    ARE_2_SUITE_FIXES_DONE: ["task"],
    FIX_THE_CODEBASE_FOR_SUITE: ["task"],
    COMMIT_SUITE_FIX_IF_NEEDED: [],
    DID_CHANGES_STAY_INSIDE_FENCE: ["task"],
    EXIT_WORKFLOW_SUITE: [],
    MERGE_PIPELINE: [],
    GREEN_WORKTREE_INPUT: [],
    MERGE_WORKTREES: [],
    READ_MERGE_PUBLICATION_STATE: [],
    WHAT_IS_PUBLICATION_STATE: ["task"],
    PUBLICATION_ALL: [],
    PUBLICATION_NONE: [],
    PUBLICATION_PARTIAL: [],
    ARE_2_MERGE_ATTEMPTS_DONE: ["task"],
    EXIT_WORKFLOW_MERGE: [],
    EXIT_WORKFLOW_SUCCESS: [],
    MERGE_RECEIPT_INPUT: [],
    RECORD_MERGE_COMMIT_HASHES: [],
    WRITE_EXIT_TYPE_COMPLETED: [],
    RECORD_MODIFIED_FILES_SUCCESS: [],
    CLEAN_UP_WORKTREES: ["task"],
    BUILD_CLOSURE_NOTE: [],
    MARK_TASK_INACTIVE_SUCCESS: ["task"],
    ARCHIVE_TASK: ["tasks", "task"],
    REPORT_CLOSURE_NOTE: [],
    STOP: [],
};

// Counts live in the run state, beside everything else tasks.json records about a run.
function recordVisitInRunState(state: Input, block: Block): void {
    if (state.task === undefined) return;
    const run = state.task.run ?? {};
    state.task.run = run;
    const counts = run.counts ?? {};
    run.counts = counts;
    counts[block.name] = (counts[block.name] ?? 0) + 1;
}

const blockToScriptMap = new Map<string, Script>();
for (const name in blocks) {
    const script: Script = {
        run: blocks[name]!,
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
    const schema: Schema = {};
    for (const block of blockList) {
        const fields = blockInputFields[block.name];
        if (fields === undefined) throw new Error(`no input fields declared for block ${block.name}`);
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
    const fieldsTheBlockReads = blockInputFields[block.name];
    if (fieldsTheBlockReads === undefined) throw new Error(`no input fields declared for block ${block.name}`);
    const scriptInput: Partial<Input> = {};
    for (const field of fieldsTheBlockReads) {
        scriptInput[field] = input[field] as never;
    }
    return scriptInput as Input;
}

function run(script: Script, scriptInput: Input, state: Input): RunStepResult {
    const { next, prompt, ...changes } = script.run(scriptInput);
    const output: Input = { ...state };
    output.answer = "";
    Object.assign(output, changes);
    output.block = next;
    output.ran = [...state.ran];
    output.ran.push(state.block!);
    const result: RunStepResult = {
        output,
        nextBlock: next,
        prompt: prompt ?? "",
    };
    return result;
}

function runStep(input: Input): Directions {
    /*
      invokes the runStepHook.ts hook with the given input.  Looks up the script (here emulated as a function) that should be executed for the block, and passes the input to it.  If the script is matched to a 'continue' block, the output of the script says what block to run next, and the output is passed to the next block in the chain.  If the script is matched to a 'prompt' block, the script output stops the loop here, and the output is returned to the caller of 'runStep'.
    */
    let state = input;
    let block = getBlockFor(state);
    let scriptInput = prepareInputForBlock(state, block); //input contains 'blockName'
    let result: RunStepResult;
    while (true) {
        // find the script (function) for the block being run.
        console.log(`${block.name} being executed`);
        const script = blockToScriptMap.get(block.name);
        if (script === undefined) throw new Error(`no script found for block ${block.name}`);
        // execute the script (function) matched to the block being run.
        recordVisitInRunState(state, block);
        result = run(script, scriptInput, state);
        // if the script is a prompt-generating script, return the generated prompt.
        if (result.prompt !== "") {
            return {
                block: block.name,
                prompt: result.prompt,
                payload: result.output,
                previousBlockWasTerminal: false,
            };
        }
        // if the block is the last block in the chain, return the output of that
        const nextBlock = result.nextBlock;
        if (nextBlock === null) {
            return {
                block: block.name,
                prompt: "return the payload verbatim",
                payload: result.output,
                previousBlockWasTerminal: true,
            };
        }
        // if the script is a continue-generating script, get the next block to run.
        state = result.output;
        block = getBlockFor(state);
        // else pass the output from the script execution to the next block in the chain.
        scriptInput = prepareInputForBlock(state, block);
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
    let answer = sim(directions.payload, directions.block);
    if (answer === null) return null;
    const output: Input = { ...directions.payload };

    // For the planner prompt the agent writes the plan file. The sim only names it.
    if (directions.block === "PLAN_THE_TASK") {
        if (answer === "PLAN") {
            const task = directions.payload.task!;
            output.plan = `${task.run!.worktree}/plans/task-${task.taskNumber}-plan.md`;
        }
    }

    // For the two codex prompts the agent runs codex in a shell and returns codex's JSON.
    // ponytail: the fixture names the outcome; the sim writes the JSON that outcome would carry.
    if (directions.block === "CODEX_REVIEWS_PLAN") {
        if (answer === "ERROR") {
            answer = JSON.stringify({
                outcome: "ERROR",
                missingFiles: [directions.payload.plan],
                message: "Review not performed because one or more required input files were unavailable.",
                issues: [],
                fixes: [],
                sectionsThatHoldUp: [],
            });
        } else {
            let fixCount = 0;
            if (answer === "AMEND_THEN_ACCEPT") fixCount = 1;
            if (answer === "AMEND") fixCount = 2;
            if (answer === "SCRAP") fixCount = 5;
            const fixes = [];
            for (let i = 1; i <= fixCount; i++) {
                fixes.push({
                    sectionId: `section-${i}`,
                    fix: `simulated fix ${i}`,
                    durableBecause: "simulated",
                });
            }
            answer = JSON.stringify({
                outcome: "OK",
                missingFiles: [],
                message: "",
                issues: [],
                fixes,
                sectionsThatHoldUp: [],
            });
        }
    }
    if (directions.block === "CODEX_REVIEWS_TESTS") {
        const flagged = answer === "YES";
        let notes = "";
        if (flagged) notes = "simulated reviewer notes on the task tests";
        answer = JSON.stringify({ flagged, notes });
    }

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
    console.log(`  agent reads the prompt from ${directions.block}:\n    ${directions.prompt.split("\n").join("\n    ")}`);

    /*
      the agent follows the prompt and returns a specific output shape (based on a schema)
    */
    const resultFromFollowingThePrompt = followPrompt(directions, schema);
    return resultFromFollowingThePrompt;
}

function main(taskNumber: number, tasksJsonPath: string) {
    const tasks = JSON.parse(readFileSync(tasksJsonPath, "utf8")) as Task[];
    let input: Input = {
        command: "/run-step",
        block: "PREAMBLE_STATUS_CHECK",
        taskNumber,
        tasks,
        task: undefined,
        runId: randomUUID(),
        docsMode: "",
        plan: "",
        codexNotes: "",
        suiteFixAttempts: 0,
        exitType: "",
        exitNote: "",
        answer: "",
        ran: [],
    };
    const diagrams = getDiagramsForPipelines(pipelines);
    blockList = getBlocksForDiagrams(diagrams);
    // Not in any diagram yet: the .mmd files still draw these as 24 boxes across three diagrams.
    blockList.push({
        name: "PREAMBLE_STATUS_CHECK",
        diagram: "monolith",
        fedBy: [],
        feeds: ["DOCUMENT_GENERATION", "REPORT_ONLY_EXIT", "FAILURES_EXIT"],
    });
    blockList.push({
        name: "DOCUMENT_GENERATION",
        diagram: "monolith",
        fedBy: ["PREAMBLE_STATUS_CHECK", "WHAT_DID_THE_PLANNER_RETURN"],
        feeds: ["PLAN_THE_TASK"],
    });
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
