// Behavioral checks for compiledOutputPaths.ts: does tsconfig.json say this .js is that .ts compiled?
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isCompiledOutputOf } from "./compiledOutputPaths.ts";

function makeCheckout(): string {
    return mkdtempSync(join(tmpdir(), "compiled-output-"));
}

test("test_isCompiledOutputOf_trueWhenNoOutDirEmitsBesideTheSource", () => {
    const checkout = makeCheckout();
    mkdirSync(join(checkout, "src"));
    writeFileSync(join(checkout, "tsconfig.json"), JSON.stringify({ compilerOptions: {} }));

    assert.equal(isCompiledOutputOf(checkout, "src/viewer.ts", "src/viewer.js"), true);
});

test("test_isCompiledOutputOf_falseWhenNoTsconfigExistsAnywhereAbove", () => {
    const checkout = makeCheckout();
    mkdirSync(join(checkout, "src"));

    assert.equal(isCompiledOutputOf(checkout, "src/viewer.ts", "src/viewer.js"), false);
});

test("test_isCompiledOutputOf_falseWhenNoEmitIsSet", () => {
    const checkout = makeCheckout();
    mkdirSync(join(checkout, "src"));
    writeFileSync(join(checkout, "tsconfig.json"), JSON.stringify({ compilerOptions: { noEmit: true } }));

    assert.equal(isCompiledOutputOf(checkout, "src/viewer.ts", "src/viewer.js"), false);
});

test("test_isCompiledOutputOf_falseWhenEmitDeclarationOnlyIsSet", () => {
    const checkout = makeCheckout();
    mkdirSync(join(checkout, "src"));
    writeFileSync(join(checkout, "tsconfig.json"), JSON.stringify({ compilerOptions: { emitDeclarationOnly: true } }));

    assert.equal(isCompiledOutputOf(checkout, "src/viewer.ts", "src/viewer.js"), false);
});

test("test_isCompiledOutputOf_trueWithOutDirAndRootDirMapping", () => {
    const checkout = makeCheckout();
    mkdirSync(join(checkout, "src"));
    writeFileSync(join(checkout, "tsconfig.json"), JSON.stringify({ compilerOptions: { rootDir: "src", outDir: "dist" } }));

    assert.equal(isCompiledOutputOf(checkout, "src/viewer.ts", "dist/viewer.js"), true);
});

test("test_isCompiledOutputOf_falseWhenOutDirSetButRootDirMissing", () => {
    const checkout = makeCheckout();
    mkdirSync(join(checkout, "src"));
    writeFileSync(join(checkout, "tsconfig.json"), JSON.stringify({ compilerOptions: { outDir: "dist" } }));

    assert.equal(isCompiledOutputOf(checkout, "src/viewer.ts", "dist/viewer.js"), false);
});

test("test_isCompiledOutputOf_falseWhenCandidateDoesNotMatchComputedOutputPath", () => {
    const checkout = makeCheckout();
    mkdirSync(join(checkout, "src"));
    writeFileSync(join(checkout, "tsconfig.json"), JSON.stringify({ compilerOptions: {} }));

    assert.equal(isCompiledOutputOf(checkout, "src/viewer.ts", "src/other.js"), false);
});

test("test_isCompiledOutputOf_walksUpToFindAnAncestorTsconfig", () => {
    const checkout = makeCheckout();
    mkdirSync(join(checkout, "src", "nested"), { recursive: true });
    writeFileSync(join(checkout, "tsconfig.json"), JSON.stringify({ compilerOptions: {} }));

    assert.equal(isCompiledOutputOf(checkout, "src/nested/viewer.ts", "src/nested/viewer.js"), true);
});
