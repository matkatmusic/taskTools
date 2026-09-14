// The one place that says what an implementer may write and which test files a task must have.
import { join } from "node:path";
import { testFileCandidates } from "../../hooks/relatedTests.ts";
import { modifiableFiles } from "../../shared/prepareTasks.ts";
import { TASK_HAS_TESTS } from "../../shared/resultCodes.ts";
import { taskHasTests, type TaskRecord } from "../../shared/taskFiles.ts";

export const notesFile = (taskNumber: number) => `plans/implementation-notes-${taskNumber}.md`;

// tests: "skip" wins over hasTests; a skip task checks for no tests at all.
export const taskDeclaresTests = (task: TaskRecord) => task.tests !== "skip" && taskHasTests(task) === TASK_HAS_TESTS;

// One group per owned file: its repo-relative test candidates. [] when the task declares no tests.
export function requiredTestGroups(task: TaskRecord): { source: string; candidates: string[] }[] {
  if (!taskDeclaresTests(task))
    return [];
  const groups: { source: string; candidates: string[] }[] = [];
  for (const source of modifiableFiles(task)) {
    const candidates = testFileCandidates("", source).map((path) => join(path));
    const hasCandidates = candidates.length > 0;
    if (hasCandidates)
      groups.push({ source, candidates });
  }
  return groups;
}

export function writableFiles(task: TaskRecord): string[] {
  const testPaths = requiredTestGroups(task).flatMap((group) => group.candidates);
  return [...new Set([...modifiableFiles(task), ...testPaths, notesFile(task.taskNumber)])];
}
