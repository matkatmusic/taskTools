export const agentPrompt = (): string => ``;

if (process.argv[1]?.endsWith("tackle-tasks_AgentPromptEmitter.ts"))
  process.stdout.write(agentPrompt());
