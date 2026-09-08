// The agent registry polls .claude/agents every 30s when idle; new agent files need that poll before launch.
import { setTimeout as sleep } from "node:timers/promises";

await sleep(45_000);
process.stdout.write("agent registry poll window elapsed\n");
