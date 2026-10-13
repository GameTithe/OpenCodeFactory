import fs from "node:fs";
import path from "node:path";
import { tool } from "@opencode-ai/plugin";

function now() {
  return new Date().toISOString();
}

function statePath(projectRoot) {
  return path.join(projectRoot, ".opencode", "orchestration", "state.json");
}

function loadState(projectRoot) {
  try {
    return JSON.parse(fs.readFileSync(statePath(projectRoot), "utf8"));
  } catch {
    throw new Error("Partition state was not found. Start the partition runner first.");
  }
}

function saveState(projectRoot, state) {
  fs.mkdirSync(path.dirname(statePath(projectRoot)), { recursive: true });
  fs.writeFileSync(statePath(projectRoot), JSON.stringify(state, null, 2));
}

function summaryPath(projectRoot, partitionID) {
  return path.join(projectRoot, ".opencode", "orchestration", "summaries", `${partitionID}.md`);
}

function markdown(args) {
  return [
    `# Partition Summary: ${args.partition_id}`,
    "",
    `Status: ${args.status}`,
    `Completed: ${now()}`,
    "",
    "## Changed",
    args.changed,
    "",
    "## Decisions",
    args.decisions,
    "",
    "## Tested",
    args.tested,
    "",
    "## Risks",
    args.risks,
    "",
    "## Next Context",
    args.next_context,
    "",
  ].join("\n");
}

export default tool({
  description:
    "Record a final partition summary and mark the active partition completed or blocked. Only the Manager may call this once all partition work is finished.",
  args: {
    partition_id: tool.schema.string().min(1),
    status: tool.schema.string().min(1).describe("completed or blocked"),
    changed: tool.schema.string().min(1),
    decisions: tool.schema.string().min(1),
    tested: tool.schema.string().min(1),
    risks: tool.schema.string().min(1),
    next_context: tool.schema.string().min(1),
  },
  async execute(args, context) {
    if (context.agent !== "manager") {
      return "DENIED: partition_control may only be called by the manager agent.";
    }
    if (!['completed', 'blocked'].includes(args.status)) {
      return "DENIED: status must be completed or blocked.";
    }

    const state = loadState(context.directory);
    if (state.run?.currentPartitionID !== args.partition_id) {
      return `DENIED: ${args.partition_id} is not the active partition.`;
    }
    if (state.activeTask) {
      return `DENIED: ${state.activeTask.taskID} is still active.`;
    }

    const tasks = Object.values(state.tasks ?? {}).filter((task) => task.partitionID === args.partition_id);
    const unresolved = tasks.filter((task) => task.status !== "completed");
    if (args.status === "completed" && unresolved.length > 0) {
      return `DENIED: unresolved Worker tasks: ${unresolved.map((task) => task.taskID).join(", ")}.`;
    }

    const file = summaryPath(context.directory, args.partition_id);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, markdown(args));

    state.partitions ??= {};
    state.partitions[args.partition_id] ??= {};
    state.partitions[args.partition_id].status = args.status;
    state.partitions[args.partition_id].completedAt = now();
    state.partitions[args.partition_id].summaryFile = path.relative(context.directory, file).replace(/\\/g, "/");
    state.run.status = args.status;
    state.run.currentPartitionID = null;
    state.run.updatedAt = now();
    saveState(context.directory, state);

    return `PARTITION: ${args.partition_id}\nSTATUS: ${args.status}\nSUMMARY: ${file}`;
  },
});
