// PREFLIGHT_OK_Q, from pipeline-preambleStatusCheck.mmd. "is the environment ok to run in?"
import { existsSync, readFileSync, realpathSync, statfsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../shared/contracts.ts";
import { spawnSync } from "node:child_process";
import { modifiableFiles, readStagingTip } from "../../shared/prepareTasks.ts";
import { readTaskFile, resolveTaskFiles } from "../../shared/taskFiles.ts";
import type { EntryPacket } from "./_packet.ts";

const MINIMUM_FREE_BYTES = 5 * 1024 * 1024 * 1024;

export function checkDiskSpace(projectRoot: string): string | null {
    const stats = statfsSync(projectRoot);
    const freeBytes = stats.bavail * stats.bsize;
    if (freeBytes >= MINIMUM_FREE_BYTES) return null;
    const freeGb = (freeBytes / (1024 * 1024 * 1024)).toFixed(2);
    return `only ${freeGb} GB free at "${projectRoot}"; the pipeline requires at least 5 GB free`;
}

function readJsonIfExists(path: string): Record<string, unknown> | null {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

export function checkPlanModeDefault(projectRoot: string): string | null {
    const candidatePaths = [
        join(projectRoot, ".claude", "settings.json"),
        join(projectRoot, ".claude", "settings.local.json"),
        join(homedir(), ".claude", "settings.json"),
    ];
    for (const path of candidatePaths) {
        const settings = readJsonIfExists(path);
        if (settings === null) continue;
        const permissions = settings.permissions as Record<string, unknown> | undefined;
        if (permissions?.defaultMode === "plan") return `"${path}" sets permissions.defaultMode to "plan"`;
    }
    return null;
}

type HookGroup = { matcher?: string; hooks: Array<{ command?: string }> };
type HooksField = { hooks?: Record<string, HookGroup[]> };

function extractScriptName(command: string | undefined): string | null {
    const match = command?.match(/([^\s"]+\.(?:ts|js))/);
    return match ? basename(match[1]!) : null;
}

export function checkDuplicateHookRegistration(projectRoot: string): string | null {
    const files = [join(projectRoot, "hooks", "hooks.json"), join(projectRoot, ".claude", "settings.json")];
    const scriptNamesByGroupKey = new Map<string, string[]>();
    for (const file of files) {
        const parsed = readJsonIfExists(file) as HooksField | null;
        if (parsed === null) continue;
        for (const [event, groups] of Object.entries(parsed.hooks ?? {})) {
            for (const group of groups) {
                const groupKey = `${event}::${group.matcher ?? ""}`;
                const scriptNames = scriptNamesByGroupKey.get(groupKey) ?? [];
                for (const hookEntry of group.hooks) {
                    const scriptName = extractScriptName(hookEntry.command);
                    if (scriptName !== null) scriptNames.push(scriptName);
                }
                scriptNamesByGroupKey.set(groupKey, scriptNames);
            }
        }
    }
    for (const [groupKey, scriptNames] of scriptNamesByGroupKey) {
        const [event = "", matcher = ""] = groupKey.split("::");
        const duplicate = scriptNames.find((name, index) => scriptNames.indexOf(name) !== index);
        if (duplicate !== undefined) return `"${duplicate}" is registered more than once for event "${event}" matcher "${matcher}"`;
    }
    return null;
}

export function checkScriptPathsInsideRoot(projectRoot: string): string | null {
    const stepsConfigPath = join(projectRoot, "scripts", "tackle-tasks", "diagram-steps.json");
    const config = readJsonIfExists(stepsConfigPath) as Record<string, Array<{ script: string }>> | null;
    if (config === null) return null;
    const scriptsRoot = resolve(projectRoot, "scripts");
    for (const entries of Object.values(config)) {
        for (const entry of entries) {
            const resolvedScript = resolve(projectRoot, entry.script);
            const relativeToRoot = relative(scriptsRoot, resolvedScript);
            if (relativeToRoot.startsWith("..") || isAbsolute(relativeToRoot)) {
                return `"${entry.script}" resolves outside "${scriptsRoot}"`;
            }
        }
    }
    return null;
}

const CHECKS = [checkDiskSpace, checkPlanModeDefault, checkDuplicateHookRegistration, checkScriptPathsInsideRoot];

export function main(input: string): EntryPacket & { next: string } {
    const { next: _next, ...packet } = JSON.parse(input) as EntryPacket & { next?: string };
    for (const check of CHECKS) {
        const failure = check(packet.projectRoot);
        if (failure !== null) {
            return {
                ...packet,
                box: "PREFLIGHT_OK_Q",
                scriptSignal: SCRIPT_SIGNAL.CONTINUE,
                exitType: "preflight-failed",
                exitNote: failure,
                next: "pipeline-reportOnlyExit.mmd::REPORT_ONLY_EXIT",
            };
        }
    }
    // The worktree is cut from staging, or from HEAD when staging does not exist yet; check that same tree.
    const task = readTaskFile(resolveTaskFiles(packet.projectRoot).tasksPath).find((entry) => entry.taskNumber === packet.taskNumber);
    if (task === undefined) throw new Error(`task ${packet.taskNumber} not found in tasks.json`);
    const createsFiles: string[] = Array.isArray((task as any).createsFiles) ? (task as any).createsFiles : [];
    const baseTree = readStagingTip(packet.projectRoot) ?? "HEAD";
    const missingFiles = modifiableFiles(task).filter((file) =>
        !createsFiles.includes(file)
        && spawnSync("git", ["-C", packet.projectRoot, "cat-file", "-e", `${baseTree}:${file}`], { stdio: "ignore" }).status !== 0,
    );
    if (missingFiles.length > 0) {
        return {
            ...packet,
            box: "PREFLIGHT_OK_Q",
            scriptSignal: SCRIPT_SIGNAL.CONTINUE,
            exitType: "preflight-failed",
            exitNote: `task ${packet.taskNumber}: modifiableFiles names ${missingFiles.join(", ")} but ${missingFiles.length === 1 ? "that file is" : "those files are"} not in the tree the worktree is cut from (${baseTree}); list each in "createsFiles" if this task creates it, or run the task that creates it first`,
            next: "pipeline-reportOnlyExit.mmd::REPORT_ONLY_EXIT",
        };
    }
    return { ...packet, box: "PREFLIGHT_OK_Q", scriptSignal: SCRIPT_SIGNAL.CONTINUE, next: "MARK_TASK_ACTIVE" };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
