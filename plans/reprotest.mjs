const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
const fn = new AsyncFunction('return (await import("./scripts/mergeTaskWorktrees.ts")).mergeTaskDeepestFirst')
try {
  const r = await fn()
  console.log("resolved ok", typeof r)
} catch (e) {
  console.log("failed:", e.message)
}
