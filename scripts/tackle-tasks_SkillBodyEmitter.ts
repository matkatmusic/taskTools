import { fileURLToPath } from "node:url";

// Absolute, because the reading agent's shell has no CLAUDE_PLUGIN_ROOT to expand.  Exported for tackleTasksBrief.ts to reuse (workflow-only-context-injection.md).
export const WORKFLOW_PATH = fileURLToPath(new URL("../skills/tackle-tasks/tackle-tasks.workflow.js", import.meta.url));
export const AGENT_PROMPT_EMITTER_PATH = fileURLToPath(new URL("./tackle-tasks_AgentPromptEmitter.ts", import.meta.url));

export const skillBody = (): string => ``;

if (process.argv[1]?.endsWith("tackle-tasks_SkillBodyEmitter.ts"))
  process.stdout.write(skillBody());
