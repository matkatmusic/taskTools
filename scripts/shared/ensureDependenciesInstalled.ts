import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

// Same submodule listing as runStepHook.ts buildRewindPoints.
export function ensureDependenciesInstalled(worktree: string): void {
  const submodulePaths = spawnSync("git", ["-C", worktree, "submodule", "foreach", "--recursive", "--quiet", "echo \"$displaypath\""], { encoding: "utf8" }).stdout.split("\n").filter(Boolean);
  for (const relativePath of ["", ...submodulePaths]) {
    const checkoutPath = relativePath === "" ? worktree : join(worktree, relativePath);
    const hasPackageJson = existsSync(join(checkoutPath, "package.json"));
    const hasNodeModules = existsSync(join(checkoutPath, "node_modules"));
    const hasLockfile = existsSync(join(checkoutPath, "package-lock.json"));
    if (!hasPackageJson || hasNodeModules) continue;
    if (hasLockfile) {
      execFileSync("npm", ["ci", "--no-audit", "--no-fund"], { cwd: checkoutPath, stdio: ["ignore", "pipe", "pipe"] });
    } else {
      execFileSync("npm", ["install", "--no-audit", "--no-fund", "--no-package-lock"], { cwd: checkoutPath, stdio: ["ignore", "pipe", "pipe"] });
    }
  }
}
