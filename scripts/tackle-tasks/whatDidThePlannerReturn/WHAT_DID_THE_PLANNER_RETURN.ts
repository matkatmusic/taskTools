// WHAT_DID_THE_PLANNER_RETURN, from pipeline-plan.mmd's decision, ported to route only.
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../shared/contracts.ts";
import { readTaskFile, resolveTaskFiles, taskHasTests, taskWorkflowDirectory } from "../../shared/taskFiles.ts";
import { modifiableFiles } from "../../shared/prepareTasks.ts";
import { withTaskStateLock, writeJsonAtomically } from "../../shared/taskStateLock.ts";
import { TASK_HAS_TESTS } from "../../shared/resultCodes.ts";
// import { pairedTestPath } from "../shared/preparedTask.ts";
import { requiredTestGroups, taskDeclaresTests } from "../shared/writableFiles.ts";
import type { EntryPacket } from "../preambleStatusCheck/_packet.ts";
import type { WhatDidThePlannerReturnPacket } from "./_packet.ts";

type Input = EntryPacket & {
  message: string;
  additionalData: { outcome: "PLAN" | "CLARIFY"; planFile: string; clarifyRequest: string; additionalFiles?: string[] };
};

// The plan step first learns a needed file was missed, so widen the fence here before rejection.
function mergeAdditionalFiles(projectRoot: string, taskNumber: number, additionalFiles: string[]): void {
  if (additionalFiles.length === 0)
    return;
  const { tasksPath } = resolveTaskFiles(projectRoot);
  withTaskStateLock(tasksPath, () => {
    const tasks = readTaskFile(tasksPath);
    let entry: (typeof tasks)[number] | undefined;
    for (const task of tasks) {
      const isMatch = task.taskNumber === taskNumber;
      if (isMatch) {
        entry = task;
        break;
      }
    }
    if (entry === undefined)
      throw new Error(`task ${taskNumber} not found in ${tasksPath}`);
    (entry as any).modifiableFiles = [...new Set([...modifiableFiles(entry), ...additionalFiles])];
    writeJsonAtomically(tasksPath, tasks);
  });
}

// The run's steps.json picks the diagram set; the fast set skips codex plan review. Missing file means default pipeline.
function isFastPipeline(projectRoot: string, taskNumber: number): boolean {
  const stepsConfigPath = join(taskWorkflowDirectory(resolveTaskFiles(projectRoot).tasksPath, taskNumber), "steps.json");
  const stepsConfigExists = existsSync(stepsConfigPath);
  if (!stepsConfigExists)
    return false;
  const stepsConfig = JSON.parse(readFileSync(stepsConfigPath, "utf8")) as Record<string, unknown>;
  return !("pipeline-codexReviewsPlan.mmd" in stepsConfig);
}

export function main(input: string): Record<string, unknown> {
  const { message: _message, additionalData, ...packet } = JSON.parse(input) as Input;
  const { outcome, planFile, clarifyRequest } = additionalData;
  const output: WhatDidThePlannerReturnPacket & { reviewOutputFile: string; verdict: string; notes: string } = {
    ...packet, box: "WHAT_DID_THE_PLANNER_RETURN", scriptSignal: SCRIPT_SIGNAL.CONTINUE, planFile, outcome, clarifyRequest,
    reviewOutputFile: "", verdict: "", notes: "",
  };
  if (outcome === "PLAN") {
    mergeAdditionalFiles(packet.projectRoot, packet.taskNumber, additionalData.additionalFiles ?? []);
    const allTasks = readTaskFile(resolveTaskFiles(packet.projectRoot).tasksPath);
    let entry: (typeof allTasks)[number] | undefined;
    for (const task of allTasks) {
      const isMatch = task.taskNumber === packet.taskNumber;
      if (isMatch) {
        entry = task;
        break;
      }
    }
    if (entry === undefined)
      throw new Error(`task ${packet.taskNumber} not found in tasks.json`);
    // A fast run draws neither the plan review nor the verdict, so an accepted plan goes to the implementer.
    const isFast = isFastPipeline(packet.projectRoot, packet.taskNumber);
    if (isFast) {
      return { ...output, next: "pipeline-implementTask.mmd::IMPLEMENT_TASK" };
    }
    // User ruling: no more pipeline failures for nitpick reasons. A guessed test-name gate looped forever
    // on tasks whose real test file doesn't match requiredTestGroups' guessed sibling name (e.g. task 44).
    // if (taskDeclaresTests(entry)) {
    //   const planText = readFileSync(planFile, "utf8");
    //   const unnamed = requiredTestGroups(entry).filter((group) => !group.candidates.some((candidate) => planText.includes(basename(candidate))));
    //   if (unnamed.length > 0) {
    //     return {
    //       ...output,
    //       verdict: "AMEND",
    //       notes: `the task declares tests but the plan does not name: ${unnamed.map((group) => group.candidates.join(" or ")).join(", ")}`,
    //       next: "pipeline-whatIsReviewVerdict.mmd::UPDATE_TASKS_JSON",
    //     };
    //   }
    // }
    const isLowDifficulty = Number(entry.difficulty) <= 3;
    if (isLowDifficulty) {
      return { ...output, next: "pipeline-implementTask.mmd::IMPLEMENT_TASK" };
    }
    return { ...output, next: "pipeline-codexReviewsPlan.mmd::IS_PLAN_APPROVED_BY_DEFAULT_Q" };
  }
  if (outcome === "CLARIFY") {
    return { ...output, next: "ARE_2_CLARIFY_ROUNDS_DONE_Q" };
  }
  throw new Error(`unknown planner outcome: ${JSON.stringify(outcome)}`);
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
const scriptPath = realpathSync(process.argv[1]!);
const modulePath = realpathSync(fileURLToPath(import.meta.url));
const isMainModule = scriptPath === modulePath;
if (isMainModule)
  console.log(JSON.stringify(main(process.argv[2] ?? "")));
