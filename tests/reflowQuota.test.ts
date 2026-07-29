// applyQuota: block until one flagged comment is fixed per session, then stay silent except for new offenders.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyQuota } from "../scripts/reflowQuota.ts";

const SESSION = "test-session";
const longComment = (label: string) =>
  `// ${label} ${Array.from({ length: 22 }, (_, n) => `word${n}`).join(" ")}`;

function makeQuotaFixture() {
  const dir = mkdtempSync(join(tmpdir(), "reflow-quota-"));
  const filePath = join(dir, "target.ts");
  return { quotaDir: join(dir, "state"), filePath };
}

const readState = (quotaDir: string) =>
  JSON.parse(readFileSync(join(quotaDir, `${SESSION}.json`), "utf8"));

test("first sighting blocks, lists all over-cap lines, and stores the baseline", () => {
  const { quotaDir, filePath } = makeQuotaFixture();
  // The file has two over-cap comments on lines 1 and 3.
  writeFileSync(filePath, [longComment("alpha"), "const x = 1;", longComment("beta")].join("\n"));
  // First sighting: both lines block and both texts become the baseline.
  const blocking = applyQuota(SESSION, [{ path: filePath, lines: [1, 3] }], quotaDir);
  assert.deepEqual(blocking, [{ path: filePath, lines: [1, 3] }]);
  assert.deepEqual(readState(quotaDir)[filePath], {
    baseline: [longComment("alpha"), longComment("beta")],
    satisfied: false,
  });
});

test("a repeat sighting with nothing fixed blocks again", () => {
  const { quotaDir, filePath } = makeQuotaFixture();
  writeFileSync(filePath, [longComment("alpha"), longComment("beta")].join("\n"));
  applyQuota(SESSION, [{ path: filePath, lines: [1, 2] }], quotaDir);
  // Nothing changed on disk, so the same lines block again.
  const blocking = applyQuota(SESSION, [{ path: filePath, lines: [1, 2] }], quotaDir);
  assert.deepEqual(blocking, [{ path: filePath, lines: [1, 2] }]);
  assert.equal(readState(quotaDir)[filePath].satisfied, false);
});

test("fixing one baseline comment satisfies the quota and silences the file", () => {
  const { quotaDir, filePath } = makeQuotaFixture();
  writeFileSync(filePath, [longComment("alpha"), longComment("beta")].join("\n"));
  applyQuota(SESSION, [{ path: filePath, lines: [1, 2] }], quotaDir);
  // The alpha comment was rewritten under the cap, so only beta is still over-cap.
  writeFileSync(filePath, ["// alpha, now short", longComment("beta")].join("\n"));
  const blocking = applyQuota(SESSION, [{ path: filePath, lines: [2] }], quotaDir);
  assert.deepEqual(blocking, []);
  assert.equal(readState(quotaDir)[filePath].satisfied, true);
});

test("a satisfied file with remaining baseline comments stays silent", () => {
  const { quotaDir, filePath } = makeQuotaFixture();
  writeFileSync(filePath, [longComment("alpha"), longComment("beta")].join("\n"));
  applyQuota(SESSION, [{ path: filePath, lines: [1, 2] }], quotaDir);
  writeFileSync(filePath, ["// alpha, now short", longComment("beta")].join("\n"));
  applyQuota(SESSION, [{ path: filePath, lines: [2] }], quotaDir);
  // beta is still over-cap on a later sighting, but the quota was already met.
  const blocking = applyQuota(SESSION, [{ path: filePath, lines: [2] }], quotaDir);
  assert.deepEqual(blocking, []);
});

test("a new over-cap comment after satisfaction blocks alone", () => {
  const { quotaDir, filePath } = makeQuotaFixture();
  writeFileSync(filePath, [longComment("alpha"), longComment("beta")].join("\n"));
  applyQuota(SESSION, [{ path: filePath, lines: [1, 2] }], quotaDir);
  writeFileSync(filePath, ["// alpha, now short", longComment("beta")].join("\n"));
  applyQuota(SESSION, [{ path: filePath, lines: [2] }], quotaDir);
  // A brand-new verbose comment appears on line 3; only it blocks, not the baseline beta.
  writeFileSync(filePath, ["// alpha, now short", longComment("beta"), longComment("gamma")].join("\n"));
  const blocking = applyQuota(SESSION, [{ path: filePath, lines: [2, 3] }], quotaDir);
  assert.deepEqual(blocking, [{ path: filePath, lines: [3] }]);
});

test("fixing the new comment restores silence", () => {
  const { quotaDir, filePath } = makeQuotaFixture();
  writeFileSync(filePath, [longComment("alpha")].join("\n"));
  applyQuota(SESSION, [{ path: filePath, lines: [1] }], quotaDir);
  writeFileSync(filePath, ["// alpha, now short", longComment("gamma")].join("\n"));
  applyQuota(SESSION, [{ path: filePath, lines: [2] }], quotaDir);
  // gamma gets rewritten under the cap, so the file has no over-cap runs at all.
  writeFileSync(filePath, ["// alpha, now short", "// gamma, now short"].join("\n"));
  const blocking = applyQuota(SESSION, [], quotaDir);
  assert.deepEqual(blocking, []);
});

test("line shifts alone are not counted as fixes", () => {
  const { quotaDir, filePath } = makeQuotaFixture();
  writeFileSync(filePath, [longComment("alpha"), longComment("beta")].join("\n"));
  applyQuota(SESSION, [{ path: filePath, lines: [1, 2] }], quotaDir);
  // Code inserted above shifts both comments down; their texts are unchanged.
  writeFileSync(filePath, ["const a = 1;", longComment("alpha"), longComment("beta")].join("\n"));
  const blocking = applyQuota(SESSION, [{ path: filePath, lines: [2, 3] }], quotaDir);
  assert.deepEqual(blocking, [{ path: filePath, lines: [2, 3] }]);
  assert.equal(readState(quotaDir)[filePath].satisfied, false);
});

test("replacing a baseline comment with a reworded over-cap one satisfies the quota but keeps blocking the new text", () => {
  const { quotaDir, filePath } = makeQuotaFixture();
  writeFileSync(filePath, [longComment("alpha"), longComment("beta")].join("\n"));
  applyQuota(SESSION, [{ path: filePath, lines: [1, 2] }], quotaDir);
  // alpha reworded yet still over-cap: old text gone (quota met), new text is a fresh offender.
  writeFileSync(filePath, [longComment("alpha-reworded"), longComment("beta")].join("\n"));
  const blocking = applyQuota(SESSION, [{ path: filePath, lines: [1, 2] }], quotaDir);
  assert.deepEqual(blocking, [{ path: filePath, lines: [1] }]);
  assert.equal(readState(quotaDir)[filePath].satisfied, true);
});

test("the baseline is never mutated after creation", () => {
  const { quotaDir, filePath } = makeQuotaFixture();
  writeFileSync(filePath, [longComment("alpha"), longComment("beta")].join("\n"));
  applyQuota(SESSION, [{ path: filePath, lines: [1, 2] }], quotaDir);
  writeFileSync(filePath, ["// alpha, now short", longComment("beta"), longComment("gamma")].join("\n"));
  applyQuota(SESSION, [{ path: filePath, lines: [2, 3] }], quotaDir);
  // gamma must not have been absorbed into the baseline as existing debt.
  assert.deepEqual(readState(quotaDir)[filePath].baseline, [longComment("alpha"), longComment("beta")]);
});
