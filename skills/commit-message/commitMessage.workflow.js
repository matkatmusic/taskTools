export const meta = {
  name: 'commit-message-summarize',
  description: 'Summarize the staged diff into one commit message per affected repo',
  phases: [{ title: 'Commit message', detail: 'one subagent summarizes the staged diff per repo' }],
}

const ARGS = typeof args === 'string' ? JSON.parse(args) : args

const SUMMARY_SCHEMA = {
  type: 'object',
  properties: {
    summaries: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          repo: { type: 'string' },
          message: { type: 'string' },
        },
        required: ['repo', 'message'],
      },
    },
  },
  required: ['summaries'],
}

const prompt = `Run \`node ${ARGS.commitDiffBriefPath}\` with Bash and follow the instructions it prints.`

// ponytail: one fallback attempt (Sonnet then Opus), not the retired plan workflow's 3x retry-on-null loop
const runAgent = (model) => agent(prompt, { label: 'commit-message', phase: 'Commit message', schema: SUMMARY_SCHEMA, model })

let result
try {
  result = await runAgent('Sonnet 5')
} catch {
  result = undefined
}
if (result == null) result = await runAgent('Opus 5')

return result ?? { summaries: [] }
