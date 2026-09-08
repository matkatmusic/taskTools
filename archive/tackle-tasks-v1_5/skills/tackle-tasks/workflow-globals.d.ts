// Globals the Workflow harness injects into *.workflow.js scripts. Not importable.

declare const args: any

declare function agent(
  prompt: string,
  opts?: {
    label?: string
    phase?: string
    schema?: object
    model?: string
    effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
    isolation?: 'worktree'
    agentType?: string
  },
): Promise<any>

declare function parallel(thunks: Array<() => Promise<any>>): Promise<any[]>

declare function pipeline(
  items: any[],
  ...stages: Array<(prev: any, item: any, index: number) => any>
): Promise<any[]>

declare function phase(title: string): void
declare function log(message: string): void

declare function workflow(
  nameOrRef: string | { scriptPath: string },
  args?: any,
): Promise<any>

declare const budget: {
  total: number | null
  spent(): number
  remaining(): number
}
