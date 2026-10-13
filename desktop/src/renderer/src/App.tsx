import { useEffect, useMemo, useState } from "react";
import type { Partition, Plan, Snapshot } from "./types";

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
  const [generatedPlan, setGeneratedPlan] = useState<Plan | null>(null);

  useEffect(() => {
    void window.orchestrator.snapshot().then((next) => {
      setSnapshot(next);
      setPlanText(next.plan ? JSON.stringify(next.plan, null, 2) : "");
    });
    return window.orchestrator.onChanged((next) => {
      setSnapshot(next);
    });
  }, []);

  const partitions = snapshot.plan?.partitions ?? [];
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
      const generated = await window.orchestrator.generatePlan(goalText);
      setGeneratedPlan(generated);
      setNotice("계획 초안이 생성되었습니다. 검토 후 적용 방식을 선택하세요.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    }
  }

  function applyGeneratedPlan(mode: "append" | "replace") {
    if (!generatedPlan) return;
    try {
      if (mode === "replace") {
        setPlanText(JSON.stringify(generatedPlan, null, 2));
      } else {
        const current: Plan = planText.trim()
          ? JSON.parse(planText) as Plan
          : { version: 1, goal: "", partitions: [] };
        const existing = new Set(current.partitions.map((partition) => partition.id));
        const duplicate = generatedPlan.partitions.find((partition) => existing.has(partition.id));
        if (duplicate) throw new Error(`기존 계획에 이미 ${duplicate.id} ID가 있습니다.`);
        current.partitions.push(...generatedPlan.partitions);
        if (!current.goal.trim()) current.goal = generatedPlan.goal;
        setPlanText(JSON.stringify(current, null, 2));
      }
      setGeneratedPlan(null);
      setNotice("초안을 편집기에 적용했습니다. 계획 저장을 눌러 반영하세요.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    }
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

  const active = snapshot.state?.sessions?.active;

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
                    {status === "completed" && <button className="text-button" onClick={() => void archive(partition)}>아카이브</button>}
                    {status === "completed" && <button className="delete-button" onClick={() => void permanentlyDelete(partition)}>완전 삭제</button>}
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
        <textarea className="goal-input" value={goalText} disabled={snapshot.runner === "running"} onChange={(event) => setGoalText(event.target.value)} placeholder="예: 캐릭터 생성, 이동, 공격 기능을 구현해줘. 각 기능은 별도 파티션으로 나누고, 이동과 공격은 이전 작업의 세션을 이어서 사용해줘." />
        <p className="muted">Planner는 파일을 수정하지 않습니다. 생성된 결과는 아래에서 검토한 뒤에만 계획에 적용됩니다.</p>
        {generatedPlan && <div className="generated-plan">
          <div className="panel-heading"><div><p className="eyebrow">DRAFT PREVIEW</p><h2>{generatedPlan.goal}</h2></div><div className="editor-actions"><button onClick={() => setGeneratedPlan(null)}>버리기</button><button onClick={() => applyGeneratedPlan("append")}>현재 계획에 추가</button><button className="primary" onClick={() => applyGeneratedPlan("replace")}>전체 교체</button></div></div>
          <pre>{JSON.stringify(generatedPlan, null, 2)}</pre>
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

      {summary && <div className="modal-backdrop" onClick={() => setSummary(null)}>
        <section className="modal" onClick={(event) => event.stopPropagation()}>
          <div className="panel-heading"><h2>{summary.title}</h2><button onClick={() => setSummary(null)}>닫기</button></div>
          <pre>{summary.text}</pre>
        </section>
      </div>}
    </main>
  );
}

function Metric({ label, value, accent, wide }: { label: string; value: string | number; accent?: string; wide?: boolean }) {
  return <div className={`metric ${accent ?? ""} ${wide ? "wide" : ""}`}><span>{label}</span><strong>{value}</strong></div>;
}
