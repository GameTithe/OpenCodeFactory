# OpenCode Orchestrator Desktop

Local Electron dashboard for the partition runner. It does not replace the
existing `.opencode` environment; it controls the existing scripts and shows
their persisted state.

## Start

From the project root, run `start-orchestrator-gui.bat`.

The app provides:

- `TODO/plan.json` editor with a new-partition draft button
- Natural-language goal to Planner-generated plan draft, with review before apply
- Run and stop controls for `run-partitions.bat`
- Current partition, sessions, and runner log display
- Dependency graph with live Manager/Worker task overlay
- Graph-based dependency editing and partition detail inspector
- Partition summary viewer
- Current Manager/Worker terminal launcher
- Completed partition archive and permanent deletion actions

The plan editor is locked while the runner is active. The desktop app is a
development build for now; packaging an installable `.exe` is a later step.

## Runner Safety

Only one runner may control a project at a time. The runner records a
project-local lock at `.opencode/orchestration/runner.lock.json`; a second GUI
or a manual `run-partitions.bat` invocation is rejected while its PID is alive.
Locks left by a terminated process are detected and replaced safely on the next
run.

If the runner ends while a partition is marked `running`, the next launch does
not automatically repeat it. The partition becomes `needs_attention` and the
GUI offers three choices:

- **기존 세션으로 재개**: clears incomplete Worker task records and resumes with
  the recorded Manager and Worker sessions.
- **처음부터 재시도**: clears incomplete Worker task records and starts the
  partition with fresh sessions.
- **차단 유지**: preserves the partition as blocked until it is manually retried.

## Verification

Run the orchestration state integration tests from the project root:

```text
node --test .opencode\tools\partition_runner.test.cjs
```

## Completed partitions

- **Archive** removes a completed partition from the active plan and saves its
  plan, state, and summary snapshot under `TODO/archive/`. Original runtime
  records remain available.
- **Permanent delete** removes the completed partition from the active plan and
  deletes its state, task reports, summary, and Worker handoff. This cannot be
  undone.

Neither action is allowed while the runner is active or while an unfinished
partition depends on the selected partition.

## Plan assistant

Enter a natural-language goal in **목표에서 계획 초안 만들기** and select
**계획 초안 생성**. Select a planning model after **모델 불러오기**, or leave
the default model selected. Choose **세분화 추천** for long, multi-feature
goals; it instructs the Planner to separate independently verifiable work into
multiple partitions. The app starts or reuses the local OpenCode Server and
asks a Planner session for JSON only. Review its preview and any decomposition
warning, then choose **현재 계획에 추가** or **전체 교체**. Nothing is written
until you subsequently press **계획 저장**.

## Dependency graph

The graph renders each partition as a node and each `dependsOn` entry as an
arrow. A running partition shows its active Manager/Worker task inside the
node. Dragging a node saves only its visual position to
`.opencode/orchestration/graph-layout.json`; it does not change execution
order.

When the runner is idle, drag a connection from one node to another to add a
dependency. Select an edge and press Delete to remove it. Click a node to edit
its title, goal, criteria, constraints, and session policy in the inspector.
Save the plan to apply graph edits to `TODO/plan.json`.

## Development

```text
cd desktop
npm.cmd run dev
npm.cmd run build
```

Set `OPENCODE_PROJECT_ROOT` before starting the app only when controlling a
different project directory. By default it controls this repository's parent
directory.
