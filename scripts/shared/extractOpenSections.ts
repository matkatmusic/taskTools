// Prints the open-work sections of implementation notes and handoffs:
//   implementation-notes-*.md -> every "### Open questions" section
//   handoff-*.md              -> the "## What Remains" section
// Each section prints under a "=== <file> ===" banner and ends at the next ##/### header or EOF.
// Usage: node extractOpenSections.ts [file ...]   (default: all notes/handoffs at plans/ top level)
import { readFileSync, readdirSync } from "node:fs";

const NOTE_FILE_PATTERN = /^(implementation-notes-|handoff-).*\.md$/;
const SECTION_START = /^### Open questions|^## What Remains/;
const HEADER = /^##/;

function listDefaultNoteFiles(): string[] {
  return readdirSync("plans")
    .filter(name => NOTE_FILE_PATTERN.test(name))
    .map(name => `plans/${name}`);
}

function printOpenSections(file: string): void {
  let inSection = false;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (SECTION_START.test(line)) {
      inSection = true;
      console.log(`\n=== ${file} ===`);
      continue;
    }
    if (HEADER.test(line)) inSection = false;
    if (inSection) console.log(line);
  }
}

if (process.argv[2] === "--list") {
  for (const file of listDefaultNoteFiles()) console.log(file);
} else {
  const files = process.argv.length > 2 ? process.argv.slice(2) : listDefaultNoteFiles();
  for (const file of files) printOpenSections(file);
}

