# Partition plan

`plan.json` is the execution plan for unattended partition runs. Add ordered
partitions to `partitions`. Partitions use new Manager and Worker sessions by
default, or can explicitly continue a completed partition's sessions.

```json
{
  "version": 1,
  "goal": "Playable character features",
  "partitions": [
    {
      "id": "P001-character-foundation",
      "title": "Character foundation",
      "goal": "Create and place the playable character.",
      "acceptanceCriteria": [
        "A player character exists when the game starts.",
        "The project builds or runs successfully."
      ],
      "constraints": ["Do not implement movement or attacks."],
      "dependsOn": [],
      "session": { "mode": "new" }
    }
  ]
}
```

Rules:

- `id` must be unique and stable. Do not rename an ID after it has run.
- `dependsOn` is optional. Every referenced partition must finish first.
- `session` is optional and defaults to `{ "mode": "new" }`.
- Use `{ "mode": "continue" }` to reuse the latest active Manager and Worker
  sessions. The first partition must use `new` because no active sessions exist
  yet.
- Keep one partition to one coherent deliverable. The Manager creates the
  smaller Worker tasks inside it.
- Run `run-partitions.bat` after defining at least one partition.

`run-partitions.bat` runs partitions in dependency order, creating or reusing
the configured sessions. A `new` partition automatically opens Manager and
Worker terminals after creating its sessions; a `continue` partition leaves
the existing terminals in place. If a Worker is automatically replaced for
context headroom, a new Worker terminal opens. Restart
the OpenCode server once after copying or updating `.opencode` so it loads the
partition tools and agent rules.

Runtime records are created under `.opencode/orchestration/`:

- `state.json`: restartable execution state and task reports.
- `summaries/<partition-id>.md`: final Manager summary for a completed partition.
- `handoffs/<partition-id>-worker.md`: context for a replacement Worker.
