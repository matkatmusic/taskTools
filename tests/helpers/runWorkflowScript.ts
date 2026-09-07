// Mimics the harness: async body, free arg names, same export-to-const rewrite as tackleTasksRetry.test.ts; no top-level export in sandbox.
export function runWorkflowScript(script: string, args: Record<string, unknown>, agentResults: unknown[]): Promise<Record<string, unknown>> {
    let call = 0;
    // An entry can be a canned result, or a function that records (prompt, options) and returns one.
    const agent = (prompt: string, options: unknown) => {
        const result = agentResults[call++];
        return Promise.resolve(typeof result === "function" ? result(prompt, options) : result);
    };
    const phase = () => {};
    const body = script.replace("export const meta", "const meta");
    return new Function("args", "agent", "phase", `return (async () => {\n${body}\n})()`)(args, agent, phase);
}
