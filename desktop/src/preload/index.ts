import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("orchestrator", {
  snapshot: () => ipcRenderer.invoke("orchestrator:snapshot"),
  start: () => ipcRenderer.invoke("orchestrator:start"),
  stop: () => ipcRenderer.invoke("orchestrator:stop"),
  openSessions: () => ipcRenderer.invoke("orchestrator:open-sessions"),
  savePlan: (text: string) => ipcRenderer.invoke("orchestrator:save-plan", text),
  generatePlan: (goal: string) => ipcRenderer.invoke("orchestrator:generate-plan", goal),
  archive: (partitionID: string) => ipcRenderer.invoke("orchestrator:archive", partitionID),
  delete: (partitionID: string) => ipcRenderer.invoke("orchestrator:delete", partitionID),
  summary: (partitionID: string) => ipcRenderer.invoke("orchestrator:summary", partitionID),
  onChanged: (listener: (snapshot: unknown) => void) => {
    const callback = (_event: Electron.IpcRendererEvent, snapshot: unknown) => listener(snapshot);
    ipcRenderer.on("orchestrator:changed", callback);
    return () => ipcRenderer.removeListener("orchestrator:changed", callback);
  },
});
