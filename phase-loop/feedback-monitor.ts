import { readdirSync, statSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";

export type FeedbackMonitorOptions = {
    projectRoot: string;
    pollIntervalMs?: number;
    timeoutMs?: number | null;
    includeExisting?: boolean;
};

export type FeedbackMonitorEvent = {
    event: "feedback";
    feedbackPath: string;
    relativePath: string;
    phase: number;
    iteration: number;
};

const DEFAULT_POLL_INTERVAL_MS = 1_000;
const FEEDBACK_FILE_PATTERN = /^feedback-phase(\d+)-(\d+)\.md$/;
const SKIPPED_DIRECTORIES = new Set([".git", "node_modules"]);

function sleep(milliseconds: number): Promise<void> {
    return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

function assertPositiveMilliseconds(value: number, label: string): void {
    if (!Number.isFinite(value) || value <= 0) {
        throw new Error(`${label} must be a positive number`);
    }
}

/** Find matching feedback files anywhere below the repository root, excluding repository metadata. */
export function findFeedbackFiles(projectRoot: string): string[] {
    const root = resolve(projectRoot);
    const matches: string[] = [];
    const pending = [root];
    while (pending.length > 0) {
        const directory = pending.pop()!;
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
            if (entry.isDirectory()) {
                if (!SKIPPED_DIRECTORIES.has(entry.name)) pending.push(join(directory, entry.name));
                continue;
            }
            if (entry.isFile() && FEEDBACK_FILE_PATTERN.test(entry.name)) {
                matches.push(join(directory, entry.name));
            }
        }
    }
    return matches.sort();
}

function buildFeedbackEvent(projectRoot: string, feedbackPath: string): FeedbackMonitorEvent {
    const match = FEEDBACK_FILE_PATTERN.exec(basename(feedbackPath));
    if (match === null) throw new Error(`not a feedback-phaseN-M.md file: ${feedbackPath}`);
    return {
        event: "feedback",
        feedbackPath,
        relativePath: relative(resolve(projectRoot), feedbackPath),
        phase: Number(match[1]),
        iteration: Number(match[2]),
    };
}

/**
 * Wait for one newly generated feedback file, emit its identity, and exit. By default files that
 * existed when monitoring began are the baseline and do not fire. `includeExisting` supports an
 * orchestrator restart that deliberately wants to consume an already-created feedback file.
 */
export async function waitForFeedback(options: FeedbackMonitorOptions): Promise<FeedbackMonitorEvent> {
    const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const timeoutMs = options.timeoutMs ?? null;
    assertPositiveMilliseconds(pollIntervalMs, "pollIntervalMs");
    if (timeoutMs !== null) assertPositiveMilliseconds(timeoutMs, "timeoutMs");

    const root = resolve(options.projectRoot);
    const initialFiles = findFeedbackFiles(root);
    if (options.includeExisting && initialFiles.length > 0) {
        const newest = initialFiles
            .map((path) => ({ path, modifiedAt: statSync(path).mtimeMs }))
            .sort((left, right) => right.modifiedAt - left.modifiedAt || left.path.localeCompare(right.path))[0];
        return buildFeedbackEvent(root, newest.path);
    }

    const baseline = new Set(initialFiles);
    const deadline = timeoutMs === null ? null : Date.now() + timeoutMs;
    while (true) {
        const generated = findFeedbackFiles(root).find((path) => !baseline.has(path));
        if (generated !== undefined) return buildFeedbackEvent(root, generated);
        if (deadline !== null && Date.now() >= deadline) {
            throw new Error(`timed out waiting for feedback-phaseN-M.md below ${root}`);
        }
        await sleep(pollIntervalMs);
    }
}

type CliOptions = FeedbackMonitorOptions;

function parseCliOptions(args: string[]): CliOptions {
    let projectRoot = process.cwd();
    let pollIntervalMs = DEFAULT_POLL_INTERVAL_MS;
    let timeoutMs: number | null = null;
    let includeExisting = false;
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
        } else if (argument === "--include-existing") {
            includeExisting = true;
        } else {
            throw new Error(`unknown or incomplete argument: ${argument}`);
        }
    }
    return { projectRoot, pollIntervalMs, timeoutMs, includeExisting };
}

if (process.argv[1]?.endsWith("feedback-monitor.ts")) {
    waitForFeedback(parseCliOptions(process.argv.slice(2)))
        .then((event) => process.stdout.write(`${JSON.stringify(event)}\n`))
        .catch((error) => {
            process.stderr.write(`feedback-monitor: ${error instanceof Error ? error.message : String(error)}\n`);
            process.exitCode = 1;
        });
}

