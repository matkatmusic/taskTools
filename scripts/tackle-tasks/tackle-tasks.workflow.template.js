export const meta = {
  name: 'tackle-task',
  description: 'Drive one active task from planning to merge, per plans/diagram/pipeline-*.mmd',
  phases: [
    { title: 'Plan', detail: 'write the plan, review it, replan or clarify' },
    { title: 'Implement', detail: 'implement, commit, run the task tests, review them' },
    { title: 'Rebase and merge', detail: 'lock the source repo, rebase, run the full suite, merge' },
    { title: 'Exit', detail: 'record the outcome, release what is held, report' },
  ],
}

/*
  meta comes first: the harness reads it as a pure literal.
*/

/*
  Drives paragraphs 18 to 97 of plans/tackle-tasks-v1_5-prompt.md.
*/

/*
  Paragraphs 1 to 17 already ran in PreambleDataEmitter.ts:runPreamble, at skill-invocation time.
*/

/*
  So this file starts from an active task, an initialized worktree, and a written brief.
*/

/*
  WIRED: the 6 [S] paragraphs 23, 30, 36, 45, 58, 63, as real agent() calls.
*/

/*
  NOT WIRED: the 90 [C] paragraphs. The sandbox cannot run a command, so each throws.
*/

/*
  FAKE MODE: args.fake supplies every [C] decision, so a path walks offline with no repository.
*/

/*
  Paragraph 18: resumption is worktree-level, so there is no resume entry point here.
*/

/*
  Paragraph 19: the preamble initializes submodules on every path, before this file runs.
*/

// ---------------------------------------------------------------------------
// Diagram labels, spliced from plans/diagram/*.mmd by generateTaskWorkflow.ts
// ---------------------------------------------------------------------------

/*
  Every label below is its node's text. A typo fails the build, never a run.
*/

// GENERATED LABELS

/*
  The same lookup tracePipeline.ts exports, so a trace and a run cannot word a box differently.
*/
const L = (id) => {
  const label = LABELS[id]
  if (label === undefined) throw new Error(`tackle-tasks workflow: no diagram node named "${id}"`)
  return label
}

// ---------------------------------------------------------------------------
// Plan-file validators, spliced from planArtifacts.ts by generateTaskWorkflow.ts
// ---------------------------------------------------------------------------

/*
  The v1.5 diagrams dropped the receipt-validity boxes, so nothing calls these yet.
*/

// GENERATED VALIDATORS

// ---------------------------------------------------------------------------
// Pipelines, spliced whole from pipelines.ts by generateTaskWorkflow.ts
// ---------------------------------------------------------------------------

/*
  One function per diagram. A test imports pipelines.ts and drives any one of them alone.
*/

// GENERATED PIPELINES

// ---------------------------------------------------------------------------
// Launch
// ---------------------------------------------------------------------------

return runTaskPipeline(createPipelineContext({
  task: args.task,
  emitter: args.agentPromptEmitterPath,
  worktree: args.worktree,
  projectRoot: args.projectRoot,
  sourceBranch: args.sourceBranch,
  runId: args.runId,
  fake: args && typeof args === 'object' ? args.fake : null,
  L,
  agent,
  log,
  phase,
}))
