// Session quota: one fixed flagged comment per file unblocks its existing debt. Tracked by line text, not number.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const SESSION_FIX_QUOTA = 1;
const DEFAULT_QUOTA_DIR = join(process.env.HOME ?? "", ".claude", "comment-quota");

export type OverCapFile = { path: string; lines: number[] };
type QuotaEntry = { baseline: string[]; satisfied: boolean };
type QuotaState = { [path: string]: QuotaEntry };

function readTrimmedLineTexts(path: string, lines: number[]): { line: number; text: string }[] {
  const fileLines = readFileSync(path, "utf8").split("\n");
  return lines.map((line) => ({ line, text: (fileLines[line - 1] ?? "").trim() }));
}

function loadQuotaState(statePath: string): QuotaState {
  try {
    return JSON.parse(readFileSync(statePath, "utf8"));
  } catch {
    return {};
  }
}

// The baseline is frozen at first sighting: new offenders must never become "existing debt".
function filterBlockingLines(entry: QuotaEntry, current: { line: number; text: string }[]): number[] {
  const currentTexts = current.map(({ text }) => text);
  const fixedCount = entry.baseline.filter((text) => !currentTexts.includes(text)).length;
  if (!entry.satisfied) {
    if (fixedCount >= SESSION_FIX_QUOTA) {
      entry.satisfied = true;
    }
  }
  if (!entry.satisfied) return current.map(({ line }) => line);
  return current.filter(({ text }) => !entry.baseline.includes(text)).map(({ line }) => line);
}

// Returns the files/lines that should still block; quota-satisfied existing debt is dropped entirely.
export function applyQuota(sessionId: string, files: OverCapFile[], quotaDir = DEFAULT_QUOTA_DIR): OverCapFile[] {
  mkdirSync(quotaDir, { recursive: true });
  const statePath = join(quotaDir, `${sessionId}.json`);
  const state = loadQuotaState(statePath);
  const blocking = files.flatMap(({ path, lines }) => {
    const current = readTrimmedLineTexts(path, lines);
    const entry = state[path];
    if (!entry) {
      state[path] = { baseline: current.map(({ text }) => text), satisfied: false };
      return [{ path, lines }];
    }
    const blockingLines = filterBlockingLines(entry, current);
    if (blockingLines.length === 0) return [];
    return [{ path, lines: blockingLines }];
  });
  writeFileSync(statePath, JSON.stringify(state));
  return blocking;
}
