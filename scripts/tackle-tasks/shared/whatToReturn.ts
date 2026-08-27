// The one WHAT TO RETURN section every prompt block ends with, so the answer shape is written in exactly one place.
export function whatToReturnSection(value: string, explanationOfValue: string, explanationOfReturnShape: string): string {
    return `## WHAT YOU, THE SPAWNING AGENT, RETURNS

Return \`{ "message": "", "additionalData": ${value} }\`, ${explanationOfValue}.

If the command above could not be run at all, return that same shape anyway. ${explanationOfReturnShape}`.trimEnd();
}
