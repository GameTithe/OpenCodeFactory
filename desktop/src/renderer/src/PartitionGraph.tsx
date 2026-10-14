import { useState } from "react";
import { Background, Controls, Handle, MiniMap, Position, ReactFlow, type Connection, type Edge, type Node, type NodeProps, type ReactFlowInstance } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { GraphLayout, GraphPlannerRequest, Partition, State } from "./types";

type PartitionNodeData = {
  partition: Partition;
  status: string;
  active: boolean;
  task?: string;
};

function statusLabel(status: string) {
  return { completed: "완료", running: "실행 중", blocked: "차단됨", needs_attention: "확인 필요", pending: "대기" }[status] ?? status;
}

function PartitionNode({ data, selected }: NodeProps<Node<PartitionNodeData>>) {
  return (
    <div className={`flow-node ${data.status} ${selected ? "selected" : ""}`}>
      <Handle type="target" position={Position.Left} />
      <div className="flow-node-top"><span className="flow-status">{statusLabel(data.status)}</span><span>{data.partition.session?.mode ?? "new"}</span></div>
      <strong>{data.partition.title}</strong>
      <p>{data.partition.goal}</p>
      {data.active && <div className="flow-worker">Manager / Worker<br />{data.task ?? "다음 작업 준비 중"}</div>}
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

const nodeTypes = { partition: PartitionNode };

type Props = {
  partitions: Partition[];
  state: State | null;
  layout: GraphLayout;
  selectedID: string | null;
  onSelect: (id: string) => void;
  onMove: (id: string, position: { x: number; y: number }) => void;
  onConnect: (source: string, target: string) => void;
  onDisconnect: (source: string, target: string) => void;
  onCreatePlan: (request: GraphPlannerRequest) => void;
  editable: boolean;
};

export default function PartitionGraph({ partitions, state, layout, selectedID, onSelect, onMove, onConnect, onDisconnect, onCreatePlan, editable }: Props) {
  const [instance, setInstance] = useState<ReactFlowInstance | null>(null);
  const [menu, setMenu] = useState<(GraphPlannerRequest & { clientX: number; clientY: number }) | null>(null);
  const activeOwner = state?.sessions?.active?.ownerPartitionID;
  const activeTask = state?.activeTask?.taskID;
  const nodes: Array<Node<PartitionNodeData>> = partitions.map((partition, index) => {
    const saved = layout.positions[partition.id];
    const partitionState = state?.partitions?.[partition.id];
    const task = activeOwner === partition.id && activeTask ? state?.tasks?.[activeTask]?.objective : undefined;
    return {
      id: partition.id,
      type: "partition",
      position: saved ?? { x: 50 + (index % 3) * 310, y: 50 + Math.floor(index / 3) * 215 },
      selected: selectedID === partition.id,
      data: {
        partition,
        status: partitionState?.status ?? "pending",
        active: activeOwner === partition.id,
        task,
      },
    };
  });
  const edges: Edge[] = partitions.flatMap((partition) => (partition.dependsOn ?? []).map((dependency) => ({
    id: `${dependency}->${partition.id}`,
    source: dependency,
    target: partition.id,
    type: "smoothstep",
    animated: state?.partitions?.[partition.id]?.status === "running",
  })));

  return (
    <div className="graph-canvas">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        fitView
        minZoom={0.25}
        maxZoom={1.5}
        nodesConnectable={editable}
        nodesDraggable={editable}
        onInit={setInstance}
        onNodeClick={(_event, node) => onSelect(node.id)}
        onPaneClick={() => setMenu(null)}
        onPaneContextMenu={(event) => {
          if (!editable || !instance) return;
          event.preventDefault();
          setMenu({
            clientX: event.clientX,
            clientY: event.clientY,
            position: instance.screenToFlowPosition({ x: event.clientX, y: event.clientY }),
          });
        }}
        onNodeContextMenu={(event, node) => {
          if (!editable || !instance) return;
          event.preventDefault();
          const partition = (node.data as PartitionNodeData).partition;
          setMenu({
            clientX: event.clientX,
            clientY: event.clientY,
            position: instance.screenToFlowPosition({ x: event.clientX, y: event.clientY }),
            anchor: { id: partition.id, title: partition.title, goal: partition.goal },
          });
        }}
        onNodeDragStop={(_event, node) => onMove(node.id, node.position)}
        onConnect={(connection: Connection) => {
          if (connection.source && connection.target && connection.source !== connection.target) onConnect(connection.source, connection.target);
        }}
        onEdgesDelete={editable ? (deleted) => deleted.forEach((edge) => onDisconnect(edge.source, edge.target)) : undefined}
        deleteKeyCode={["Backspace", "Delete"]}
      >
        <Background gap={18} size={1} color="#29364a" />
        <MiniMap nodeColor={(node) => node.data?.status === "completed" ? "#237b59" : node.data?.status === "running" ? "#347ec4" : node.data?.status === "blocked" ? "#a8503d" : "#4a5870"} />
        <Controls />
      </ReactFlow>
      {menu && <div className="graph-context-menu" style={{ left: menu.clientX, top: menu.clientY }}>
        <button onClick={() => { onCreatePlan(menu); setMenu(null); }}>Planner로 노드 추가</button>
      </div>}
    </div>
  );
}
