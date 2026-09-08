// PreToolUse hook: blocks writes outside the task's modifiableFiles fence. Args: taskNumber, tasksFile.
import { readFileSync } from "node:fs";
import { readTaskFile } from "../shared/taskFiles.ts";
import { modifiableFiles } from "../shared/prepareTasks.ts";

const taskNumber = Number(process.argv[2]);
const tasksFile = process.argv[3]!;
const input = JSON.parse(readFileSync(0, "utf8"));
const filePath: unknown = input.tool_input?.file_path ?? input.tool_input?.notebook_path;

const task = readTaskFile(tasksFile).find((entry) => entry.taskNumber === taskNumber);
if (task === undefined) throw new Error(`agentFenceHook: task ${taskNumber} not found in ${tasksFile}`);

const fence = modifiableFiles(task);
// Suffix match on a "/"-bounded segment, since the fence holds worktree-relative paths.
const inFence = typeof filePath === "string" && fence.some((relative) => filePath === relative || filePath.endsWith(`/${relative}`));

if (!inFence) {
    process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason: `${String(filePath)} is outside task ${taskNumber}'s modifiableFiles fence`,
        },
    }));
}
