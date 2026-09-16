import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export function mermaidForFile(relativePath: string, sourceText: string): string {
  const boxId = "B_" + relativePath.replace(/[^A-Za-z0-9_]/g, "_");
  return `flowchart TD\n${boxId}["${relativePath}"]\n`;
}

export function writeAllDiagrams(repoRoot: string = process.cwd()): void {
  const tracked = execFileSync("git", ["-C", repoRoot, "ls-files", "*.ts"], { encoding: "utf8" });
  const files = tracked.split("\n").filter((line) => line.length > 0);
  for (const relativePath of files) {
    if (relativePath.endsWith(".test.ts")) {
      continue;
    }
    if (relativePath.startsWith("tests/")) {
      continue;
    }
    const sourceText = readFileSync(join(repoRoot, relativePath), "utf8");
    const diagramPath = join(repoRoot, ".taskTools", "diagrams", relativePath.replace(/\.ts$/, ".mmd"));
    mkdirSync(dirname(diagramPath), { recursive: true });
    writeFileSync(diagramPath, mermaidForFile(relativePath, sourceText));
  }
}

if (process.argv[1]?.endsWith("mermaid.ts")) {
  writeAllDiagrams();
}
