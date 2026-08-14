export const meta = {
  name: 'tackle-task',
  description: 'Drive one task from validation to merge, per plans/diagram/pipeline.mmd',
  phases: [
    { title: 'Preflight', detail: 'validate the number, claim the task, check blockers' },
    { title: 'Worktree', detail: 'create, reset or adopt the task worktree' },
    { title: 'Plan', detail: 'write the plan, review it, apply amendments' },
    { title: 'Implement', detail: 'implement the plan and record its notes' },
    { title: 'Test', detail: 'run the task tests and review them' },
    { title: 'Rebase', detail: 'lock the source repo and rebase onto the target branch' },
    { title: 'Suite', detail: 'run the full suite' },
    { title: 'Merge', detail: 'check the file fence and merge' },
    { title: 'Close', detail: 'record, clean up and archive' },
  ],
}
