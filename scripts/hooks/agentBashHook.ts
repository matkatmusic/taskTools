// PreToolUse hook on Bash for fenced agents: exit 2 blocks git and the full test suite; everything else runs.
import { readFileSync } from "node:fs";

const input = JSON.parse(readFileSync(0, "utf8"));
const command: unknown = input.tool_input?.command;
if (typeof command !== "string") throw new Error(`agentBashHook: ${input.tool_name} carries no command`);

const blocked = /(^|[;&|]\s*)(git|npm\s+test|npm\s+run\s+test)\b/.test(command.trim());
if (blocked) {
    process.stderr.write(`blocked by the fenced agent's Bash hook: git and the full test suite are not allowed here: ${command}\n`);
    process.exit(2);
}
