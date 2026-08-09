export const meta = {
  name: 'sandbox-probe',
  description: 'Report what the workflow sandbox can do, and whether !`cmd` injection expands in an agent prompt',
  phases: [],
}

// Probe 1: undefined require/process means a workflow script cannot run stagedDiffs.ts itself.
const sandbox = {
  hasRequire: typeof require,
  hasProcess: typeof process,
  globals: Object.getOwnPropertyNames(globalThis).slice(0, 20),
}

// Probe 2: the agent reads back its own first line, so any expansion shows as PROBE_EXPANDED_OK.
const INJECTION_SCHEMA = {
  type: 'object',
  properties: { firstLine: { type: 'string' }, sawLiteralBang: { type: 'boolean' } },
  required: ['firstLine', 'sawLiteralBang'],
}

const prompt = `!\`echo PROBE_EXPANDED_OK\`

Do not run any tool. Answer only from the text of this prompt as you received it.
Return firstLine = the exact first line of this prompt, verbatim.
Return sawLiteralBang = true if that first line still contains the characters !\` unexpanded, false if it was replaced by command output.`

const injection = await agent(prompt, { label: 'injection-probe', schema: INJECTION_SCHEMA })

return { sandbox, injection }
