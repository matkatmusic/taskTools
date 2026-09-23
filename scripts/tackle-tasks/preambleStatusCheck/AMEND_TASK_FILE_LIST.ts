// B_AMEND_TASK_FILE_LIST, from pipeline-preambleStatusCheck.mmd. Mutating: writes tasks.json. One successor, so no next.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../shared/contracts.ts";
import { addTaskFiles } from "../../shared/addTaskFiles.ts";
import type { EntryPacket } from "./_packet.ts";

export function main(input: string): EntryPacket {
  const { next: _next, ...packet } = JSON.parse(input) as EntryPacket & { next?: string };
  addTaskFiles([packet.taskNumber], packet.violations, packet.projectRoot);
  // The diagram's edge to Q_INIT_SUBMODULES_RECURSIVELY is labelled "docs mode: UPDATE".
  return { ...packet, box: "B_AMEND_TASK_FILE_LIST", scriptSignal: SCRIPT_SIGNAL.CONTINUE, docsMode: "UPDATE" };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
const scriptPath = realpathSync(process.argv[1]!);
const moduleUrl = fileURLToPath(import.meta.url);
const modulePath = realpathSync(moduleUrl);
if (scriptPath === modulePath)
  console.log(JSON.stringify(main(process.argv[2] ?? "")));
