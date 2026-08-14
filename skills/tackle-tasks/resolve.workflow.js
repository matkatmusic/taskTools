export const meta = {
  name: 'tackle-tasks-resolve',
  description: 'Parse the tackle-tasks arguments into task numbers and one run identity, in an isolated agent',
  phases: [{ title: 'Resolve', detail: 'resolveTaskRun.ts on quoted-heredoc stdin' }],
}

const RESOLVE_SCHEMA = {
  type: 'object',
  properties: {
    taskNumbers: { type: 'array', items: { type: 'number' } },
    projectRoot: { type: 'string' },
    sourceBranch: { type: 'string' },
    runId: { type: 'string' },
  },
  required: ['taskNumbers', 'projectRoot', 'sourceBranch', 'runId'],
}

const ARGS = typeof args === 'string' ? JSON.parse(args) : args
const ARGS_VALUE = ARGS.argsValue
const SCRIPTS_DIR = ARGS.scriptsDir

if (!ARGS_VALUE) throw new Error('tackle-tasks-resolve: args.argsValue is required')
if (!SCRIPTS_DIR) throw new Error('tackle-tasks-resolve: args.scriptsDir is required')

// The script names itself only here, on the agent side of the boundary. It normalizes the
// agent's working directory to the repository top level and returns that as projectRoot.
const RESOLVE_SCRIPT_PATH = `${SCRIPTS_DIR}/resolveTaskRun.ts`
const payload = JSON.stringify({ args: ARGS_VALUE })

// ponytail: null/undefined means the harness returned no result; the script is read-only, so re-spawn.
const retryAgent = async (spawn, attempts = 3) => {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const result = await spawn()
    if (result !== null && result !== undefined) return result
  }
  return null
}

const result = await retryAgent(() => agent(
  `Run \`node "${RESOLVE_SCRIPT_PATH}" <<'RESOLVE_PAYLOAD'\n${payload}\nRESOLVE_PAYLOAD\` with Bash. Return exactly the JSON it prints, with no other keys added or removed.`,
  { label: 'resolve', phase: 'Resolve', schema: RESOLVE_SCHEMA },
))

if (result === null) throw new Error('tackle-tasks-resolve: the resolver agent returned no result after 3 attempts')

return result
