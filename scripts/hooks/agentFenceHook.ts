// PreToolUse hook: blocks writes outside the block's edit fence. Args: taskNumber, tasksFile, box.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { readTaskFile } from "../shared/taskFiles.ts";
import { modifiableFiles } from "../shared/prepareTasks.ts";

// A throw exits 1, which is non-blocking; exit 2 blocks the tool and shows the error.
process.on("uncaughtException", (error) => { process.stderr.write(`${error.stack ?? error}\n`); process.exit(2); });

const taskNumber = Number(process.argv[2]);
const tasksFile = process.argv[3]!;
const box = process.argv[4]!;
const input = JSON.parse(readFileSync(0, "utf8"));
const filePath: unknown = input.tool_input?.file_path ?? input.tool_input?.notebook_path;
if (typeof filePath !== "string") throw new Error(`agentFenceHook: ${input.tool_name} carries no file_path`);

const task = readTaskFile(tasksFile).find((entry) => entry.taskNumber === taskNumber);
if (task === undefined) throw new Error(`agentFenceHook: task ${taskNumber} not found in ${tasksFile}`);

// The planner owns only the plan file.
const fence = box === "PLAN_THE_TASK" ? ["plans/plan.json"] : [...modifiableFiles(task)];
// The conflict fixer also owns whatever git reports unmerged in the edited file's own repo, submodules included.
if (box === "FIX_CONFLICTS") {
    const unmerged = execFileSync("git", ["-C", dirname(filePath), "diff", "--name-only", "--diff-filter=U", "-z"], { encoding: "utf8" });
    fence.push(...unmerged.split("\0").filter((line) => line.length > 0));
}
// Suffix match on a "/"-bounded segment, since the fence holds repo-relative paths.
const inFence = fence.some((relative) => filePath === relative || filePath.endsWith(`/${relative}`));

if (!inFence) {
    process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason: `${filePath} is outside task ${taskNumber}'s ${box} fence`,
        },
    }));
}
