// FIX_IMPLEMENT_TASK_TESTS, from pipeline-fixImplementTaskTests.mmd. Prompt block: fix the task's own tests, never the tests themselves.
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildPromptOutputTemplate } from "../../shared/contracts.ts";
import { loadPreparedTask, type PreparedTask } from "../shared/preparedTask.ts";
import { absolutePathsSection } from "../shared/promptSections.ts";
import { resumedRunSection } from "../shared/resumedRunSection.ts";
import { whatToReturnSection } from "../shared/whatToReturn.ts";
// import { spawnClaudeCliPrompt } from "../shared/spawnAgentCli.ts"; // retired: the agent follows the prompt itself, no CLI spawn.
import type { CommitImplementationIfNeededPacket } from "../commitImplementationIfNeeded/_packet.ts";

// Double-quoted for the read-file hook's parser; deduped so a path is never listed twice.
const readFileArgs = (paths: string[]) => [...new Set(paths)].map((path) => `"${path}"`).join(" ");
const GUIDE = (name: string) => `${homedir()}/.claude/guides/${name}`;

// Retired (prompt shapes): one template literal became FIX_TASK_TESTS_SECTIONS below, so the skeleton view cannot drift.
// export function buildFixTaskTestsPrompt(prepared: PreparedTask): string {
//     const root = prepared.repoRoot.replace(/\/+$/, "");
//     return `## YOUR JOB
//
// Fix the cause of every failure listed under FAILING TASK TESTS.
// Read \`~/.claude/guides/tests-and-code-changes.md\` first: it decides, per failing test, whether the code or the test is wrong.
//
// The task's own tests in the worktree \`${root}\` are red.
// A test that fails is reporting a real defect until you have proved otherwise.
// A test that checks behavior this task was asked to change is obsolete: comment it out and say which test and why.
//
// ## WHAT TO READ
//
// Run this, which puts the files into your context without spending a Read tool call, so you can read them all at once:
// \`\`\`
// /read-file ${readFileArgs([GUIDE("tests-and-code-changes.md"), ...prepared.ownedFilePaths, ...prepared.testFilePaths])}
// \`\`\`
//
// You may read any other file, anywhere in the tree, to understand a failure: callers, callees, tests, other layers.
//
// ${absolutePathsSection(root)}
//
// ## WHAT YOU MAY EDIT
//
// ${prepared.ownedFilePaths.map((path) => `- \`${path}\``).join("\n")}
//
// This list is complete, plus any test file whose failure the guide rules obsolete.
// Every other path in the tree belongs to another task.
//
// If fixing the cause needs an edit outside this list, make no edit at all and say so.
//
// ${resumedRunSection(root)}
//
// ## HOW TO FIX
//
// 1. Read the failing test notes below and name the single defect behind each failure.
// 2. Fix that defect in the paths listed above.
// 3. Re-run only the individual test that failed, with \`node --test <absolute test path>\`, run inside \`${root}\`.
// 4. Repeat until every listed failure is addressed.
// 5. Never run the full suite.
//
// ## FORBIDDEN ACTIONS
//
// You are forbidden from doing any of the following actions:
// - weaken, delete, skip, or stub out a test to make a failure disappear;
// - edit a test file, except to comment out one the guide rules obsolete;
// - edit any path not listed under WHAT YOU MAY EDIT;
// - add scope or a refactor no listed failure calls for;
// - run the full suite;
// - stage or commit anything by hand;
// - force-push or hard-reset anything you did not create.
//
// Leaving a failure unaddressed and saying so is a correct outcome when the cause sits outside the paths you own.
// It is not a failure, and it is always better than a guess.
//
// ${whatToReturnSection('{ "fixSummary": "..." }', "where \\`fixSummary\\` is one paragraph naming which failures you fixed, and any failure left unaddressed and why", "")}
//
// ## FAILING TASK TESTS
//
// \`\`\`
// ${prepared.codexReviewNotes}
// \`\`\``;
// }

export type FixTaskTestsChoices = {};

export type FixTaskTestsVars = {
    root: string;
    readFileArgs: string;
    absolutePaths: string;
    ownedPaths: string;
    resumedRun: string;
    whatToReturn: string;
    codexReviewNotes: string;
};

export type FixTaskTestsSection = { name: string; when: (c: FixTaskTestsChoices) => boolean; render: (v: FixTaskTestsVars) => string };

export const FIX_TASK_TESTS_SECTIONS: FixTaskTestsSection[] = [
    {
        name: "YOUR JOB",
        when: () => true,
        render: (v) => `## YOUR JOB

You are an agent fixing the task's own failing tests.
Your job is to fix the cause of every failure listed under FAILING TASK TESTS.
Your goal is to fix the real defect behind each failure.
Read \`~/.claude/guides/tests-and-code-changes.md\` first.
That guide decides, per failing test, whether the code or the test is wrong.
The task's own tests in the worktree \`${v.root}\` are red.
A test that fails is reporting a real defect until you have proved otherwise.
A test that checks behavior this task was asked to change is obsolete.
Comment it out.
Say which test and why.

`,
    },
    {
        name: "WHAT TO READ",
        when: () => true,
        render: (v) => `## WHAT TO READ

invoke this skill exactly:
\`\`\`
/read-file ${v.readFileArgs}
\`\`\`
This puts the files into your context without spending a Read tool call.

You may read any other file, anywhere in the tree, to understand a failure: callers, callees, tests, other layers.

${v.absolutePaths}

`,
    },
    {
        name: "WHAT YOU MAY EDIT",
        when: () => true,
        // Retired (rule 7): "This list is complete, plus any test file whose failure the guide rules obsolete."
        render: (v) => `## WHAT YOU MAY EDIT

${v.ownedPaths}

You may also edit any test file whose failure the guide rules obsolete.
Every other path in the tree belongs to another task.

If fixing the cause needs an edit outside the file paths listed above, make no edit at all.
Say so.

${v.resumedRun === "" ? "" : `${v.resumedRun}\n\n`}`,
    },
    {
        name: "HOW TO FIX",
        when: () => true,
        // Retired (task 51): "Never run the full suite." — the fenced agent's disallowedTools now denies it.
        render: (v) => `## HOW TO FIX

1. Read the failing test notes below.
Name the single defect behind each failure.
2. Fix that defect in the paths listed above.
3. Re-run only the individual test that failed, with \`node --test <absolute test path>\`, run inside \`${v.root}\`.
4. Repeat until every listed failure is addressed.

`,
    },
    {
        name: "FORBIDDEN ACTIONS",
        when: () => true,
        // Retired (task 51): the fenced hook and disallowedTools now deny editing, testing, and git actions.
        render: () => `## FORBIDDEN ACTIONS

You are forbidden from doing any of the following actions:
- weaken, delete, skip, or stub out a test to make a failure disappear;
- edit a test file, except to comment out one the guide rules obsolete;
- add scope or a refactor no listed failure calls for.

Leaving a failure unaddressed and saying so is a correct outcome when the cause sits outside the paths you own.
It is not a failure.
It is always better than a guess.

`,
    },
    {
        name: "WHAT YOU, THE SPAWNING AGENT, RETURNS",
        when: () => true,
        render: (v) => `${v.whatToReturn}

`,
    },
    {
        name: "FAILING TASK TESTS",
        when: () => true,
        render: (v) => `## FAILING TASK TESTS

\`\`\`
${v.codexReviewNotes}
\`\`\``,
    },
];

export function fixTaskTestsChoices(): FixTaskTestsChoices {
    return {};
}

export const FIX_TASK_TESTS_SKELETON_VARS: FixTaskTestsVars = {
    root: "`${root}`",
    readFileArgs: '`${readFileArgs([GUIDE("tests-and-code-changes.md"), ...prepared.readFilePaths, ...prepared.testFilePaths])}`',
    absolutePaths: "`${absolutePathsSection(root)}`",
    ownedPaths: '`${prepared.ownedFilePaths.map((path) => `- \\`${path}\\``).join("\\n")}`',
    resumedRun: "`${resumedRunSection(root)}`",
    whatToReturn: "`${whatToReturnSection(...)}`",
    codexReviewNotes: "`${prepared.codexReviewNotes}`",
};

export function renderFixTaskTestsSections(choices: FixTaskTestsChoices, vars: FixTaskTestsVars): string {
    return FIX_TASK_TESTS_SECTIONS.filter((s) => s.when(choices)).map((s) => s.render(vars)).join("");
}

export function buildFixTaskTestsPromptSkeleton(choices: FixTaskTestsChoices): string {
    return renderFixTaskTestsSections(choices, FIX_TASK_TESTS_SKELETON_VARS);
}

export function buildFixTaskTestsPrompt(prepared: PreparedTask): string {
    const root = prepared.repoRoot.replace(/\/+$/, "");
    return renderFixTaskTestsSections(fixTaskTestsChoices(), {
        root,
        readFileArgs: readFileArgs([GUIDE("tests-and-code-changes.md"), ...prepared.readFilePaths, ...prepared.testFilePaths]),
        absolutePaths: absolutePathsSection(root),
        ownedPaths: prepared.ownedFilePaths.map((path) => `- \`${path}\``).join("\n"),
        resumedRun: resumedRunSection(root),
        whatToReturn: whatToReturnSection('{ "fixSummary": "..." }', "where \\`fixSummary\\` is one paragraph naming which failures you fixed, and any failure left unaddressed and why", ""),
        codexReviewNotes: prepared.codexReviewNotes,
    });
}

export function fixTaskTestsPromptCombos(): { name: string; skeleton: string; rendered: string }[] {
    const fakeTask: PreparedTask = {
        number: 99,
        briefFile: "/tmp/fake-worktree/plans/brief-99.md",
        planFile: "/tmp/fake-worktree/plans/plan.json",
        reviewFile: "/tmp/fake-worktree/plans/codex-review.json",
        reviewOutputFile: "/tmp/fake-worktree/plans/codex-review.json",
        testReviewFile: "/tmp/fake-worktree/plans/test-review.json",
        notesFile: "/tmp/fake-worktree/plans/implementation-notes-99.md",
        files: ["src/thing.ts"],
        readOnlyFiles: ["*"],
        ownedFilePaths: ["/tmp/fake-worktree/src/thing.ts"],
        readFilePaths: ["/tmp/fake-worktree/src/thing.ts"],
        createsFiles: [],
        difficulty: 1,
        clarifyRequest: "",
        testFilePaths: ["/tmp/fake-worktree/tests/thing.test.ts"],
        hasTests: true,
        tests: "node --test tests/thing.test.ts",
        codexReviewNotes: "the failing test notes text",
        siblingTasks: [],
        blockedBy: [],
        blocks: [],
        repoRoot: "/tmp/fake-worktree",
        taskStateRoot: "/tmp/fake-worktree",
    };
    const c = fixTaskTestsChoices();
    return [{ name: "default", skeleton: buildFixTaskTestsPromptSkeleton(c), rendered: buildFixTaskTestsPrompt(fakeTask) }];
}

// const agentLogFile = () => process.env.RUN_STEP_LOG!.replace(/-run-log\.md$/, "-agents.log");

export function main(input: string): Record<string, unknown> {
    const packet = JSON.parse(input) as CommitImplementationIfNeededPacket;
    const prepared = loadPreparedTask(packet.taskNumber, packet.worktree, packet.projectRoot);
    const promptFile = `${prepared.repoRoot.replace(/\/+$/, "")}/plans/FIX_IMPLEMENT_TASK_TESTS.prompt.md`;
    mkdirSync(dirname(promptFile), { recursive: true });
    writeFileSync(promptFile, buildFixTaskTestsPrompt(prepared));
    // const prompt = spawnClaudeCliPrompt(...): retired, the workflow agent reads the prompt file and follows it.
    const prompt = `invoke '/read-file "${promptFile}"' and follow the instructions.`;
    return { ...buildPromptOutputTemplate("FIX_IMPLEMENT_TASK_TESTS"), prompt };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
