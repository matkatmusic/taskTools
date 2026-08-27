// The one WHAT TO RETURN section every prompt block ends with, so the answer shape is written in exactly one place.
export function whatToReturnSection(value: string, explanationOfValue: string, explanationOfReturnShape: string): string {
    return `## WHAT YOU, THE SPAWNING AGENT, RETURNS

Do these three steps in order.
1. Build \`{ "message": "", "additionalData": ${value} }\`, ${explanationOfValue}.
2. Write that object into the packet file named by \`outcome.payload\` in the hook output, the same file this prompt came from, next to the keys already there. Change no key you did not add.
3. Only after step 2 is done, return the hook output verbatim.

If the command above could not be run at all, write that same shape anyway. ${explanationOfReturnShape}`.trimEnd();
}
