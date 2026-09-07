# Task 38: pick the model for each `agent()` call by block and difficulty

Task 38 and task 37 here are entries in the Claude Code session task list (TaskList), not `.taskTools/tasks.json`. Do not touch `.taskTools/tasks.json` or `completedTasks.json` for bookkeeping.

## Context

`scripts/tackle-tasks/generateWorkflow.ts:74` calls `agent()` with a label and a schema only. Every pass runs on the session model. This change makes code pick the model and effort for each prompt block from the task's difficulty, with a per-task override, and makes each prompt block run in its own `agent()` call.

Decisions made by the user:
- Default bands: difficulty 1-4 `claude-opus-4-8[1m]` effort `high`; 5-7 `claude-sonnet-5[1m]` effort `xhigh`; 8-10 `claude-fable-5-1[1m]` effort `medium`.
- The bands apply only to the five blocks where the agent itself does the work: PLAN_THE_TASK, IMPLEMENT_TASK, FIX_IMPLEMENT_TASK_TESTS, FIX_CONFLICTS, FIX_THE_CODEBASE_FOR_SUITE.
- Every other block runs on `haiku`, the cheapest agent. That covers all decision and mutating blocks, and the three prompt blocks that only run codex and relay its answer: PLAN_THE_TASK_CODEX, CODEX_REVIEWS_PLAN, CODEX_REVIEWS_TESTS.
- The default bands and the haiku default live in a source file, not in diagram-steps.json.
- A tasks.json entry may override model and effort per block, by box name.
- The per-task `.taskTools/workflows/<N>/steps.json` holds the resolved model and effort on every block.
- The hook walks decision and mutating blocks only. It stops before a prompt block and returns that block as `outcome.next`, with the packet and the block's model and effort. A separate `agent()` call runs the prompt block.
- The workflow's first `input` carries the first block's model and effort, baked in from the per-task steps.json. Each later `input` carries what the hook returned.

Not yet confirmed by the user: the haiku effort. This plan uses `low`. Change `RELAY_AGENT` in Step 1 if you want another value.

## Vocabulary

- **band**: `{ minDifficulty, model, effort }`.
- **band block**: one of the five blocks where the agent does the work itself. Its model comes from the band.
- **relay agent**: `{ model: "haiku", effort: "low" }`. Every block that is not a band block runs on it.
- **agent options**: `{ model, effort }`. The field name is `agent` on a steps.json entry, in `outcome`, in the workflow `input`, and as the tasks.json override map.
- **walker stop**: the hook stopped before a prompt block. `outcome.next` names the prompt block. The packet is the previous block's output.
- **prompt stop**: the hook ran a prompt block and stopped. Unchanged from today.

## Data shapes

Source constants, `scripts/tackle-tasks/shared/resolveAgentOptions.ts`:

```ts
export const DEFAULT_AGENT_BANDS: AgentBand[] = [
    { minDifficulty: 1, model: "claude-opus-4-8[1m]", effort: "high" },
    { minDifficulty: 5, model: "claude-sonnet-5[1m]", effort: "xhigh" },
    { minDifficulty: 8, model: "claude-fable-5-1[1m]", effort: "medium" },
];
// The blocks where the agent does the work itself. Every other block, decision or codex relay, runs on RELAY_AGENT.
export const BAND_BLOCKS = new Set(["PLAN_THE_TASK", "IMPLEMENT_TASK", "FIX_IMPLEMENT_TASK_TESTS", "FIX_CONFLICTS", "FIX_THE_CODEBASE_FOR_SUITE"]);
export const RELAY_AGENT: AgentOptions = { model: "haiku", effort: "low" };
```

Per-task `steps.json`, on every entry. A band block at difficulty 5:

```json
"agent": { "model": "claude-sonnet-5[1m]", "effort": "xhigh" }
```

Every other block:

```json
"agent": { "model": "haiku", "effort": "low" }
```

tasks.json entry, optional, keyed by box name:

```json
"agent": { "IMPLEMENT_TASK": { "model": "claude-fable-5-1[1m]", "effort": "high" } }
```

Hook `outcome`:

```json
{ "next": "pipeline-implementTask.mmd::IMPLEMENT_TASK", "payload": "/.../IMPLEMENT_TASK-123.json", "agent": { "model": "...", "effort": "..." } }
```

`agent` is present whenever `next` is not null, because every block in the per-task steps.json has one. A walker `agent()` call runs on haiku.

Shared `scripts/tackle-tasks/diagram-steps.json` does not change.

## Order of work

For each step: write the failing test, run it, write the code, run it again.

### Step 1: resolve `agent` on every block for one task

Files: new `scripts/tackle-tasks/shared/resolveAgentOptions.ts`, new `scripts/tackle-tasks/shared/resolveAgentOptions.test.ts`, `scripts/tackle-tasks/generateSteps.ts`, `scripts/tackle-tasks/shared/SkillBodyEmitter.ts`, `scripts/tackle-tasks/shared/SkillBodyEmitter.test.ts`.

1. Types in `generateSteps.ts:56`:
   ```ts
   export type AgentOptions = { model: string; effort: string };
   export type StepConfigEntry = { box: string; script: string; template: string; producesPrompt: boolean; mutating?: boolean; agent?: AgentOptions; next: string[] };
   ```
   `agent` is not carried forward by `generateSteps`; this step rewrites it on every launch.
2. Tests in `resolveAgentOptions.test.ts`, one behavior each, against a temp steps.json holding IMPLEMENT_TASK, PLAN_THE_TASK, CODEX_REVIEWS_PLAN and IS_DIFFICULTY_7_PLUS_Q, and a temp tasks.json:
   - `test_resolveAgentOptions_picksTheBandWithTheLargestMinDifficultyNotAboveTheTask`: difficulty 4 gives IMPLEMENT_TASK the Opus band. Difficulty 5 and 7 give the Sonnet band. Difficulty 8 gives the Fable band.
   - `test_resolveAgentOptions_usesTheTaskOverrideForThatBlockOnly`: tasks.json entry has `agent: { IMPLEMENT_TASK: {...} }`. IMPLEMENT_TASK gets the override. PLAN_THE_TASK gets its band.
   - `test_resolveAgentOptions_givesTheRelayAgentToEveryBlockOutsideTheBandSet`: IS_DIFFICULTY_7_PLUS_Q and CODEX_REVIEWS_PLAN both get `{ model: "haiku", effort: "low" }`.
   - `test_resolveAgentOptions_throwsWhenTheTaskHasNoDifficulty`: an entry without `difficulty` throws. The message holds the task number and `run /rate-task N`.
3. Code:
   ```ts
   export type AgentBand = { minDifficulty: number; model: string; effort: string };
   export const DEFAULT_AGENT_BANDS: AgentBand[] = [ /* see Data shapes */ ];
   export const BAND_BLOCKS = new Set([ /* see Data shapes */ ]);
   export const RELAY_AGENT: AgentOptions = { model: "haiku", effort: "low" };

   // Writes agent {model, effort} onto every block: the task's override for that box, else the band for a band block, else the relay agent.
   export function resolveAgentOptions(stepsConfigPath: string, tasksFile: string, taskNumber: number): void {
       const config = JSON.parse(readFileSync(stepsConfigPath, "utf8")) as StepConfig;
       const entry = readTaskFile(tasksFile).find(task => task.taskNumber === taskNumber);
       if (entry === undefined) throw new Error(`task ${taskNumber} not found in ${tasksFile}`);
       if (typeof entry.difficulty !== "number") throw new Error(`task ${taskNumber} has no difficulty; run /rate-task ${taskNumber}`);
       const difficulty = entry.difficulty;
       const overrides = (entry.agent ?? {}) as Record<string, AgentOptions>;
       const band = DEFAULT_AGENT_BANDS.filter(candidate => candidate.minDifficulty <= difficulty).at(-1)!;
       const bandAgent: AgentOptions = { model: band.model, effort: band.effort };
       for (const entries of Object.values(config)) {
           for (const step of entries) {
               step.agent = overrides[step.box] ?? (BAND_BLOCKS.has(step.box) ? bandAgent : RELAY_AGENT);
           }
       }
       writeFileSync(stepsConfigPath, `${JSON.stringify(config, null, 4)}\n`);
   }
   ```
   `readTaskFile` is exported from `scripts/shared/taskFiles.ts`. `TaskRecord` there is `Record<string, unknown>`, so the `typeof` guard narrows `entry.difficulty` to `number`.
4. In `ensureTaskWorkflowPair` (`SkillBodyEmitter.ts:49-50`), call it between `generateSteps(...)` and `generateWorkflow(...)`:
   ```ts
   resolveAgentOptions(stepsConfigPath, tasksFile, taskNumber);
   ```
5. Test in `SkillBodyEmitter.test.ts`, next to the `mutating` carry-forward test at line 136: `test_ensureTaskWorkflowPair_writesResolvedAgentOptionsIntoTheTaskStepsJson`. Fixture task difficulty 5. Assert `IMPLEMENT_TASK.agent` in `.taskTools/workflows/<N>/steps.json` deep-equals `{ model: "claude-sonnet-5[1m]", effort: "xhigh" }`. Assert `IS_DIFFICULTY_7_PLUS_Q.agent` deep-equals `{ model: "haiku", effort: "low" }`.
6. Test `test_bandBlocks_areAllPromptBlocksInTheRepoConfig` in `resolveAgentOptions.test.ts`: read `scripts/tackle-tasks/diagram-steps.json`; every name in `BAND_BLOCKS` is a `producesPrompt: true` entry there.
7. Existing fixtures that call `skillBody` must now carry a difficulty, or the resolver throws:
   - `SkillBodyEmitter.test.ts:24-37` `makeTargetRepository`: add `difficulty: 1` to every task it writes.
   - `tests/generateSteps.test.ts:294-329`, the custom-diagram test that calls `skillBody` for task 999999: seed that task in its tasks.json with `difficulty: 1`.
   - Run `rg -n "skillBody\(" tests scripts --glob '*.test.ts'` and give every other fixture task a `difficulty` the same way.
   The two throw cases, missing task and missing difficulty, stay covered only by the dedicated tests in `resolveAgentOptions.test.ts`.

### Step 2: hook output schema gets `agent`

Files: `scripts/tackle-tasks/buildRunStepSchemas.ts`, `tests/generateWorkflow.test.ts`.

1. Test `test_buildHookOutputSchema_allowsAgentOptionsOnTheOutcome`: `outcome.properties.agent` is `{ type: "object", properties: { model: { type: "string" }, effort: { type: "string" } }, required: ["model", "effort"], additionalProperties: false }`. `outcome.required` stays `["next", "payload"]`.
2. Add that `agent` property to the `outcome` properties in `buildHookOutputSchema`.

### Step 3: the hook stops before a prompt block and names its agent options

Files: `scripts/hooks/runStepHook.ts`, `tests/runStepHook.test.ts`, `scripts/hooks/runStepStopHook.ts`, `tests/runStepStopHook.test.ts`.

Tests in `tests/runStepHook.test.ts`, using the `configWith` fixture builder at line 49. Add `agent?: AgentOptions` to the fixture entry type.

- `test_walkStopsBeforeAPromptBlockAndNamesItAsNext`: config A (continue) -> B (prompt) -> C. Run `/run-step A`. Assert `ran` is `["one.mmd::A"]`, `outcome.next` is `"one.mmd::B"`, and the payload file holds A's output with no `prompt` key.
- `test_walkStopReturnsTheNextBlocksAgentOptions`: B has `agent: { model: "m", effort: "e" }`. Assert `outcome.agent` deep-equals it.
- `test_walkStopOmitsAgentWhenTheNextBlockHasNone`: B has no `agent`. Assert `"agent" in outcome` is false.
- `test_promptBlockRunsWhenTheWalkStartsAtIt`: run `/run-step B {packetFile}` where the packet file holds A's output. Assert `ran` is `["one.mmd::B"]`, the payload holds `prompt`, `outcome.next` is `"one.mmd::C"`.
- `test_walkStopInstructionsDoNotAskForAnAnswer`: after a walker stop, the injected `additionalContext` is the JSON line only.
- `test_workerStartFromAWalkerPacketLogsNoAgentTime`: after `/run-step B {packetFile: walkerPacket}`, the run log has no entry whose `block` ends with ` agent`. After a prompt-stop packet, it still has one.

Update every existing test whose fixture walks a continue block into a prompt block (lines near 188, 203, 272, 284, 301, 400, 761, 791, 971, 990, 1020, 1042, 1426) to the two-stop rhythm: the first call stops before the prompt block; a second call starting at the prompt block with `{packetFile}` gives the prompt stop. Do not add a fallback in the hook to keep an old expectation alive.

Code in `runStepHook.ts`:

1. `Outcome` type at line 88: add `agent?: AgentOptions`. Import `AgentOptions` from `../tackle-tasks/generateSteps.ts`.
2. At the top of the `while (true)` loop in `walkFromStep`, directly after `const packet = getPacketFromInput(input);` (line 381) and before the checkpoint block:
   ```ts
   // A prompt block runs under its own model, so the walk stops here and names it; the next agent starts at it.
   if (step.producesPrompt && boxesRun.length > 0) {
       return buildWalkerStop(boxesRun, stepKey, packet);
   }
   ```
3. New function directly after `buildSuccess` (line 322). Keep it separate from `buildSuccess`:
   ```ts
   // The packet is the previous block's output, unchanged; only the next block and its agent options are new.
   function buildWalkerStop(boxesRun: string[], nextStepKey: string, packet: Record<string, unknown>): HookOutput {
       const nextStep = STEPS_BY_KEY.get(nextStepKey)!;
       const payload = join(packetsDirectory(), `${nextStep.box}-${process.pid}.json`);
       mkdirSync(dirname(payload), { recursive: true });
       writeJsonAtomically(payload, packet);
       return { ok: true, ran: boxesRun, errors: [], outcome: { next: nextStepKey, payload, agent: nextStep.agent } };
   }
   ```
   `JSON.stringify` drops `agent: undefined`, so the injected JSON has no `agent` key when the block has none.
4. In `buildSuccess` (line 311-322), change the returned outcome to `{ next, payload, agent: STEPS_BY_KEY.get(String(next))?.agent }`. `String(null)` is `"null"`, never a key.
5. Packet-file start (lines 340-352): wrap the lines from `const agentTookMs = ...` through `writeJsonAtomically(logFile(), runLogEntries);` in `if (startedAt !== undefined) { ... }`. A walker packet has no `startedAt`; a prompt packet always has one.
6. `getInstructionsForAgent` (line 528), after the `next === null` return:
   ```ts
   // The walk stopped short of a prompt block; the packet holds no prompt, so the agent only relays the output.
   if (STEPS_BY_KEY.get(result.outcome.next)!.producesPrompt) {
       return "";
   }
   ```
7. `runStepStopHook.ts:29`: remove the trailing `\}` from the regex so an outcome with `"agent"` after `"payload"` still matches. Add `test_stopHook_matchesAnOutcomeThatCarriesAgentOptions` in `tests/runStepStopHook.test.ts`: a transcript line with `"agent":{"model":"m","effort":"e"}` after `"payload"`, a packet that matches the next block's template input, exit 0 and a log line saying the packet is ready.

### Step 4: the workflow reads `agent` from `input` and from the hook result

Files: `scripts/tackle-tasks/generateWorkflow.ts`, `tests/generateWorkflow.test.ts`.

Tests in `tests/generateWorkflow.test.ts`. Change the `buildProject` fixture at line 11 so each block takes an optional `diagram` (default `one.mmd`) and an optional `agent`. `buildWorkflowScript` throws unless the config holds `pipeline-preambleStatusCheck.mmd::PREAMBLE_STATUS_CHECK`, so every fixture below names its first block that way. Call the fixture's start block START and its prompt block B, where B is `pipeline-implementTask.mmd::IMPLEMENT_TASK` and START's `next` is that full key.

- `test_buildWorkflowScript_bakesAgentOptionsByBlockFromTheConfig`: START has `agent: { model: "haiku", effort: "low" }`, B has `agent: { model: "m", effort: "e" }`. The script holds `const AGENT_BY_BLOCK = ` followed by a JSON object with exactly those two keys and values.
- `test_buildWorkflowScript_startsWithTheFirstBlocksAgentOptionsInInput`: the script has the exact line `let input = { taskNumber: args.task, tasksFile: args.tasksFile, agent: AGENT_BY_BLOCK[blockToRun] }`.
- `test_buildWorkflowScript_passesInputAgentOptionsToAgent`: the script matches `` agent(prompt, { label: `run-step:${blockName}`, ...input.agent, schema: HOOK_OUTPUT_SCHEMA }) ``. `schema` stays last so the test at line 104 stays green.
- `test_buildWorkflowScript_carriesTheHookAgentOptionsIntoTheNextInput`: the script has the exact line `input = { packetFile: result.outcome.payload, agent: result.outcome.agent }`. Change the anchored regex in `test_buildWorkflowScript_handsThePacketFileToTheNextBlock` (line 112) to this line.
- `test_buildWorkflowScript_runsEachPassWithTheModelTheHookNamed`: same fixture as the first test. Run the script through `runWorkflowScript` with a fake `agent` that records its options. First result `{ ok: true, ran: [START key], errors: [], outcome: { next: B key, payload: "/tmp/p.json", agent: { model: "m", effort: "e" } } }`. Second result `{ ok: true, ran: [B key], errors: [], outcome: { next: null, payload: "/tmp/q.json" } }`. Assert the first call's options have `model: "haiku"` and `effort: "low"`. Assert the second call's options have `model: "m"` and `effort: "e"`.
- `test_buildWorkflowScript_resolvesABareStartingBlockToItsKey`: same fixture. Run with `args.startingBlock: "IMPLEMENT_TASK"`. Assert the first call's options have `model: "m"` and the first prompt holds `/run-step pipeline-implementTask.mmd::IMPLEMENT_TASK`.
- `test_buildWorkflowScript_throwsWhenAStartingBlockMatchesNoKeyOrManyKeys`: `args.startingBlock: "NOPE"` rejects with a message holding `NOPE` and `0`. A fixture with `IMPLEMENT_TASK` in two diagrams and `args.startingBlock: "IMPLEMENT_TASK"` rejects with a message holding `2`.
- Change `test_buildWorkflowScript_startsAtArgsStartingBlockWhenGiven` (line 133) and the anchored `let blockToRun` regex in the test at line 100 to the new three lines below.

Code in `buildWorkflowScript`:

1. Before the template string:
   ```ts
   const agentByBlock: Record<string, AgentOptions> = {};
   for (const [diagram, entries] of Object.entries(config)) {
       for (const entry of entries) {
           if (entry.agent !== undefined) agentByBlock[`${diagram}::${entry.box}`] = entry.agent;
       }
   }
   ```
2. Emit `const AGENT_BY_BLOCK = ${JSON.stringify(agentByBlock, null, 4)}` directly after the `const TASK_NUMBER = ...` line. It must not sit between `const HOOK_OUTPUT_SCHEMA = ` and `// Required:`, because the test at line 108 slices that span as JSON.
3. Replace line 60, `let blockToRun = args.startingBlock ?? START_STEP`, with three lines. A starting block may arrive bare, such as `IMPLEMENT_TASK`, and `AGENT_BY_BLOCK` holds every step key, so the lookup happens here, before the first `agent()` call:
   ```js
   // A bare starting block names a box; keys are diagram::box, so match on the box part. Zero or many matches is an error.
   const startingBlockKeys = Object.keys(AGENT_BY_BLOCK).filter(key => key === args.startingBlock || key.endsWith(\`::\${args.startingBlock}\`))
   if (args.startingBlock !== undefined && startingBlockKeys.length !== 1) throw new Error(\`startingBlock \${args.startingBlock} matches \${startingBlockKeys.length} blocks\`)
   let blockToRun = startingBlockKeys[0] ?? START_STEP
   ```
   Then line 61: `let input = { taskNumber: args.task, tasksFile: args.tasksFile, agent: AGENT_BY_BLOCK[blockToRun] }`.
4. Line 74: `const result = await agent(prompt, { label: \`run-step:\${blockName}\`, ...input.agent, schema: HOOK_OUTPUT_SCHEMA })`. Spreading `undefined` adds nothing.
5. Line 102: `input = { packetFile: result.outcome.payload, agent: result.outcome.agent }`.

`input` is also the `/run-step` argument. `getTemplateShapeMismatches` ignores keys the template does not list. `PREAMBLE_STATUS_CHECK.ts:16` reads only `taskNumber` and `tasksFile`. A `packetFile` start replaces the input with the packet contents. So `agent` never enters a packet.

### Step 5: from a tasks.json entry to the `agent()` call and the `input` value

File: new `tests/workflowAgentOptions.test.ts`.

Fixture, built once per test in a temp folder:
- `tasks.json` with one entry: `taskNumber: 7`, `difficulty: 3`, plus the `agent` override when the test needs one.
- A steps.json holding two blocks with real scripts, built the way `configWith` does it in `tests/runStepHook.test.ts:49`, under two diagram keys: `pipeline-preambleStatusCheck.mmd` holds `PREAMBLE_STATUS_CHECK` (scriptSignal continue, `next: ["pipeline-implementTask.mmd::IMPLEMENT_TASK"]`); `pipeline-implementTask.mmd` holds `IMPLEMENT_TASK` (scriptSignal prompt, `producesPrompt: true`, `next: []`). `buildWorkflowScript` needs the first key. `BAND_BLOCKS` needs the second box name.
- `resolveAgentOptions(stepsConfigPath, tasksFile, 7)`, then `buildWorkflowScript(7, stepsConfigPath)`.
- Pass 1 through the real hook: spawn `scripts/hooks/runStepHook.ts` with `RUN_STEP_CONFIG` set to the steps.json and `RUN_STEP_LOG` set to a temp file, with stdin `{ hook_event_name: "UserPromptSubmit", prompt: "/run-step pipeline-preambleStatusCheck.mmd::PREAMBLE_STATUS_CHECK {\"taskNumber\":7,\"tasksFile\":\"<tasksFile>\"}" }`, the way `runHook` does at `tests/runStepHook.test.ts:21`. The process prints an envelope. Parse stdout as JSON, take `hookSpecificOutput.additionalContext`, split on `\n`, and parse the first line as the hook output.
- Run the script with `runWorkflowScript` from `tests/generateWorkflow.test.ts` (move it to a shared `tests/helpers/runWorkflowScript.ts` and import it from both files). The fake `agent` records every `(prompt, options)` pair. Call 1 returns the real hook output. Call 2 returns `{ ok: true, ran: ["pipeline-implementTask.mmd::IMPLEMENT_TASK"], errors: [], outcome: { next: null, payload: "/tmp/q.json" } }`.
- The `input` value on line 102 is visible as the JSON after `/run-step pipeline-implementTask.mmd::IMPLEMENT_TASK ` in call 2's prompt. Parse it.

Tests:
- `test_workflow_inputAndAgentCallCarryTheDefaultBandWhenTheTaskHasNoOverride`: no `agent` on the task entry. Call 2's options have `model: "claude-opus-4-8[1m]"` and `effort: "high"`. Call 2's parsed `input.agent` deep-equals `{ model: "claude-opus-4-8[1m]", effort: "high" }`. Call 1's options have `model: "haiku"` and `effort: "low"`.
- `test_workflow_inputAndAgentCallCarryTheTaskOverride`: the task entry has `agent: { IMPLEMENT_TASK: { model: "claude-sonnet-5[1m]", effort: "medium" } }`. Call 2's options have `model: "claude-sonnet-5[1m]"` and `effort: "medium"`. Call 2's parsed `input.agent` deep-equals `{ model: "claude-sonnet-5[1m]", effort: "medium" }`.
- `test_workflow_labelsTheWorkerCallWithThePromptBlock`: call 2's options have `label: "run-step:IMPLEMENT_TASK"`.
- `test_workflow_aBareStartingBlockGetsThatBlocksAgentOptions`: the task entry has the Sonnet effort medium override. Run the script with `args.startingBlock: "IMPLEMENT_TASK"` and a fake `agent` whose first result is the stop result above. Call 1's options have `model: "claude-sonnet-5[1m]"` and `effort: "medium"`, and call 1's prompt holds `/run-step pipeline-implementTask.mmd::IMPLEMENT_TASK`.

### Step 6: end-to-end drivers follow the two-stop rhythm

File: `tests/tackleTasksAcceptance.test.ts`. It has three loops that drive the real hook: `driveRun` at line 92, the inline child driver at line 222, and the fixed two-hop loop in `test_acceptance_resumesAfterAnInterruptedCleanup` at line 325. `tests/taskWorkflowPlanImplementStage.test.ts` and `tests/taskWorkflowMergeStage.test.ts` load the frozen v1.1 workflow and never run this hook; leave them alone. Run `rg -n "runStepHook|RUN_STEP_HOOK_PATH|runHookOnce" tests scripts --glob '*.test.ts'` to confirm no other driver exists.

1. In each of the three loops, read the payload file. If it has a `prompt` key, look up the scripted answer for the stopped box and write it, throwing when none exists, as today. If it has no `prompt` key, write nothing. Then continue with `box = result.outcome.next` and `input = { packetFile }` as today. The two-hop loop at line 325 must become a loop that runs until it has written two answers, because walker stops now sit between the hops.
2. `test_driveRun_dispatchesToTheBoxThatActuallyStoppedNotTheOneThePassStartedAt` (line 110) still expects the throw to name IMPLEMENT_TASK. The throw now happens on the prompt stop at IMPLEMENT_TASK.
3. Add `test_driveRun_stopsBeforeEveryPromptBlockWithItsAgentOptions`: fixture task difficulty 5. Collect every `outcome`. Assert the one whose `next` ends in `::IMPLEMENT_TASK` carries `agent` equal to `{ model: "claude-sonnet-5[1m]", effort: "xhigh" }`. Assert the one whose `next` ends in `::CODEX_REVIEWS_PLAN` carries `{ model: "haiku", effort: "low" }`. Assert the one whose `next` ends in `::COMMIT_IMPLEMENTATION_IF_NEEDED` carries `{ model: "haiku", effort: "low" }`.

### Step 7: task 37 is closed by this change

The agent label is `run-step:${blockName}` where `blockName` comes from `blockToRun`. After Step 3, `blockToRun` is the prompt block for every worker pass, so `/workflows` shows `run-step:IMPLEMENT_TASK` while the implementer runs. No code change. Mark session task 37 done with TaskUpdate when Step 6 is green.

## Verification

1. Per step: `node --test <file>` for the files that step touched.
2. Whole suite: `npm run test:baseline`. It exits non-zero only on failures outside `.taskTools/knownFailingTests.json`.
3. `git diff scripts/tackle-tasks/diagram-steps.json` must be empty.
4. Live check: run `/tackle-tasks N` for a task with difficulty 5. In `.taskTools/workflows/N/steps.json`, `IMPLEMENT_TASK.agent` is the Sonnet band, `CODEX_REVIEWS_PLAN.agent` is haiku, and `IS_DIFFICULTY_7_PLUS_Q.agent` is haiku. In `.taskTools/workflows/N/workflow.js`, the keys of `AGENT_BY_BLOCK` equal every `diagram::box` key in that steps.json. Check with:
   ```sh
   jq -r 'to_entries[] | .key as $d | .value[] | "\($d)::\(.box)"' .taskTools/workflows/N/steps.json | sort > /tmp/steps-keys.txt
   node -e 'const s=require("fs").readFileSync(".taskTools/workflows/N/workflow.js","utf8");const m=s.slice(s.indexOf("const AGENT_BY_BLOCK = ")+23);console.log(Object.keys(JSON.parse(m.slice(0,m.indexOf("\n}")+2))).sort().join("\n"))' > /tmp/map-keys.txt
   diff /tmp/steps-keys.txt /tmp/map-keys.txt
   ```
   While the run is live, `/workflows` shows `run-step:PLAN_THE_TASK`, then `run-step:IMPLEMENT_TASK`, as their agents run.

## Example flow, task 42 at difficulty 5, no override

1. Walker on haiku from PREAMBLE_STATUS_CHECK. The hook runs the eleven preamble blocks through IS_DIFFICULTY_7_PLUS_Q, sees PLAN_THE_TASK next, stops. Returns `next: PLAN_THE_TASK`, the packet, `agent: Sonnet band`.
2. Worker on Sonnet at PLAN_THE_TASK. The block prints the prompt. The agent plans, writes the answer. Returns `next: WHAT_DID_THE_PLANNER_RETURN`, `agent: haiku`.
3. Walker on haiku. Runs WHAT_DID_THE_PLANNER_RETURN, sees CODEX_REVIEWS_PLAN next, stops. Returns `agent: haiku`, because CODEX_REVIEWS_PLAN is not a band block.
4. Worker on haiku at CODEX_REVIEWS_PLAN. Runs codex, relays its answer. Returns `next: WHAT_IS_REVIEW_VERDICT`, `agent: haiku`.
5. Walker on haiku. Runs WHAT_IS_REVIEW_VERDICT, sees IMPLEMENT_TASK next, stops. Returns `agent: Sonnet band`.
6. Worker on Sonnet at IMPLEMENT_TASK. Implements, writes the answer. Returns `next: COMMIT_IMPLEMENTATION_IF_NEEDED`, `agent: haiku`.
7. Walker on haiku. Runs the commit, test, lock, rebase, suite, merge and success-exit blocks to the stop. Returns `next: null`.

## Out of scope

- Validation of model id strings. A wrong id fails at the first `agent()` call.
