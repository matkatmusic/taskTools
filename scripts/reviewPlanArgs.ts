// Splits "<plan path> <target...>" for review-plan: --target or --amendment to stdout.

export function splitPlanPath(argumentString: string): { planPath: string; target: string } {
  const trimmed = argumentString.trim();
  const quote = trimmed.startsWith('"') || trimmed.startsWith("'") ? trimmed[0] : "";
  const end = quote ? trimmed.indexOf(quote, 1) : trimmed.search(/\s/);
  if (end === -1) return { planPath: quote ? trimmed.slice(1) : trimmed, target: "" };
  return { planPath: trimmed.slice(quote ? 1 : 0, end), target: trimmed.slice(end + 1).trim() };
}

export function amendmentPath(planPath: string): string {
  const baseName = (planPath.split("/").pop() ?? "").replace(/\.md$/, "");
  return `plans/${baseName}-amendment.md`;
}

if (process.argv[1]?.endsWith("reviewPlanArgs.ts")) {
  const [mode, ...rest] = process.argv.slice(2);
  const { planPath, target } = splitPlanPath(rest.join(" "));
  process.stdout.write(`${mode === "--amendment" ? amendmentPath(planPath) : target}\n`);
}
