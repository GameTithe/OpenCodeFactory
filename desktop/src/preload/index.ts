import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("orchestrator", {
  snapshot: () => ipcRenderer.invoke("orchestrator:snapshot"),
  start: () => ipcRenderer.invoke("orchestrator:start"),
  stop: () => ipcRenderer.invoke("orchestrator:stop"),
  openSessions: () => ipcRenderer.invoke("orchestrator:open-sessions"),
  savePlan: (text: string) => ipcRenderer.invoke("orchestrator:save-plan", text),
  plannerSettings: () => ipcRenderer.invoke("orchestrator:planner-settings"),
  savePlannerSettings: (settings: unknown) => ipcRenderer.invoke("orchestrator:save-planner-settings", settings),
  plannerModels: () => ipcRenderer.invoke("orchestrator:planner-models"),
  graphLayout: () => ipcRenderer.invoke("orchestrator:graph-layout"),
  saveGraphLayout: (layout: unknown) => ipcRenderer.invoke("orchestrator:save-graph-layout", layout),
  generatePlan: (goal: string, settings: unknown, context?: unknown) => ipcRenderer.invoke("orchestrator:generate-plan", goal, settings, context),
  archive: (partitionID: string) => ipcRenderer.invoke("orchestrator:archive", partitionID),
  delete: (partitionID: string) => ipcRenderer.invoke("orchestrator:delete", partitionID),
  retry: (partitionID: string) => ipcRenderer.invoke("orchestrator:retry", partitionID),
  summary: (partitionID: string) => ipcRenderer.invoke("orchestrator:summary", partitionID),
  onChanged: (listener: (snapshot: unknown) => void) => {
    const callback = (_event: Electron.IpcRendererEvent, snapshot: unknown) => listener(snapshot);
    ipcRenderer.on("orchestrator:changed", callback);
    return () => ipcRenderer.removeListener("orchestrator:changed", callback);
  },
});
