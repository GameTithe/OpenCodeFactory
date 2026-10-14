import { useRef, useState } from "react";
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
  selectedIDs: string[];
  onSelectionChange: (ids: string[]) => void;
  onRequestDelete: (ids: string[]) => void;
  onMove: (id: string, position: { x: number; y: number }) => void;
  onConnect: (source: string, target: string) => void;
  onDisconnect: (source: string, target: string) => void;
  onCreatePlan: (request: GraphPlannerRequest) => void;
  editable: boolean;
};

export default function PartitionGraph({ partitions, state, layout, selectedIDs, onSelectionChange, onRequestDelete, onMove, onConnect, onDisconnect, onCreatePlan, editable }: Props) {
  const [instance, setInstance] = useState<ReactFlowInstance | null>(null);
  const [menu, setMenu] = useState<(GraphPlannerRequest & { clientX: number; clientY: number }) | null>(null);
  const rightDrag = useRef<{ start: { x: number; y: number }; moved: boolean } | null>(null);
  const suppressContextMenu = useRef(false);
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
      selected: selectedIDs.includes(partition.id),
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
    <div className="graph-canvas" onKeyDownCapture={(event) => {
      if (!editable || !["Backspace", "Delete"].includes(event.key) || !selectedIDs.length) return;
      event.preventDefault();
      event.stopPropagation();
      onRequestDelete(selectedIDs);
    }} onPointerDownCapture={(event) => {
      if (!editable || event.button !== 2) return;
      rightDrag.current = { start: { x: event.clientX, y: event.clientY }, moved: false };
      suppressContextMenu.current = false;
      event.currentTarget.setPointerCapture(event.pointerId);
    }} onPointerMoveCapture={(event) => {
      const drag = rightDrag.current;
      if (!drag) return;
      if (Math.abs(event.clientX - drag.start.x) > 4 || Math.abs(event.clientY - drag.start.y) > 4) drag.moved = true;
    }} onPointerUpCapture={(event) => {
      const drag = rightDrag.current;
      rightDrag.current = null;
      if (!drag || !drag.moved || !instance) return;
      suppressContextMenu.current = true;
      const start = instance.screenToFlowPosition(drag.start);
      const end = instance.screenToFlowPosition({ x: event.clientX, y: event.clientY });
      const selected = instance.getIntersectingNodes({
        x: Math.min(start.x, end.x),
        y: Math.min(start.y, end.y),
        width: Math.abs(end.x - start.x),
        height: Math.abs(end.y - start.y),
      }, false).map((node) => node.id);
      onSelectionChange(selected);
    }}>
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
        onNodeClick={(event, node) => {
          const next = event.shiftKey
            ? selectedIDs.includes(node.id) ? selectedIDs.filter((id) => id !== node.id) : [...selectedIDs, node.id]
            : [node.id];
          onSelectionChange(next);
        }}
        onPaneClick={() => { setMenu(null); onSelectionChange([]); }}
        onPaneContextMenu={(event) => {
          if (suppressContextMenu.current) {
            event.preventDefault();
            suppressContextMenu.current = false;
            return;
          }
          if (!editable || !instance) return;
          event.preventDefault();
          setMenu({
            clientX: event.clientX,
            clientY: event.clientY,
            position: instance.screenToFlowPosition({ x: event.clientX, y: event.clientY }),
          });
        }}
        onNodeContextMenu={(event, node) => {
          if (suppressContextMenu.current) {
            event.preventDefault();
            suppressContextMenu.current = false;
            return;
          }
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
        nodesDeletable={false}
        deleteKeyCode={editable ? ["Backspace", "Delete"] : null}
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
