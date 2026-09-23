// ADD_MISSING_FILES_TO_CREATES_FILES, from pipeline-preambleStatusCheck.mmd. Mutating: writes tasks.json. One successor, so no next.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../shared/contracts.ts";
import { addTaskCreatesFiles } from "../../shared/addTaskCreatesFiles.ts";
import type { EntryPacket } from "./_packet.ts";

export function main(input: string): EntryPacket {
  const { next: _next, ...packet } = JSON.parse(input) as EntryPacket & { next?: string };
  // Each path stays in modifiableFiles: the edit fence is built from that list alone.
  addTaskCreatesFiles([packet.taskNumber], packet.missingFiles, packet.projectRoot);
  return { ...packet, box: "B_ADD_MISSING_FILES_TO_CREATES_FILES", scriptSignal: SCRIPT_SIGNAL.CONTINUE };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
const scriptPath = realpathSync(process.argv[1]!);
const moduleUrl = fileURLToPath(import.meta.url);
const modulePath = realpathSync(moduleUrl);
if (scriptPath === modulePath)
  console.log(JSON.stringify(main(process.argv[2] ?? "")));
