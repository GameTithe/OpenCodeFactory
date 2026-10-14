import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { tool } from "@opencode-ai/plugin";

const SERVER_URL = "http://127.0.0.1:4096";
const MAX_TASK_DURATION_MS = 20 * 60 * 1000;
const MAX_RETRIES = 2;
const MIN_CONTEXT_HEADROOM = 0.1;
const WORKER_ROTATION_HEADROOM = 0.3;

function now() {
  return new Date().toISOString();
}

function normalize(value) {
  return path.resolve(value).replace(/\\/g, "/").toLowerCase();
}

function statePath(projectRoot) {
  return path.join(projectRoot, ".opencode", "orchestration", "state.json");
}

function loadState(projectRoot) {
  const file = statePath(projectRoot);
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return {
      version: 1,
      policy: {
        maxTaskDurationMinutes: 20,
        maxRetries: MAX_RETRIES,
        minimumContextHeadroom: MIN_CONTEXT_HEADROOM,
        workerRotationHeadroom: WORKER_ROTATION_HEADROOM,
      },
      paused: null,
      activeTask: null,
      tasks: {},
      run: {
        status: "idle",
        currentPartitionID: null,
      },
      partitions: {},
    };
  }
}

function saveState(projectRoot, state) {
  fs.mkdirSync(path.dirname(statePath(projectRoot)), { recursive: true });
  fs.writeFileSync(statePath(projectRoot), JSON.stringify(state, null, 2));
}

function sessionIDs(projectRoot) {
  const file = path.join(projectRoot, "opencode-session-ids.txt");
  if (!fs.existsSync(file)) {
    throw new Error("Worker session ID file was not found.");
  }

  const values = Object.fromEntries(
    fs
      .readFileSync(file, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => line.split("=", 2)),
  );

  return values;
}

function workerSessionID(projectRoot) {
  const values = sessionIDs(projectRoot);
  if (!values.WORKER_SESSION) {
    throw new Error("WORKER_SESSION is missing from opencode-session-ids.txt.");
  }

  return values.WORKER_SESSION;
}

function saveSessionIDs(projectRoot, values) {
  const file = path.join(projectRoot, "opencode-session-ids.txt");
  fs.writeFileSync(
    file,
    [
      values.MANAGER_SESSION ? `MANAGER_SESSION=${values.MANAGER_SESSION}` : null,
      values.WORKER_SESSION ? `WORKER_SESSION=${values.WORKER_SESSION}` : null,
    ]
      .filter(Boolean)
      .join("\n") + "\n",
  );
}

function openWorkerSessionWindow(projectRoot) {
  const script = path.join(projectRoot, "start-opencode-worker-session.bat");
  if (!fs.existsSync(script)) return;
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
  return response.json();
}

function data(body) {
  return body?.data ?? body;
}

async function session(directory, sessionID) {
  return data(await api(directory, `/session/${sessionID}`));
}

async function contextUsage(directory, sessionID) {
  const messages = data(await api(directory, `/session/${sessionID}/message`));
  const latest = [...messages]
    .reverse()
    .find((message) => message.info.role === "assistant" && message.info.time.completed);

  // A new session has no completed response and therefore no accumulated context to guard.
  if (!latest) {
    return { used: 0, contextLimit: 0, headroom: 1 };
  }

  const providerID = latest.info.providerID;
  const modelID = latest.info.modelID;
  const used = latest.info.tokens.total;

  const providers = data(await api(directory, "/provider")).all;
  const provider = providers.find((item) => item.id === providerID);
  const contextLimit = provider?.models?.[modelID]?.limit?.context;
  if (!contextLimit) {
    throw new Error("Unable to determine the model context limit.");
  }

  return {
    used,
    contextLimit,
    headroom: Math.max(0, 1 - used / contextLimit),
    providerID,
    modelID,
  };
}

function formatPercent(value) {
  return `${Math.round(value * 100)}%`;
}

function workerPrompt(args, handoffFile) {
  return [
    "You are the Worker agent. Complete only this assigned task.",
    `Task ID: ${args.task_id}`,
    `Objective: ${args.objective}`,
    `Acceptance criteria: ${args.acceptance_criteria}`,
    `Constraints: ${args.constraints || "None."}`,
    handoffFile ? `Before working, read the Worker handoff: ${handoffFile}` : null,
    "Run the relevant verification before responding.",
    "Return exactly this concise report format:",
    "STATUS: completed | blocked | failed",
    "CHANGED: files or directories changed",
    "TESTED: commands run and results",
    "BLOCKER: none or the blocking issue",
  ]
    .filter(Boolean)
    .join("\n");
}

function reportText(result) {
  const parts = result?.parts ?? [];
  return parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

function reportStatus(text) {
  return text.match(/^STATUS:\s*(completed|blocked|failed)\s*$/im)?.[1] ?? "failed";
}

function activePartitionID(state) {
  return state.run?.currentPartitionID ?? null;
}

function taskStateID(partitionID, taskID) {
  return partitionID ? `${partitionID}::${taskID}` : taskID;
}

function handoffPath(projectRoot, partitionID) {
  return path.join(projectRoot, ".opencode", "orchestration", "handoffs", `${partitionID}-worker.md`);
}

function writeWorkerHandoff(projectRoot, state, partitionID, reason) {
  const tasks = Object.values(state.tasks)
    .filter((task) => task.partitionID === partitionID)
    .map((task) => [
      `## ${task.taskID}`,
      `Status: ${task.status}`,
      `Objective: ${task.objective}`,
      `Acceptance criteria: ${task.acceptanceCriteria}`,
      `Report: ${task.report || task.error || "No report recorded."}`,
    ].join("\n"));
  const file = handoffPath(projectRoot, partitionID);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, [
    `# Worker Handoff: ${partitionID}`,
    "",
    `Reason: ${reason}`,
    `Generated: ${now()}`,
    "",
    "Complete only the next task assigned by the Manager. Use the records below as context; verify the current project state before changing files.",
    "",
    ...tasks,
    "",
  ].join("\n"));
  return file;
}

async function createWorkerSession(directory, projectRoot, state, reason) {
  const partitionID = activePartitionID(state);
  const handoffFile = partitionID
    ? writeWorkerHandoff(projectRoot, state, partitionID, reason)
    : null;
  const created = data(
    await api(directory, "/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: partitionID ? `Worker ${partitionID}` : "Worker" }),
    }),
  );
  if (!created?.id) throw new Error("Failed to create a replacement Worker session.");

  const ids = sessionIDs(projectRoot);
  ids.WORKER_SESSION = created.id;
  saveSessionIDs(projectRoot, ids);
  if (partitionID) {
    state.partitions ??= {};
    state.partitions[partitionID] ??= {};
    state.partitions[partitionID].workerSessionID = created.id;
    state.partitions[partitionID].workerRotations ??= [];
    state.partitions[partitionID].workerRotations.push({
      at: now(),
      reason,
      workerSessionID: created.id,
      handoffFile: path.relative(projectRoot, handoffFile).replace(/\\/g, "/"),
    });
    state.sessions ??= { active: null };
    state.sessions.active ??= {};
    state.sessions.active.workerSessionID = created.id;
    state.sessions.active.ownerPartitionID = partitionID;
  }
  openWorkerSessionWindow(projectRoot);
  return { workerID: created.id, handoffFile };
}

export default tool({
  description:
    "Delegate one implementation task to the configured Worker session and return its verified report. Only the Manager agent may call this tool.",
  args: {
    task_id: tool.schema.string().min(1).describe("Stable task identifier, for example TASK-001"),
    objective: tool.schema.string().min(1).describe("One small, implementable objective"),
    acceptance_criteria: tool.schema
      .string()
      .min(1)
      .describe("Concrete conditions that prove the task is complete"),
    constraints: tool.schema
      .string()
      .optional()
      .describe("Scope limits, files to avoid, or other constraints"),
  },
  async execute(args, context) {
    if (context.agent !== "manager") {
      return "DENIED: delegate_worker may only be called by the manager agent.";
    }

    // The session directory is the copied project's root, unlike an optional Git worktree.
    const projectRoot = context.directory;
    const state = loadState(projectRoot);
    state.tasks ??= {};
    state.partitions ??= {};
    state.run ??= { status: "idle", currentPartitionID: null };
    const partitionID = activePartitionID(state);
    if (state.paused) {
      return `PAUSED: dispatch is stopped. Reason: ${state.paused.reason}. Check ${statePath(projectRoot)} before resuming.`;
    }

    let workerID = workerSessionID(projectRoot);
    let worker = await session(context.directory, workerID);
    if (normalize(worker.directory) !== normalize(context.directory)) {
      return `DENIED: Worker directory ${worker.directory} does not match Manager directory ${context.directory}.`;
    }

    if (state.activeTask) {
      const activeTaskKey = state.activeTask.taskKey ?? state.activeTask.taskID;
      const deadline = Date.parse(state.activeTask.deadline);
      if (Number.isFinite(deadline) && Date.now() > deadline) {
        await api(context.directory, `/session/${state.activeTask.workerSessionID}/abort`, {
          method: "POST",
        }).catch(() => undefined);
        if (state.tasks[activeTaskKey]) {
          state.tasks[activeTaskKey].status = "timed_out";
          state.tasks[activeTaskKey].updatedAt = now();
        }
        state.activeTask = null;
        saveState(projectRoot, state);
      } else {
        return `BUSY: ${state.activeTask.taskID} is still assigned to the Worker.`;
      }
    }

    const managerContext = await contextUsage(context.directory, context.sessionID);
    let workerContext = await contextUsage(context.directory, workerID);
    if (managerContext.headroom <= MIN_CONTEXT_HEADROOM) {
      state.paused = {
        reason: "manager_context_headroom_low",
        at: now(),
        managerHeadroom: managerContext.headroom,
        workerHeadroom: workerContext.headroom,
      };
      saveState(projectRoot, state);
      return `PAUSED: Manager context headroom is too low: ${formatPercent(managerContext.headroom)}.`;
    }

    let workerRotation = null;
    if (partitionID && workerContext.headroom <= WORKER_ROTATION_HEADROOM) {
      workerRotation = await createWorkerSession(
        context.directory,
        projectRoot,
        state,
        `Worker context headroom reached ${formatPercent(workerContext.headroom)}.`,
      );
      workerID = workerRotation.workerID;
      worker = await session(context.directory, workerID);
      workerContext = { used: 0, contextLimit: 0, headroom: 1 };
      saveState(projectRoot, state);
    } else if (workerContext.headroom <= MIN_CONTEXT_HEADROOM) {
      state.paused = {
        reason: "worker_context_headroom_low_without_partition",
        at: now(),
        workerHeadroom: workerContext.headroom,
      };
      saveState(projectRoot, state);
      return `PAUSED: Worker context headroom is too low: ${formatPercent(workerContext.headroom)}.`;
    }

    const taskKey = taskStateID(partitionID, args.task_id);
    const previous = state.tasks[taskKey];
    if (previous?.status === "completed") {
      return `DENIED: ${args.task_id} is already completed in ${partitionID ?? "the current session"}.`;
    }
    if ((previous?.attempts ?? 0) >= MAX_RETRIES + 1) {
      return `DENIED: ${args.task_id} already used its ${MAX_RETRIES} allowed retries.`;
    }

    const task = {
      stateKey: taskKey,
      taskID: args.task_id,
      objective: args.objective,
      acceptanceCriteria: args.acceptance_criteria,
      constraints: args.constraints ?? "",
      partitionID,
      attempts: (previous?.attempts ?? 0) + 1,
      status: "running",
      startedAt: now(),
      updatedAt: now(),
    };
    state.tasks[taskKey] = task;
    state.activeTask = {
      taskID: args.task_id,
      taskKey,
      workerSessionID: workerID,
      deadline: new Date(Date.now() + MAX_TASK_DURATION_MS).toISOString(),
    };
       saveState(projectRoot, state);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), MAX_TASK_DURATION_MS);

    try {
      const result = data(
        await api(context.directory, `/session/${workerID}/message`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            agent: "worker",
            parts: [{ type: "text", text: workerPrompt(args, workerRotation?.handoffFile) }],
          }),
          signal: controller.signal,
        }),
      );
      const report = reportText(result);
      task.status = reportStatus(report);
      task.report = report || "Worker returned no text report.";
      task.updatedAt = now();
      task.workerTokens = result?.info?.tokens;
      state.activeTask = null;

      const updatedWorkerContext = await contextUsage(context.directory, workerID);
      if (partitionID && updatedWorkerContext.headroom <= WORKER_ROTATION_HEADROOM) {
        writeWorkerHandoff(
          projectRoot,
          state,
          partitionID,
          `Worker context headroom reached ${formatPercent(updatedWorkerContext.headroom)} after ${args.task_id}.`,
        );
      }

      saveState(projectRoot, state);
      return [
        `TASK: ${args.task_id}`,
        `STATUS: ${task.status}`,
        `ATTEMPT: ${task.attempts} of ${MAX_RETRIES + 1}`,
        "WORKER REPORT:",
        task.report,
        workerRotation ? `WORKER ROTATED: ${workerID}` : null,
      ]
        .filter(Boolean)
        .join("\n");
    } catch (error) {
      const timedOut = error?.name === "AbortError";
      if (timedOut) {
        await api(context.directory, `/session/${workerID}/abort`, { method: "POST" }).catch(() => undefined);
      }
      task.status = timedOut ? "timed_out" : "failed";
      task.error = error instanceof Error ? error.message : String(error);
      task.updatedAt = now();
      state.activeTask = null;
      saveState(projectRoot, state);
      return `TASK: ${args.task_id}\nSTATUS: ${task.status}\nERROR: ${task.error}`;
    } finally {
      clearTimeout(timer);
    }
  },
});
