export type SessionMode = "new" | "continue";

export type Partition = {
  id: string;
  title: string;
  goal: string;
  acceptanceCriteria: string[];
  constraints?: string[];
  dependsOn?: string[];
  session?: { mode: SessionMode };
};

export type Plan = {
  version: 1;
  goal: string;
  partitions: Partition[];
};

export type PlannerSettings = {
  model: { providerID: string; modelID: string } | null;
  decomposition: "auto" | "detailed" | "compact";
};

export type PlannerModel = {
  providerID: string;
  modelID: string;
  label: string;
};

export type GeneratedPlan = {
  plan: Plan;
  warnings: string[];
};

export type PlannerContext = {
  anchor?: { id: string; title: string; goal: string };
};

export type GraphPlannerRequest = {
  position: { x: number; y: number };
  anchor?: PlannerContext["anchor"];
};

export type GraphLayout = {
  positions: Record<string, { x: number; y: number }>;
};

export type PartitionState = {
  status?: string;
  attempts?: number;
  summaryFile?: string;
  managerSessionID?: string;
  workerSessionID?: string;
  completedAt?: string;
  retriedAt?: string;
};

export type State = {
  run?: { status?: string; currentPartitionID?: string | null; updatedAt?: string };
  activeTask?: { taskID?: string } | null;
  tasks?: Record<string, { taskID?: string; partitionID?: string | null; objective?: string; status?: string }>;
  partitions?: Record<string, PartitionState>;
  sessions?: { active?: { managerSessionID?: string; workerSessionID?: string; ownerPartitionID?: string } | null };
};

export type Snapshot = {
  projectRoot: string;
  runner: "idle" | "running";
  plan: Plan | null;
  state: State | null;
  logs: string[];
  error: string | null;
};

declare global {
  interface Window {
    orchestrator: {
      snapshot: () => Promise<Snapshot>;
      start: () => Promise<Snapshot>;
      stop: () => Promise<Snapshot>;
      openSessions: () => Promise<void>;
      savePlan: (text: string) => Promise<Snapshot>;
      plannerSettings: () => Promise<PlannerSettings>;
      savePlannerSettings: (settings: PlannerSettings) => Promise<PlannerSettings>;
      plannerModels: () => Promise<PlannerModel[]>;
      graphLayout: () => Promise<GraphLayout>;
      saveGraphLayout: (layout: GraphLayout) => Promise<GraphLayout>;
      generatePlan: (goal: string, settings: PlannerSettings, context?: PlannerContext) => Promise<GeneratedPlan>;
      archive: (partitionID: string) => Promise<Snapshot>;
      delete: (partitionID: string) => Promise<Snapshot>;
      retry: (partitionID: string) => Promise<Snapshot>;
      summary: (partitionID: string) => Promise<string>;
      onChanged: (listener: (snapshot: Snapshot) => void) => () => void;
    };
  }
}
