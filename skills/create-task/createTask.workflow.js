export const meta = {
    name: 'create-task-research',
    description: 'Find the files a new task touches and the open tasks that block it',
    phases: [{ title: 'Research', detail: 'file-hunter and blocker-hunter run in parallel' }],
}

const ARGS = typeof args === 'string' ? JSON.parse(args) : args

const FILE_HUNTER_SCHEMA = {
    type: 'object',
    properties: {
        files: { type: 'array', items: { type: 'string' } },
        description: { type: 'string' },
        difficulty: { type: 'number' },
    },
    required: ['files', 'description', 'difficulty'],
}

const BLOCKER_HUNTER_SCHEMA = {
    type: 'object',
    properties: {
        blockedBy: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    taskNumber: { type: 'number' },
                    reason: { type: 'string' },
                },
                required: ['taskNumber', 'reason'],
            },
        },
    },
    required: ['blockedBy'],
}

// !`cmd` does not expand inside a workflow agent prompt, so the description is interpolated here instead.
const buildPrompt = (mode) => `Run this with Bash:

node ${ARGS.agentPromptEmitterPath} ${mode} <<'CREATETASKEOF'
${ARGS.taskDescription}
CREATETASKEOF

Follow the printed instructions.`

// ponytail: one fallback attempt (Sonnet then Opus), copied from commitMessage.workflow.js
const runAgent = (label, mode, schema, model) =>
    agent(buildPrompt(mode), { label, phase: 'Research', schema, model })

const runWithFallback = async (label, mode, schema) => {
    let result
    try {
        result = await runAgent(label, mode, schema, 'claude-sonnet-5[1m]')
    } catch {
        result = undefined
    }
    if (result == null) result = await runAgent(label, mode, schema, 'claude-opus-5[1m]')
    return result
}

const [fileFindings, blockerFindings] = await parallel([
    () => runWithFallback('file-hunter', 'files', FILE_HUNTER_SCHEMA),
    () => runWithFallback('blocker-hunter', 'blockers', BLOCKER_HUNTER_SCHEMA),
])

return {
    files: fileFindings?.files ?? [],
    description: fileFindings?.description ?? '',
    difficulty: fileFindings?.difficulty ?? 5,
    blockedBy: blockerFindings?.blockedBy ?? [],
}
