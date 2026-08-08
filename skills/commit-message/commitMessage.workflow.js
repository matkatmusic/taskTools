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

const { execFileSync } = await import('node:child_process')
const diffs = execFileSync('node', [ARGS.stagedDiffsPath], { encoding: 'utf8' })

const prompt = `Staged diff, one section per affected repo (the current repo plus any submodule whose pointer moved):

${diffs}
Generate, per affected repo, a short (40 words or less) single-sentence summary of the work done in that repo, so the user can use each summary as that repo's commit message.
A parent repo whose only change is a submodule pointer counts as an affected repo — its message should name the submodule being updated and why.

Return {summaries}: one {repo, message} per affected repo.`

// ponytail: one fallback attempt (Sonnet then Opus), not plan.workflow.js's 3x retry-on-null loop
const runAgent = (model) => agent(prompt, { label: 'commit-message', phase: 'Commit message', schema: SUMMARY_SCHEMA, model })

let result
try {
  result = await runAgent('Sonnet 5')
} catch {
  result = undefined
}
if (result == null) result = await runAgent('Opus 5')

return result ?? { summaries: [] }
