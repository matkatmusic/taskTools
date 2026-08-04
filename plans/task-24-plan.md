# Task 24 Plan: Opaque finalization authorization token

Source brief: `plans/brief-24.md`. New module only, two files, no edits to any existing file.

## Files

- `scripts/runAuthorization.ts` (new)
- `tests/runAuthorization.test.ts` (new)

## Design (the "why" behind every line below)

The finalizer must not be callable without a token, and a token must not be
forgeable out of an ordinary object (e.g. manifest data that happens to have
a `stateDigest` field). Two independent mechanisms produce that guarantee,
and both are needed — one alone doesn't cover it:

1. **Compile-time**: `runFinalization`'s first parameter is typed
   `RunAuthorizationToken`, a required (non-optional) parameter. Omitting it
   is a TypeScript arity error — "impossible to express", not a runtime
   `if (!token) throw`.
2. **Runtime**: because Bun strips types without checking them, a caller can
   still reach `runFinalization` with the wrong value at runtime (e.g. by
   shifting positional args, or via an `any`-typed caller). So the token
   type is also branded with a `unique symbol` that is declared but never
   exported from the module. An ordinary object literal — including one
   that copies a real token's `stateDigest` value — cannot carry that
   symbol-keyed property, so it fails both the TS structural check *and* a
   runtime `isRunAuthorizationToken` guard that inspects for the symbol key
   before trusting anything about the value.

Only one constructor function exists: `issueRunAuthorization(stateDigest)`.
There is no separate "test constructor" — the brief says tests may
construct one directly, which just means tests are allowed to import and
call `issueRunAuthorization` the same way the future Phase 4 approval
recorder will. The restriction ("only the approval recorder may issue one
in production") isn't a runtime check — it's enforced by an import-scan
test (last bullet below) that fails the day some other production module
starts importing the constructor.

`runFinalization` takes the token, the current state digest, and a
`mutate` callback. It validates the token, compares digests, and only then
invokes `mutate`. There's no real mutation logic to wire up yet (brief:
"no production call sites yet") — `mutate` is the seam a later phase will
fill with actual finalization work; today the tests only prove the gate
opens/closes correctly around whatever callback is passed in.

## Step-by-step (TDD: red, then minimum green)

### Step 1 — write the failing test file first

Create `tests/runAuthorization.test.ts` with these five tests, matching
this repo's existing Bun test conventions (see `tests/relatedTests.test.ts`
for import style / `describe`/`test` usage — match it, don't invent a new
style). Run against the not-yet-created module so they fail on import
first (red).

```ts
import { describe, test, expect } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { issueRunAuthorization, runFinalization } from "../scripts/runAuthorization";

describe("runFinalization", () => {
    test("rejects a call missing the authorization token", () => {
        // Omitting the token shifts args; runtime guard must reject the resulting non-token value.
        // @ts-expect-error - omitting the token is the behavior under test
        expect(() => runFinalization("some-digest", () => "mutated")).toThrow();
    });

    test("rejects a token whose digest no longer matches current state", () => {
        // Token issued for digest-a; finalizing against digest-b must throw and skip mutate.
        const token = issueRunAuthorization("digest-a");
        let mutateCallCount = 0;
        const mutate = () => { mutateCallCount++; return "mutated"; };
        expect(() => runFinalization(token, "digest-b", mutate)).toThrow();
        expect(mutateCallCount).toBe(0);
    });

    test("accepts a token whose digest matches current state", () => {
        // Token and current digest match, so mutate must run once and return its result.
        const token = issueRunAuthorization("digest-a");
        let mutateCallCount = 0;
        const mutate = () => { mutateCallCount++; return "mutated"; };
        const result = runFinalization(token, "digest-a", mutate);
        expect(result).toBe("mutated");
        expect(mutateCallCount).toBe(1);
    });

    test("no production module other than the Phase 4 approval recorder imports issueRunAuthorization", () => {
        // Scan scripts/ for issueRunAuthorization imports; only allowlisted files (future approval recorder) may use it.
        const allowedImporters = new Set<string>([]);
        const scriptsDir = path.join(__dirname, "..", "scripts");
        const scriptFiles = fs.readdirSync(scriptsDir).filter((file) => file.endsWith(".ts") && file !== "runAuthorization.ts");
        for (const file of scriptFiles) {
            const contents = fs.readFileSync(path.join(scriptsDir, file), "utf8");
            if (contents.includes("issueRunAuthorization")) {
                expect(allowedImporters.has(file)).toBe(true);
            }
        }
    });
});
```

Run the suite, confirm it fails only because `scripts/runAuthorization.ts`
doesn't exist yet (import error), not for any other reason.

### Step 2 — write the minimum module to go green

Create `scripts/runAuthorization.ts`:

```ts
const runAuthorizationBrand: unique symbol = Symbol("RunAuthorizationToken");

export type RunAuthorizationToken = {
    readonly [runAuthorizationBrand]: true;
    readonly stateDigest: string;
};

export function issueRunAuthorization(stateDigest: string): RunAuthorizationToken {
    return { [runAuthorizationBrand]: true, stateDigest };
}

function isRunAuthorizationToken(value: unknown): value is RunAuthorizationToken {
    return typeof value === "object" && value !== null && runAuthorizationBrand in value;
}

export function runFinalization<T>(token: RunAuthorizationToken, currentStateDigest: string, mutate: () => T): T {
    if (!isRunAuthorizationToken(token)) {
        throw new Error("runFinalization requires a RunAuthorizationToken issued by issueRunAuthorization");
    }
    if (token.stateDigest !== currentStateDigest) {
        throw new Error(`runAuthorization token digest "${token.stateDigest}" does not match current state digest "${currentStateDigest}"`);
    }
    return mutate();
}
```

### Step 3 — verify green, then stop

Run the test file. All five tests must pass. Do not add anything beyond
this: no exported `isRunAuthorizationToken` (not needed by any test), no
separate test-only constructor (brief says tests use the same one), no
wiring into any existing finalizer (brief says none exists as a call site
yet).

## Explicit scope boundaries (ponytail)

- Skipped: a runtime test that forges a token by casting a plain
  `{ stateDigest }` object to `RunAuthorizationToken` — the brand/symbol
  design already makes that a TS structural-type error, and the brief's
  four required tests don't ask for a separate runtime proof of it. Add one
  if the approval-recorder phase needs to double-check the guard against a
  hostile `any`-typed caller.
- Skipped: exporting `isRunAuthorizationToken` or the brand symbol — nothing
  in this task's tests needs to reach it from outside the module, and
  exporting the symbol would defeat the "not forgeable" guarantee.
- Skipped: recursive directory walk in the import-scan test — brief's repo
  layout keeps `scripts/` flat; switch to a recursive walk only if a
  subdirectory under `scripts/` is introduced later.
- Not touched: any existing file. This task adds exactly the two files
  above.
