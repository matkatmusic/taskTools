import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

// A folder's .git can be a submodule's; the real project root is the outermost superproject.
function findSuperprojectWorkingTree(folder: string): string | null {
  const superprojectPath = execFileSync(
    "git", ["-C", folder, "rev-parse", "--show-superproject-working-tree"], { encoding: "utf8" },
  ).trim();
  const hasSuperproject = superprojectPath.length > 0;
  if (hasSuperproject)
    return superprojectPath;
  return null;
}

export function getProjectRoot(cwd: string): string {
  let current = cwd;
  while (true) {
    const hasGit = existsSync(join(current, ".git"));
    if (hasGit) {
      const superprojectPath = findSuperprojectWorkingTree(current);
      if (superprojectPath !== null) {
        current = superprojectPath;
        continue;
      }
      return current;
    }
    const parent = dirname(current);
    const reachedFilesystemRoot = parent === current;
    if (reachedFilesystemRoot)
      throw new Error(`getProjectRoot: reached filesystem root without finding .git, starting from ${cwd}`);
    current = parent;
  }
}

// function findPackageJsonFolderOrUndefined(projectRootPath: string): string | undefined {
//   let queue = [projectRootPath];
//   while (queue.length > 0) {
//     const nextQueue: string[] = [];
//     for (const dir of queue) {
//       const entries = readdirSync(dir);
//       const hasPackageJson = entries.includes("package.json");
//       if (hasPackageJson)
//         return dir;
//       for (const entry of entries) {
//         const isExcluded = entry === "node_modules" || entry === ".git";
//         if (isExcluded)
//           continue;
//         const entryPath = join(dir, entry);
//         const isDirectory = statSync(entryPath).isDirectory();
//         if (isDirectory)
//           nextQueue.push(entryPath);
//       }
//     }
//     queue = nextQueue;
//   }
//   return undefined;
// }

// export function findPackageJsonFolder(projectRootPath: string): string {
//   const folder = findPackageJsonFolderOrUndefined(projectRootPath);
//   if (folder === undefined)
//     throw new Error(`findPackageJsonFolder: no package.json found under ${projectRootPath}`);
//   return folder;
// }

export function findNearestPackageJson(filePath: string): string | null {
  const root = realpathSync(getProjectRoot(filePath));
  const isDirectory = statSync(filePath).isDirectory();
  let current = isDirectory ? filePath : dirname(filePath);
  while (true) {
    const candidate = join(current, "package.json");
    if (existsSync(candidate))
      return candidate;
    const reachedRoot = realpathSync(current) === root;
    if (reachedRoot)
      return null;
    const parent = dirname(current);
    const reachedFilesystemRoot = parent === current;
    if (reachedFilesystemRoot)
      throw new Error(`findNearestPackageJson: reached filesystem root without finding package.json or ${root}, starting from ${filePath}`);
    current = parent;
  }
}

// export function ensurePackageJsonExists(projectRootPath: string): boolean {
//   return findPackageJsonFolderOrUndefined(projectRootPath) !== undefined;
// }
