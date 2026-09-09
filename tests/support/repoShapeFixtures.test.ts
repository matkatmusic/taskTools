import test from "node:test";
import assert from "node:assert";
import { git } from "./gitFixtures.ts";
import { makeShapeFixture, type RepoShape, type StagingState } from "./repoShapeFixtures.ts";

const shapes: RepoShape[] = ["none", "one-submodule", "two-submodules", "two-submodules-nested"];
const states: StagingState[] = ["absent", "at-head", "behind-head", "ahead-head"];

for (const shape of shapes) {
    for (const state of states) {
        test(`${shape} / ${state}`, () => {
            const fixture = makeShapeFixture(shape, state, 42);
            for (const repo of fixture.repos) {
                assert.match(repo.headTip, /^[0-9a-f]{40}$/);
                assert.strictEqual(repo.stagingTip === null, state === "absent");
                if (state === "behind-head") {
                    assert.notStrictEqual(repo.stagingTip, repo.headTip);
                    git(repo.checkoutPath, "merge-base", "--is-ancestor", repo.stagingTip as string, repo.headTip);
                }
                if (state === "ahead-head") {
                    const parents = git(repo.checkoutPath, "rev-list", "--parents", "-n", "1", "staging").split(" ");
                    assert.strictEqual(parents.length, 3);
                    const reachesOldTip = git(repo.checkoutPath, "merge-base", parents[2], repo.headTip);
                    assert.strictEqual(reachesOldTip, repo.headTip);
                }
            }
        });
    }
}
