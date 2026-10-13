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
- Partition summary viewer
- Current Manager/Worker terminal launcher
- Completed partition archive and permanent deletion actions

The plan editor is locked while the runner is active. The desktop app is a
development build for now; packaging an installable `.exe` is a later step.

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
**계획 초안 생성**. The app starts or reuses the local OpenCode Server and asks
a Planner session for JSON only. Review its preview, then choose **현재 계획에
추가** or **전체 교체**. Nothing is written until you subsequently press
**계획 저장**.

## Development

```text
cd desktop
npm.cmd run dev
npm.cmd run build
```

Set `OPENCODE_PROJECT_ROOT` before starting the app only when controlling a
different project directory. By default it controls this repository's parent
directory.
