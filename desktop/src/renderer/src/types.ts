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

export type PartitionState = {
  status?: string;
  attempts?: number;
  summaryFile?: string;
  managerSessionID?: string;
  workerSessionID?: string;
  completedAt?: string;
};

export type State = {
  run?: { status?: string; currentPartitionID?: string | null; updatedAt?: string };
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
      generatePlan: (goal: string) => Promise<Plan>;
      archive: (partitionID: string) => Promise<Snapshot>;
      delete: (partitionID: string) => Promise<Snapshot>;
      summary: (partitionID: string) => Promise<string>;
      onChanged: (listener: (snapshot: Snapshot) => void) => () => void;
    };
  }
}
