import { app, BrowserWindow, ipcMain } from "electron";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, promises as fs } from "node:fs";
import path from "node:path";

type Partition = {
  id: string;
  title: string;
  goal: string;
  acceptanceCriteria: string[];
  constraints?: string[];
  dependsOn?: string[];
  session?: { mode: "new" | "continue" };
};

type Plan = { version: 1; goal: string; partitions: Partition[] };

type Snapshot = {
  projectRoot: string;
  runner: "idle" | "running";
  plan: Plan | null;
  state: Record<string, unknown> | null;
  logs: string[];
  error: string | null;
};

const projectRoot = process.env.OPENCODE_PROJECT_ROOT
  ? path.resolve(process.env.OPENCODE_PROJECT_ROOT)
  : path.resolve(app.getAppPath(), "..");
const planFile = path.join(projectRoot, "TODO", "plan.json");
const stateFile = path.join(projectRoot, ".opencode", "orchestration", "state.json");
const archiveDirectory = path.join(projectRoot, "TODO", "archive");
const serverUrl = "http://127.0.0.1:4096";

let mainWindow: BrowserWindow | null = null;
let runner: ChildProcessWithoutNullStreams | null = null;
let lastError: string | null = null;
const logs: string[] = [];

function appendLog(value: string) {
  for (const line of value.replace(/\r/g, "").split("\n")) {
    if (line.trim()) logs.push(`[${new Date().toLocaleTimeString("ko-KR")}] ${line}`);
  }
  if (logs.length > 500) logs.splice(0, logs.length - 500);
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as T;
  } catch {
    return null;
  }
}

async function writeJson(file: string, value: unknown) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(temporary, file);
}

function validatePlan(value: unknown): asserts value is Plan {
  if (!value || typeof value !== "object") throw new Error("계획은 JSON 객체여야 합니다.");
  const plan = value as Partial<Plan>;
  if (plan.version !== 1 || typeof plan.goal !== "string" || !Array.isArray(plan.partitions)) {
    throw new Error("version: 1, goal, partitions가 필요합니다.");
  }
  const ids = new Set<string>();
  for (const partition of plan.partitions) {
    if (!partition?.id || !partition.title || !partition.goal || !Array.isArray(partition.acceptanceCriteria)) {
      throw new Error("각 파티션에는 id, title, goal, acceptanceCriteria가 필요합니다.");
    }
    if (ids.has(partition.id)) throw new Error(`중복된 파티션 ID: ${partition.id}`);
    if (partition.session && !["new", "continue"].includes(partition.session.mode)) {
      throw new Error(`${partition.id}의 session.mode는 new 또는 continue여야 합니다.`);
    }
    ids.add(partition.id);
  }
  for (const partition of plan.partitions) {
    for (const dependency of partition.dependsOn ?? []) {
      if (!ids.has(dependency)) throw new Error(`${partition.id}이(가) 알 수 없는 의존성 ${dependency}을 참조합니다.`);
    }
  }
}

function requireIdle() {
  if (runner) throw new Error("실행 중에는 계획 또는 기록을 변경할 수 없습니다.");
}

function resolveProjectFile(relative: string) {
  const root = `${path.resolve(projectRoot)}${path.sep}`;
  const file = path.resolve(projectRoot, relative);
  if (!file.startsWith(root)) throw new Error("허용되지 않은 프로젝트 파일 경로입니다.");
  return file;
}

async function loadPlanAndState() {
  const [plan, state] = await Promise.all([
    readJson<Plan>(planFile),
    readJson<Record<string, any>>(stateFile),
  ]);
  if (!plan) throw new Error("TODO/plan.json을 읽을 수 없습니다.");
  validatePlan(plan);
  if (!state) throw new Error("실행 상태 파일을 읽을 수 없습니다.");
  state.partitions ??= {};
  state.tasks ??= {};
  return { plan, state };
}

function removeCompletedPartition(plan: Plan, state: Record<string, any>, partitionID: string) {
  const partition = plan.partitions.find((item) => item.id === partitionID);
  if (!partition) throw new Error("활성 계획에서 해당 파티션을 찾을 수 없습니다.");
  if (state.partitions?.[partitionID]?.status !== "completed") {
    throw new Error("완료된 파티션만 아카이브하거나 완전 삭제할 수 있습니다.");
  }
  const dependents = plan.partitions.filter((item) => item.dependsOn?.includes(partitionID));
  const activeDependent = dependents.find((item) => state.partitions?.[item.id]?.status !== "completed");
  if (activeDependent) {
    throw new Error(`${activeDependent.id}이(가) 아직 완료되지 않아 이 파티션을 제거할 수 없습니다.`);
  }
  plan.partitions = plan.partitions.filter((item) => item.id !== partitionID);
  for (const dependent of dependents) {
    dependent.dependsOn = dependent.dependsOn?.filter((id) => id !== partitionID);
  }
  return partition;
}

async function archivePartition(partitionID: string) {
  requireIdle();
  const { plan, state } = await loadPlanAndState();
  const partition = removeCompletedPartition(plan, state, partitionID);
  const partitionState = state.partitions[partitionID];
  let summary = "";
  if (partitionState?.summaryFile) {
    try {
      summary = await fs.readFile(resolveProjectFile(partitionState.summaryFile), "utf8");
    } catch {
      summary = "요약 문서를 읽을 수 없습니다.";
    }
  }
  await fs.mkdir(archiveDirectory, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  await writeJson(path.join(archiveDirectory, `${stamp}-${partitionID}.json`), {
    archivedAt: new Date().toISOString(),
    partition,
    state: partitionState,
    summary,
  });
  await writeJson(planFile, plan);
  appendLog(`${partitionID} 파티션을 아카이브했습니다.`);
}

async function permanentlyDeletePartition(partitionID: string) {
  requireIdle();
  const { plan, state } = await loadPlanAndState();
  const partition = removeCompletedPartition(plan, state, partitionID);
  const partitionState = state.partitions[partitionID];
  for (const [taskID, task] of Object.entries(state.tasks as Record<string, { partitionID?: string }>)) {
    if (task.partitionID === partitionID) delete state.tasks[taskID];
  }
  delete state.partitions[partitionID];
  if (state.sessions?.active?.ownerPartitionID === partitionID) state.sessions.active = null;
  if (partitionState?.summaryFile) await fs.rm(resolveProjectFile(partitionState.summaryFile), { force: true });
  await fs.rm(path.join(projectRoot, ".opencode", "orchestration", "handoffs", `${partition.id}-worker.md`), { force: true });
  await Promise.all([writeJson(planFile, plan), writeJson(stateFile, state)]);
  appendLog(`${partitionID} 파티션과 관련 기록을 완전 삭제했습니다.`);
}

async function snapshot(): Promise<Snapshot> {
  return {
    projectRoot,
    runner: runner ? "running" : "idle",
    plan: await readJson<Plan>(planFile),
    state: await readJson<Record<string, unknown>>(stateFile),
    logs: [...logs],
    error: lastError,
  };
}

async function publish() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send("orchestrator:changed", await snapshot());
}

function startDetachedScript(scriptName: string) {
  const script = path.join(projectRoot, scriptName);
  if (!existsSync(script)) throw new Error(`${scriptName}을 찾을 수 없습니다.`);
  const child = spawn(script, [], {
    cwd: projectRoot,
    shell: true,
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
}

function startRunner() {
  if (runner) throw new Error("이미 파티션 실행기가 동작 중입니다.");
  const script = path.join(projectRoot, "run-partitions.bat");
  if (!existsSync(script)) throw new Error("run-partitions.bat을 찾을 수 없습니다.");
  lastError = null;
  appendLog("파티션 실행기를 시작했습니다.");
  runner = spawn(script, [], {
    cwd: projectRoot,
    shell: true,
    windowsHide: true,
  });
  runner.stdout.on("data", (chunk) => {
    appendLog(chunk.toString());
    void publish();
  });
  runner.stderr.on("data", (chunk) => {
    appendLog(chunk.toString());
    void publish();
  });
  runner.on("error", (error) => {
    lastError = error.message;
    appendLog(`실행기 오류: ${error.message}`);
    void publish();
  });
  runner.on("close", (code) => {
    appendLog(`파티션 실행기가 종료되었습니다. 종료 코드: ${code ?? "unknown"}`);
    runner = null;
    void publish();
  });
}

function stopRunner() {
  if (!runner?.pid) return;
  spawnSync("taskkill.exe", ["/pid", String(runner.pid), "/t", "/f"], { windowsHide: true });
  appendLog("사용자 요청으로 파티션 실행기를 중단했습니다.");
  runner = null;
}

async function serverReady() {
  try {
    const response = await fetch(`${serverUrl}/global/health`);
    return response.ok;
  } catch {
    return false;
  }
}

async function ensureServer() {
  if (await serverReady()) return;
  appendLog("OpenCode Server를 시작합니다.");
  const child = spawn("opencode.cmd", ["serve", "--hostname", "127.0.0.1", "--port", "4096"], {
    cwd: projectRoot,
    detached: true,
    shell: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    if (await serverReady()) return;
  }
  throw new Error("OpenCode Server를 시작하지 못했습니다.");
}

async function openCodeApi(endpoint: string, options: RequestInit = {}) {
  await ensureServer();
  const separator = endpoint.includes("?") ? "&" : "?";
  const response = await fetch(`${serverUrl}${endpoint}${separator}directory=${encodeURIComponent(projectRoot)}`, options);
  if (!response.ok) throw new Error(`OpenCode API 오류: ${response.status} ${await response.text()}`);
  const body = await response.json();
  return body?.data ?? body;
}

function textFromResponse(value: any) {
  const parts = value?.parts ?? [];
  return parts.filter((part: { type?: string }) => part.type === "text").map((part: { text?: string }) => part.text ?? "").join("\n").trim();
}

function jsonFromPlanner(text: string) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  const candidate = fenced ?? text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  if (!candidate) throw new Error("Planner가 JSON 계획을 반환하지 않았습니다.");
  try {
    return JSON.parse(candidate);
  } catch {
    throw new Error("Planner가 유효하지 않은 JSON 계획을 반환했습니다.");
  }
}

async function generatePlan(goal: string) {
  requireIdle();
  if (!goal.trim()) throw new Error("목표를 입력하세요.");
  const current = await readJson<Plan>(planFile);
  const existing = current?.partitions.map((partition) => partition.id).join(", ") || "none";
  const created = await openCodeApi("/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "Plan Draft" }),
  });
  if (!created?.id) throw new Error("Planner 세션을 만들지 못했습니다.");
  const prompt = [
    "You are a planning assistant. Convert the user's goal into a proposed OpenCode partition plan.",
    "Do not edit files, execute commands, or start implementation.",
    "Return only one valid JSON object, with no markdown or explanation.",
    "Required shape: { version: 1, goal: string, partitions: [{ id, title, goal, acceptanceCriteria: string[], constraints: string[], dependsOn: string[], session: { mode: 'new' | 'continue' } }] }.",
    "Use stable ASCII partition IDs. The first partition must use new. Use continue only for directly related sequential work; otherwise use new.",
    `Existing partition IDs that must not be reused: ${existing}.`,
    `User goal:\n${goal.trim()}`,
  ].join("\n");
  const result = await openCodeApi(`/session/${created.id}/message`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ agent: "plan", parts: [{ type: "text", text: prompt }] }),
  });
  const plan = jsonFromPlanner(textFromResponse(result));
  validatePlan(plan);
  appendLog("자연어 목표에서 계획 초안을 생성했습니다.");
  return plan as Plan;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1100,
    minHeight: 720,
    backgroundColor: "#0e1117",
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void mainWindow.loadFile(path.join(__dirname, "../renderer/index.html"));
  }
}

app.whenReady().then(() => {
  ipcMain.handle("orchestrator:snapshot", snapshot);
  ipcMain.handle("orchestrator:start", async () => {
    startRunner();
    await publish();
    return snapshot();
  });
  ipcMain.handle("orchestrator:stop", async () => {
    stopRunner();
    await publish();
    return snapshot();
  });
  ipcMain.handle("orchestrator:open-sessions", () => startDetachedScript("start-opencode-sessions.bat"));
  ipcMain.handle("orchestrator:save-plan", async (_event, text: string) => {
    requireIdle();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error("유효한 JSON 형식이 아닙니다.");
    }
    validatePlan(parsed);
    await writeJson(planFile, parsed);
    appendLog("계획 파일을 저장했습니다.");
    await publish();
    return snapshot();
  });
  ipcMain.handle("orchestrator:generate-plan", async (_event, goal: string) => generatePlan(goal));
  ipcMain.handle("orchestrator:archive", async (_event, partitionID: string) => {
    await archivePartition(partitionID);
    await publish();
    return snapshot();
  });
  ipcMain.handle("orchestrator:delete", async (_event, partitionID: string) => {
    await permanentlyDeletePartition(partitionID);
    await publish();
    return snapshot();
  });
  ipcMain.handle("orchestrator:summary", async (_event, partitionID: string) => {
    if (!/^[A-Za-z0-9_-]+$/.test(partitionID)) throw new Error("잘못된 파티션 ID입니다.");
    const state = await readJson<{ partitions?: Record<string, { summaryFile?: string }> }>(stateFile);
    const relative = state?.partitions?.[partitionID]?.summaryFile;
    if (!relative) return "요약 문서가 아직 없습니다.";
    const file = path.resolve(projectRoot, relative);
    if (!file.startsWith(path.resolve(projectRoot))) throw new Error("허용되지 않은 요약 경로입니다.");
    return fs.readFile(file, "utf8");
  });
  createWindow();
  setInterval(() => void publish(), 1500);
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
