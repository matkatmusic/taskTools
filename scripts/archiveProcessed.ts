// Move the given implementation notes / handoffs into an archived/ folder next to each file
// (plans/foo.md -> plans/archived/foo.md). A file whose name already exists there is left
// in place and reported as a COLLISION. Requires an explicit file list (the update-tasks
// skill passes its step-1 list) so a bare invocation can never mass-archive by accident.
import { existsSync, mkdirSync, renameSync } from "node:fs";
import { basename, dirname, join } from "node:path";

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error("Usage: node archiveProcessed.ts <file ...>");
  process.exit(1);
}

for (const file of files) {
  if (!existsSync(file)) continue;
  const archiveDir = join(dirname(file), "archived");
  const destination = join(archiveDir, basename(file));
  if (existsSync(destination)) {
    console.log(`COLLISION (left in place): ${file}`);
    continue;
  }
  mkdirSync(archiveDir, { recursive: true });
  renameSync(file, destination);
  console.log(`archived: ${file}`);
}

