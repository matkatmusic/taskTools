// One-off audit script (not wired into npm test): recounts task 9's "43 of 126" open-run
// figure by durable runId instead of by raw run-log file count. Run once: node plans/audit-2026-09-05/recountOpenRuns.ts
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { readTaskFile, type TaskRecord } from "../../scripts/taskFiles.ts";
import type { TaskRunState } from "../../scripts/tackle-tasks/shared/taskRunState.ts";

const RUNS_DIR = ".taskTools/runs";
const STAMP_LOG_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d+)(?:-task-(\d+))?-run-log\.json$/;
const FAILURE_EXIT_TYPES = new Set(["run-failed", "agent-failed", "rebase-stuck", "merge-failed", "tests-red", "suite-red", "clarify-stuck", "not-resumable"]);

type LogEntry = { block: string };
type TaskRecordWithRun = TaskRecord & { run?: TaskRunState };

type Stamp = {
    stamp: string;
    entries: LogEntry[];
    mtimeMs: number;
    taskNumber: number | null;
    runId: string | null;
    classification: "completed" | "operational failure" | "open";
    exitDiagram: string | null;
};

function mergedEntriesFor(stamp: string, files: string[]): LogEntry[] {
    // Task-tagged half runs first: it starts the pass, the untagged half continues it.
    const ordered = [...files].sort((a, b) => Number(/-task-\d+-run-log\.json$/.test(b)) - Number(/-task-\d+-run-log\.json$/.test(a)));
    return ordered.flatMap(file => JSON.parse(readFileSync(join(RUNS_DIR, file), "utf8")) as LogEntry[]);
}

function classify(entries: LogEntry[]): { classification: Stamp["classification"]; exitDiagram: string | null } {
    const last = entries.at(-1);
    if (last === undefined) return { classification: "open", exitDiagram: null };
    if (last.block === "FAILURE" || last.block === "HOOK EXCEPTION") return { classification: "operational failure", exitDiagram: null };
    if (last.block.endsWith("::STOP")) {
        const diagram = last.block.split("::")[0]!.replace(/^pipeline-/, "").replace(/\.mmd$/, "");
        return { classification: "completed", exitDiagram: diagram };
    }
    return { classification: "open", exitDiagram: null };
}

// The newest packet file's own taskNumber/runId, else its output.result's (a numbered diagnostic pass), else neither.
function packetFields(stamp: string): { taskNumber: number | null; runId: string | null } {
    const packetsFolder = join(RUNS_DIR, stamp, "packets");
    if (!existsSync(packetsFolder)) return { taskNumber: null, runId: null };
    const packetNames = readdirSync(packetsFolder);
    if (packetNames.length === 0) return { taskNumber: null, runId: null };
    const newest = packetNames.map(name => ({ name, mtimeMs: statSync(join(packetsFolder, name)).mtimeMs })).sort((a, b) => b.mtimeMs - a.mtimeMs)[0]!.name;
    const packet = JSON.parse(readFileSync(join(packetsFolder, newest), "utf8")) as Record<string, unknown>;
    const output = packet.output as { result?: Record<string, unknown> } | undefined;
    const taskNumber = packet.taskNumber ?? output?.result?.taskNumber;
    const runId = packet.runId ?? output?.result?.runId;
    return { taskNumber: taskNumber === undefined ? null : Number(taskNumber), runId: runId === undefined ? null : String(runId) };
}

function stampMtimeMs(stamp: string, files: string[]): number {
    return Math.max(...files.map(file => statSync(join(RUNS_DIR, file)).mtimeMs));
}

const filesByStamp = new Map<string, string[]>();
for (const name of readdirSync(RUNS_DIR)) {
    const match = name.match(STAMP_LOG_RE);
    if (match === null) continue;
    const stamp = match[1]!;
    filesByStamp.set(stamp, [...(filesByStamp.get(stamp) ?? []), name]);
}

const stamps: Stamp[] = [];
for (const [stamp, files] of filesByStamp) {
    const entries = mergedEntriesFor(stamp, files);
    const { classification, exitDiagram } = classify(entries);
    const { taskNumber, runId } = packetFields(stamp);
    stamps.push({ stamp, entries, mtimeMs: stampMtimeMs(stamp, files), taskNumber, runId, classification, exitDiagram });
}

const unknownRunIdStamps = stamps.filter(stamp => stamp.runId === null);
const groupsByRunId = new Map<string, Stamp[]>();
for (const stamp of stamps) {
    if (stamp.runId === null) continue;
    groupsByRunId.set(stamp.runId, [...(groupsByRunId.get(stamp.runId) ?? []), stamp]);
}

type ResolvedGroup = { runId: string; label: string; exitDiagram: string | null };
const resolvedGroups: ResolvedGroup[] = [];
const stillOpen: { runId: string; group: Stamp[] }[] = [];

for (const [runId, group] of groupsByRunId) {
    if (group.length === 1) {
        const stamp = group[0]!;
        if (stamp.classification === "open") stillOpen.push({ runId, group });
        else resolvedGroups.push({ runId, label: stamp.classification, exitDiagram: stamp.exitDiagram });
        continue;
    }
    const completedStamp = group.find(stamp => stamp.classification === "completed");
    if (completedStamp !== undefined) {
        resolvedGroups.push({ runId, label: "completed", exitDiagram: completedStamp.exitDiagram });
        continue;
    }
    const failureStamps = group.filter(stamp => stamp.classification === "operational failure");
    const openStamps = group.filter(stamp => stamp.classification === "open");
    const latestFailureMtime = Math.max(...failureStamps.map(stamp => stamp.mtimeMs));
    const laterOpenStamp = openStamps.find(stamp => stamp.mtimeMs > latestFailureMtime);
    if (failureStamps.length > 0 && laterOpenStamp !== undefined) {
        resolvedGroups.push({ runId, label: "later resumed", exitDiagram: null });
        continue;
    }
    if (openStamps.length > 0 && failureStamps.length === 0) {
        stillOpen.push({ runId, group });
        continue;
    }
    resolvedGroups.push({ runId, label: "operational failure", exitDiagram: null });
}

const tasks = readTaskFile(".taskTools/tasks.json") as TaskRecordWithRun[];
const completedTasks = readTaskFile(".taskTools/completedTasks.json") as TaskRecordWithRun[];

for (const { runId, group } of stillOpen) {
    const taskNumber = group.find(stamp => stamp.taskNumber !== null)?.taskNumber ?? null;
    const task = [...tasks, ...completedTasks].find(candidate => candidate.taskNumber === taskNumber);
    const historyEntry = task?.run?.history.find(entry => entry.runId === runId);
    if (task === undefined || historyEntry === undefined) {
        resolvedGroups.push({ runId, label: "unknown", exitDiagram: null });
    } else if (historyEntry.endedAt === null && task.run?.active === true && task.run?.leaseRunId === runId) {
        resolvedGroups.push({ runId, label: "in progress", exitDiagram: null });
    } else if (historyEntry.exitType === "completed") {
        resolvedGroups.push({ runId, label: "completed", exitDiagram: null });
    } else if (historyEntry.exitType !== null && FAILURE_EXIT_TYPES.has(historyEntry.exitType)) {
        resolvedGroups.push({ runId, label: "operational failure", exitDiagram: null });
    } else {
        resolvedGroups.push({ runId, label: String(historyEntry.exitType), exitDiagram: null });
    }
}

const bucketed = new Map<string, string[]>();
for (const { runId, label, exitDiagram } of resolvedGroups) {
    const key = label === "completed" && exitDiagram !== null ? `completed (${exitDiagram})` : label;
    bucketed.set(key, [...(bucketed.get(key) ?? []), runId]);
}
if (unknownRunIdStamps.length > 0) {
    bucketed.set("runId unknown", unknownRunIdStamps.map(stamp => stamp.stamp));
}

for (const [label, ids] of bucketed) {
    console.log(`${label}: ${ids.length} (${ids.join(", ")})`);
}
console.log(`total real runs: ${resolvedGroups.length + unknownRunIdStamps.length}`);
