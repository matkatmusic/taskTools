import { readFileSync } from "node:fs";
import { computeTaskStats, formatTaskStats } from "./taskStats.ts";
import { readTaskFile, resolveTaskFiles } from "../shared/taskFiles.ts";

const payload = JSON.parse(readFileSync(0, "utf8")) as { prompt?: string; cwd?: string };

const prompt = (typeof payload.prompt === "string" ? payload.prompt.trimStart() : "").replace(/^\/[\w-]+:/, "/");
if (prompt !== "/task-stats" && !prompt.startsWith("/task-stats ")) {
    process.exit(0);
}

const pair = resolveTaskFiles(payload.cwd ?? process.cwd());
const today = new Date().toISOString().slice(0, 10);
const stats = computeTaskStats(readTaskFile(pair.tasksPath), readTaskFile(pair.completedTasksPath), today);
const reason = formatTaskStats(stats);

process.stdout.write(JSON.stringify({ decision: "block", reason }));
