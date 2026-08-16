// Walks the pipeline one decision box at a time, asking you the outcome of each, then prints the trace and a replay string. Nothing here touches a repository: it drives tracePipeline.ts only.
//
// Usage: node scripts/tackle-tasks/stepPipeline.ts <taskNumber> [--replay <sequence>] [--malformed <receipt>]
import { readSync } from "node:fs";
import { traceTaskPipeline, L, type AgentBoxName, type PipelineDecisions, type ReceiptName } from "../tracePipeline.ts";

// One keypress per decision, so a whole walk replays as a short string.
type Choice<T> = { key: string; value: T; shown: string };

const YES_NO: Choice<boolean>[] = [
    { key: "y", value: true, shown: "YES" },
    { key: "n", value: false, shown: "NO" },
];
const VERDICT: Choice<"accept" | "amend" | "scrap">[] = [
    { key: "a", value: "accept", shown: "ACCEPT" },
    { key: "m", value: "amend", shown: "AMEND" },
    { key: "s", value: "scrap", shown: "SCRAP" },
];
const REBASE: Choice<"ok" | "conflict">[] = [
    { key: "o", value: "ok", shown: "no conflicts" },
    { key: "c", value: "conflict", shown: "conflicts" },
];
const ADVANCE: Choice<"finished" | "conflicts">[] = [
    { key: "f", value: "finished", shown: "finished" },
    { key: "c", value: "conflicts", shown: "conflicts" },
];
// An agent box has exactly two outcomes: it hands back its receipt, or the harness loses it.
const AGENT_RESULT: Choice<boolean>[] = [
    { key: "r", value: true, shown: "receipt" },
    { key: "0", value: false, shown: "null" },
];

// The diagram box behind each decision field, so every prompt is worded by the diagram.
const BOOLEAN_NODES: Record<string, string> = {
    taskNumberValid: "IS_TASK_NUMBER_VALID",
    taskBlocked: "IS_TASK_BLOCKED",
    taskActive: "IS_TASK_ACTIVE",
    worktreeExists: "DOES_WORKTREE_EXIST",
    worktreeSafe: "IS_WORKTREE_SAFE_TO_USE",
    previousWorkResumable: "IS_PREVIOUS_RUN_RESUMABLE",
    fenceHeld: "DID_CHANGES_STAY_INSIDE_FENCE",
    taskTestsFail: "DO_TASK_TESTS_FAIL",
    codexTestsFlagged: "ARE_TESTS_FLAGGED",
    sourceRepoFree: "CAN_SOURCE_REPO_BE_LOCKED",
    lockSucceeds: "DID_LOCKING_SOURCE_REPO_SUCCEED",
    fullSuitePasses: "DO_ALL_TESTS_PASS",
    mergeLands: "DID_MERGE_LAND",
};
// The fields the tracer reads as a list, one entry per attempt, rather than once.
const LIST_FIELDS = new Set([
    "codexPlanVerdict", "taskTestsFail", "codexTestsFlagged", "sourceRepoFree",
    "lockSucceeds", "rebase", "rebaseAdvance", "fullSuitePasses", "mergeLands",
]);

// Reads one keypress without waiting for enter, so a walk feels like stepping, not typing.
function readKey(): string {
    const buffer = Buffer.alloc(1);
    if (!process.stdin.isTTY) {
        process.stderr.write("\nstepPipeline: no terminal to ask, and the replay sequence ran out\n");
        process.exit(1);
    }
    process.stdin.setRawMode(true);
    readSync(0, buffer, 0, 1, null);
    process.stdin.setRawMode(false);
    const key = buffer.toString("utf8");
    if (key === "") {
        process.stdout.write("\n");
        process.exit(130);
    }
    return key;
}

// Asks one decision box, or takes the next key from a replay sequence instead.
function makeAsk(replay: string[], recorded: string[]) {
    return <T,>(nodeId: string, choices: Choice<T>[]): T => {
        const menu = choices.map((choice) => `${choice.key}=${choice.shown}`).join("  ");
        for (;;) {
            const replayed = replay.shift();
            if (replayed === undefined) process.stdout.write(`${L(nodeId)}   [${menu}] `);
            const key = replayed ?? readKey();
            const chosen = choices.find((choice) => choice.key === key);
            if (chosen === undefined && replayed !== undefined) {
                process.stderr.write(`\nstepPipeline: replay key "${key}" is not one of ${menu} at "${L(nodeId)}"\n`);
                process.exit(1);
            }
            if (chosen === undefined) {
                process.stdout.write("\n");
                continue;
            }
            if (replayed === undefined) process.stdout.write(`${chosen.shown}\n`);
            recorded.push(chosen.key);
            return chosen.value;
        }
    };
}

type Ask = ReturnType<typeof makeAsk>;

// A list field the tracer indexes per attempt. Reporting an endless length makes every index a fresh question, so a loop's second pass is asked rather than repeating the first pass's answer.
function askedList<T>(ask: Ask, nodeId: string, choices: Choice<T>[]): T[] {
    // The tracer reads the same index more than once per attempt, so each index is asked once.
    const answered = new Map<string, T>();
    return new Proxy([] as T[], {
        get(target, property) {
            if (property === "length") return Infinity;
            if (typeof property !== "string" || !/^\d+$/.test(property)) return Reflect.get(target, property);
            if (!answered.has(property)) answered.set(property, ask(nodeId, choices));
            return answered.get(property);
        },
    });
}

// Every field traceTaskPipeline reads becomes a question the first time it is read.
function askedDecisions(taskNumber: number, malformedReceipt: ReceiptName | undefined, ask: Ask): PipelineDecisions {
    // The tracer reads a field more than once per box, so each field keeps the answer it was given.
    const answered = new Map<string, unknown>();
    const once = <T,>(property: string, produce: () => T): T => {
        if (!answered.has(property)) answered.set(property, produce());
        return answered.get(property) as T;
    };
    const agentBoxes = new Proxy({} as Record<AgentBoxName, boolean[]>, {
        get: (_target, box: string) => once(`agent:${box}`, () => askedList(ask, `DID_${box}_RETURN_A_RESULT`, AGENT_RESULT)),
    });
    return new Proxy({} as PipelineDecisions, {
        get(_target, property: string) {
            if (property === "taskNumber") return taskNumber;
            if (property === "malformedReceipt") return malformedReceipt;
            if (property === "agentReturnsResult") return agentBoxes;
            if (property === "codexPlanVerdict") return once(property, () => askedList(ask, "WHAT_IS_REVIEW_VERDICT", VERDICT));
            if (property === "rebase") return once(property, () => askedList(ask, "DID_REBASE_REPORT_CONFLICTS", REBASE));
            if (property === "rebaseAdvance") return once(property, () => askedList(ask, "IS_REBASE_FINISHED", ADVANCE));
            const node = BOOLEAN_NODES[property];
            if (node === undefined) return undefined;
            if (LIST_FIELDS.has(property)) return once(property, () => askedList(ask, node, YES_NO));
            return once(property, () => ask(node, YES_NO));
        },
    });
}

if (process.argv[1]?.endsWith("stepPipeline.ts")) {
    const commandArguments = process.argv.slice(2);
    const valueAfter = (flag: string): string | undefined => {
        const index = commandArguments.indexOf(flag);
        return index === -1 ? undefined : commandArguments[index + 1];
    };
    const taskNumber = Number(commandArguments[0]);
    if (!Number.isInteger(taskNumber)) {
        process.stderr.write("usage: node stepPipeline.ts <taskNumber> [--replay <sequence>] [--malformed <receipt>]\n");
        process.exit(1);
    }

    const replay = [...(valueAfter("--replay") ?? "")];
    const recorded: string[] = [];
    const malformed = valueAfter("--malformed") as ReceiptName | undefined;
    const trace = traceTaskPipeline(askedDecisions(taskNumber, malformed, makeAsk(replay, recorded)));

    process.stdout.write(`\n${trace.join("\n")}\n`);
    process.stdout.write(`\nuse sequence ${recorded.join("")} to replay\n`);
    process.exit(0);
}
