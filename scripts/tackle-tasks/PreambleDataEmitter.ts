// Emits the prompt text for one preamble-pipeline box (plans/diagram/pipeline-preamble.mmd).
// Unlike AgentPromptEmitter (which hands a subagent bulk data to read itself), every box here
// is a small script/decision whose real work IS the data script — so this emitter imports the
// data script, runs it now, and bakes the small resolved result into the prompt. The subagent
// running this file's stdout never touches the data script itself; only this emitter does, per
// workflow-only-context-injection.md §2/§6. Every builder puts instructions first and the
// resolved result in one final "---- DATA ----" section (§6: interpolate data last).
import { readFileSync } from "node:fs";
import { isTaskNumberValid } from "./isTaskNumberValid.ts";
import { isTaskOpen } from "./isTaskOpen.ts";
import { claimTaskRun } from "./claimTaskRun.ts";
import { isTaskBlocked } from "./isTaskBlocked.ts";
import { doesTaskWorktreeExist } from "./doesTaskWorktreeExist.ts";
import { checkTaskWorktreeSafe } from "./checkTaskWorktreeSafe.ts";
import { isTaskRunResumable } from "./isTaskRunResumable.ts";
import { createTaskWorktree } from "./createTaskWorktree.ts";
import { resetTaskWorktree } from "./resetTaskWorktree.ts";
import { generateTaskDocs } from "./generateTaskDocs.ts";
import { updateTaskDocs } from "./updateTaskDocs.ts";
import { initTaskSubmodules } from "./initTaskSubmodules.ts";
import { validateActiveTaskReceipt } from "./validateActiveTaskReceipt.ts";

function readStdin(): string {
    try {
        return readFileSync(0, "utf8");
    } catch {
        return "";
    }
}

function fail(problem: string): never {
    process.stderr.write(`PreambleDataEmitter: ${problem}\n`);
    process.exit(1);
}

export type PreambleDataEmitterPayload = {
    projectRoot?: string;
    worktreePath?: string;
    runId?: string;
    stepId?: string;
    receipt?: unknown;
    [key: string]: unknown;
};

function requireString(payload: PreambleDataEmitterPayload, field: keyof PreambleDataEmitterPayload): string {
    const value = payload[field];
    if (typeof value !== "string" || value === "") throw new Error(`payload missing "${String(field)}"`);
    return value;
}

// ---------------------------------------------------------------------------
// Shared prompt shape: the instructions and return contract come first, the resolved
// result (already computed by this emitter) comes last, as the only thing "DATA" holds.
// ---------------------------------------------------------------------------

function resultPrompt(description: string, returnContract: string, result: unknown): string {
    return `${description}

Return exactly this JSON, unchanged: ${returnContract}

---- DATA ----
RESULT =
${JSON.stringify(result)}`;
}

// ---------------------------------------------------------------------------
// Dispatch — one case per preamble-pipeline box.
// ---------------------------------------------------------------------------

export function emitPreambleData(taskNumber: number, mode: string, payload: PreambleDataEmitterPayload): string {
    switch (mode) {
        case "task-number-valid": {
            const projectRoot = requireString(payload, "projectRoot");
            const result = isTaskNumberValid(taskNumber, projectRoot);
            return resultPrompt(
                "Report whether the task number is valid: present in tasks.json and/or completedTasks.json.",
                '{"valid": <boolean>, "location": "open"|"completed"|"both"|null}',
                result,
            );
        }
        case "task-open": {
            const projectRoot = requireString(payload, "projectRoot");
            const result = isTaskOpen(taskNumber, projectRoot);
            return resultPrompt(
                "Report whether the task is still open (not already completed).",
                '{"open": <boolean>, "closeInProgress": <boolean>}',
                result,
            );
        }
        case "claim-task": {
            const projectRoot = requireString(payload, "projectRoot");
            const runId = requireString(payload, "runId");
            const result = claimTaskRun(taskNumber, runId, projectRoot);
            return resultPrompt(
                "The task's active/claimed status was just atomically checked and, if it was free, marked active for this run.",
                '{"status": "claimed"|"refused"|"closing"|"not-found", "heldByRunId": <string|null>}',
                result,
            );
        }
        case "task-blocked": {
            const projectRoot = requireString(payload, "projectRoot");
            const result = isTaskBlocked(taskNumber, projectRoot);
            return resultPrompt(
                "Report whether the task has an open blocker remaining.",
                '{"blocked": <boolean>, "blockers": [{"taskNum": <number>, "reason": <string>}]}',
                result,
            );
        }
        case "worktree-exists": {
            const projectRoot = requireString(payload, "projectRoot");
            const result = doesTaskWorktreeExist(taskNumber, projectRoot);
            return resultPrompt(
                "Report whether a worktree already exists for this task.",
                '{"exists": <boolean>, "worktree": <string|null>}',
                result,
            );
        }
        case "worktree-safe": {
            const worktreePath = requireString(payload, "worktreePath");
            const result = checkTaskWorktreeSafe(taskNumber, worktreePath);
            return resultPrompt(
                "Report whether the existing worktree is structurally safe to use: it opens, it is on the task's branch, and its submodules are intact.",
                '{"safe": <boolean>, "problems": [<string>, ...]}',
                result,
            );
        }
        case "run-resumable": {
            const worktreePath = requireString(payload, "worktreePath");
            const runId = requireString(payload, "runId");
            const projectRoot = requireString(payload, "projectRoot");
            const result = isTaskRunResumable(taskNumber, worktreePath, runId, projectRoot);
            return resultPrompt(
                "Report whether the previous run's work is resumable: did it record where in the plan it stopped.",
                '{"resumable": <boolean>, "implementationNotesFile": <string|null>, "leaseEstablished": <boolean>}',
                result,
            );
        }
        case "create-worktree": {
            const runId = requireString(payload, "runId");
            const projectRoot = requireString(payload, "projectRoot");
            const result = createTaskWorktree(taskNumber, runId, projectRoot);
            return resultPrompt(
                "A fresh worktree for this task was just created.",
                '{"worktree": <string>, "branch": <string>}',
                result,
            );
        }
        case "reset-worktree": {
            const runId = requireString(payload, "runId");
            const projectRoot = requireString(payload, "projectRoot");
            const result = resetTaskWorktree(taskNumber, runId, projectRoot);
            return resultPrompt(
                "The unsafe, non-resumable worktree for this task was just torn down and recreated.",
                '{"worktree": <string>, "branch": <string>}',
                result,
            );
        }
        case "generate-docs": {
            const worktreePath = requireString(payload, "worktreePath");
            const projectRoot = requireString(payload, "projectRoot");
            const result = generateTaskDocs(taskNumber, worktreePath, projectRoot);
            return resultPrompt(
                "The task's brief was just auto-generated into the new worktree.",
                '{"briefFile": <string>}',
                result,
            );
        }
        case "update-docs": {
            const worktreePath = requireString(payload, "worktreePath");
            const projectRoot = requireString(payload, "projectRoot");
            const result = updateTaskDocs(taskNumber, worktreePath, projectRoot);
            return resultPrompt(
                "The task's brief was just refreshed in the existing worktree.",
                '{"briefFile": <string>}',
                result,
            );
        }
        case "init-submodules": {
            const worktreePath = requireString(payload, "worktreePath");
            const runId = requireString(payload, "runId");
            const projectRoot = requireString(payload, "projectRoot");
            const stepId = requireString(payload, "stepId");
            const result = initTaskSubmodules({ worktreePath, taskNumber, runId, projectRoot, stepId });
            return resultPrompt(
                "The worktree's submodules were just initialized recursively (a no-op if there are none).",
                '{"initialized": <boolean>}',
                result,
            );
        }
        case "validate-active-task-receipt": {
            if (payload.receipt === undefined) throw new Error('payload missing "receipt"');
            const result = validateActiveTaskReceipt({ receipt: payload.receipt, taskNumber });
            return resultPrompt(
                "The { active task, initialized worktree } receipt was just checked for structural validity.",
                '{"valid": <boolean>, "problem": <string|null>}',
                result,
            );
        }
        default:
            throw new Error(`unknown mode "${mode}"`);
    }
}

if (process.argv[1]?.endsWith("PreambleDataEmitter.ts")) {
    const N = Number(process.argv[2]);
    const MODE = process.argv[3];
    if (!Number.isInteger(N)) fail(`invalid task number: ${process.argv[2]}`);
    if (!MODE) fail("no mode given");

    const payloadText = readStdin();
    const PAYLOAD: PreambleDataEmitterPayload = payloadText ? JSON.parse(payloadText) : {};

    try {
        process.stdout.write(emitPreambleData(N, MODE, PAYLOAD));
    } catch (error) {
        fail(String((error as Error)?.message ?? error));
    }
}
