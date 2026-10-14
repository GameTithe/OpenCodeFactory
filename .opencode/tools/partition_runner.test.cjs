const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const runner = require("./partition_runner.cjs");

function temporaryProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-runner-test-"));
  fs.mkdirSync(path.join(root, ".opencode", "orchestration"), { recursive: true });
  return root;
}

test("runner lock prevents a second runner and releases only its own lock", () => {
  const root = temporaryProject();
  try {
    const lock = runner.acquireRunnerLock(root);
    assert.equal(runner.readRunnerLock(root).token, lock.token);
    assert.throws(() => runner.acquireRunnerLock(root), /already active/);
    runner.releaseRunnerLock(root, { token: "not-the-owner" });
    assert.equal(runner.readRunnerLock(root).token, lock.token);
    runner.releaseRunnerLock(root, lock);
    assert.equal(runner.readRunnerLock(root), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("runner replaces a stale lock left by a terminated process", () => {
  const root = temporaryProject();
  try {
    fs.writeFileSync(runner.lockPath(root), JSON.stringify({ pid: 2147483647, token: "stale", startedAt: "2000-01-01T00:00:00.000Z" }));
    const lock = runner.acquireRunnerLock(root);
    assert.equal(runner.readRunnerLock(root).token, lock.token);
    runner.releaseRunnerLock(root, lock);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("interrupted runs require recovery and prevent dependent work from running", () => {
  const state = runner.defaultState();
  state.run = { status: "running", currentPartitionID: "P001", startedAt: "now", updatedAt: "now" };
  state.partitions.P001 = { status: "running" };
  state.activeTask = { taskID: "P001-T001", taskKey: "P001::P001-T001" };
  state.tasks["P001::P001-T001"] = { partitionID: "P001", status: "running" };
  assert.equal(runner.recoverInterruptedRun(state), true);
  assert.equal(state.partitions.P001.status, "needs_attention");
  assert.equal(state.tasks["P001::P001-T001"].status, "interrupted");
  assert.equal(state.activeTask, null);
  assert.equal(state.recovery.partitionID, "P001");

  const plan = {
    partitions: [
      { id: "P001", dependsOn: [] },
      { id: "P002", dependsOn: ["P001"] },
    ],
  };
  assert.equal(runner.nextPartition(plan, state), undefined);
});

test("next runnable partition waits for completed dependencies", () => {
  const state = runner.defaultState();
  state.partitions.P001 = { status: "completed" };
  const plan = {
    partitions: [
      { id: "P001", dependsOn: [] },
      { id: "P002", dependsOn: ["P001"] },
    ],
  };
  assert.equal(runner.nextPartition(plan, state).id, "P002");
});
