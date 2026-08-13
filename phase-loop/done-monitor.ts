import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

export type DoneMonitorOptions = {
    projectRoot: string;
    pollIntervalMs?: number;
    timeoutMs?: number | null;
};

export type DoneMonitorEvent = {
    event: "done";
    markerPath: string;
    contents: string;
};

export type CompleteMonitorEvent = {
    event: "complete";
    markerPath: string;
    contents: string;
};

export type AuditorMonitorEvent = DoneMonitorEvent | CompleteMonitorEvent;

const DEFAULT_POLL_INTERVAL_MS = 1_000;
const INDEX_RETRY_TIMEOUT_MS = 5_000;
const INDEX_RETRY_INTERVAL_MS = 50;
const INDEX_RETRY_WAIT = new Int32Array(new SharedArrayBuffer(4));

function sleep(milliseconds: number): Promise<void> {
    return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

function assertPositiveMilliseconds(value: number, label: string): void {
    if (!Number.isFinite(value) || value <= 0) {
        throw new Error(`${label} must be a positive number`);
    }
}

function repositoryRoot(projectRoot: string): string {
    const absoluteRoot = resolve(projectRoot);
    return execFileSync("git", ["-C", absoluteRoot, "rev-parse", "--show-toplevel"], {
        encoding: "utf8",
    }).trim();
}

/**
 * The marker is ready only when it is a newly staged root `.done` file. Restricting the check
 * to added files prevents a consumed marker's staged deletion from retriggering the monitor.
 */
export function isRootDoneMarkerStaged(projectRoot: string): boolean {
    const root = repositoryRoot(projectRoot);
    const stagedAdds = execFileSync(
        "git",
        ["-C", root, "diff", "--cached", "--diff-filter=A", "--name-only", "-z", "--", ".done"],
        { encoding: "utf8" },
    ).split("\0").filter(Boolean);
    return stagedAdds.includes(".done");
}

export function isRootCompleteMarkerPresent(projectRoot: string): boolean {
    return existsSync(join(repositoryRoot(projectRoot), ".complete"));
}

function refuseTrackedMarker(root: string, markerName: ".done" | ".complete"): void {
    const markerPath = join(root, markerName);
    try {
        execFileSync("git", ["-C", root, "cat-file", "-e", `HEAD:${markerName}`], { stdio: "ignore" });
        throw new Error(`refusing to consume tracked repository file as a marker: ${markerPath}`);
    } catch (error) {
        if (error instanceof Error && error.message.startsWith("refusing to consume")) throw error;
    }
}

/** Remove the transient marker from both the index and the working tree before firing. */
export function consumeRootDoneMarker(projectRoot: string): Omit<DoneMonitorEvent, "event"> {
    const root = repositoryRoot(projectRoot);
    const markerPath = join(root, ".done");
    if (!isRootDoneMarkerStaged(root)) {
        throw new Error(`the root marker is not staged for addition: ${markerPath}`);
    }

    // A marker is protocol state, never repository content. Refuse to reinterpret a tracked file
    // as the transient marker because consuming it would stage an unrelated deletion.
    refuseTrackedMarker(root, ".done");
    // `.done` is a staged publication, so report the exact bytes that triggered the monitor from
    // the index rather than a possibly modified working-tree copy.
    const contents = execFileSync("git", ["-C", root, "show", ":.done"], { encoding: "utf8" });

    // The producer may still be completing a larger `git add` when the marker becomes visible.
    // Retry index-lock contention, but never emit the event until the marker is actually unstaged.
    const deadline = Date.now() + INDEX_RETRY_TIMEOUT_MS;
    let lastError: unknown = null;
    while (isRootDoneMarkerStaged(root)) {
        try {
            execFileSync("git", ["-C", root, "restore", "--staged", "--", ".done"], {
                encoding: "utf8",
                stdio: ["ignore", "pipe", "pipe"],
            });
        } catch (error) {
            lastError = error;
            if (Date.now() >= deadline) {
                const detail = error instanceof Error ? error.message : String(error);
                throw new Error(`could not unstage ${markerPath} after waiting for the index: ${detail}`);
            }
            Atomics.wait(INDEX_RETRY_WAIT, 0, 0, INDEX_RETRY_INTERVAL_MS);
        }
    }
    if (lastError !== null && isRootDoneMarkerStaged(root)) throw lastError;
    if (existsSync(markerPath)) unlinkSync(markerPath);
    return { markerPath, contents };
}


/** Consume the implementor's terminal acknowledgement before ending the auditor loop. */
export function consumeRootCompleteMarker(projectRoot: string): Omit<CompleteMonitorEvent, "event"> {
    const root = repositoryRoot(projectRoot);
    const markerPath = join(root, ".complete");
    if (!existsSync(markerPath)) {
        throw new Error(`the root completion marker does not exist: ${markerPath}`);
    }
    refuseTrackedMarker(root, ".complete");
    const contents = readFileSync(markerPath, "utf8");
    unlinkSync(markerPath);
    return { markerPath, contents };
}

export async function waitForStagedDone(options: DoneMonitorOptions): Promise<DoneMonitorEvent> {
    const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const timeoutMs = options.timeoutMs ?? null;
    assertPositiveMilliseconds(pollIntervalMs, "pollIntervalMs");
    if (timeoutMs !== null) assertPositiveMilliseconds(timeoutMs, "timeoutMs");

    const root = repositoryRoot(options.projectRoot);
    const deadline = timeoutMs === null ? null : Date.now() + timeoutMs;
    while (true) {
        if (isRootDoneMarkerStaged(root)) {
            return { event: "done", ...consumeRootDoneMarker(root) };
        }
        if (deadline !== null && Date.now() >= deadline) {
            throw new Error(`timed out waiting for a staged root .done marker in ${root}`);
        }
        await sleep(pollIntervalMs);
    }
}

/** Wait for the next implementor handoff: a staged attempt or the terminal acknowledgement. */
export async function waitForAuditorSignal(options: DoneMonitorOptions): Promise<AuditorMonitorEvent> {
    const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const timeoutMs = options.timeoutMs ?? null;
    assertPositiveMilliseconds(pollIntervalMs, "pollIntervalMs");
    if (timeoutMs !== null) assertPositiveMilliseconds(timeoutMs, "timeoutMs");

    const root = repositoryRoot(options.projectRoot);
    const deadline = timeoutMs === null ? null : Date.now() + timeoutMs;
    while (true) {
        const hasDone = isRootDoneMarkerStaged(root);
        const hasComplete = isRootCompleteMarkerPresent(root);
        if (hasDone && hasComplete) {
            throw new Error(`conflicting root protocol markers: ${join(root, ".done")} and ${join(root, ".complete")}`);
        }
        if (hasComplete) {
            return { event: "complete", ...consumeRootCompleteMarker(root) };
        }
        if (hasDone) {
            return { event: "done", ...consumeRootDoneMarker(root) };
        }
        if (deadline !== null && Date.now() >= deadline) {
            throw new Error(`timed out waiting for staged .done or root .complete in ${root}`);
        }
        await sleep(pollIntervalMs);
    }
}

type CliOptions = DoneMonitorOptions;

function parseCliOptions(args: string[]): CliOptions {
    let projectRoot = process.cwd();
    let pollIntervalMs = DEFAULT_POLL_INTERVAL_MS;
    let timeoutMs: number | null = null;
    for (let index = 0; index < args.length; index += 1) {
        const argument = args[index];
        const value = args[index + 1];
        if (argument === "--root" && value !== undefined) {
            projectRoot = isAbsolute(value) ? value : resolve(process.cwd(), value);
            index += 1;
        } else if (argument === "--poll-ms" && value !== undefined) {
            pollIntervalMs = Number(value);
            index += 1;
        } else if (argument === "--timeout-ms" && value !== undefined) {
            timeoutMs = Number(value);
            index += 1;
        } else {
            throw new Error(`unknown or incomplete argument: ${argument}`);
        }
    }
    return { projectRoot, pollIntervalMs, timeoutMs };
}

if (process.argv[1]?.endsWith("done-monitor.ts")) {
    waitForAuditorSignal(parseCliOptions(process.argv.slice(2)))
        .then((event) => process.stdout.write(`${JSON.stringify(event)}\n`))
        .catch((error) => {
            process.stderr.write(`done-monitor: ${error instanceof Error ? error.message : String(error)}\n`);
            process.exitCode = 1;
        });
}
