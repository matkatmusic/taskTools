// SubagentStop hook: an agent that got a prompt from /run-step may not stop until its answer is in the packet file.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getTemplateShapeMismatches } from "./templateShape.ts";
import type { BlockTemplate, StepConfig } from "./generateSteps.ts";

const PROJECT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CONFIG_FILE = process.env.RUN_STEP_CONFIG ?? join(PROJECT_ROOT, "scripts/steps.json");
// Same log the run-step hook writes, so a run shows whether this hook fired at all.
const LOG_FILE = process.env.RUN_STEP_LOG ?? join(process.cwd(), ".taskTools/runs/run-log.json");

function log(note: string): void {
    mkdirSync(dirname(LOG_FILE), { recursive: true });
    const runLogEntries = existsSync(LOG_FILE) ? JSON.parse(readFileSync(LOG_FILE, "utf8")) : [];
    runLogEntries.push({ block: "STOP HOOK", at: new Date().toISOString(), note });
    writeFileSync(LOG_FILE, `${JSON.stringify(runLogEntries, null, 4)}\n`);
}

const input: { agent_transcript_path?: unknown } = JSON.parse(readFileSync(0, "utf8"));
log(`fired for ${JSON.stringify(input.agent_transcript_path)}`);
if (typeof input.agent_transcript_path !== "string") {
    process.exit(0);
}

// The run-step hook output sits inside the transcript as an escaped string; the last one is this pass's.
const transcript = readFileSync(input.agent_transcript_path, "utf8");
const matches = [...transcript.matchAll(/\\"outcome\\":\{\\"next\\":\\"([^\\"]+)\\",\\"payload\\":\\"([^\\"]+)\\"\}/g)];
if (matches.length === 0) {
    log("no run-step prompt stop in this transcript; nothing to check");
    process.exit(0);
}
const [, nextStepKey, packetFile] = matches.at(-1)!;

const config = JSON.parse(readFileSync(CONFIG_FILE, "utf8")) as StepConfig;
const [diagram, box] = String(nextStepKey).split("::");
const entry = config[String(diagram)]!.find(candidate => candidate.box === box)!;
const templateInput = (JSON.parse(readFileSync(resolve(PROJECT_ROOT, entry.template), "utf8")) as BlockTemplate).input;
const { prompt: _prompt, ...packet } = JSON.parse(readFileSync(String(packetFile), "utf8"));
const mismatches = getTemplateShapeMismatches(templateInput, packet);
if (mismatches.length === 0) {
    log(`${packetFile} is ready for ${nextStepKey}`);
    process.exit(0);
}
const reason = [
    `${packetFile} is not ready for ${nextStepKey}: ${mismatches.join("; ")}.`,
    "Follow the prompt in that file and write your answer into it, next to the keys already there.",
    "Then return the hook output verbatim.",
].join(" ");
log(`blocked the stop: ${reason}`);
process.stdout.write(`${JSON.stringify({ decision: "block", reason })}\n`);
