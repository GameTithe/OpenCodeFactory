const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const SERVER_URL = "http://127.0.0.1:4096";

function now() {
  return new Date().toISOString();
}

function parseArgs() {
  const projectFlag = process.argv.indexOf("--project");
  if (projectFlag === -1 || !process.argv[projectFlag + 1]) {
    throw new Error("Usage: node partition_runner.cjs --project <project-directory>");
  }
  return path.resolve(process.argv[projectFlag + 1]);
}

function planPath(projectRoot) {
  return path.join(projectRoot, "TODO", "plan.json");
}

function statePath(projectRoot) {
  return path.join(projectRoot, ".opencode", "orchestration", "state.json");
}

function lockPath(projectRoot) {
  return path.join(projectRoot, ".opencode", "orchestration", "runner.lock.json");
}

function loadJSON(file, message) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`${message}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function loadPlan(projectRoot) {
  const plan = loadJSON(planPath(projectRoot), "Unable to read TODO/plan.json");
  if (plan?.version !== 1 || !Array.isArray(plan.partitions)) {
    throw new Error("TODO/plan.json must contain version 1 and a partitions array.");
  }
  const ids = new Set();
  for (const partition of plan.partitions) {
    if (!partition?.id || !partition?.title || !partition?.goal || !Array.isArray(partition.acceptanceCriteria)) {
      throw new Error("Each partition requires id, title, goal, and acceptanceCriteria.");
    }
    if (ids.has(partition.id)) throw new Error(`Duplicate partition id: ${partition.id}`);
    ids.add(partition.id);
  }
  for (const partition of plan.partitions) {
    for (const dependency of partition.dependsOn ?? []) {
      if (!ids.has(dependency)) throw new Error(`${partition.id} depends on unknown partition ${dependency}.`);
    }
    const session = partition.session ?? { mode: "new" };
    if (!["new", "continue"].includes(session.mode)) {
      throw new Error(`${partition.id} session.mode must be new or continue.`);
    }
  }
  return plan;
}

function defaultState() {
  return {
    version: 2,
    policy: {
      maxTaskDurationMinutes: 20,
      maxRetries: 2,
      minimumContextHeadroom: 0.1,
      workerRotationHeadroom: 0.3,
    },
    paused: null,
    activeTask: null,
    tasks: {},
    partitions: {},
    sessions: {
      active: null,
    },
    run: {
      status: "idle",
      currentPartitionID: null,
      startedAt: null,
      updatedAt: null,
    },
  };
}

function loadState(projectRoot) {
  const file = statePath(projectRoot);
  if (!fs.existsSync(file)) return defaultState();
  const state = loadJSON(file, "Unable to read orchestration state");
  state.tasks ??= {};
  state.partitions ??= {};
  state.sessions ??= { active: null };
  state.run ??= defaultState().run;
  state.policy ??= defaultState().policy;
  return state;
}

function saveState(projectRoot, state) {
  fs.mkdirSync(path.dirname(statePath(projectRoot)), { recursive: true });
  state.run.updatedAt = now();
  const temporary = `${statePath(projectRoot)}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`);
  fs.renameSync(temporary, statePath(projectRoot));
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function readRunnerLock(projectRoot) {
  try {
    return JSON.parse(fs.readFileSync(lockPath(projectRoot), "utf8"));
  } catch {
    return null;
  }
}

function acquireRunnerLock(projectRoot) {
  const file = lockPath(projectRoot);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const token = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const record = { pid: process.pid, token, startedAt: now(), command: process.argv.join(" ") };
  try {
    fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, { flag: "wx" });
    return record;
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }

  const existing = readRunnerLock(projectRoot);
  if (existing && processAlive(existing.pid)) {
    throw new Error(`Another partition runner is already active (PID ${existing.pid}, started ${existing.startedAt ?? "unknown"}).`);
  }
  fs.rmSync(file, { force: true });
  fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, { flag: "wx" });
  return record;
}

function releaseRunnerLock(projectRoot, lock) {
  const existing = readRunnerLock(projectRoot);
  if (existing?.token === lock?.token) fs.rmSync(lockPath(projectRoot), { force: true });
}

function recoverInterruptedRun(state) {
  const partitionID = state.run?.currentPartitionID;
  if (!partitionID || state.partitions?.[partitionID]?.status !== "running") return false;
  const interruptedAt = now();
  const activeTaskKey = state.activeTask?.taskKey ?? state.activeTask?.taskID;
  if (activeTaskKey && state.tasks?.[activeTaskKey]) {
    state.tasks[activeTaskKey].status = "interrupted";
    state.tasks[activeTaskKey].updatedAt = interruptedAt;
  }
  state.activeTask = null;
  state.partitions[partitionID].status = "needs_attention";
  state.partitions[partitionID].interruptedAt = interruptedAt;
  state.run.status = "needs_attention";
  state.run.currentPartitionID = null;
  state.recovery = {
    partitionID,
    status: "interrupted",
    detectedAt: interruptedAt,
    message: "The previous runner ended before this partition recorded a final status.",
  };
  return true;
}

function sessionFile(projectRoot) {
  return path.join(projectRoot, "opencode-session-ids.txt");
}

function saveSessionIDs(projectRoot, managerID, workerID) {
  fs.writeFileSync(
    sessionFile(projectRoot),
    `MANAGER_SESSION=${managerID}\nWORKER_SESSION=${workerID}\n`,
  );
}

function openCurrentSessionWindows(projectRoot) {
  const script = path.join(projectRoot, "start-opencode-sessions.bat");
  if (!fs.existsSync(script)) {
    console.warn("Session windows were not opened because start-opencode-sessions.bat is missing.");
    return;
  }
  const child = spawn(script, [], {
    cwd: projectRoot,
    shell: true,
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
}

async function api(directory, endpoint, options = {}) {
  const separator = endpoint.includes("?") ? "&" : "?";
  const response = await fetch(
    `${SERVER_URL}${endpoint}${separator}directory=${encodeURIComponent(directory)}`,
    options,
  );
  if (!response.ok) {
    throw new Error(`OpenCode API request failed: ${response.status} ${await response.text()}`);
  }
  if (response.status === 204) return undefined;
  const body = await response.json();
  return body?.data ?? body;
}

async function createSession(projectRoot, title) {
  const session = await api(projectRoot, "/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title }),
  });
  if (!session?.id) throw new Error(`Failed to create ${title} session.`);
  return session.id;
}

function normalize(value) {
  return path.resolve(value).replace(/\\/g, "/").toLowerCase();
}

async function validateSessions(projectRoot, managerID, workerID) {
  const [manager, worker] = await Promise.all([
    api(projectRoot, `/session/${managerID}`),
    api(projectRoot, `/session/${workerID}`),
  ]);
  if (normalize(manager.directory) !== normalize(projectRoot) || normalize(worker.directory) !== normalize(projectRoot)) {
    throw new Error("The continued Manager or Worker session belongs to a different project directory.");
  }
}

async function sessionsForPartition(projectRoot, state, partition) {
  const session = partition.session ?? { mode: "new" };
  const active = state.sessions?.active;
  if (state.recovery?.partitionID === partition.id && active?.managerSessionID && active?.workerSessionID) {
    await validateSessions(projectRoot, active.managerSessionID, active.workerSessionID);
    return { managerID: active.managerSessionID, workerID: active.workerSessionID, mode: "continue", from: "interrupted run" };
  }
  if (session.mode === "new") {
    const managerID = await createSession(projectRoot, `Manager ${partition.id}`);
    const workerID = await createSession(projectRoot, `Worker ${partition.id}`);
    return { managerID, workerID, mode: "new" };
  }

  if (!active?.managerSessionID || !active?.workerSessionID) {
    throw new Error(`${partition.id} cannot continue because no active Manager and Worker sessions are recorded.`);
  }
  await validateSessions(projectRoot, active.managerSessionID, active.workerSessionID);
  return {
    managerID: active.managerSessionID,
    workerID: active.workerSessionID,
    mode: "continue",
    from: active.ownerPartitionID,
  };
}

function dependencySummaries(projectRoot, state, partition) {
  return (partition.dependsOn ?? [])
    .map((id) => state.partitions[id]?.summaryFile)
    .filter(Boolean)
    .map((file) => path.join(projectRoot, file));
}

function managerPrompt(projectRoot, state, partition, sessions) {
  const summaries = dependencySummaries(projectRoot, state, partition);
  return [
    "You are managing exactly one partition in a resumable long-running workflow.",
    `Project root: ${projectRoot}`,
    `Partition ID: ${partition.id}`,
    `Title: ${partition.title}`,
    sessions.mode === "continue"
      ? `Continue the active Manager and Worker sessions from ${sessions.from ?? "the prior partition"}; this is a new partition with its own scope.`
      : "This partition starts with new Manager and Worker sessions.",
    `Goal: ${partition.goal}`,
    "Acceptance criteria:",
    ...partition.acceptanceCriteria.map((item) => `- ${item}`),
    "Constraints:",
    ...(partition.constraints?.length ? partition.constraints.map((item) => `- ${item}`) : ["- None."]),
    summaries.length ? "Read these completed dependency summaries before planning:" : null,
    ...summaries.map((file) => `- ${file}`),
    "Use delegate_worker for every implementation, file change, or test command.",
    "Create and complete only small, ordered Worker tasks for this partition.",
    `Prefix every Worker task ID with ${partition.id}- so task records never collide with another partition.`,
    "After verifying the partition acceptance criteria, delegate one final read-only Worker summary task, then call partition_control with status completed and that factual context.",
    "If progress cannot continue, call partition_control with status blocked and explain the blocker.",
    "Do not start another partition after calling partition_control.",
  ]
    .filter(Boolean)
    .join("\n");
}

function nextPartition(plan, state) {
  return plan.partitions.find((partition) => {
    const status = state.partitions[partition.id]?.status;
    if (["completed", "blocked", "needs_attention", "running"].includes(status)) return false;
    return (partition.dependsOn ?? []).every((dependency) => state.partitions[dependency]?.status === "completed");
  });
}

async function runPartition(projectRoot, plan, state, partition) {
  const partitionState = state.partitions[partition.id] ?? {};
  state.partitions[partition.id] = {
    ...partitionState,
    status: "running",
    attempts: (partitionState.attempts ?? 0) + 1,
    startedAt: partitionState.startedAt ?? now(),
  };
  state.run.status = "running";
  state.run.currentPartitionID = partition.id;
  state.run.startedAt ??= now();
  state.paused = null;
  saveState(projectRoot, state);

  const sessions = await sessionsForPartition(projectRoot, state, partition);
  const { managerID, workerID } = sessions;
  saveSessionIDs(projectRoot, managerID, workerID);
  state.partitions[partition.id].managerSessionID = managerID;
  state.partitions[partition.id].workerSessionID = workerID;
  state.partitions[partition.id].session = sessions;
  state.sessions.active = {
    managerSessionID: managerID,
    workerSessionID: workerID,
    ownerPartitionID: partition.id,
  };
  if (state.recovery?.partitionID === partition.id) delete state.recovery;
  saveState(projectRoot, state);

  if (sessions.mode === "new") openCurrentSessionWindows(projectRoot);

  console.log(
    sessions.mode === "continue"
      ? `[${partition.id}] Continuing sessions from ${sessions.from}.`
      : `[${partition.id}] Manager and Worker sessions created.`,
  );
  await api(projectRoot, `/session/${managerID}/message`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      agent: "manager",
      parts: [{ type: "text", text: managerPrompt(projectRoot, state, partition, sessions) }],
    }),
  });

  const updated = loadState(projectRoot);
  const status = updated.partitions[partition.id]?.status;
  if (status === "completed") {
    console.log(`[${partition.id}] Completed.`);
    return { state: updated, status };
  }
  if (status === "blocked") {
    console.log(`[${partition.id}] Blocked. See its summary for details.`);
    return { state: updated, status };
  }

  updated.run.status = "needs_attention";
  updated.run.currentPartitionID = partition.id;
  updated.partitions[partition.id] ??= {};
  updated.partitions[partition.id].status = "needs_attention";
  saveState(projectRoot, updated);
  throw new Error(`${partition.id} ended without recording a partition completion status.`);
}

async function main() {
  const projectRoot = parseArgs();
  const lock = acquireRunnerLock(projectRoot);
  try {
    const plan = loadPlan(projectRoot);
    if (plan.partitions.length === 0) throw new Error("TODO/plan.json has no partitions.");

    let state = loadState(projectRoot);
    if (recoverInterruptedRun(state)) {
      saveState(projectRoot, state);
      throw new Error(`Recovered interrupted partition ${state.recovery.partitionID}. Choose resume, restart, or block in the desktop app.`);
    }
    if (state.paused) throw new Error(`Dispatch is paused: ${state.paused.reason}. Inspect state.json first.`);
    if (state.run.currentPartitionID) {
      const current = plan.partitions.find((partition) => partition.id === state.run.currentPartitionID);
      if (!current) throw new Error(`State references unknown partition ${state.run.currentPartitionID}.`);
      state = (await runPartition(projectRoot, plan, state, current)).state;
      if (state.partitions[current.id]?.status === "blocked") return;
    }

    while (true) {
      const partition = nextPartition(plan, state);
      if (!partition) {
        const unfinished = plan.partitions.filter((item) => state.partitions[item.id]?.status !== "completed");
        if (unfinished.length) {
          throw new Error(`No runnable partition remains: ${unfinished.map((item) => item.id).join(", ")}.`);
        }
        state.run.status = "completed";
        state.run.currentPartitionID = null;
        saveState(projectRoot, state);
        console.log("All partitions completed.");
        return;
      }
      const result = await runPartition(projectRoot, plan, state, partition);
      state = result.state;
      if (result.status === "blocked") return;
    }
  } finally {
    releaseRunnerLock(projectRoot, lock);
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

module.exports = { acquireRunnerLock, defaultState, lockPath, nextPartition, readRunnerLock, recoverInterruptedRun, releaseRunnerLock };
