type Input = {
    command: string;
};

const commands = {
    "/run-step": runStep,
};

function runStep(input: Input) {
    return {};
}

function agent(input: Input) {
    const fn = commands[input.command];
    return fn(input);
}

function main() {
    let input: Input = { command: "/run-step" };
    while (true) {
        const result = agent(input);
        //handle errors
        input = result.output;
    }
}

main();
