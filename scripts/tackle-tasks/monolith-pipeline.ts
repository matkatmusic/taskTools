import { readFileSync } from "node:fs";

type Task = {
    taskNumber: number;
    blockedBy?: { taskNum: number }[];
    run?: { active: boolean };
};

type Input = {
    command: "/run-step";
    block: string;
    tasks: Task[];
    task: Task | undefined;
};

type Packet = {
    next: string;
    tasks: Task[];
    task: Task | undefined;
};

function IS_TASK_NUMBER_VALID(input: Input): Packet {
    const next = input.task === undefined ? "REPORT_ONLY_EXIT" : "IS_TASK_BLOCKED";
    return { next, tasks: input.tasks, task: input.task };
}

function IS_TASK_BLOCKED(input: Input): Packet {
    const blockers = input.task!.blockedBy ?? [];
    const blocked = blockers.some((b) => input.tasks.some((t) => t.taskNumber === b.taskNum));
    const next = blocked ? "REPORT_ONLY_EXIT" : "IS_TASK_ACTIVE";
    return { next, tasks: input.tasks, task: input.task };
}

function IS_TASK_ACTIVE(input: Input): Packet {
    const active = input.task!.run?.active === true;
    const next = active ? "REPORT_ONLY_EXIT" : "MARK_TASK_ACTIVE";
    return { next, tasks: input.tasks, task: input.task };
}

const blocks: Record<string, (input: Input) => Packet> = {
    IS_TASK_NUMBER_VALID,
    IS_TASK_BLOCKED,
    IS_TASK_ACTIVE,
};

function runStep(input: Input) {
    const packet = blocks[input.block](input);
    return { output: { command: "/run-step", block: packet.next, tasks: packet.tasks, task: packet.task } as Input };
}

const commands = {
    "/run-step": runStep,
};

function agent(input: Input) {
    const fn = commands[input.command];
    return fn(input);
}

function main(taskNumber: number, tasksJsonPath: string) {
    const tasks = JSON.parse(readFileSync(tasksJsonPath, "utf8")) as Task[];
    const task = tasks.find((t) => t.taskNumber === taskNumber);
    let input: Input = { command: "/run-step", block: "IS_TASK_NUMBER_VALID", tasks, task };
    while (true) {
        const result = agent(input);
        //handle errors
        input = result.output;
    }
}

main(Number(process.argv[2]), process.argv[3]);
