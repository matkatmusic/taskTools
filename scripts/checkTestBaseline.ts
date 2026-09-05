// Runs the suite and exits 1 only when a failure is not in .taskTools/knownFailingTests.json.  Run: node scripts/checkTestBaseline.ts
import { execFileSync } from "node:child_process";
import { judgeSuite, newFailingTests, parseFailingTests, readKnownFailingTests, runSuite } from "./taskTestsRunner.ts";

const projectRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const suite = runSuite(projectRoot);
const failing = suite.allPassing ? [] : parseFailingTests(suite.log);
const newFailures = newFailingTests(failing, readKnownFailingTests(projectRoot));
const passed = judgeSuite(suite.allPassing, failing, newFailures);

console.log(`failing: ${failing.length}, known: ${failing.length - newFailures.length}, new: ${newFailures.length}`);
for (const test of newFailures) console.log(`NEW ${test.file} — ${test.name}`);
if (!passed && failing.length === 0) console.log(suite.output);
console.log(passed ? "baseline ok" : "baseline broken");
process.exit(passed ? 0 : 1);
