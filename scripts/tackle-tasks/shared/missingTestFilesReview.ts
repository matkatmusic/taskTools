// Fills the review-tests ERROR shape with the real missing paths, so the reviewer never hand-edits the placeholder.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const REVIEW_TESTS_ERROR_TEMPLATE_PATH = fileURLToPath(new URL("../../../plans/review-tests-error-template.json", import.meta.url));

export function missingTestFilesReview(missingPaths: string[]): string {
    const template = JSON.parse(readFileSync(REVIEW_TESTS_ERROR_TEMPLATE_PATH, "utf8"));
    return JSON.stringify({ ...template, missingFiles: missingPaths });
}

if (process.argv[1]?.endsWith("missingTestFilesReview.ts")) {
    const missingPaths = process.argv.slice(2);
    if (missingPaths.length === 0) {
        process.stderr.write(`usage: node missingTestFilesReview.ts <missing path> [<missing path> ...]\n`);
        process.exit(1);
    }
    process.stdout.write(`${missingTestFilesReview(missingPaths)}\n`);
}
