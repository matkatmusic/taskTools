// Renames the legacy `files` key to `modifiableFiles` on every task in a tasks.json.
import { readFileSync } from "node:fs";
import { writeJsonAtomically } from "../shared/taskStateLock.ts";
import type { TaskRecord } from "../shared/taskFiles.ts";

export function migrateTaskFiles(tasksPath: string): number[] {
    const tasks = JSON.parse(readFileSync(tasksPath, "utf8")) as TaskRecord[];
    const changed: number[] = [];
    for (const task of tasks) {
        const hasFiles = "files" in task;
        const hasModifiableFiles = "modifiableFiles" in task;
        if (hasFiles && !hasModifiableFiles) {
            task.modifiableFiles = task.files;
            delete task.files;
            changed.push(task.taskNumber);
        } else if (hasFiles && hasModifiableFiles) {
            delete task.files;
            changed.push(task.taskNumber);
        }
    }
    if (changed.length > 0) writeJsonAtomically(tasksPath, tasks);
    return changed;
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
    const tasksPath = process.argv[2];
    if (!tasksPath) throw new Error("migrateTaskFiles: no tasks.json path given");
    const changed = migrateTaskFiles(tasksPath);
    for (const taskNumber of changed) process.stdout.write(`migrated task ${taskNumber}\n`);
    process.stdout.write(`${changed.length} task(s) migrated\n`);
}
