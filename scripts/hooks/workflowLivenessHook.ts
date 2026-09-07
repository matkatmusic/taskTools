// PostToolUse hook (matcher Workflow): reports the newest run log for the task and its age.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { taskFilesProjectRoot } from "../shared/taskFiles.ts";

const payload: { hook_event_name?: unknown; tool_name?: unknown; tool_input?: Record<string, unknown> } = JSON.parse(readFileSync(0, "utf8"));

if (payload.tool_name !== "Workflow") process.exit(0);

const toolInput = payload.tool_input ?? {};
const args = (toolInput.args ?? {}) as Record<string, unknown>;
const taskNumber = Number(args.task);
if (!Number.isInteger(taskNumber)) process.exit(0);
if (typeof args.tasksFile !== "string") process.exit(0);

// Derived from args.tasksFile, never from the payload cwd, which may be an unrelated repository.
const projectRoot = taskFilesProjectRoot({ tasksPath: args.tasksFile, completedTasksPath: "" });
const runsDirectory = join(projectRoot, ".taskTools", "runs");

function newestRunLogPathForTask(directory: string, task: number): string | null {
    if (!existsSync(directory)) return null;
    // Each run folder holds its own log: runs/<stamp>/task-<N>-run-log.json.
    const matchingNames = readdirSync(directory).map((stamp) => join(stamp, `task-${task}-run-log.json`)).filter((name) => existsSync(join(directory, name)));
    if (matchingNames.length === 0) return null;
    const namesByNewestFirst = matchingNames
        .map((name) => ({ name, mtimeMs: statSync(join(directory, name)).mtimeMs }))
        .sort((a, b) => b.mtimeMs - a.mtimeMs);
    return join(directory, namesByNewestFirst[0].name);
}

// The run log is rewritten whole each pass; a read mid-rewrite yields diagnostic text, never a throw.
function describeFirstBlock(path: string): string {
    let parsed: unknown;
    try {
        parsed = JSON.parse(readFileSync(path, "utf8"));
    } catch {
        return "unreadable (invalid JSON, possibly a rewrite in progress)";
    }
    if (!Array.isArray(parsed)) return "unreadable (not a JSON array)";
    if (parsed.length === 0) return "empty (no entries recorded yet)";
    const firstEntry = parsed[0] as Record<string, unknown>;
    if (typeof firstEntry.block !== "string") return "unreadable (first entry has no block field)";
    return firstEntry.block;
}

const runLogPath = newestRunLogPathForTask(runsDirectory, taskNumber);
const additionalContext = runLogPath === null
    ? `no run log yet for task ${taskNumber}`
    : `most recent run log for task ${taskNumber}, ${Math.round((Date.now() - statSync(runLogPath).mtimeMs) / 1000)}s old (${runLogPath}): ${describeFirstBlock(runLogPath)}`;

process.stdout.write(`${JSON.stringify({
    hookSpecificOutput: { hookEventName: payload.hook_event_name, additionalContext },
})}\n`);
