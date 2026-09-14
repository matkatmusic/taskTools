// Deterministic, tsconfig-driven answer to "would compiling this .ts file emit this exact .js path?"
// ponytail: tsconfig only, no `extends` resolution and no inferred rootDir; a bundler-driven generated file needs its own check when that class of bug shows up.
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, extname, join, relative } from "node:path";

type CompilerOptions = { outDir?: string; rootDir?: string; noEmit?: boolean; emitDeclarationOnly?: boolean };

function stripJsonComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1")
    .replace(/,(\s*[}\]])/g, "$1");
}

function findNearestTsconfig(checkoutPath: string, sourceRelativePath: string): string | null {
  let dir = join(checkoutPath, dirname(sourceRelativePath));
  while (true) {
    const candidate = join(dir, "tsconfig.json");
    if (existsSync(candidate))
      return candidate;
    if (dir === checkoutPath)
      return null;
    const parent = dirname(dir);
    if (parent === dir)
      return null;
    dir = parent;
  }
}

function readCompilerOptions(tsconfigPath: string): CompilerOptions {
  const parsed = JSON.parse(stripJsonComments(readFileSync(tsconfigPath, "utf8")));
  return parsed.compilerOptions ?? {};
}

// True only when the repo's own tsconfig.json says compiling sourceRelativePath emits exactly candidateRelativePath.
export function isCompiledOutputOf(checkoutPath: string, sourceRelativePath: string, candidateRelativePath: string): boolean {
  const tsconfigPath = findNearestTsconfig(checkoutPath, sourceRelativePath);
  if (tsconfigPath === null)
    return false;
  const options = readCompilerOptions(tsconfigPath);
  if (options.noEmit === true || options.emitDeclarationOnly === true)
    return false;

  const tsconfigDir = dirname(tsconfigPath);
  const sourceAbsolutePath = join(checkoutPath, sourceRelativePath);
  const sourceStemName = basename(sourceRelativePath, extname(sourceRelativePath));

  let expectedAbsolutePath: string;
  if (options.outDir === undefined) {
    expectedAbsolutePath = join(dirname(sourceAbsolutePath), `${sourceStemName}.js`);
  }
  else {
    if (options.rootDir === undefined)
      return false;
    const rootDirAbsolute = join(tsconfigDir, options.rootDir);
    const outDirAbsolute = join(tsconfigDir, options.outDir);
    const sourceDirFromRoot = relative(rootDirAbsolute, dirname(sourceAbsolutePath));
    expectedAbsolutePath = join(outDirAbsolute, sourceDirFromRoot, `${sourceStemName}.js`);
  }

  return join(checkoutPath, candidateRelativePath) === expectedAbsolutePath;
}
