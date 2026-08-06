// Emits the whole /review-plan prompt with paths resolved, read from "<plan path> <target...>" on stdin.
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Absolute, because the reviewer's shell has no CLAUDE_PLUGIN_ROOT to expand.
const RULING_SCRIPT = fileURLToPath(new URL("./planReviewRuling.ts", import.meta.url));

export function splitPlanPath(argumentString: string): { planPath: string; target: string } {
  const trimmed = argumentString.trim();
  const quote = trimmed.startsWith('"') || trimmed.startsWith("'") ? trimmed[0] : "";
  const end = quote ? trimmed.indexOf(quote, 1) : trimmed.search(/\s/);
  if (end === -1) return { planPath: quote ? trimmed.slice(1) : trimmed, target: "" };
  return { planPath: trimmed.slice(quote ? 1 : 0, end), target: trimmed.slice(end + 1).trim() };
}

// Where the plan lives once copied into plans/, so the brief never names a file outside the repo.
export function repoRelativePlanPath(planPath: string): string {
  const segments = planPath.split("/").filter(segment => segment !== "" && segment !== ".");
  const plansIndex = segments.lastIndexOf("plans");
  if (plansIndex !== -1) return segments.slice(plansIndex).join("/");
  return `plans/${segments.at(-1) ?? ""}`;
}

export function amendmentPath(planPath: string): string {
  return repoRelativePlanPath(planPath).replace(/(\.md)?$/, "-amendment.md");
}

// Copies an out-of-repo plan into plans/ so the brief only ever names files inside this project.
export function copyPlanToPlansFolder(plan: string, sourcePath: string): string {
  if (resolve(sourcePath) === resolve(plan)) return plan;
  if (existsSync(plan)) return plan;
  if (!existsSync(sourcePath)) return plan;
  mkdirSync(dirname(plan), { recursive: true });
  copyFileSync(sourcePath, plan);
  return plan;
}

export const reviewerBrief = (plan: string, target: string, amendment: string) => `
review ${plan} against ${target}.

check ${plan} for gotchas/failures/bugs/incorrect assumptions/errors/false statements/illusions/lies, by reading any file ${plan} references and any file ${plan} claims it will change — verify every claim against the source, never against ${plan}'s own account of it.

Ignore file-size claims or line-count claims, as they are not worth flagging. 

${plan}, the codebase, and git state are read-only — do not edit code, do not edit ${plan}, do not stage, do not commit. The one file you may create or modify is ${amendment}.

if ${amendment} already exists, this is not your first review of ${plan}.  The previous review's issues and durable fixes are already incorporated into ${plan}.  Clear (or delete) ${amendment} before you start, so you can write ${amendment} from scratch.  Do not reference any of your previous amendment findings from your context or memory when you draft your new amendment as they may be stale.

Every flagged issue must carry evidence: a citation listing each repo-relative file path followed by \`:\` and the line numbers you read, either a single line or an inclusive \`start-end\` range — as in \`[path/to/file.ts:12-40, other/file.ts:8]\`, meaning lines 12 through 40 of the first file and line 8 of the second. A command you ran and its output counts as evidence too. An issue you cannot evidence does not go in the report.

If a section of ${plan} holds up, say so and move on. Do not manufacture issues to fill the report — "no issues found" is a valid and useful result.

Once you have settled on your list of durable fixes, count them and run:

\`node ${RULING_SCRIPT} ${plan} <the number of fixes>\`

It prints three lines — Sections, Efficacy, Ruling. Copy them verbatim into the template below. Do not compute the sections, efficacy, or ruling yourself, and do not reword what it prints.

amendment format — write ${amendment} using exactly this template:

\`\`\`markdown
# Amendment: <plan title>

- Plan reviewed: ${plan}
- Reviewed against: ${target}
<the three lines printed by planReviewRuling.ts, verbatim>

## Issues

### 1. <short title>

- Evidence: \`[path/to/file.ts:12-40]\`
- The plan claims: <quote or close paraphrase>
- Actually true: <what the source shows>

<repeat one block per issue; write "None found." if there are none>

## Durable fixes

### Fix for issue 1

- Change: <the concrete edit to make to ${plan}>
- Durable because: <why this will not regress the same way>

<repeat one block per issue; omit this section if there are no issues>

## Sections that hold up

- <section name> — verified against \`path/to/file.ts:12-40\`
\`\`\`
`;

function readStdin(): string {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

// Arguments arrive on stdin, so an empty read must stop here rather than emit a brief pointing nowhere.
function fail(problem: string): never {
  process.stderr.write(
    `reviewPlanBrief: ${problem}\n` +
      `usage: node reviewPlanBrief.ts <<'REVIEWPLANEOF'\n<plan file path> <target...>\nREVIEWPLANEOF\n`,
  );
  process.exit(1);
}

if (process.argv[1]?.endsWith("reviewPlanBrief.ts")) {
  const { planPath, target } = splitPlanPath(readStdin());
  if (planPath === "") fail("no plan file path on stdin");
  if (target === "") fail(`no target given after the plan file path ${planPath}`);
  const plan = copyPlanToPlansFolder(repoRelativePlanPath(planPath), planPath);
  if (!existsSync(plan)) fail(`plan file does not exist: ${planPath}`);
  process.stdout.write(reviewerBrief(resolve(plan), target, resolve(amendmentPath(planPath))));
}
