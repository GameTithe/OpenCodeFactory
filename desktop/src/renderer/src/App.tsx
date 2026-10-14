import { useEffect, useMemo, useState } from "react";
import PartitionGraph from "./PartitionGraph";
import type { GeneratedPlan, GraphLayout, GraphPlannerRequest, Partition, Plan, PlannerContext, PlannerModel, PlannerSettings, Snapshot } from "./types";

const emptySnapshot: Snapshot = {
  projectRoot: "",
  runner: "idle",
  plan: null,
  state: null,
  logs: [],
  error: null,
};

function partitionStatus(snapshot: Snapshot, partition: Partition) {
  return snapshot.state?.partitions?.[partition.id]?.status ?? "pending";
}

function statusLabel(status: string) {
  return {
    completed: "완료",
    running: "실행 중",
    blocked: "차단됨",
    needs_attention: "확인 필요",
    pending: "대기",
  }[status] ?? status;
}

export default function App() {
  const [snapshot, setSnapshot] = useState<Snapshot>(emptySnapshot);
  const [planText, setPlanText] = useState("");
  const [notice, setNotice] = useState("");
  const [summary, setSummary] = useState<{ title: string; text: string } | null>(null);
  const [goalText, setGoalText] = useState("");
  const [generatedPlan, setGeneratedPlan] = useState<GeneratedPlan | null>(null);
  const [plannerSettings, setPlannerSettings] = useState<PlannerSettings>({ model: null, decomposition: "detailed" });
  const [plannerModels, setPlannerModels] = useState<PlannerModel[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [graphLayout, setGraphLayout] = useState<GraphLayout>({ positions: {} });
  const [selectedPartitionIDs, setSelectedPartitionIDs] = useState<string[]>([]);
  const [deleteSelection, setDeleteSelection] = useState<Partition[] | null>(null);
  const [graphPlanner, setGraphPlanner] = useState<GraphPlannerRequest | null>(null);
  const [graphPlannerGoal, setGraphPlannerGoal] = useState("");
  const [graphGeneratedPlan, setGraphGeneratedPlan] = useState<GeneratedPlan | null>(null);

  useEffect(() => {
    void window.orchestrator.snapshot().then((next) => {
      setSnapshot(next);
      setPlanText(next.plan ? JSON.stringify(next.plan, null, 2) : "");
    });
    void window.orchestrator.plannerSettings().then(setPlannerSettings);
    void window.orchestrator.graphLayout().then(setGraphLayout);
    return window.orchestrator.onChanged((next) => {
      setSnapshot(next);
    });
  }, []);

  const draftPlan = useMemo(() => {
    try {
      return planText.trim() ? JSON.parse(planText) as Plan : null;
    } catch {
      return null;
    }
  }, [planText]);
  const partitions = draftPlan?.partitions ?? snapshot.plan?.partitions ?? [];
  const stats = useMemo(() => {
    const statuses = partitions.map((partition) => partitionStatus(snapshot, partition));
    return {
      total: statuses.length,
      completed: statuses.filter((status) => status === "completed").length,
      blocked: statuses.filter((status) => status === "blocked" || status === "needs_attention").length,
    };
  }, [partitions, snapshot]);

  async function action(run: () => Promise<Snapshot | void>, success: string) {
    try {
      const next = await run();
      if (next) setSnapshot(next);
      setNotice(success);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    }
  }

  async function savePlan() {
    await action(() => window.orchestrator.savePlan(planText), "계획을 저장했습니다.");
  }

  function addPartitionDraft() {
    try {
      const plan = planText.trim()
        ? JSON.parse(planText) as { partitions?: Partition[] }
        : { version: 1, goal: "새 작업 목표", partitions: [] as Partition[] };
      const partitions = plan.partitions ?? [];
      const number = String(partitions.length + 1).padStart(3, "0");
      partitions.push({
        id: `P${number}-new-partition`,
        title: "새 파티션",
        goal: "이 파티션에서 달성할 목표를 작성하세요.",
        acceptanceCriteria: ["완료 조건을 작성하세요."],
        constraints: ["범위와 제약을 작성하세요."],
        dependsOn: partitions.length ? [partitions[partitions.length - 1].id] : [],
        session: { mode: "new" },
      });
      plan.partitions = partitions;
      setPlanText(JSON.stringify(plan, null, 2));
      setNotice("새 파티션 초안을 추가했습니다. 내용을 수정한 뒤 계획을 저장하세요.");
    } catch {
      setNotice("JSON 형식이 올바르지 않아 파티션 초안을 추가할 수 없습니다.");
    }
  }

  async function showSummary(partition: Partition) {
    try {
      const text = await window.orchestrator.summary(partition.id);
      setSummary({ title: `${partition.title} 요약`, text });
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    }
  }

  async function generatePlan() {
    try {
      setNotice("Planner가 목표를 분석해 계획 초안을 만들고 있습니다.");
      const generated = await window.orchestrator.generatePlan(goalText, plannerSettings);
      setGeneratedPlan(generated);
      setNotice("계획 초안이 생성되었습니다. 검토 후 적용 방식을 선택하세요.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    }
  }

  function openGraphPlanner(request: GraphPlannerRequest) {
    setGraphPlanner(request);
    setGraphPlannerGoal("");
    setGraphGeneratedPlan(null);
  }

  async function generateGraphPlan() {
    if (!graphPlanner || !graphPlannerGoal.trim()) return;
    try {
      setNotice("Planner가 그래프에 추가할 작업을 분석하고 있습니다.");
      const context: PlannerContext = graphPlanner.anchor ? { anchor: graphPlanner.anchor } : {};
      const generated = await window.orchestrator.generatePlan(graphPlannerGoal, plannerSettings, context);
      setGraphGeneratedPlan(generated);
      setNotice("그래프 추가 초안이 생성되었습니다.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    }
  }

  async function appendGraphPlan() {
    if (!graphPlanner || !graphGeneratedPlan) return;
    try {
      const current: Plan = planText.trim()
        ? JSON.parse(planText) as Plan
        : { version: 1, goal: graphGeneratedPlan.plan.goal, partitions: [] };
      const existing = new Set(current.partitions.map((partition) => partition.id));
      const duplicate = graphGeneratedPlan.plan.partitions.find((partition) => existing.has(partition.id));
      if (duplicate) throw new Error(`기존 계획에 이미 ${duplicate.id} ID가 있습니다.`);
      current.partitions.push(...graphGeneratedPlan.plan.partitions);
      if (!current.goal.trim()) current.goal = graphGeneratedPlan.plan.goal;
      setPlanText(JSON.stringify(current, null, 2));

      const positions = { ...graphLayout.positions };
      for (const [index, partition] of graphGeneratedPlan.plan.partitions.entries()) {
        positions[partition.id] = {
          x: graphPlanner.position.x + 36 + (index % 3) * 290,
          y: graphPlanner.position.y + 36 + Math.floor(index / 3) * 210,
        };
      }
      const nextLayout = { positions };
      setGraphLayout(nextLayout);
      await window.orchestrator.saveGraphLayout(nextLayout);
      setGraphPlanner(null);
      setGraphGeneratedPlan(null);
      setNotice("노드 초안을 그래프에 추가했습니다. 계획 저장을 눌러 반영하세요.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    }
  }

  function applyGeneratedPlan(mode: "append" | "replace") {
    if (!generatedPlan) return;
    try {
      if (mode === "replace") {
        setPlanText(JSON.stringify(generatedPlan.plan, null, 2));
      } else {
        const current: Plan = planText.trim()
          ? JSON.parse(planText) as Plan
          : { version: 1, goal: "", partitions: [] };
        const existing = new Set(current.partitions.map((partition) => partition.id));
        const duplicate = generatedPlan.plan.partitions.find((partition) => existing.has(partition.id));
        if (duplicate) throw new Error(`기존 계획에 이미 ${duplicate.id} ID가 있습니다.`);
        current.partitions.push(...generatedPlan.plan.partitions);
        if (!current.goal.trim()) current.goal = generatedPlan.plan.goal;
        setPlanText(JSON.stringify(current, null, 2));
      }
      setGeneratedPlan(null);
      setNotice("초안을 편집기에 적용했습니다. 계획 저장을 눌러 반영하세요.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    }
  }

  async function loadPlannerModels() {
    try {
      setModelsLoading(true);
      const models = await window.orchestrator.plannerModels();
      setPlannerModels(models);
      setNotice(`${models.length}개의 Planner 모델을 불러왔습니다.`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setModelsLoading(false);
    }
  }

  async function updatePlannerSettings(next: PlannerSettings) {
    try {
      const saved = await window.orchestrator.savePlannerSettings(next);
      setPlannerSettings(saved);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    }
  }

  function editDraft(mutator: (plan: Plan) => void) {
    try {
      const plan = draftPlan ?? snapshot.plan;
      if (!plan) throw new Error("수정할 계획이 없습니다.");
      const copy = JSON.parse(JSON.stringify(plan)) as Plan;
      mutator(copy);
      setPlanText(JSON.stringify(copy, null, 2));
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    }
  }

  function moveNode(id: string, position: { x: number; y: number }) {
    const next = { positions: { ...graphLayout.positions, [id]: position } };
    setGraphLayout(next);
    void window.orchestrator.saveGraphLayout(next).catch((error) => setNotice(error instanceof Error ? error.message : String(error)));
  }

  function connectNodes(source: string, target: string) {
    editDraft((plan) => {
      const targetPartition = plan.partitions.find((partition) => partition.id === target);
      if (!targetPartition) throw new Error("대상 파티션을 찾을 수 없습니다.");
      targetPartition.dependsOn ??= [];
      if (!targetPartition.dependsOn.includes(source)) targetPartition.dependsOn.push(source);
    });
  }

  function disconnectNodes(source: string, target: string) {
    editDraft((plan) => {
      const targetPartition = plan.partitions.find((partition) => partition.id === target);
      if (targetPartition) targetPartition.dependsOn = targetPartition.dependsOn?.filter((id) => id !== source);
    });
  }

  function updateSelectedPartition(changes: Partial<Partition>) {
    const selectedID = selectedPartitionIDs.length === 1 ? selectedPartitionIDs[0] : null;
    if (!selectedID) return;
    editDraft((plan) => {
      const partition = plan.partitions.find((item) => item.id === selectedID);
      if (!partition) throw new Error("선택한 파티션을 찾을 수 없습니다.");
      Object.assign(partition, changes);
    });
  }

  async function archive(partition: Partition) {
    if (!window.confirm(`${partition.title}을(를) 아카이브할까요? 실행 기록과 요약 문서는 보존됩니다.`)) return;
    try {
      const next = await window.orchestrator.archive(partition.id);
      setSnapshot(next);
      setPlanText(next.plan ? JSON.stringify(next.plan, null, 2) : "");
      setNotice("파티션을 아카이브했습니다.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    }
  }

  async function permanentlyDelete(partition: Partition) {
    if (!window.confirm(`${partition.title}의 상태, 요약, 인계, 작업 기록을 모두 삭제할까요? 이 작업은 되돌릴 수 없습니다.`)) return;
    try {
      const next = await window.orchestrator.delete(partition.id);
      setSnapshot(next);
      setPlanText(next.plan ? JSON.stringify(next.plan, null, 2) : "");
      setNotice("파티션과 관련 기록을 완전 삭제했습니다.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    }
  }

  function requestDelete(ids: string[]) {
    const selected = partitions.filter((partition) => ids.includes(partition.id));
    if (selected.length) setDeleteSelection(selected);
  }

  async function deleteSelected(mode: "archive" | "permanent") {
    if (!deleteSelection) return;
    const running = deleteSelection.filter((partition) => partitionStatus(snapshot, partition) === "running");
    if (running.length) {
      setNotice("실행 중인 파티션은 아카이브하거나 완전 삭제할 수 없습니다.");
      return;
    }
    try {
      let next = snapshot;
      for (const partition of deleteSelection) {
        next = mode === "archive"
          ? await window.orchestrator.archive(partition.id)
          : await window.orchestrator.delete(partition.id);
      }
      setSnapshot(next);
      setPlanText(next.plan ? JSON.stringify(next.plan, null, 2) : "");
      setSelectedPartitionIDs([]);
      setDeleteSelection(null);
      setNotice(mode === "archive" ? "선택한 파티션을 아카이브했습니다." : "선택한 파티션과 관련 기록을 완전 삭제했습니다.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    }
  }

  async function retry(partition: Partition) {
    if (!window.confirm(`${partition.title}을(를) 재시도할까요? 이 파티션의 이전 Worker 작업 기록만 초기화됩니다.`)) return;
    try {
      const next = await window.orchestrator.retry(partition.id);
      setSnapshot(next);
      setNotice("파티션을 재시도 대기 상태로 되돌렸습니다. 실행을 눌러 다시 시작하세요.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    }
  }

  const active = snapshot.state?.sessions?.active;
  const selectedPartition = selectedPartitionIDs.length === 1 ? partitions.find((partition) => partition.id === selectedPartitionIDs[0]) ?? null : null;
  const selectedPlannerModelUnavailable = Boolean(
    plannerSettings.model
      && plannerModels.length
      && !plannerModels.some((model) => model.providerID === plannerSettings.model?.providerID && model.modelID === plannerSettings.model?.modelID),
  );

  return (
    <main>
      <header className="topbar">
        <div>
          <p className="eyebrow">LOCAL ORCHESTRATION CONSOLE</p>
          <h1>OpenCode 작업 관제</h1>
          <p className="path">{snapshot.projectRoot || "프로젝트 경로를 불러오는 중"}</p>
        </div>
        <div className="controls">
          <span className={`status ${snapshot.runner}`}>{snapshot.runner === "running" ? "실행 중" : "대기 중"}</span>
          <button className="primary" disabled={snapshot.runner === "running"} onClick={() => void action(() => window.orchestrator.start(), "파티션 실행을 시작했습니다.")}>실행</button>
          <button className="danger" disabled={snapshot.runner !== "running"} onClick={() => void action(() => window.orchestrator.stop(), "실행기를 중단했습니다.")}>중단</button>
          <button onClick={() => void action(() => window.orchestrator.openSessions(), "현재 세션 창을 열었습니다.")}>세션 창 열기</button>
        </div>
      </header>

      {notice && <div className="notice">{notice}</div>}
      {snapshot.error && <div className="notice error">실행기 오류: {snapshot.error}</div>}

      <section className="metrics">
        <Metric label="전체 파티션" value={stats.total} />
        <Metric label="완료" value={stats.completed} accent="green" />
        <Metric label="확인 필요" value={stats.blocked} accent="orange" />
        <Metric label="현재 파티션" value={snapshot.state?.run?.currentPartitionID ?? "-"} wide />
      </section>

      <section className="panel graph-panel">
          <div className="panel-heading">
             <div><p className="eyebrow">DEPENDENCY GRAPH</p><h2>파티션 실행 흐름</h2><p className="muted">Shift+클릭 또는 우클릭 드래그로 노드를 선택합니다. 선택 노드는 Delete로 아카이브 또는 완전 삭제하고, 간선은 Delete로 의존성을 수정합니다.</p></div>
            <div className="editor-actions">
              <span>{snapshot.runner === "running" ? "실행 중에는 읽기 전용" : "드래그로 배치 저장"}</span>
              <button className="primary" disabled={snapshot.runner === "running"} onClick={() => void savePlan()}>계획 저장</button>
            </div>
          </div>
        <PartitionGraph
          partitions={partitions}
          state={snapshot.state}
          layout={graphLayout}
          selectedIDs={selectedPartitionIDs}
          editable={snapshot.runner !== "running"}
          onSelectionChange={setSelectedPartitionIDs}
          onRequestDelete={requestDelete}
          onMove={moveNode}
          onConnect={connectNodes}
          onDisconnect={disconnectNodes}
          onCreatePlan={openGraphPlanner}
        />
        {selectedPartition && <div className="node-inspector">
          <div className="panel-heading"><div><p className="eyebrow">NODE INSPECTOR</p><h2>{selectedPartition.title}</h2></div><button onClick={() => setSelectedPartitionIDs([])}>선택 해제</button></div>
          <div className="inspector-grid">
            <label>제목<input disabled={snapshot.runner === "running"} value={selectedPartition.title} onChange={(event) => updateSelectedPartition({ title: event.target.value })} /></label>
            <label>세션 정책<select disabled={snapshot.runner === "running"} value={selectedPartition.session?.mode ?? "new"} onChange={(event) => updateSelectedPartition({ session: { mode: event.target.value as "new" | "continue" } })}><option value="new">new</option><option value="continue">continue</option></select></label>
            <label className="full">목표<textarea disabled={snapshot.runner === "running"} value={selectedPartition.goal} onChange={(event) => updateSelectedPartition({ goal: event.target.value })} /></label>
            <label>완료 조건 (한 줄에 하나)<textarea disabled={snapshot.runner === "running"} value={selectedPartition.acceptanceCriteria.join("\n")} onChange={(event) => updateSelectedPartition({ acceptanceCriteria: event.target.value.split("\n").filter(Boolean) })} /></label>
            <label>제약 조건 (한 줄에 하나)<textarea disabled={snapshot.runner === "running"} value={(selectedPartition.constraints ?? []).join("\n")} onChange={(event) => updateSelectedPartition({ constraints: event.target.value.split("\n").filter(Boolean) })} /></label>
          </div>
          <p className="muted">그래프와 상세 패널의 수정은 아래 `계획 저장`을 눌러야 실제 plan.json에 반영됩니다.</p>
        </div>}
      </section>

      <section className="workspace">
        <div className="panel partitions">
          <div className="panel-heading">
            <div><p className="eyebrow">PARTITIONS</p><h2>실행 계획</h2></div>
            <span>{snapshot.state?.run?.status ?? "idle"}</span>
          </div>
          <div className="partition-list">
            {partitions.map((partition, index) => {
              const status = partitionStatus(snapshot, partition);
              const state = snapshot.state?.partitions?.[partition.id];
              return (
                <article className="partition" key={partition.id}>
                  <div className={`partition-index ${status}`}>{String(index + 1).padStart(2, "0")}</div>
                  <div className="partition-body">
                    <div className="partition-title"><h3>{partition.title}</h3><span className={`tag ${status}`}>{statusLabel(status)}</span></div>
                    <p>{partition.goal}</p>
                    <div className="partition-meta">
                      <span>{partition.session?.mode ?? "new"} 세션</span>
                      <span>{partition.dependsOn?.length ? `의존성 ${partition.dependsOn.length}` : "시작 파티션"}</span>
                      {state?.attempts && <span>시도 {state.attempts}</span>}
                    </div>
                  </div>
                  <div className="partition-actions">
                     <button className="text-button" disabled={!state?.summaryFile} onClick={() => void showSummary(partition)}>요약</button>
                     {(status === "blocked" || status === "needs_attention") && <button className="text-button" disabled={snapshot.runner === "running"} onClick={() => void retry(partition)}>재시도</button>}
                      {status !== "running" && <button className="text-button" disabled={snapshot.runner === "running"} onClick={() => void archive(partition)}>아카이브</button>}
                     {status !== "running" && <button className="delete-button" disabled={snapshot.runner === "running"} onClick={() => void permanentlyDelete(partition)}>완전 삭제</button>}
                  </div>
                </article>
              );
            })}
            {!partitions.length && <p className="empty">TODO/plan.json에 파티션을 추가하세요.</p>}
          </div>
        </div>

        <aside className="side-column">
          <section className="panel session-panel">
            <div className="panel-heading"><div><p className="eyebrow">SESSIONS</p><h2>현재 세션</h2></div></div>
            <dl>
              <dt>소유 파티션</dt><dd>{active?.ownerPartitionID ?? "없음"}</dd>
              <dt>Manager</dt><dd>{active?.managerSessionID ?? "없음"}</dd>
              <dt>Worker</dt><dd>{active?.workerSessionID ?? "없음"}</dd>
            </dl>
            <p className="muted">Worker는 컨텍스트 기준에 도달하면 자동으로 교체됩니다.</p>
          </section>
          <section className="panel log-panel">
            <div className="panel-heading"><div><p className="eyebrow">RUNNER LOG</p><h2>실행 로그</h2></div></div>
            <pre>{snapshot.logs.length ? snapshot.logs.join("\n") : "아직 실행 로그가 없습니다."}</pre>
          </section>
        </aside>
      </section>

      <section className="panel generator-panel">
        <div className="panel-heading">
          <div><p className="eyebrow">PLAN ASSISTANT</p><h2>목표에서 계획 초안 만들기</h2></div>
          <button className="primary" disabled={snapshot.runner === "running" || !goalText.trim()} onClick={() => void generatePlan()}>계획 초안 생성</button>
        </div>
        <div className="planner-options">
          <label>계획 모델
            <select value={plannerSettings.model ? `${plannerSettings.model.providerID}::${plannerSettings.model.modelID}` : "default"} disabled={snapshot.runner === "running"} onChange={(event) => {
              const value = event.target.value;
              if (value === "default") {
                void updatePlannerSettings({ ...plannerSettings, model: null });
                return;
              }
              const [providerID, modelID] = value.split("::");
              void updatePlannerSettings({ ...plannerSettings, model: { providerID, modelID } });
            }}>
              <option value="default">기본 모델 사용</option>
              {selectedPlannerModelUnavailable && <option value={`${plannerSettings.model!.providerID}::${plannerSettings.model!.modelID}`} disabled>현재 사용할 수 없는 모델</option>}
              {plannerModels.map((model) => <option key={`${model.providerID}::${model.modelID}`} value={`${model.providerID}::${model.modelID}`}>{model.label}</option>)}
            </select>
          </label>
          <button disabled={snapshot.runner === "running" || modelsLoading} onClick={() => void loadPlannerModels()}>{modelsLoading ? "불러오는 중" : "모델 불러오기"}</button>
          <label>분해 수준
            <select value={plannerSettings.decomposition} disabled={snapshot.runner === "running"} onChange={(event) => void updatePlannerSettings({ ...plannerSettings, decomposition: event.target.value as PlannerSettings["decomposition"] })}>
              <option value="detailed">세분화 추천</option>
              <option value="auto">자동 추천</option>
              <option value="compact">간단히</option>
            </select>
          </label>
        </div>
        {selectedPlannerModelUnavailable && <p className="planner-warning">저장된 Planner 모델은 현재 연결되어 있지 않습니다. 기본 모델 또는 목록의 다른 모델을 선택하세요.</p>}
        <textarea className="goal-input" value={goalText} disabled={snapshot.runner === "running"} onChange={(event) => setGoalText(event.target.value)} placeholder="예: 캐릭터 생성, 이동, 공격 기능을 구현해줘. 각 기능은 별도 파티션으로 나누고, 이동과 공격은 이전 작업의 세션을 이어서 사용해줘." />
        <p className="muted">Planner는 파일을 수정하지 않습니다. 생성된 결과는 아래에서 검토한 뒤에만 계획에 적용됩니다.</p>
        {generatedPlan && <div className="generated-plan">
          <div className="panel-heading"><div><p className="eyebrow">DRAFT PREVIEW</p><h2>{generatedPlan.plan.goal}</h2><p className="muted">생성된 파티션 {generatedPlan.plan.partitions.length}개</p></div><div className="editor-actions"><button onClick={() => setGeneratedPlan(null)}>버리기</button><button onClick={() => applyGeneratedPlan("append")}>현재 계획에 추가</button><button className="primary" onClick={() => applyGeneratedPlan("replace")}>전체 교체</button></div></div>
          {generatedPlan.warnings.map((warning) => <p className="planner-warning" key={warning}>{warning}</p>)}
          <pre>{JSON.stringify(generatedPlan.plan, null, 2)}</pre>
        </div>}
      </section>

      <section className="panel editor-panel">
        <div className="panel-heading">
          <div><p className="eyebrow">PLAN EDITOR</p><h2>plan.json 편집</h2></div>
          <div className="editor-actions">
            <button disabled={snapshot.runner === "running"} onClick={addPartitionDraft}>파티션 초안 추가</button>
            <button className="primary" disabled={snapshot.runner === "running"} onClick={() => void savePlan()}>계획 저장</button>
          </div>
        </div>
        <textarea value={planText} disabled={snapshot.runner === "running"} onChange={(event) => setPlanText(event.target.value)} spellCheck={false} />
        <p className="muted">실행 중에는 계획을 잠가 현재 실행과 파일 상태가 충돌하지 않도록 합니다.</p>
      </section>

      {deleteSelection && <div className="modal-backdrop" onClick={() => setDeleteSelection(null)}>
        <section className="modal delete-modal" onClick={(event) => event.stopPropagation()}>
          <div className="panel-heading"><div><p className="eyebrow">DELETE PARTITIONS</p><h2>{deleteSelection.length}개 노드 삭제</h2></div><button onClick={() => setDeleteSelection(null)}>취소</button></div>
          <p className="muted">실행 중인 파티션만 처리할 수 없습니다. 아카이브는 실행 기록과 요약을 보존하고, 완전 삭제는 관련 상태와 기록을 되돌릴 수 없게 제거합니다.</p>
          <ul className="delete-selection">{deleteSelection.map((partition) => <li key={partition.id}>{partition.title} <span>{statusLabel(partitionStatus(snapshot, partition))}</span></li>)}</ul>
          <div className="editor-actions modal-actions"><button onClick={() => void deleteSelected("archive")}>아카이브</button><button className="danger" onClick={() => void deleteSelected("permanent")}>완전 삭제</button></div>
        </section>
      </div>}
      {summary && <div className="modal-backdrop" onClick={() => setSummary(null)}>
        <section className="modal" onClick={(event) => event.stopPropagation()}>
          <div className="panel-heading"><h2>{summary.title}</h2><button onClick={() => setSummary(null)}>닫기</button></div>
          <pre>{summary.text}</pre>
        </section>
      </div>}
      {graphPlanner && <div className="modal-backdrop" onClick={() => setGraphPlanner(null)}>
        <section className="modal planner-modal" onClick={(event) => event.stopPropagation()}>
          <div className="panel-heading"><div><p className="eyebrow">GRAPH PLANNER</p><h2>그래프에 작업 추가</h2></div><button onClick={() => setGraphPlanner(null)}>닫기</button></div>
          <p className="muted">{graphPlanner.anchor ? `${graphPlanner.anchor.title}을(를) 문맥으로 전달합니다. 의존성 연결은 Planner가 목표를 바탕으로 판단합니다.` : "새 작업의 목표를 입력하세요. Planner가 필요한 노드와 의존성을 제안합니다."}</p>
          <textarea className="goal-input" value={graphPlannerGoal} onChange={(event) => setGraphPlannerGoal(event.target.value)} placeholder="예: 로그인 이후의 사용자 프로필 편집 기능을 추가해줘." autoFocus />
          {!graphGeneratedPlan && <div className="editor-actions modal-actions"><button className="primary" disabled={!graphPlannerGoal.trim()} onClick={() => void generateGraphPlan()}>계획 초안 생성</button></div>}
          {graphGeneratedPlan && <div className="generated-plan">
            <div className="panel-heading"><div><p className="eyebrow">GRAPH DRAFT</p><h2>{graphGeneratedPlan.plan.partitions.length}개 노드</h2></div><div className="editor-actions"><button onClick={() => setGraphGeneratedPlan(null)}>다시 작성</button><button className="primary" onClick={() => void appendGraphPlan()}>그래프에 추가</button></div></div>
            {graphGeneratedPlan.warnings.map((warning) => <p className="planner-warning" key={warning}>{warning}</p>)}
            <pre>{JSON.stringify(graphGeneratedPlan.plan, null, 2)}</pre>
          </div>}
        </section>
      </div>}
    </main>
  );
}

function Metric({ label, value, accent, wide }: { label: string; value: string | number; accent?: string; wide?: boolean }) {
  return <div className={`metric ${accent ?? ""} ${wide ? "wide" : ""}`}><span>{label}</span><strong>{value}</strong></div>;
}
