export const meta = {
  name: 'tackle-tasks-bootstrap',
  description: 'Run tackle-tasks blocker/task-detail discovery in an isolated agent, returning only structured results',
  phases: [{ title: 'Bootstrap', detail: 'checkBlockers / getTaskDetails / prepareTasks via the bootstrap agent prompt emitter' }],
}

const DISCOVER_SCHEMA = {
  type: 'object',
  properties: {
    blockerPairs: {
      type: 'array',
      items: {
        type: 'object',
        properties: { blockedTask: { type: 'number' }, blockerTask: { type: 'number' }, reason: { type: 'string' } },
        required: ['blockedTask', 'blockerTask', 'reason'],
      },
    },
    unblockedNumbers: { type: 'array', items: { type: 'number' } },
  },
  required: ['blockerPairs', 'unblockedNumbers'],
}

const PREPARE_SCHEMA = {
  type: 'object',
  properties: {
    taskDetails: { type: 'array' },
    pipelineArgs: { type: 'object' },
    maxConcurrency: { type: 'number' },
  },
  required: ['taskDetails', 'pipelineArgs', 'maxConcurrency'],
}

const ARGS = typeof args === 'string' ? JSON.parse(args) : args
const MODE = ARGS.mode
const ARGS_VALUE = ARGS.argsValue
const EMITTER_PATH = ARGS.bootstrapAgentPromptEmitterPath

if (MODE !== 'discover' && MODE !== 'prepare') throw new Error(`tackle-tasks-bootstrap: unknown mode "${MODE}"`)

const schema = MODE === 'discover' ? DISCOVER_SCHEMA : PREPARE_SCHEMA

log(`bootstrap: running ${MODE}`)

// ponytail: null/undefined means the harness returned no result; re-spawn. Duplicated per file (see blockers.workflow.js).
const retryAgent = async (spawn, attempts = 3) => {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const result = await spawn()
    if (result !== null && result !== undefined) return result
  }
  return null
}

const result = await retryAgent(() => agent(
  `Run \`node "${EMITTER_PATH}" ${MODE} <<'BOOTSTRAP_PAYLOAD'\n${ARGS_VALUE}\nBOOTSTRAP_PAYLOAD\` with Bash. Return exactly the JSON it prints, with no other keys added or removed.`,
  { label: `bootstrap:${MODE}`, schema },
))

if (result === null) throw new Error(`tackle-tasks-bootstrap: ${MODE} agent returned no result after 3 attempts`)

return result
