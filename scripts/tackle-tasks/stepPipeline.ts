// Walks the pipeline one decision at a time, then prints the trace and a replay string.
import { readSync } from "node:fs";
import { traceTaskPipeline, L, type AgentBoxName, type PipelineDecisions } from "../tracePipeline.ts";

// One keypress per decision, so a whole walk replays as a short string.
type Choice<T> = { key: string; value: T; shown: string };

const YES_NO: Choice<boolean>[] = [
    { key: "y", value: true, shown: "YES" },
    { key: "n", value: false, shown: "NO" },
];
const PLANNER_OUTCOME: Choice<"PLAN" | "CLARIFY" | "ERROR">[] = [
    { key: "p", value: "PLAN", shown: "PLAN" },
    { key: "c", value: "CLARIFY", shown: "CLARIFY" },
    { key: "e", value: "ERROR", shown: "ERROR" },
];
const VERDICT: Choice<"ACCEPT" | "AMEND" | "SCRAP">[] = [
    { key: "a", value: "ACCEPT", shown: "ACCEPT" },
    { key: "m", value: "AMEND", shown: "AMEND" },
    { key: "s", value: "SCRAP", shown: "SCRAP" },
];
const PUBLICATION_STATE: Choice<"ALL LANDED" | "NONE LANDED" | "SOME LANDED">[] = [
    { key: "a", value: "ALL LANDED", shown: "ALL LANDED" },
    { key: "n", value: "NONE LANDED", shown: "NONE LANDED" },
    { key: "s", value: "SOME LANDED", shown: "SOME LANDED" },
];

// The diagram box behind each boolean decision field, so every prompt is worded by the diagram.
const BOOLEAN_NODES: Record<string, string> = {
    taskTestsPass: "DO_TASK_TESTS_PASS",
    testsFlagged: "ARE_TESTS_FLAGGED",
    lockAcquired: "WAS_LOCK_ACQUIRED",
    rebaseConflicts: "DID_REBASE_REPORT_CONFLICTS",
    rebaseFinished: "IS_REBASE_FINISHED",
    suitePasses: "DO_ALL_TESTS_PASS",
    fenceHeld: "DID_CHANGES_STAY_INSIDE_FENCE",
};
// The boolean fields the tracer reads as a list, one entry per attempt, rather than once.
const LIST_FIELDS = new Set(["taskTestsPass", "testsFlagged", "lockAcquired", "rebaseConflicts", "rebaseFinished", "suitePasses"]);

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
    if (key === "") {
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
function askedDecisions(taskNumber: number, ask: Ask): PipelineDecisions {
    // The tracer reads a field more than once per box, so each field keeps the answer it was given.
    const answered = new Map<string, unknown>();
    const once = <T,>(property: string, produce: () => T): T => {
        if (!answered.has(property)) answered.set(property, produce());
        return answered.get(property) as T;
    };
    const agentErrors = new Proxy({} as Record<AgentBoxName, boolean[]>, {
        get: (_target, box: string) => once(`agent:${box}`, () => askedList(ask, "AGENT_ERRORED", YES_NO)),
    });
    return new Proxy({} as PipelineDecisions, {
        get(_target, property: string) {
            if (property === "taskNumber") return taskNumber;
            if (property === "agentErrors") return agentErrors;
            if (property === "plannerOutcome") return once(property, () => askedList(ask, "WHAT_DID_THE_PLANNER_RETURN", PLANNER_OUTCOME));
            if (property === "planVerdict") return once(property, () => askedList(ask, "WHAT_IS_REVIEW_VERDICT", VERDICT));
            if (property === "publicationState") return once(property, () => askedList(ask, "WHAT_IS_PUBLICATION_STATE", PUBLICATION_STATE));
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
        process.stderr.write("usage: node stepPipeline.ts <taskNumber> [--replay <sequence>]\n");
        process.exit(1);
    }

    const replay = [...(valueAfter("--replay") ?? "")];
    const recorded: string[] = [];
    const trace = traceTaskPipeline(askedDecisions(taskNumber, makeAsk(replay, recorded)));

    process.stdout.write(`\n${trace.join("\n")}\n`);
    process.stdout.write(`\nuse sequence ${recorded.join("")} to replay\n`);
    process.exit(0);
}
